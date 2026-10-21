import { describe, expect, it } from '@effect/vitest';
import { Clock, Effect, Layer, Stream } from 'effect';
import { TestClock } from 'effect/testing';

import { runCli } from '../src/runtime/effect-runtime';
import { Browser, Console, Http, Process, SecureConfig } from '../src/runtime/services';

describe('Effect CLI runtime', () => {
	it.effect('runs an Effect command through the central render boundary', () =>
		Effect.gen(function* () {
			const stdout: string[] = [];
			const exitCode = yield* Effect.provide(
				runCli(
					Effect.succeed({
						command: 'akua test',
						observations: ['Effect runtime active.'],
						data: { runtime: 'effect-v4' }
					}),
					{ mode: 'json' }
				),
				Layer.succeed(Console, {
					stdoutIsTTY: false,
					stdinIsTTY: false,
					writeStderr: () => Effect.void,
					writeStdout: (value) => Effect.sync(() => stdout.push(value))
				})
			);

			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout.join(''))).toMatchObject({
				status: 'ok',
				command: 'akua test',
				data: { runtime: 'effect-v4' }
			});
		})
	);

	it.effect('renders streaming command results incrementally', () =>
		Effect.gen(function* () {
			const stdout: string[] = [];
			const exitCode = yield* Effect.provide(
				runCli(
					Effect.succeed({
						command: 'akua installs get-logs',
						stream: Stream.make({ event: 'message', data: 'first' }, { event: 'end', data: '{}' })
					}),
					{ mode: 'json' }
				),
				Layer.succeed(Console, {
					stdoutIsTTY: false,
					stdinIsTTY: false,
					writeStderr: () => Effect.void,
					writeStdout: (value) => Effect.sync(() => stdout.push(value))
				})
			);

			expect(exitCode).toBe(0);
			expect(stdout.map((value) => JSON.parse(value))).toEqual([
				{
					status: 'ok',
					command: 'akua installs get-logs',
					data: { event: 'message', data: 'first' }
				},
				{
					status: 'ok',
					command: 'akua installs get-logs',
					data: { event: 'end', data: '{}' }
				}
			]);
		})
	);

	it.effect('uses service tags and TestClock layers without host dependencies', () =>
		Effect.gen(function* () {
			const services = Layer.mergeAll(
				Layer.succeed(Http, { postJson: () => Effect.die('not used') }),
				Layer.succeed(Browser, { launch: () => Effect.void }),
				Layer.succeed(Process, { awaitSignal: Effect.never }),
				Layer.succeed(Console, {
					stdoutIsTTY: false,
					stdinIsTTY: false,
					writeStderr: () => Effect.void,
					writeStdout: () => Effect.void
				}),
				Layer.succeed(SecureConfig, {
					readToken: () => Effect.succeed(undefined),
					saveToken: () => Effect.void,
					removeToken: () => Effect.succeed(false),
					readWorkspace: () => Effect.succeed(undefined),
					saveWorkspace: () => Effect.void,
					removeWorkspace: () => Effect.succeed(false)
				}),
				TestClock.layer()
			);
			const program = Effect.gen(function* () {
				yield* Http;
				yield* Browser;
				yield* Process;
				yield* Console;
				yield* SecureConfig;
				return yield* Clock.currentTimeMillis;
			});

			expect(yield* Effect.provide(program, services)).toBe(0);
		})
	);
});
