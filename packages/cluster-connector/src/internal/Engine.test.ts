import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Option, Stream, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { ApplySetId, Engine, engineSupervision } from '../ClusterConnector';
import { engineLayer, EngineStatus, nextRestart } from './Engine';
import { answerEverything, FakeEngine, fakeEngineLayer } from '../testing/FakeEngine';

const applySetId = ApplySetId.make('applyset-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-v1');

const layer = engineLayer({
	path: '/usr/local/bin/akua-apply',
	userAgent: 'akua-cluster-agent/1.0.0'
}).pipe(Layer.provideMerge(fakeEngineLayer({ version: '1.0.0' })));

const waitUntil = <A>(ref: SubscriptionRef.SubscriptionRef<A>, predicate: (value: A) => boolean) =>
	SubscriptionRef.changes(ref).pipe(
		Stream.filter(predicate),
		Stream.runHead,
		Effect.map(Option.getOrThrow)
	);

const apply = Effect.gen(function* () {
	const engine = yield* Engine;
	return yield* engine.apply({
		applySetId,
		manifests: [
			{
				apiVersion: 'v1',
				kind: 'ConfigMap',
				metadata: {
					name: 'a',
					namespace: 'app',
					labels: { 'applyset.kubernetes.io/part-of': applySetId }
				}
			}
		],
		revisionChanged: true,
		forceSelector: {},
		exclusionSelector: {},
		timeoutSeconds: 30
	});
});

describe('nextRestart', () => {
	it('restarts a first exit after one second without marking a crash loop', () => {
		assert.deepStrictEqual(
			nextRestart({ previousDelaySeconds: 8, lastRestartAt: null, exitedAt: 0 }),
			{
				delaySeconds: engineSupervision.firstRestartSeconds,
				crashLooping: false
			}
		);
	});
	it('doubles the delay up to the maximum for an exit inside the window', () => {
		assert.deepStrictEqual(
			nextRestart({ previousDelaySeconds: 1, lastRestartAt: 0, exitedAt: 1000 }),
			{
				delaySeconds: 2,
				crashLooping: true
			}
		);
		assert.strictEqual(
			nextRestart({ previousDelaySeconds: 60, lastRestartAt: 0, exitedAt: 1000 }).delaySeconds,
			engineSupervision.maxRestartSeconds
		);
	});
	it('treats an exit after a full window as a first exit again', () => {
		const exitedAt = engineSupervision.crashLoopWindowSeconds * 1000 + 1;
		assert.isFalse(
			nextRestart({ previousDelaySeconds: 32, lastRestartAt: 0, exitedAt }).crashLooping
		);
	});
});

