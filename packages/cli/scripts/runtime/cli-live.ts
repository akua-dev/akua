import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from 'effect';
import { CliConfig, GlobalFlag } from 'effect/cli';
import { ChildProcessSpawner } from 'effect/process';

import { ScriptEnvironment } from './services';

export const ScriptCliLive = Layer.mergeAll(
	CliConfig.layer({ builtIns: [GlobalFlag.Help] }),
	FileSystem.layerNoop({}),
	Path.layer,
	Stdio.layerTest({
		args: Effect.sync(() => process.argv.slice(2)),
		stdinIsTerminal: Effect.sync(() => process.stdin.isTTY === true),
		stdoutIsTerminal: Effect.sync(() => process.stdout.isTTY === true)
	}),
	Layer.succeed(
		Terminal.Terminal,
		Terminal.make({
			columns: Effect.succeed(process.stdout.columns ?? 80),
			rows: Effect.succeed(process.stdout.rows ?? 24),
			readInput: Effect.die('Interactive terminal input is unavailable'),
			readLine: Effect.die('Interactive terminal input is unavailable'),
			display: () => Effect.void
		})
	),
	Layer.succeed(
		ChildProcessSpawner.ChildProcessSpawner,
		ChildProcessSpawner.make(() => Effect.die('Child processes are unavailable'))
	),
	Layer.succeed(ScriptEnvironment, {
		openApiUrl: Effect.sync(() => process.env.AKUA_OPENAPI_URL)
	})
);
