import {
	Effect,
	type JsonSchema as EffectJsonSchema,
	Predicate,
	Schema,
	SchemaIssue,
	SchemaRepresentation
} from 'effect';

import type { ApiContract, ApiOperation, ApiParameter, JsonSchema } from './contract';
import { OperationFailure } from './failure';
import { operationParameters, partitionOf } from './inputs';
import { JsonRecord } from './json';

const LOCATIONS: ReadonlyArray<ApiParameter['in']> = ['path', 'query', 'header'];

/**
 * The JSON request envelope an operation accepts, as one JSON Schema
 * document: `{ path, query, headers, body }`, each partition closed so
 * unknown fields are rejected before a request is sent.
 */
export function requestDocument(
	contract: ApiContract,
	operation: ApiOperation
): EffectJsonSchema.Document<'draft-2020-12'> {
	const parameters = operationParameters(contract, operation);
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];
	for (const location of LOCATIONS) {
		const members = parameters.filter((parameter) => parameter.in === location);
		if (members.length === 0) continue;
		const partition = partitionOf(location);
		properties[partition] = closedObject(members);
		if (members.some((parameter) => parameter.required)) required.push(partition);
	}
	if (operation.body !== undefined) {
		properties.body = operation.body.schema;
		if (operation.body.required) required.push('body');
	}
	return {
		dialect: 'draft-2020-12',
		schema: { type: 'object', properties, required, additionalProperties: false },
		definitions: contract.definitions
	};
}

function closedObject(parameters: readonly ApiParameter[]): JsonSchema {
	return {
		type: 'object',
		properties: Object.fromEntries(
			parameters.map((parameter) => [parameter.name, parameter.schema])
		),
		required: parameters.filter((parameter) => parameter.required).map(({ name }) => name),
		additionalProperties: false
	};
}

/** A request envelope after it passed the operation's schema. */
export const ApiRequest = Schema.Struct({
	path: Schema.optionalKey(JsonRecord),
	query: Schema.optionalKey(JsonRecord),
	headers: Schema.optionalKey(JsonRecord),
	body: Schema.optionalKey(Schema.Json)
});
export type ApiRequest = typeof ApiRequest.Type;

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Validates a request envelope against the operation's generated schema,
 * rejecting unknown fields. Issues name the field and the expectation, never
 * the rejected value.
 */
export const decodeRequest = Effect.fnUntraced(function* (
	contract: ApiContract,
	operation: ApiOperation,
	input: unknown
) {
	// The generator imports every operation's document, so a failure here is a CLI defect.
	const schema = yield* Effect.sync(() =>
		Schema.make<Schema.Codec<unknown>>(
			SchemaRepresentation.fromJsonSchemaDocument(requestDocument(contract, operation), {
				patterns: 'apply'
			}).ast
		)
	);
	const validated = yield* Schema.decodeUnknownEffect(schema)(input, {
		onExcessProperty: 'error'
	}).pipe(
		Effect.mapError(
			(error) =>
				new OperationFailure({
					operationId: operation.id,
					reason: 'input',
					issues: formatIssues(error.issue).issues.map((issue) => ({
						path: (issue.path ?? []).map((segment) =>
							String(Predicate.isObject(segment) ? segment.key : segment)
						),
						message: issue.message
					}))
				})
		)
	);
	return yield* Schema.decodeUnknownEffect(ApiRequest)(validated).pipe(Effect.orDie);
});