describe('Engine', () => {
	it.effect('spawns serve with the user agent and correlates responses by id', () =>
		Effect.gen(function* () {
			const applied = yield* apply;
			assert.strictEqual(applied._tag, 'applied');
			assert.deepStrictEqual(
				applied.changes.map((change) => change.key),
				['app_a__ConfigMap']
			);
			const fake = yield* FakeEngine;
			const process = yield* fake.current;
			assert.deepStrictEqual(
				process?.command._tag === 'StandardCommand' ? process.command.args : [],
				['serve', '--user-agent', 'akua-cluster-agent/1.0.0']
			);
			const requests = yield* fake.requests;
			assert.strictEqual(requests[0]?._tag, 'apply');
			assert.strictEqual(
				requests[0]?._tag === 'apply' ? requests[0].impersonate : '',
				'system:serviceaccount:akua-system:akua-apply'
			);
		}).pipe(Effect.provide(layer))
	);

	it.effect('fails in-flight requests with restarted and recovers after the restart delay', () =>
		Effect.gen(function* () {
			const fake = yield* FakeEngine;
			const status = yield* EngineStatus;
			yield* waitUntil(status.state, (state) => state.phase === 'ready');
			yield* fake.setBehavior((_request, process) => process.exit(2));
			const failed = yield* apply.pipe(Effect.flip);
			assert.strictEqual(failed._tag, 'EngineFailed');
			assert.strictEqual(failed._tag === 'EngineFailed' ? failed.reason : '', 'restarted');
			assert.strictEqual(failed._tag === 'EngineFailed' ? failed.exitCode : null, 2);

			yield* fake.setBehavior(answerEverything);
			const retried = yield* Effect.forkChild(apply);
			yield* TestClock.adjust('1 second');
			const applied = yield* Fiber.join(retried);
			assert.strictEqual(applied._tag, 'applied');
			assert.strictEqual(yield* fake.spawns, 2);
			assert.isFalse((yield* SubscriptionRef.get(status.state)).crashLooping);
		}).pipe(Effect.provide(layer))
	);

	it.effect('marks a crash loop for an exit within the window and backs off exponentially', () =>
		Effect.gen(function* () {
			const fake = yield* FakeEngine;
			const status = yield* EngineStatus;
			yield* waitUntil(status.state, (state) => state.phase === 'ready');
			const first = yield* fake.current;
			if (first !== null) yield* first.exit(1);
			yield* waitUntil(status.state, (state) => state.phase === 'backoff');
			yield* TestClock.adjust('1 second');
			yield* waitUntil(status.state, (state) => state.phase === 'ready' && state.restarts === 1);
			const second = yield* fake.current;
			if (second !== null) yield* second.exit(1);
			const looping = yield* waitUntil(
				status.state,
				(state) => state.phase === 'backoff' && state.restarts === 2
			);
			assert.isTrue(looping.crashLooping);
			yield* TestClock.adjust('1 second');
			assert.strictEqual(yield* fake.spawns, 2);
			yield* TestClock.adjust('1 second');
			yield* waitUntil(status.state, (state) => state.phase === 'ready' && state.restarts === 2);
			assert.strictEqual(yield* fake.spawns, 3);
			yield* TestClock.adjust(`${engineSupervision.crashLoopWindowSeconds} seconds`);
			yield* waitUntil(status.state, (state) => !state.crashLooping);
		}).pipe(Effect.provide(layer))
	);

	it.effect('kills a hung engine after the request timeout plus grace and fails with timeout', () =>
		Effect.gen(function* () {
			const fake = yield* FakeEngine;
			const status = yield* EngineStatus;
			yield* waitUntil(status.state, (state) => state.phase === 'ready');
			yield* fake.setBehavior(() => Effect.void);
			const fiber = yield* Effect.forkChild(apply.pipe(Effect.flip));
			yield* TestClock.adjust('60 seconds');
			const failed = yield* Fiber.join(fiber);
			assert.strictEqual(failed._tag === 'EngineFailed' ? failed.reason : '', 'timeout');
			yield* waitUntil(status.state, (state) => state.phase === 'backoff');
		}).pipe(Effect.provide(layer))
	);

	it.effect('re-sends the last subscription after the engine restarts', () =>
		Effect.gen(function* () {
			const engine = yield* Engine;
			const fake = yield* FakeEngine;
			const status = yield* EngineStatus;
			yield* engine.subscribe({ placements: [] });
			const first = yield* fake.current;
			if (first !== null) yield* first.exit(1);
			yield* waitUntil(status.state, (state) => state.phase === 'backoff');
			yield* TestClock.adjust('1 second');
			yield* waitUntil(status.state, (state) => state.phase === 'ready' && state.restarts === 1);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;
			const subscribes = (yield* fake.requests).filter((request) => request._tag === 'subscribe');
			assert.strictEqual(subscribes.length, 2);
		}).pipe(Effect.provide(layer))
	);

	it.effect('fails only the request whose response line is undecodable', () =>
		Effect.gen(function* () {
			const fake = yield* FakeEngine;
			yield* fake.setBehavior((request, process) =>
				process.emit({ _tag: 'applied', id: request.id })
			);
			const failed = yield* apply.pipe(Effect.flip);
			assert.strictEqual(failed._tag === 'EngineFailed' ? failed.reason : '', 'decode');
			yield* fake.setBehavior(answerEverything);
			assert.strictEqual((yield* apply)._tag, 'applied');
			assert.strictEqual(yield* fake.spawns, 1);
		}).pipe(Effect.provide(layer))
	);

	it.effect('surfaces a rejected request as EngineRejected', () =>
		Effect.gen(function* () {
			const fake = yield* FakeEngine;
			yield* fake.setBehavior((request, process) =>
				process.emit({
					_tag: 'rejected',
					id: request.id,
					failure: { stage: 'decode', reason: 'invalid', object: null, message: 'bad' }
				})
			);
			const rejected = yield* apply.pipe(Effect.flip);
			assert.strictEqual(rejected._tag, 'EngineRejected');
		}).pipe(Effect.provide(layer))
	);
});
