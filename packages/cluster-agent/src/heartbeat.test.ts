import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { AcceptedTracker } from './accepted';
import { heartbeatLoop, WatchedNamespaces } from './heartbeat';
import { agentHarness } from './testing/agent-harness';
import { fakeKubernetesState } from './testing/fake-kubernetes';
import { FakePlatform } from './testing/fake-platform';
import { testSettings } from './testing/settings';

describe('heartbeat', () => {
	it.effect(
		'reports release, cluster UID, distribution, granted access and the last accepted report',
		() =>
			Effect.gen(function* () {
				yield* (yield* WatchedNamespaces).set(['app', 'other']);
				yield* (yield* AcceptedTracker).markAccepted('report');
				const loop = yield* Effect.forkChild(heartbeatLoop);
				const platform = yield* FakePlatform;
				while ((yield* Ref.get(platform.state)).heartbeats.length === 0)
					yield* TestClock.adjust('10 millis');
				const [heartbeat] = (yield* Ref.get(platform.state)).heartbeats;
				assert.deepStrictEqual(heartbeat?.release, testSettings().release);
				assert.strictEqual(heartbeat?.cluster_uid, '6f1c1b0e-2f4b-4b7a-9d0e-0c6b1f2a3d4e');
				assert.strictEqual(heartbeat?.distribution, 'k0s');
				assert.strictEqual(heartbeat?.kubernetes_version, 'v1.34.1+k0s');
				assert.strictEqual(heartbeat?.last_accepted?.kind, 'report');
				assert.deepStrictEqual(heartbeat?.access.scope, {
					_tag: 'namespaces',
					namespaces: ['app']
				});
				assert.deepStrictEqual(
					heartbeat?.access.reviews.map((review) => review.namespace),
					[null, 'app', 'other']
				);
				yield* TestClock.adjust('30 seconds');
				assert.strictEqual((yield* Ref.get(platform.state)).heartbeats.length, 2);
				yield* Fiber.interrupt(loop);
			}).pipe(
				Effect.provide(
					agentHarness({
						kubernetes: fakeKubernetesState({
							allow: (attributes) => attributes.verb !== '*',
							rulesNamespaces: new Set(['app'])
						})
					})
				)
			)
	);
});
