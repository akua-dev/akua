import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { agentUpdaterLayer, updaterAnnotations, updaterLoop } from './updater';
import {
	agentDeploymentObject,
	FakeAgentDeployment,
	fakeAgentDeploymentLayer
} from './testing/fake-agent-deployment';
import { agentHarness } from './testing/agent-harness';
import { FakePlatform, fakePlatformState } from './testing/fake-platform';
import { testEnrollmentCode, testImage } from './testing/settings';
import { PlacementReconciler } from './contract';

const v1 = { version: '1.0.0', image: testImage('1'), protocol: 1 };
const v2 = { version: '1.1.0', image: testImage('2'), protocol: 1 };

const layer = agentUpdaterLayer.pipe(
	Layer.provideMerge(
		fakeAgentDeploymentLayer(
			agentDeploymentObject(v1.image, { [updaterAnnotations.release]: JSON.stringify(v1) })
		)
	),
	Layer.provideMerge(
		agentHarness({
			platform: fakePlatformState({
				enrollmentCode: testEnrollmentCode,
				instruction: {
					desired: v2,
					verify_seconds: 120,
					observed: null,
					next_heartbeat_seconds: 30
				}
			})
		})
	)
);

const image = Effect.gen(function* () {
	const deployment = yield* Ref.get((yield* FakeAgentDeployment).deployment);
	return deployment.spec?.template.spec?.containers[0]?.image;
});

describe('updaterLoop', () => {
	it.effect(
		'does not roll back a verifying release while the platform is unreachable, then verifies it',
		() =>
			Effect.gen(function* () {
				// The harness enrolls the agent, so the updater shares its identity.
				yield* PlacementReconciler;
				const platform = yield* FakePlatform;
				const fake = yield* FakeAgentDeployment;
				const loop = yield* Effect.forkChild(updaterLoop('1.0.0'));
				while ((yield* image) !== v2.image) yield* TestClock.adjust('1 second');
				yield* fake.settle;
				yield* Ref.update(platform.state, (state) => ({ ...state, updaterDown: true }));
				yield* TestClock.adjust('10 seconds');
				yield* TestClock.adjust('10 seconds');
				yield* TestClock.adjust('300 seconds');
				for (let tick = 0; tick < 20; tick += 1) yield* TestClock.adjust('10 seconds');
				assert.strictEqual(yield* image, v2.image, 'kept during the outage');
				yield* Ref.update(platform.state, (state) => ({
					...state,
					updaterDown: false,
					instruction: {
						...state.instruction,
						desired: null,
						observed: { version: v2.version, heartbeat_at: 1, accepted_at: 2 }
					}
				}));
				let phase = '';
				for (let tick = 0; tick < 20 && phase !== 'steady'; tick += 1) {
					yield* TestClock.adjust('10 seconds');
					const beats = (yield* Ref.get(platform.state)).updaterHeartbeats;
					phase = beats.at(-1)?.phase._tag ?? '';
				}
				assert.strictEqual(phase, 'steady');
				assert.strictEqual(yield* image, v2.image);
				yield* Fiber.interrupt(loop);
			}).pipe(Effect.provide(layer))
	);

	it.effect(
		'rolls back with no-heartbeat when the platform answers but never sees the new release',
		() =>
			Effect.gen(function* () {
				yield* PlacementReconciler;
				const platform = yield* FakePlatform;
				const fake = yield* FakeAgentDeployment;
				const loop = yield* Effect.forkChild(updaterLoop('1.0.0'));
				while ((yield* image) !== v2.image) yield* TestClock.adjust('1 second');
				yield* fake.settle;
				yield* Ref.update(platform.state, (state) => ({
					...state,
					instruction: { ...state.instruction, desired: null }
				}));
				for (let tick = 0; tick < 20 && (yield* image) !== v1.image; tick += 1)
					yield* TestClock.adjust('10 seconds');
				assert.strictEqual(yield* image, v1.image);
				const last = (yield* Ref.get(platform.state)).updaterHeartbeats.at(-1)?.phase;
				for (let tick = 0; tick < 5; tick += 1) yield* TestClock.adjust('30 seconds');
				const reported = (yield* Ref.get(platform.state)).updaterHeartbeats.at(-1)?.phase;
				assert.strictEqual(
					reported?._tag === 'rolled-back' ? reported.reason : last?._tag,
					'no-heartbeat'
				);
				yield* Fiber.interrupt(loop);
			}).pipe(Effect.provide(layer))
	);
});
