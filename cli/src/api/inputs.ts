import { Effect, Predicate, Result } from 'effect';

import type { ApiContract, ApiOperation, ApiParameter, JsonSchema } from './contract';

/**
 * How a command-line operation exposes its request: path parameters become
 * positional arguments, query, header, and top-level body fields become typed
 * flags, and the workspace context header is filled in by the CLI.
 *
 * Derived from the generated contract with pure functions so the generator
 * can prove every operation maps cleanly (no flag collisions) and the
 * runtime builds the same commands without carrying a second copy of them.
 */
export interface OperationInputs {
	readonly arguments: readonly InputArgument[];
	readonly flags: readonly InputFlag[];
	/** True when the operation accepts the workspace context header. */
	readonly context: boolean;
}

export interface InputArgument {
	/** Path template parameter name, for example `id`. */
	readonly name: string;
	readonly description?: string;
}

export type FlagTarget = 'query' | 'header' | 'body';

export type FlagKind =
	| { readonly _tag: 'String' }
	| { readonly _tag: 'Integer' }
	| { readonly _tag: 'Number' }
	| { readonly _tag: 'Boolean' }
	| { readonly _tag: 'Choice'; readonly choices: readonly string[] }
	/** Objects, arrays, and mixed unions take a JSON value. */
	| { readonly _tag: 'Json' };

export interface InputFlag {
	/** Long flag name without dashes, for example `region-id`. */
	readonly name: string;
	readonly target: FlagTarget;
	/** Wire name inside its target, for example `region_id`. */
	readonly key: string;
	readonly kind: FlagKind;
	readonly required: boolean;
	/**
	 * The field is (or contains) secret material (`format: password`). Its
	 * value is also accepted from a file or stdin via `--<name>-file`.
	 */
	readonly secret: boolean;
	readonly description?: string;
}

/** Suffix of the flag that reads a secret flag's value from a file or stdin. */
export const SECRET_FILE_SUFFIX = '-file';

/** Header the public API reads the workspace (or other scope) context from. */
export const CONTEXT_HEADER = 'akua-context';

/** Flags every command already owns; generated flags never shadow them. */
export const RESERVED_FLAG_NAMES: ReadonlySet<string> = new Set([
	'completions',
	'help',
	'input',
	'json',
	'output',
	'quiet',
	'version',
	'workspace'
]);

/** `clusters.createWorkerBootstrap` runs as `akua clusters create-worker-bootstrap`. */
export function commandPath(operation: ApiOperation): {
	readonly resource: string;
	readonly action: string;
} {
	const [resource = operation.id, action = ''] = operation.id.split('.');
	return { resource: kebab(resource), action: kebab(action) };
}

/** An operation the CLI's own commands call; its absence from the contract is a CLI defect. */
export function findOperation(contract: ApiContract, id: string): Effect.Effect<ApiOperation> {
	return Effect.fromNullishOr(contract.operations.find((candidate) => candidate.id === id)).pipe(
		Effect.orDie
	);
}

/** The request envelope partition a flag writes into. */
export function partitionOf(target: FlagTarget | 'path'): 'path' | 'query' | 'headers' | 'body' {
	return target === 'header' ? 'headers' : target;
}

export function operationParameters(
	contract: ApiContract,
	operation: ApiOperation
): readonly ApiParameter[] {
	return operation.parameters.flatMap((key) => {
		const parameter = contract.parameters[key];
		return parameter === undefined ? [] : [parameter];
	});
}

export function operationInputs(
	contract: ApiContract,
	operation: ApiOperation
): Result.Result<OperationInputs, string> {
	const parameters = operationParameters(contract, operation);
	const candidates: InputFlag[] = [];
	for (const parameter of parameters) {
		if (parameter.in === 'path' || parameter.name === CONTEXT_HEADER) continue;
		candidates.push({
			name: kebab(parameter.name),
			target: parameter.in,
			key: parameter.name,
			kind: flagKind(contract, parameter.schema),
			required: parameter.required,
			secret: isSecret(contract, parameter.schema),
			...(parameter.description === undefined ? {} : { description: parameter.description })
		});
	}
	candidates.push(...bodyFlags(contract, operation));

	const taken = new Set<string>();
	const flags: InputFlag[] = [];
	for (const candidate of candidates) {
		const name =
			RESERVED_FLAG_NAMES.has(candidate.name) || taken.has(candidate.name)
				? `${candidate.target}-${candidate.name}`
				: candidate.name;
		if (RESERVED_FLAG_NAMES.has(name) || taken.has(name)) {
			return Result.fail(
				`${operation.id}: ${candidate.target} field ${candidate.key} maps to the already used flag --${name}`
			);
		}
		taken.add(name);
		flags.push({ ...candidate, name });
	}
	for (const flag of flags.filter((candidate) => candidate.secret)) {
		const fileFlag = `${flag.name}${SECRET_FILE_SUFFIX}`;
		if (RESERVED_FLAG_NAMES.has(fileFlag) || taken.has(fileFlag)) {
			return Result.fail(
				`${operation.id}: secret flag --${flag.name} needs the already used --${fileFlag}`
			);
		}
		taken.add(fileFlag);
	}

	return Result.succeed({
		arguments: parameters
			.filter((parameter) => parameter.in === 'path')
			.map((parameter) => ({
				name: parameter.name,
				...(parameter.description === undefined ? {} : { description: parameter.description })
			})),
		flags,
		context: parameters.some(
			(parameter) => parameter.in === 'header' && parameter.name === CONTEXT_HEADER
		)
	});
}

