import { BunServices } from '@effect/platform-bun';
import { Effect, Layer, Predicate, Result, Runtime, Schema, SchemaRepresentation } from 'effect';
import { Command, Flag } from 'effect/cli';

import type {
	ApiContract,
	ApiOperation,
	ApiParameter,
	ApiResource,
	JsonSchema
} from '../src/api/contract';
import { kebab, operationInputs } from '../src/api/inputs';
import { requestDocument } from '../src/api/request';
import { ScriptCliLive } from './runtime/cli-live';
import { ScriptFiles, ScriptValidationFailure } from './runtime/services';
import { ScriptLive } from './runtime/services-live';

const SPEC_PATH = 'src/generated/openapi-public.json';
export const CONTRACT_OUTPUT_PATH = 'src/generated/contract.gen.ts';

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
const HTTP_METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const COMPONENT_PREFIX = '#/components/schemas/';
const DEFINITION_PREFIX = '#/$defs/';
/** Keywords that only document examples or vendor metadata; they never change validation. */
const DROPPED_KEYWORD = (key: string) =>
	key === 'example' || key === 'examples' || key.startsWith('x-');

// The subset of an OpenAPI 3.1 document the CLI contract is generated from.
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const MediaType = Schema.Struct({
	schema: Schema.optionalKey(JsonObject),
	'x-effect-stream': Schema.optionalKey(Schema.Struct({ failureEvent: Schema.String }))
});
const Content = Schema.Record(Schema.String, MediaType);
const Parameter = Schema.Struct({
	name: Schema.String,
	in: Schema.Literals(['path', 'query', 'header', 'cookie']),
	required: Schema.optionalKey(Schema.Boolean),
	description: Schema.optionalKey(Schema.String),
	schema: Schema.optionalKey(JsonObject)
});
const SecurityRequirements = Schema.Array(
	Schema.Record(Schema.String, Schema.Array(Schema.String))
);
const Operation = Schema.Struct({
	operationId: Schema.optionalKey(Schema.String),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	summary: Schema.optionalKey(Schema.String),
	security: Schema.optionalKey(SecurityRequirements),
	parameters: Schema.optionalKey(Schema.Array(Parameter)),
	requestBody: Schema.optionalKey(
		Schema.Struct({ required: Schema.optionalKey(Schema.Boolean), content: Content })
	),
	responses: Schema.Record(Schema.String, Schema.Struct({ content: Schema.optionalKey(Content) })),
	'x-platform-visibility': Schema.optionalKey(Schema.String)
});
type Operation = typeof Operation.Type;
export const OpenApiDocument = Schema.Struct({
	security: Schema.optionalKey(SecurityRequirements),
	tags: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({ name: Schema.String, description: Schema.optionalKey(Schema.String) })
		)
	),
	paths: Schema.Record(
		Schema.String,
		Schema.Struct({
			get: Schema.optionalKey(Operation),
			post: Schema.optionalKey(Operation),
			put: Schema.optionalKey(Operation),
			patch: Schema.optionalKey(Operation),
			delete: Schema.optionalKey(Operation)
		})
	),
	components: Schema.Struct({ schemas: Schema.Record(Schema.String, JsonObject) })
});
type OpenApiDocument = typeof OpenApiDocument.Type;
const decodeOpenApiDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenApiDocument));

export const generateContract = Effect.fn('generateContract')(function* (
	specPath: string = SPEC_PATH
) {
	const files = yield* ScriptFiles;
	const document = yield* files.readText(specPath).pipe(
		Effect.flatMap(decodeOpenApiDocument),
		Effect.catchTag('SchemaError', (cause) =>
			invalid(`OpenAPI spec does not match the expected shape: ${cause.message}`)
		)
	);
	const contract = yield* buildContract(document);
	yield* verifyContract(contract);
	return renderContract(contract);
});

