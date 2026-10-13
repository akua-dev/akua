import { Effect, Option } from 'effect';
import { Argument, Command, Flag, Prompt } from 'effect/cli';

import type { ApiClient } from '../api/client';
import type { ApiContract } from '../api/contract';
import { optionalEnv, requiredConfigPath } from '../runtime/credentials';
import { type CliFailure, UsageFailure } from '../runtime/effect-runtime';
import type { RenderEnvelope } from '../runtime/render';
import { Console, SecureConfig } from '../runtime/services';
import { Invocation, respond } from './invocation';
import { failWorkspaceLookup } from './operation-errors';
import { akua } from './root';
import {
	findWorkspace,
	isWorkspaceId,
	listWorkspaces,
	selectWorkspace,
	type Workspace,
	type WorkspaceSource
} from './workspace-context';

const SOURCE_LABEL: Record<WorkspaceSource, string> = {
	flag: 'Set by --workspace.',
	env: 'Set by AKUA_WORKSPACE.',
	config: 'Saved with akua workspaces use.'
};

/**
 * `akua workspaces use|current`: the persisted workspace context, in the
 * spirit of `vercel switch` and `gh repo set-default`. Added to the generated
 * `workspaces` group, which also answers to `akua workspace`.
 */
export function workspaceContextCommands(contract: ApiContract) {
	const use = Command.make(
		'use',
		{
			workspace: Argument.String('workspace').pipe(
				Argument.withDescription('Workspace name, slug, or ID'),
				Argument.optional
			),
			clear: Flag.Boolean('clear').pipe(
				Flag.withDefault(false),
				Flag.withDescription('Forget the saved workspace')
			)
		},
		({ workspace, clear }) => respond(clear ? clearWorkspace : useWorkspace(contract, workspace))
	).pipe(
		Command.withAlias('switch'),
		Command.withDescription(
			'Save the workspace later commands run in (--workspace and AKUA_WORKSPACE still override it)'
		),
		Command.withExamples([
			{
				command: 'akua workspaces use my-team',
				description: 'Use the workspace with this slug or name'
			},
			{ command: 'akua workspace switch ws_123', description: 'Same, by ID' },
			{ command: 'akua workspaces use --clear', description: 'Forget the saved workspace' }
		])
	);

	const current = Command.make('current', {}, () =>
		Effect.gen(function* () {
			const global = yield* akua;
			yield* respond(currentWorkspace(contract, global.workspace));
		})
	).pipe(Command.withDescription('Show the workspace commands run in and where it comes from'));

	return { commands: [use, current], alias: 'workspace' };
}

const useWorkspace = Effect.fnUntraced(function* (
	contract: ApiContract,
	reference: Option.Option<string>
): Effect.fn.Return<
	RenderEnvelope,
	CliFailure,
	SecureConfig | ApiClient | Console | Invocation | Prompt.Environment
> {
	const path = yield* requiredConfigPath;
	const named = reference.pipe(Option.filter((value) => value !== ''));
	const workspace = Option.isSome(named)
		? yield* findWorkspace(contract, named.value).pipe(Effect.catch(failWorkspaceLookup(contract)))
		: yield* pickWorkspace(contract);
	yield* (yield* SecureConfig).saveWorkspace(path, { id: workspace.id, name: workspace.name });
	const lines = [
		`Now using ${workspace.name} (${workspace.id}).`,
		...Option.toArray(yield* optionalEnv('AKUA_WORKSPACE')).map(
			(value) => `AKUA_WORKSPACE=${value} still overrides it until you unset it.`
		)
	];
	return {
		command: 'akua workspaces use',
		observations: lines,
		data: { ...workspace, source: 'config', config_path: path },
		human: lines,
		next_steps: [{ command: 'akua clusters list', description: 'List clusters in this workspace.' }]
	};
});

/**
 * `akua workspaces use` without a name: on a terminal, choose from a list
 * (like `vercel switch`); anywhere else, a usage error, because scripts and
 * agents cannot answer a prompt.
 */
const pickWorkspace = Effect.fnUntraced(function* (contract: ApiContract) {
	const console = yield* Console;
	const { mode } = yield* Invocation;
	if (mode !== 'human' || !console.stdinIsTTY || !console.stdoutIsTTY) {
		return yield* new UsageFailure({
			message: 'Name the workspace: akua workspaces use <name|id>. See akua workspaces list.'
		});
	}
	const workspaces = (yield* listWorkspaces(contract).pipe(
		Effect.catch(failWorkspaceLookup(contract))
	)).filter((workspace) => workspace.state === undefined || workspace.state === 'ACTIVE');
	const [only, ...others] = workspaces;
	if (only === undefined) {
		return yield* new UsageFailure({
			message: 'You have no workspaces yet. Create one with akua workspaces create --name <name>.'
		});
	}
	if (others.length === 0) return only;
	return yield* chooseWorkspace(workspaces).pipe(
		Effect.catchTag('QuitError', () =>
			Effect.fail(new UsageFailure({ message: 'No workspace chosen; nothing was saved.' }))
		)
	);
});

/** The terminal list; exported so it can be driven by a test terminal. */
export const chooseWorkspace = (workspaces: ReadonlyArray<Workspace>) =>
	Prompt.run(
		Prompt.Select({
			message: 'Choose the workspace for later commands',
			choices: workspaces.map((workspace) => ({
				title: workspace.name,
				...(workspace.slug === undefined || workspace.slug === workspace.name
					? {}
					: { description: workspace.slug }),
				value: workspace
			}))
		})
	);

const clearWorkspace: Effect.Effect<RenderEnvelope, CliFailure, SecureConfig> = Effect.gen(
	function* () {
		const path = yield* requiredConfigPath;
		const removed = yield* (yield* SecureConfig).removeWorkspace(path);
		const lines = [removed ? 'Saved workspace cleared.' : 'No workspace was saved.'];
		return {
			command: 'akua workspaces use --clear',
			observations: lines,
			human: lines,
			data: { cleared: removed, config_path: path }
		};
	}
);

const currentWorkspace = Effect.fnUntraced(function* (
	contract: ApiContract,
	flag: Option.Option<string>
): Effect.fn.Return<RenderEnvelope, CliFailure, SecureConfig | ApiClient> {
	const selection = yield* selectWorkspace(flag);
	if (Option.isNone(selection)) {
		return {
			command: 'akua workspaces current',
			observations: ['No workspace selected.'],
			data: { workspace: null },
			next_steps: [
				{ command: 'akua workspaces list', description: 'See your workspaces.' },
				{ command: 'akua workspaces use <name>', description: 'Choose one for later commands.' }
			]
		};
	}
	const { reference, source, name } = selection.value;
	const workspace = isWorkspaceId(reference)
		? { id: reference, ...(name === undefined ? {} : { name }) }
		: yield* findWorkspace(contract, reference).pipe(Effect.catch(failWorkspaceLookup(contract)));
	const lines = [
		workspace.name === undefined ? workspace.id : `${workspace.name} (${workspace.id})`,
		SOURCE_LABEL[source]
	];
	return {
		command: 'akua workspaces current',
		observations: lines,
		data: { ...workspace, source },
		human: lines
	};
});