/**
 * Top-level fields of an object body, or of every object branch of a union
 * body, become flags. A field present in several branches with different
 * shapes takes JSON.
 */
function bodyFlags(contract: ApiContract, operation: ApiOperation): InputFlag[] {
	if (operation.body === undefined) return [];
	const root = resolve(contract, operation.body.schema);
	const branches = unionBranches(root) ?? [root];
	const objects = branches.map((branch) => resolve(contract, branch));
	if (!objects.every((branch) => Predicate.isObject(branch.properties))) return [];

	const fields = new Map<
		string,
		{ kind: FlagKind; required: boolean; secret: boolean; description?: string }
	>();
	for (const branch of objects) {
		const properties = Predicate.isObject(branch.properties) ? branch.properties : {};
		const required = stringArray(branch.required);
		for (const [key, value] of Object.entries(properties)) {
			if (!Predicate.isObject(value)) continue;
			const kind = flagKind(contract, value);
			const description = Predicate.isString(value.description) ? value.description : undefined;
			const existing = fields.get(key);
			fields.set(key, {
				kind: existing === undefined ? kind : mergeKinds(existing.kind, kind),
				required: (existing?.required ?? true) && required.includes(key),
				secret: (existing?.secret ?? false) || isSecret(contract, value),
				...((existing?.description ?? description) === undefined
					? {}
					: { description: existing?.description ?? description })
			});
		}
	}
	for (const [key, field] of fields) {
		if (
			!objects.every((branch) => Predicate.isObject(branch.properties) && key in branch.properties)
		)
			fields.set(key, { ...field, required: false });
	}

	return [...fields].map(([key, field]) => ({
		name: kebab(key),
		target: 'body',
		key,
		kind: field.kind,
		required: field.required,
		secret: field.secret,
		...(field.description === undefined ? {} : { description: field.description })
	}));
}

/** A schema is secret when it, a union branch, or a nested property has `format: password`. */
export function isSecret(
	contract: ApiContract,
	schema: JsonSchema,
	seen = new Set<JsonSchema>()
): boolean {
	const resolved = resolve(contract, schema);
	if (seen.has(resolved)) return false;
	seen.add(resolved);
	if (resolved.format === 'password') return true;
	const nested = [
		...(unionBranches(resolved) ?? []),
		...(Predicate.isObject(resolved.properties)
			? Object.values(resolved.properties).filter(Predicate.isObject)
			: []),
		...(Predicate.isObject(resolved.items) ? [resolved.items] : [])
	];
	return nested.some((child) => isSecret(contract, child, seen));
}

export function flagKind(contract: ApiContract, schema: JsonSchema): FlagKind {
	const resolved = resolve(contract, schema);
	const choices = stringChoices(resolved);
	if (choices !== undefined) return { _tag: 'Choice', choices };

	const branches = unionBranches(resolved);
	if (branches !== undefined) {
		const kinds = branches
			.map((branch) => resolve(contract, branch))
			.filter((branch) => branch.type !== 'null')
			.map((branch) => flagKind(contract, branch));
		const [first, ...rest] = kinds;
		if (first === undefined) return { _tag: 'Json' };
		return rest.reduce(mergeKinds, first);
	}

	const types = (Array.isArray(resolved.type) ? resolved.type : [resolved.type]).filter(
		(type) => type !== 'null'
	);
	if (types.length !== 1) return { _tag: 'Json' };
	switch (types[0]) {
		case 'string':
			return { _tag: 'String' };
		case 'integer':
			return { _tag: 'Integer' };
		case 'number':
			return { _tag: 'Number' };
		case 'boolean':
			return { _tag: 'Boolean' };
		default:
			return { _tag: 'Json' };
	}
}

function mergeKinds(left: FlagKind, right: FlagKind): FlagKind {
	if (left._tag === 'Choice' && right._tag === 'Choice') {
		return { _tag: 'Choice', choices: [...new Set([...left.choices, ...right.choices])] };
	}
	return left._tag === right._tag ? left : { _tag: 'Json' };
}

function stringChoices(schema: JsonSchema): readonly string[] | undefined {
	if (Predicate.isString(schema.const)) return [schema.const];
	if (!Array.isArray(schema.enum)) return undefined;
	const values = schema.enum.filter((value) => value !== null);
	return values.length > 0 && values.every(Predicate.isString) ? values : undefined;
}

function unionBranches(schema: JsonSchema): readonly JsonSchema[] | undefined {
	const branches = Array.isArray(schema.anyOf)
		? schema.anyOf
		: Array.isArray(schema.oneOf)
			? schema.oneOf
			: undefined;
	return branches?.filter(Predicate.isObject);
}

/** Follows a local `#/$defs/<name>` reference into the contract definitions. */
export function resolve(contract: ApiContract, schema: JsonSchema): JsonSchema {
	const ref = schema.$ref;
	if (!Predicate.isString(ref) || !ref.startsWith('#/$defs/')) return schema;
	const target = contract.definitions[ref.slice('#/$defs/'.length)];
	return target === undefined ? schema : resolve(contract, target);
}

function stringArray(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter(Predicate.isString) : [];
}

export function kebab(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replace(/[_\s.]+/g, '-')
		.toLowerCase();
}