export const buildContract = Effect.fn('buildContract')(function* (document: OpenApiDocument) {
	const tagDescriptions = new Map(
		(document.tags ?? []).map((tag): [string, string | undefined] => [tag.name, tag.description])
	);
	const publicOperations: Array<{ method: HttpMethod; path: string; operation: Operation }> = [];
	for (const [path, methods] of Object.entries(document.paths)) {
		for (const method of HTTP_METHODS) {
			const operation = methods[method];
			if (operation?.['x-platform-visibility'] === 'PUBLIC') {
				publicOperations.push({ method, path, operation });
			}
		}
	}

	const operations: ApiOperation[] = [];
	const parameters: Record<string, ApiParameter> = {};
	const resources = new Map<string, ApiResource>();
	for (const { method, path, operation } of publicOperations) {
		const id = operation.operationId;
		if (id === undefined || id === '') {
			return yield* invalid(`Public operation ${method.toUpperCase()} ${path} has no operationId`);
		}
		const [rawResource, rawAction, ...rest] = id.split('.');
		if (rawResource === undefined || rawAction === undefined || rest.length > 0) {
			return yield* invalid(`${id}: operationId must be <resource>.<action>`);
		}
		const resource = kebab(rawResource);
		const tag = operation.tags?.[0];
		if (!resources.has(resource)) {
			const description = tag === undefined ? undefined : tagDescriptions.get(tag);
			resources.set(resource, {
				name: resource,
				title: tag ?? resource,
				...(description === undefined ? {} : { description })
			});
		}

		const parameterKeys: string[] = [];
		for (const parameter of yield* orderParameters(id, path, operation.parameters ?? [])) {
			parameterKeys.push(shareParameter(parameters, parameter));
		}

		const body = yield* requestBody(id, operation);
		const stream = yield* successStream(id, operation);
		for (const [status, response] of Object.entries(operation.responses)) {
			if (!/^[45]\d\d$/.test(status)) continue;
			for (const [mediaType, media] of Object.entries(response.content ?? {})) {
				if (mediaType !== 'application/json' || media.schema === undefined) {
					return yield* invalid(`${id}: ${status} ${mediaType} error response is not JSON`);
				}
			}
		}

		operations.push({
			id,
			method: httpMethod(method),
			path,
			summary: operation.summary ?? id,
			auth: requiresAuthentication(operation.security ?? document.security ?? []),
			parameters: parameterKeys,
			...(body === undefined ? {} : { body }),
			...(stream === undefined ? {} : { stream })
		});
	}

	operations.sort((left, right) => left.id.localeCompare(right.id));
	const partial = {
		resources: [...resources.values()].sort((left, right) => left.name.localeCompare(right.name)),
		parameters: sortKeys(parameters),
		operations
	};
	return {
		...partial,
		definitions: yield* reachableDefinitions(document, partial)
	} satisfies ApiContract;
});

/**
 * Proves the runtime can use the contract: every request envelope and the
 * error envelope import into Effect schemas, and every operation maps to
 * collision-free command inputs.
 */
const verifyContract = Effect.fn('verifyContract')(function* (contract: ApiContract) {
	for (const operation of contract.operations) {
		yield* importSchema(operation.id, requestDocument(contract, operation));
		const inputs = operationInputs(contract, operation);
		if (Result.isFailure(inputs)) return yield* invalid(inputs.failure);
	}
});

function importSchema(
	label: string,
	document: ReturnType<typeof requestDocument>
): Effect.Effect<void, ScriptValidationFailure> {
	return Effect.try({
		try: () => SchemaRepresentation.fromJsonSchemaDocument(document, { patterns: 'apply' }),
		catch: (cause) =>
			new ScriptValidationFailure({
				message: `${label}: request schema cannot be represented: ${String(cause)}`
			})
	}).pipe(Effect.asVoid);
}

function orderParameters(
	id: string,
	path: string,
	parameters: readonly (typeof Parameter.Type)[]
): Effect.Effect<readonly ApiParameter[], ScriptValidationFailure> {
	return Effect.gen(function* () {
		const converted: ApiParameter[] = [];
		for (const parameter of parameters) {
			if (parameter.in === 'cookie') {
				return yield* invalid(`${id}: cookie parameter ${parameter.name} is not supported`);
			}
			converted.push({
				name: parameter.name,
				in: parameter.in,
				required: parameter.in === 'path' || parameter.required === true,
				...(parameter.description === undefined ? {} : { description: parameter.description }),
				schema: cleanSchema(parameter.schema ?? {})
			});
		}
		const template = [...path.matchAll(/\{([^}:]+)(?::\*)?\}/g)].map((match) => match[1]);
		const pathParameters = template.map((name) =>
			converted.find((parameter) => parameter.in === 'path' && parameter.name === name)
		);
		if (
			pathParameters.some(Predicate.isUndefined) ||
			converted.filter((parameter) => parameter.in === 'path').length !== template.length
		) {
			return yield* invalid(`${id}: path parameters do not match the template ${path}`);
		}
		return [
			...pathParameters.filter(Predicate.isNotUndefined),
			...converted.filter((parameter) => parameter.in !== 'path')
		];
	});
}

/** Identical parameters share one entry; a differing redefinition gets a numbered key. */
function shareParameter(table: Record<string, ApiParameter>, parameter: ApiParameter): string {
	const canonical = JSON.stringify(parameter);
	const base = `${parameter.in}:${parameter.name}`;
	for (let index = 1; ; index += 1) {
		const key = index === 1 ? base : `${base}:${index}`;
		const existing = table[key];
		if (existing === undefined) {
			table[key] = parameter;
			return key;
		}
		if (JSON.stringify(existing) === canonical) return key;
	}
}

function requestBody(
	id: string,
	operation: Operation
): Effect.Effect<ApiOperation['body'], ScriptValidationFailure> {
	const requestBody = operation.requestBody;
	if (requestBody === undefined) return Effect.succeed(undefined);
	const mediaTypes = Object.keys(requestBody.content);
	const json = requestBody.content['application/json']?.schema;
	if (json === undefined || mediaTypes.length !== 1) {
		return invalid(
			`${id}: request body must be application/json only, found ${mediaTypes.join(', ')}`
		);
	}
	return Effect.succeed({ required: requestBody.required === true, schema: cleanSchema(json) });
}

