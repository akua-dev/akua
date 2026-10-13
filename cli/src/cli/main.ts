import { BunServices } from '@effect/platform-bun';
import { Console as EffectConsole, Effect, Layer, Option, Ref, Result } from 'effect';
import { CliConfig, CliError, CliOutput, Command, GlobalFlag } from 'effect/cli';

import { ApiClient } from '../api/client';
import type { ApiContract } from '../api/contract';
import { contract } from '../generated/contract.gen';
import { runCli, UsageFailure } from '../runtime/effect-runtime';
import { packageCommandError } from '../runtime/errors';
import { detectOutputMode, type OutputMode } from '../runtime/mode';
import { renderSuccess } from '../runtime/render';
import { Console, type CliServices, PackageCli } from '../runtime/services';
import { authCommand } from './auth';
import { resourceCommands } from './api-commands';
import { discoveryCommand } from './discovery';
import { Invocation } from './invocation';
import { akua } from './root';
import { workspaceContextCommands } from './workspaces';

/** The complete `akua` command tree, built from the generated API contract. */
export function akuaCommand(api: ApiContract) {
	return akua.pipe(
		Command.withSubcommands([
			authCommand,
			discoveryCommand(api),
			Command.make('pkg').pipe(
				Command.withDescription('Build, render, publish, and inspect Packages (akua pkg --help)')
			),
			...resourceCommands(api, { workspaces: workspaceContextCommands(api) })
		])
	);
}

/**
 * Runs one `akua` invocation and returns its exit code. Every mode parses
 * with the same effect/cli command tree; only rendering differs. effect/cli's
 * own output (help, version, completions) is captured so usage errors render
 * as one structured document in agent and JSON modes.
 */
export const runAkua = Effect.fn('runAkua')(function* (
	argv: readonly string[],
	version: string
): Effect.fn.Return<number, never, CliServices> {
	const console = yield* Console;
	const detected = yield* Effect.result(
		detectOutputMode({ argv, stdoutIsTTY: console.stdoutIsTTY })
	);
	if (Result.isFailure(detected)) {
		return yield* runCli(Effect.fail(detected.failure), { mode: fallbackMode(argv) });
	}
	const mode = detected.success;
	const packageArgs = withoutOutputFlags(argv);
	if (packageArgs[0] === 'pkg') return yield* runPackageCommand(packageArgs, mode);

	const exitCode = yield* Ref.make(0);
	const helpPath = yield* Ref.make(Option.none<ReadonlyArray<string>>());
	const captured = capturingConsole();
	const outcome = yield* Command.runWith(akuaCommand(contract), {
		version,
		renderErrors: false
	})(argv).pipe(
		Effect.provideService(EffectConsole.Console, captured.console),
		Effect.provide(
			Layer.mergeAll(
				Layer.succeed(Invocation, { mode, exitCode }),
				ApiClient.layer,
				CliConfig.layer({
					builtIns: [recordingHelp(helpPath), GlobalFlag.Version, GlobalFlag.Completions]
				}),
				CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
				BunServices.layer
			)
		),
		Effect.result
	);

	if (Result.isSuccess(outcome)) {
		// Only built-ins (help, version, completions) print through effect/cli on success.
		const text = captured.text();
		if (text !== '') {
			const help = yield* Ref.get(helpPath);
			yield* console.writeStdout(
				Option.isSome(help)
					? builtInOutput(commandName(help.value), text, { help: text }, mode)
					: argv.includes('--version') || argv.includes('-v')
						? builtInOutput('akua --version', text, { version }, mode)
						: builtInOutput('akua --completions', text, { script: text }, mode)
			);
		}
		return yield* Ref.get(exitCode);
	}
	const failure = outcome.failure;
	if (failure._tag === 'ShowHelp' && failure.errors.length === 0) {
		const text = captured.text();
		yield* console.writeStdout(
			builtInOutput(commandName(failure.commandPath), text, { help: text }, mode)
		);
		return 0;
	}
	return yield* runCli(Effect.fail(usageFailure(failure)), { mode });
});

