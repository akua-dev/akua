import { Effect, Option, Predicate, Schema } from 'effect';

import { ApiClient } from '../api/client';
import type { ApiContract } from '../api/contract';
import { OperationFailure } from '../api/failure';
import { findOperation } from '../api/inputs';
import { decodeRequest } from '../api/request';
import { configPath, optionalEnv } from '../runtime/credentials';
import { UsageFailure } from '../runtime/effect-runtime';
import { SecureConfig, type SecureConfigFailure, type StoredWorkspace } from '../runtime/services';

export type WorkspaceSource = 'flag' | 'env' | 'config';

/** The workspace a command runs in, as the user named it, before any API lookup. */
export interface WorkspaceSelection {
	/** A `ws_...` ID, slug, or name. */
	readonly reference: string;
	readonly source: WorkspaceSource;
	/** Display name saved by `akua workspaces use`. */
	readonly name?: string;
}

export interface Workspace {
	readonly id: string;
	readonly name: string;
	readonly slug?: string;
	/** Lifecycle state, for example `ACTIVE` or `DELETING`. */
	readonly state?: string;
}

/**
 * clig.dev precedence: the `--workspace` flag, then `AKUA_WORKSPACE`, then the
 * workspace saved by `akua workspaces use`.
 */
export const selectWorkspace = Effect.fnUntraced(function* (
	flag: Option.Option<string>
): Effect.fn.Return<
	Option.Option<WorkspaceSelection>,
	SecureConfigFailure | UsageFailure,
	SecureConfig
> {
	if (Option.isSome(flag)) {
		if (flag.value === '') {
			return yield* new UsageFailure({ message: 'Missing value for --workspace.' });
		}
		return Option.some({ reference: flag.value, source: 'flag' });
	}
	const fromEnv = yield* optionalEnv('AKUA_WORKSPACE');
	if (Option.isSome(fromEnv)) return Option.some({ reference: fromEnv.value, source: 'env' });
	const saved = yield* savedWorkspace;
	return Option.map(saved, (workspace) => ({
		reference: workspace.id,
		source: 'config',
		...(workspace.name === undefined ? {} : { name: workspace.name })
	}));
});

export const savedWorkspace: Effect.Effect<
	Option.Option<StoredWorkspace>,
	SecureConfigFailure,
	SecureConfig
> = Effect.gen(function* () {
	const path = yield* configPath;
	if (Option.isNone(path)) return Option.none();
	return Option.fromUndefinedOr(yield* (yield* SecureConfig).readWorkspace(path.value));
});

/** A workspace wire ID; anything else is a slug or name to look up. */
export const isWorkspaceId = (reference: string) => reference.startsWith('ws_');

/** A `ws_...` ID is used as given; a slug or name is looked up among the caller's workspaces. */
export const resolveWorkspaceId = Effect.fnUntraced(function* (
	contract: ApiContract,
	selection: WorkspaceSelection
) {
	if (isWorkspaceId(selection.reference)) return selection.reference;
	return (yield* findWorkspace(contract, selection.reference)).id;
});

const WorkspacePage = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			slug: Schema.optionalKey(Schema.NullOr(Schema.String)),
			lifecycle: Schema.optionalKey(Schema.Struct({ state: Schema.optionalKey(Schema.String) }))
		})
	),
	has_more: Schema.optionalKey(Schema.Boolean),
	next_cursor: Schema.optionalKey(Schema.NullOr(Schema.String))
});

/** Matches an ID, slug, or (case-insensitive) name against every workspace the caller can access. */
export const findWorkspace = Effect.fnUntraced(function* (
	contract: ApiContract,
	reference: string
): Effect.fn.Return<Workspace, OperationFailure | SecureConfigFailure, ApiClient> {
	const workspaces = yield* listWorkspaces(contract);
	const exact = workspaces.filter(
		(workspace) => workspace.id === reference || workspace.slug === reference
	);
	const matches =
		exact.length > 0
			? exact
			: workspaces.filter((workspace) => workspace.name.toLowerCase() === reference.toLowerCase());
	const [match, ...others] = matches;
	if (match !== undefined && others.length === 0) return match;
	return yield* new OperationFailure({
		operationId: 'workspaces.list',
		reason: 'workspace',
		detail:
			match === undefined
				? `No workspace matches "${reference}".`
				: `"${reference}" matches ${matches.length} workspaces: ${matches.map((workspace) => workspace.id).join(', ')}. Use the ID.`
	});
});

/** Every workspace the caller can access, across all pages. */
export const listWorkspaces = Effect.fnUntraced(function* (contract: ApiContract) {
	const operation = yield* findOperation(contract, 'workspaces.list');
	const api = yield* ApiClient;
	const workspaces: Workspace[] = [];
	let cursor: string | undefined;
	do {
		const request = yield* decodeRequest(contract, operation, {
			query: { limit: 100, ...(cursor === undefined ? {} : { cursor }) }
		});
		const result = yield* api.execute(operation, request);
		const page =
			result._tag === 'Value'
				? Schema.decodeUnknownOption(WorkspacePage)(result.value)
				: Option.none();
		if (Option.isNone(page)) {
			return yield* new OperationFailure({ operationId: operation.id, reason: 'response' });
		}
		for (const workspace of page.value.data) {
			workspaces.push({
				id: workspace.id,
				name: workspace.name,
				...(Predicate.isString(workspace.slug) ? { slug: workspace.slug } : {}),
				...(workspace.lifecycle?.state === undefined ? {} : { state: workspace.lifecycle.state })
			});
		}
		cursor =
			page.value.has_more === true && Predicate.isString(page.value.next_cursor)
				? page.value.next_cursor
				: undefined;
	} while (cursor !== undefined);
	return workspaces;
});