function successStream(
	id: string,
	operation: Operation
): Effect.Effect<ApiOperation['stream'], ScriptValidationFailure> {
	return Effect.gen(function* () {
		let stream: ApiOperation['stream'];
		for (const [status, response] of Object.entries(operation.responses)) {
			if (!/^2\d\d$/.test(status)) continue;
			for (const [mediaType, media] of Object.entries(response.content ?? {})) {
				if (mediaType === 'application/json') continue;
				const failureEvent = media['x-effect-stream']?.failureEvent;
				if (mediaType !== 'text/event-stream' || failureEvent === undefined) {
					return yield* invalid(
						`${id}: ${status} ${mediaType} success response is not representable`
					);
				}
				stream = { failureEvent };
			}
		}
		return stream;
	});
}

function reachableDefinitions(
	document: OpenApiDocument,
	roots: unknown
): Effect.Effect<Record<string, JsonSchema>, ScriptValidationFailure> {
	return Effect.gen(function* () {
		const definitions: Record<string, JsonSchema> = {};
		const pending = definitionReferences(roots);
		while (pending.length > 0) {
			const name = pending.pop();
			if (name === undefined || name in definitions) continue;
			const component = document.components.schemas[name];
			if (component === undefined) {
				return yield* invalid(`Missing component schema ${name}`);
			}
			const cleaned = cleanSchema(component);
			definitions[name] = cleaned;
			pending.push(...definitionReferences(cleaned));
		}
		return sortKeys(definitions);
	});
}

function definitionReferences(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(definitionReferences);
	if (!Predicate.isObject(value)) return [];
	const own =
		Predicate.isString(value.$ref) && value.$ref.startsWith(DEFINITION_PREFIX)
			? [value.$ref.slice(DEFINITION_PREFIX.length)]
			: [];
	return [...own, ...Object.values(value).flatMap(definitionReferences)];
}

/**
 * Keeps the validation keywords and descriptions, drops examples and vendor
 * extensions, and points component references at the document's `$defs`.
 */
export function cleanSchema(schema: Record<string, unknown>): JsonSchema {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (DROPPED_KEYWORD(key)) continue;
		cleaned[key] =
			key === '$ref' && Predicate.isString(value) && value.startsWith(COMPONENT_PREFIX)
				? `${DEFINITION_PREFIX}${value.slice(COMPONENT_PREFIX.length)}`
				: cleanValue(value);
	}
	return cleaned;
}

function cleanValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cleanValue);
	return Predicate.isObject(value) ? cleanSchema(value) : value;
}

function httpMethod(method: HttpMethod): ApiOperation['method'] {
	switch (method) {
		case 'get':
			return 'GET';
		case 'post':
			return 'POST';
		case 'put':
			return 'PUT';
		case 'patch':
			return 'PATCH';
		case 'delete':
			return 'DELETE';
	}
}

/** An operation is anonymous when any alternative requirement is empty. */
function requiresAuthentication(security: typeof SecurityRequirements.Type): boolean {
	return (
		security.length > 0 && security.every((requirement) => Object.keys(requirement).length > 0)
	);
}

function sortKeys<Value>(record: Record<string, Value>): Record<string, Value> {
	return Object.fromEntries(
		Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
	);
}

function renderContract(contract: ApiContract): string {
	return (
		'// Generated by scripts/generate-contract.ts from docs/openapi-public.json. Do not edit by hand.\n' +
		"import type { ApiContract } from '../api/contract';\n\n" +
		`export const contract: ApiContract = ${JSON.stringify(contract, null, '\t')};\n`
	);
}

function invalid(message: string): Effect.Effect<never, ScriptValidationFailure> {
	return Effect.fail(new ScriptValidationFailure({ message }));
}

export const generateContractCommand = Command.make(
	'generate-contract',
	{
		check: Flag.Boolean('check').pipe(
			Flag.withDescription('Fail if the generated contract is out of date'),
			Flag.withDefault(false)
		)
	},
	Effect.fn(function* ({ check }) {
		const generated = yield* generateContract();
		const files = yield* ScriptFiles;
		if (!check) return yield* files.writeText(CONTRACT_OUTPUT_PATH, generated);
		const current = yield* files
			.readText(CONTRACT_OUTPUT_PATH)
			.pipe(Effect.orElseSucceed(() => ''));
		if (current !== generated) {
			return yield* invalid(`${CONTRACT_OUTPUT_PATH} is out of date. Run: bun run generate`);
		}
	})
).pipe(Command.withDescription('Generate the public API contract the CLI executes'));

if (import.meta.main) {
	Runtime.makeRunMain(({ fiber, teardown }) => {
		fiber.addObserver((exit) =>
			teardown(exit, (code) => {
				process.exitCode = code;
			})
		);
	})(
		Command.run(generateContractCommand, { version: '1.0.0' }).pipe(
			Effect.provide(ScriptCliLive),
			Effect.provide(Layer.provide(ScriptLive, BunServices.layer))
		)
	);
}
