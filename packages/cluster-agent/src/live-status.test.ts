import { assert, describe, it } from '@effect/vitest';
import { Effect, Option, Ref, Stream, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import type { ResourceNode, StatusBatch } from '@platform/api-contract/services/cluster-agent';
import { EngineStatus } from './engine';
import { aggregateStatus, healthOf, LiveStatus } from './live-status';
import { FakeEngine } from './testing/fake-engine';
import { FakePlatform, placementId } from './testing/fake-platform';
import { agentHarness } from './testing/agent-harness';
import { advanceUntil } from './testing/advance-until';

const placement = placementId('live1');

const node = (
	key: string,
	overrides: Partial<typeof ResourceNode.Type> = {}
): typeof ResourceNode.Type => ({
	key,
	uid: `uid-${key}`,
	version: 'v1',
	member: true,
	parents: [],
	status: 'Current',
	message: '',
	reasons: [],
	containers: [],
	scheduling: null,
	observedAt: 1,
	...overrides
});

const emit = (line: unknown) =>
	Effect.gen(function* () {
		const process = yield* (yield* FakeEngine).current;
		if (process !== null) yield* process.emit(line);
		yield* Effect.yieldNow;
	});

const batches = Effect.gen(function* () {
	return (yield* Ref.get((yield* FakePlatform).state)).statusBatches;
});

const entries = (all: ReadonlyArray<typeof StatusBatch.Type>) =>
	all.flatMap((batch) => batch.entries);

const ready = Effect.gen(function* () {
	const status = yield* EngineStatus;
	yield* SubscriptionRef.changes(status.state).pipe(
		Stream.filter((state) => state.phase === 'ready'),
		Stream.runHead
	);
	const live = yield* LiveStatus;
	yield* live.watch([{ placementId: placement, generation: 3 }]);
	yield* live.subscribe([placement]);
});

const flush = TestClock.adjust('2100 millis').pipe(Effect.andThen(Effect.yieldNow));

/** Advances time until the posted entries satisfy `done`; scheduling order may vary between hosts. */
const until = (
	done: (all: ReadonlyArray<(typeof StatusBatch.Type)['entries'][number]>) => boolean
) =>
	advanceUntil(
		Effect.map(batches, (all) => done(entries(all))),
		'500 millis'
	);

describe('health', () => {
	it('aggregates member kstatus the way Flux does', () => {
		assert.strictEqual(aggregateStatus([]), 'Current');
		assert.strictEqual(aggregateStatus(['Current', 'InProgress']), 'InProgress');
		assert.strictEqual(aggregateStatus(['InProgress', 'Unknown']), 'Unknown');
		assert.strictEqual(aggregateStatus(['Unknown', 'Failed']), 'Failed');
		assert.strictEqual(aggregateStatus(['NotFound']), 'InProgress');
	});

	it('counts pods, ready pods and restarts and orders reasons by severity', () => {
		const health = healthOf([
			node('app_web_apps_Deployment', {
				status: 'InProgress',
				reasons: ['ProgressDeadlineExceeded']
			}),
			node('app_web-1__Pod', {
				member: false,
				reasons: ['Other', 'CrashLoopBackOff'],
				containers: [
					{
						name: 'web',
						init: false,
						ready: false,
						restartCount: 4,
						state: { _tag: 'waiting', reason: 'CrashLoopBackOff', message: '' },
						lastTermination: null
					}
				]
			})
		]);
		assert.deepStrictEqual(health, {
			status: 'InProgress',
			reasons: ['CrashLoopBackOff', 'ProgressDeadlineExceeded', 'Other'],
			restarts: 4,
			readyPods: 0,
			pods: 1
		});
	});
});

describe('LiveStatus', () => {
	it.effect(
		'sends nothing for an unsubscribed Placement and a snapshot once it is subscribed',
		() =>
			Effect.gen(function* () {
				yield* ready;
				const live = yield* LiveStatus;
				yield* live.subscribe([]);
				yield* emit({ _tag: 'node', placementId: placement, node: node('app_a__ConfigMap') });
				yield* emit({ _tag: 'synced', placementId: placement });
				yield* flush;
				yield* flush;
				assert.strictEqual((yield* batches).length, 0, 'nothing while nobody subscribed');
				assert.strictEqual(
					(yield* live.treeNode(placement, 'app_a__ConfigMap'))?.uid,
					'uid-app_a__ConfigMap',
					'the tree is still known for reads'
				);
				yield* live.subscribe([placement]);
				yield* until((all) => all.length >= 1);
				const [snapshot] = entries(yield* batches);
				assert.strictEqual(snapshot?._tag, 'snapshot');
			}).pipe(Effect.provide(agentHarness()))
	);

	it.effect(
		'sends a snapshot once the Placement synced, then deltas with increasing sequence',
		() =>
			Effect.gen(function* () {
				yield* ready;
				yield* emit({ _tag: 'node', placementId: placement, node: node('app_a__ConfigMap') });
				yield* flush;
				assert.strictEqual((yield* batches).length, 0, 'nothing before synced');
				yield* emit({ _tag: 'synced', placementId: placement });
				yield* until((all) => all.length >= 1);
				const [snapshot] = entries(yield* batches);
				assert.strictEqual(snapshot?._tag, 'snapshot');
				if (snapshot?._tag !== 'snapshot') return;
				assert.strictEqual(snapshot.snapshot.generation, 3);
				assert.deepStrictEqual(
					snapshot.snapshot.tree.map((entry) => entry.key),
					['app_a__ConfigMap']
				);
				yield* emit({ _tag: 'node', placementId: placement, node: node('app_b__ConfigMap') });
				yield* emit({ _tag: 'removed', placementId: placement, key: 'app_a__ConfigMap' });
				yield* until((all) => all.length >= 2);
				const delta = entries(yield* batches)[1];
				assert.strictEqual(delta?._tag, 'delta');
				if (delta?._tag !== 'delta') return;
				assert.strictEqual(delta.delta.sequence, snapshot.snapshot.sequence + 1);
				assert.deepStrictEqual(
					delta.delta.upserted.map((entry) => entry.key),
					['app_b__ConfigMap']
				);
				assert.deepStrictEqual(delta.delta.removed, ['app_a__ConfigMap']);
			}).pipe(Effect.provide(agentHarness()))
	);

	it.effect('replaces deltas of a lost batch with a snapshot', () =>
		Effect.gen(function* () {
			yield* ready;
			yield* emit({ _tag: 'synced', placementId: placement });
			yield* until((all) => all.length >= 1);
			const platform = yield* FakePlatform;
			yield* Ref.update(platform.state, (state) => ({
				...state,
				failing: new Set(['status' as const])
			}));
			yield* emit({ _tag: 'node', placementId: placement, node: node('app_b__ConfigMap') });
			yield* until((all) => all.length >= 2);
			const all = entries(yield* batches);
			assert.deepStrictEqual(
				all.map((entry) => entry._tag),
				['snapshot', 'snapshot']
			);
		}).pipe(Effect.provide(agentHarness()))
	);

	it.effect('answers snapshot_required with a snapshot', () =>
		Effect.gen(function* () {
			yield* ready;
			yield* emit({ _tag: 'synced', placementId: placement });
			const platform = yield* FakePlatform;
			yield* Ref.update(platform.state, (state) => ({ ...state, snapshotRequired: [placement] }));
			yield* until((all) => all.length >= 2);
			assert.deepStrictEqual(
				entries(yield* batches).map((entry) => entry._tag),
				['snapshot', 'snapshot']
			);
		}).pipe(Effect.provide(agentHarness()))
	);

	it.effect('marks engine-no-snapshot when a restarted engine does not sync within 10 s', () =>
		Effect.gen(function* () {
			yield* ready;
			yield* emit({ _tag: 'synced', placementId: placement });
			yield* until((all) => all.length >= 1);
			yield* emit({
				_tag: 'ready',
				protocol: 1,
				version: '1.0.0',
				ssa: 'v0.83.0',
				cliUtils: 'v1.4.0'
			});
			yield* until((all) => all.some((entry) => entry._tag === 'stale'));
			const stale = entries(yield* batches).find((entry) => entry._tag === 'stale');
			assert.strictEqual(stale?._tag === 'stale' ? stale.stale.reason : '', 'engine-no-snapshot');
			yield* emit({ _tag: 'synced', placementId: placement });
			yield* until((all) => all.at(-1)?._tag === 'snapshot');
		}).pipe(Effect.provide(agentHarness()))
	);

	it.effect('marks engine-crash-looping for every watched Placement', () =>
		Effect.gen(function* () {
			yield* ready;
			const fake = yield* FakeEngine;
			const status = yield* EngineStatus;
			const exitCurrent = Effect.gen(function* () {
				const process = yield* fake.current;
				if (process !== null) yield* process.exit(1);
			});
			yield* exitCurrent;
			yield* SubscriptionRef.changes(status.state).pipe(
				Stream.filter((s) => s.phase === 'backoff'),
				Stream.runHead
			);
			yield* TestClock.adjust('1 second');
			yield* SubscriptionRef.changes(status.state).pipe(
				Stream.filter((s) => s.phase === 'ready'),
				Stream.runHead
			);
			yield* exitCurrent;
			const looping = yield* SubscriptionRef.changes(status.state).pipe(
				Stream.filter((s) => s.crashLooping),
				Stream.runHead
			);
			assert.isTrue(Option.isSome(looping));
			yield* until((all) => all.some((entry) => entry._tag === 'stale'));
			const stale = entries(yield* batches).find((entry) => entry._tag === 'stale');
			assert.strictEqual(stale?._tag === 'stale' ? stale.stale.reason : '', 'engine-crash-looping');
		}).pipe(Effect.provide(agentHarness()))
	);
});
