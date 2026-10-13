import { BunServices } from '@effect/platform-bun';
import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { resolveBunBinary } from './bun-binary';

/**
 * Shared subprocess helper for tests that exercise the real `akua` CLI
 * entrypoint end to end. Genuine process-boundary glue: it spawns an OS
 * process and returns a Promise for the many plain (non-Effect) call sites in
 * cli.test.ts; test/ is not covered by the Effect-only rule for `src/` and
 * `scripts/` (see AGENTS.md).
 */
export interface RunAkuaResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export function runAkua(
	args: readonly string[],
	env: Record<string, string> = {}
): Promise<RunAkuaResult> {
	const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
	if (!('AKUA_OUTPUT' in env)) delete childEnv.AKUA_OUTPUT;
	if (!('AKUA_API_TOKEN' in env)) delete childEnv.AKUA_API_TOKEN;

	return Effect.runPromise(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const handle = yield* spawner.spawn(
				ChildProcess.make(resolveBunBinary(), ['src/bin/akua.ts', ...args], {
					env: childEnv,
					extendEnv: false,
					stdin: 'ignore'
				})
			);
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
					handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
					handle.exitCode
				],
				{ concurrency: 'unbounded' }
			);
			return { stdout, stderr, exitCode: Number(exitCode) };
		}).pipe(Effect.scoped, Effect.provide(BunServices.layer))
	);
}
