import { BunServices } from '@effect/platform-bun';
import { describe, expect, it } from '@effect/vitest';
import { type Cause, Effect, Layer, Option, Queue, Terminal } from 'effect';

import { chooseWorkspace } from '../src/cli/workspaces';
import { readConfigFile, runAkua, temporaryHome, writeConfigFile } from './fake-api';

const press = (name: string): Terminal.UserInput => ({
	input: Option.none(),
	key: { name, ctrl: false, meta: false, shift: false }
});

/** A terminal that types the given keys, then stays silent. */
const terminal = (keys: ReadonlyArray<Terminal.UserInput>) =>
	Layer.succeed(
		Terminal.Terminal,
		Terminal.make({
			columns: Effect.succeed(80),
			rows: Effect.succeed(24),
			readInput: Effect.gen(function* () {
				const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
				yield* Queue.offerAll(queue, keys);
				return queue;
			}),
			readLine: Effect.succeed(''),
			display: () => Effect.void
		})
	);

const team = { id: 'ws_team', name: 'My Team', slug: 'my-team' };
const other = { id: 'ws_other', name: 'Other', slug: 'other' };

describe('akua workspaces use without a name', () => {
	it.effect('lets a person choose from the list with the arrow keys', () =>
		Effect.gen(function* () {
			const chosen = yield* chooseWorkspace([team, other]);
			expect(chosen).toEqual(other);
		}).pipe(
			Effect.provide(Layer.merge(BunServices.layer, terminal([press('down'), press('return')])))
		)
	);

	it.effect('saves the only active workspace without asking', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: 'test-token' });

			const result = yield* runAkua(['workspaces', 'use'], {
				env: { HOME: home },
				tty: true,
				api: () => ({
					body: {
						data: [{ ...other, lifecycle: { state: 'DELETING' } }, team],
						has_more: false,
						next_cursor: null
					}
				})
			});

			expect(result.exitCode).toBe(0);
			expect((yield* readConfigFile(home)).workspace).toEqual({ id: 'ws_team', name: 'My Team' });
		}).pipe(Effect.scoped)
	);

	it.effect('asks scripts and agents for a name instead of prompting', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: 'test-token' });

			const result = yield* runAkua(['workspaces', 'use', '--json'], {
				env: { HOME: home },
				api: () => ({ body: { data: [team, other], has_more: false, next_cursor: null } })
			});

			expect(result.exitCode).toBe(2);
			expect(result.requests).toEqual([]);
			expect(JSON.parse(result.stdout).error.message).toBe(
				'Name the workspace: akua workspaces use <name|id>. See akua workspaces list.'
			);
		}).pipe(Effect.scoped)
	);
});
