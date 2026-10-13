import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from 'effect';
import { ChildProcessSpawner } from 'effect/process';

export const cliTestLayer = Layer.mergeAll(
	FileSystem.layerNoop({}),
	Path.layer,
	Stdio.layerTest({}),
	Layer.succeed(
		Terminal.Terminal,
		Terminal.make({
			columns: Effect.succeed(80),
			rows: Effect.succeed(24),
			readInput: Effect.die('unused'),
			readLine: Effect.die('unused'),
			display: () => Effect.void
		})
	),
	Layer.succeed(
		ChildProcessSpawner.ChildProcessSpawner,
		ChildProcessSpawner.make(() => Effect.die('unused'))
	)
);
