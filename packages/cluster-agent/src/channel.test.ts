import { assert, describe, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Queue, Ref, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import {
	AgentChannelFailure,
	AgentChannelRpcs,
	channelProtocol,
	ChannelCloseCode,
	type Hello
} from '@platform/api-contract/services/cluster-agent-channel';
import { ClusterUid } from '@platform/api-contract/services/cluster-agent';
import { type ChannelState, channelUrl, redialDelayMillis, runChannel } from './channel';
import {
	countingCredentials,
	defaultWelcome,
	type FakeConnection,
	FakeChannel,
	fakeChannelLayer
} from './testing/fake-channel';
import { testSettings } from './testing/settings';

const hello: Effect.Effect<Hello> = Effect.succeed({
	_tag: 'agent',
	protocol: channelProtocol,
	release: testSettings().release,
	cluster_uid: ClusterUid.make('6f1c1b0e-2f4b-4b7a-9d0e-0c6b1f2a3d4e'),
	serves: [...AgentChannelRpcs.requests.keys()],
	desired_revision: 3
});

/** Handlers that record what the platform asked. */
const recording = (calls: Queue.Queue<string>) =>
	AgentChannelRpcs.toLayer({
		'DesiredChanged.v1': ({ revision }) =>
			Queue.offer(calls, `desired:${revision}`).pipe(Effect.asVoid),
		'Subscribe.v1': ({ status }) =>
			Queue.offer(calls, `subscribe:${status.length}`).pipe(Effect.asVoid),
		'ListNodes.v1': () => Effect.succeed({ nodes: [], continue: null }),
		'GetNode.v1': ({ name }) =>
			Effect.fail(new AgentChannelFailure({ reason: 'not-found', message: name })),
		'DrainNode.v1': () => Effect.succeed({ outcome: 'drained' as const, evicted: 0, remaining: 0 }),
		'DeleteNode.v1': () => Effect.void,
		'GetAccess.v1': () =>
			Effect.succeed({
				scope: { _tag: 'cluster' as const },
				createNamespaces: true,
				reviews: [],
				observedAt: 0
			}),
		'TailLogs.v1': () =>
			Effect.fail(new AgentChannelFailure({ reason: 'not-managed', message: '' })),
		'Describe.v1': () =>
			Effect.fail(new AgentChannelFailure({ reason: 'not-managed', message: '' }))
	});

const start = Effect.gen(function* () {
	const calls = yield* Queue.unbounded<string>();
	const welcomes = yield* Queue.unbounded<number>();
	const state = yield* SubscriptionRef.make<ChannelState>({
		_tag: 'connecting',
		attempt: 0,
		since: 0
	});
	const fiber = yield* runChannel({
		role: 'agent',
		group: AgentChannelRpcs,
		handlers: recording(calls),
		hello,
		state,
		onWelcome: (welcome) => Queue.offer(welcomes, welcome.connection_id).pipe(Effect.asVoid)
	}).pipe(Effect.forkScoped);
	return { calls, welcomes, state, fiber };
});

const connection = (index: number) =>
	Effect.gen(function* () {
		const channel = yield* FakeChannel;
		while (true) {
			const found = (yield* Ref.get(channel.connections))[index];
			if (found !== undefined) return found satisfies FakeConnection;
			yield* TestClock.adjust('10 millis');
		}
	});

const harness = Layer.mergeAll(fakeChannelLayer, countingCredentials);

describe('channel', () => {
	it('dials the role on the platform origin over wss', () => {
		assert.strictEqual(
			channelUrl(new URL('https://api.akua.dev'), 'updater').href,
			'wss://api.akua.dev/v1/agent/connect?role=updater'
		);
		assert.strictEqual(channelUrl(new URL('http://localhost:8787'), 'agent').protocol, 'ws:');
	});

	it('backs off with full jitter up to a minute', () => {
		assert.strictEqual(redialDelayMillis(0, 1), 1000);
		assert.strictEqual(redialDelayMillis(3, 1), 8000);
		assert.strictEqual(redialDelayMillis(10, 1), 60_000);
		assert.strictEqual(redialDelayMillis(10, 0.5), 30_000);
	});

	it.effect('says hello with a fresh bearer and serves the platform on the same socket', () =>
		Effect.gen(function* () {
			const { calls, welcomes } = yield* start;
			const first = yield* connection(0);
			const said = yield* Deferred.await(first.hello);
			assert.strictEqual(said._tag, 'agent');
			assert.strictEqual(said._tag === 'agent' ? said.desired_revision : -1, 3);
			assert.strictEqual(first.bearer, 'bearer-1');
			assert.strictEqual(first.role, 'agent');
			assert.strictEqual(yield* Queue.take(welcomes), 1);
			yield* first.agent['DesiredChanged.v1']({ revision: 9 });
			assert.strictEqual(yield* Queue.take(calls), 'desired:9');
			const failure = yield* first.agent['GetNode.v1']({ name: 'gone' }).pipe(Effect.flip);
			assert.strictEqual(failure._tag === 'AgentChannelFailure' ? failure.reason : '', 'not-found');
		}).pipe(Effect.scoped, Effect.provide(harness))
	);

	it.effect('dials a replacement with a fresh assertion before the old one expires', () =>
		Effect.gen(function* () {
			const channel = yield* FakeChannel;
			yield* Ref.set(channel.welcome, defaultWelcome({ authenticated_until: 120_000 }));
			const { welcomes } = yield* start;
			assert.strictEqual(yield* Queue.take(welcomes), 1);
			yield* TestClock.adjust('61 seconds');
			const second = yield* connection(1);
			assert.strictEqual(second.bearer, 'bearer-2');
			assert.strictEqual(yield* Queue.take(welcomes), 2);
			const first = yield* connection(0);
			// The agent drops the replaced connection itself once the new one is welcomed.
			yield* Deferred.await(first.closedByAgent);
		}).pipe(Effect.scoped, Effect.provide(harness))
	);

	it.effect('stops for good when the platform closes 4403', () =>
		Effect.gen(function* () {
			const channel = yield* FakeChannel;
			const { state, welcomes } = yield* start;
			yield* Queue.take(welcomes);
			yield* (yield* connection(0)).close(ChannelCloseCode.revoked);
			while ((yield* SubscriptionRef.get(state))._tag !== 'stopped')
				yield* TestClock.adjust('100 millis');
			yield* TestClock.adjust('10 minutes');
			assert.strictEqual(yield* Ref.get(channel.dials), 1);
		}).pipe(Effect.scoped, Effect.provide(harness))
	);

	it.effect('redials with backoff after a dropped socket and after refused upgrades', () =>
		Effect.gen(function* () {
			const channel = yield* FakeChannel;
			yield* Ref.set(channel.refuse, 2);
			const { welcomes, fiber } = yield* start;
			yield* TestClock.adjust('2 minutes');
			assert.strictEqual(yield* Queue.take(welcomes), 1);
			assert.strictEqual(yield* Ref.get(channel.dials), 3);
			yield* (yield* connection(0)).close(1006);
			yield* TestClock.adjust('2 minutes');
			assert.strictEqual(yield* Queue.take(welcomes), 2);
			assert.strictEqual(yield* Ref.get(channel.dials), 4);
			yield* Fiber.interrupt(fiber);
		}).pipe(Effect.scoped, Effect.provide(harness))
	);
});