/**
 * Help, version, and completion text from effect/cli. JSON mode wraps it so
 * `--json` output always parses; other modes print it as is.
 */
/** effect/cli's `--help`, also noting which command's help it printed. */
function recordingHelp(path: Ref.Ref<Option.Option<ReadonlyArray<string>>>) {
	return GlobalFlag.Action({
		flag: GlobalFlag.Help.flag,
		run: (value, context) =>
			GlobalFlag.Help.run(value, context).pipe(
				Effect.andThen(Ref.set(path, Option.some(context.commandPath)))
			)
	});
}

function builtInOutput(command: string, text: string, data: unknown, mode: OutputMode): string {
	return mode === 'json' ? renderSuccess({ command, data }, mode) : text;
}

const commandName = (path: ReadonlyArray<string>) => ['akua', ...path.slice(1)].join(' ');

function usageFailure(failure: CliError.CliError): UsageFailure {
	if (failure._tag !== 'ShowHelp') return new UsageFailure({ message: failure.message });
	const command = commandName(failure.commandPath);
	return new UsageFailure({
		// A rejected value or stray positional is often a pasted secret, so none is echoed back.
		message: failure.errors
			.map((error) => {
				if (error._tag === 'InvalidValue') {
					return error.message.replace(`: "${error.value}"`, '');
				}
				if (error._tag === 'UnexpectedArgument') return `Unexpected argument for ${command}.`;
				if (error._tag === 'UnknownSubcommand') {
					return error.suggestions.length === 0
						? `Unknown command for ${command}.`
						: `Unknown command for ${command}. Did you mean ${error.suggestions.join(' or ')}?`;
				}
				return error.message;
			})
			.join('\n'),
		help: `${command} --help`
	});
}

/** `akua pkg` hands its arguments to the akuapkg executable unchanged. */
const runPackageCommand = Effect.fnUntraced(function* (argv: readonly string[], mode: OutputMode) {
	const pkg = yield* PackageCli;
	const args = argv.length === 1 ? ['--help'] : argv.slice(1);
	return yield* pkg
		.execute(mode === 'agent' || mode === 'json' ? [...args, '--json'] : args)
		.pipe(
			Effect.catchTag('PackageCliFailure', () =>
				runCli(Effect.fail(packageCommandError()), { mode })
			)
		);
});

/** The output flags the mode was read from, removed so `akua --json pkg ...` reaches the toolchain. */
function withoutOutputFlags(argv: readonly string[]): string[] {
	const rest: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index] ?? '';
		if (value === '--json' || value === '--quiet' || value === '-q') continue;
		if (value === '--output' || value === '-o') {
			index += 1;
			continue;
		}
		if (value.startsWith('--output=') || value.startsWith('-o=')) continue;
		rest.push(value);
	}
	return rest;
}

function fallbackMode(argv: readonly string[]): OutputMode {
	if (argv.includes('--json')) return 'json';
	if (argv.includes('--quiet') || argv.includes('-q')) return 'quiet';
	return 'human';
}

/** An effect Console that collects what effect/cli prints until the run decides how to show it. */
function capturingConsole(): {
	readonly console: EffectConsole.Console;
	readonly text: () => string;
} {
	const lines: string[] = [];
	const write = (...args: ReadonlyArray<unknown>) => {
		lines.push(args.map(String).join(' '));
	};
	const ignore = () => {};
	return {
		console: {
			assert: ignore,
			clear: ignore,
			count: ignore,
			countReset: ignore,
			debug: write,
			dir: write,
			dirxml: write,
			error: write,
			group: ignore,
			groupCollapsed: ignore,
			groupEnd: ignore,
			info: write,
			log: write,
			table: write,
			time: ignore,
			timeEnd: ignore,
			timeLog: ignore,
			trace: write,
			warn: write
		},
		text: () => (lines.length === 0 ? '' : `${lines.join('\n')}\n`)
	};
}
