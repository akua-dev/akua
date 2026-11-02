import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Ref, Schema, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { agentUpdaterLayer, updaterAnnotations, UpdaterInstructions, updaterLoop } from './updater';
import { ConnectionId } from '@platform/api-contract/services/cluster-agent-channel';
import type { UpdaterInstruction } from '@platform/api-contract/services/cluster-agent';
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
	Layer.provideMerge(UpdaterInstructions.layer),
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
					observed: null
				}
			})
		})
	)
);

const image = Effect.gen(function* () {
	const deployment = yield* Ref.get((yield* FakeAgentDeployment).deployment);
	return deployment.spec?.template.spec?.containers[0]?.image;
});

/** The updater's own channel connection as open or down. */
const channel = (open: boolean) =>
	Effect.gen(function* () {
		const { channel } = yield* UpdaterInstructions;
		yield* SubscriptionRef.set(
			channel,
			open
				? { _tag: 'open', connectionId: Schema.decodeSync(ConnectionId)(1), protocol: 1, since: 0 }
				: { _tag: 'connecting', attempt: 1, since: 0 }
		);
	});

/** What Cluster pushes on the channel (`Instruct.v1`). */
const push = (instruction: typeof UpdaterInstruction.Type) =>
	UpdaterInstructions.use(({ latest }) => SubscriptionRef.set(latest, instruction));

const phases = Effect.gen(function* () {
	return (yield* Ref.get((yield* FakePlatform).state)).updaterPhases.map((report) => report.phase);
});

describe('updaterLoop', () => {
	it.effect(
		'reports its phase on change, keeps a verifying release while its channel is down, then verifies it from a push',
		() =>
			Effect.gen(function* () {
				// The harness enrolls the agent, so the updater shares its identity.
				yield* PlacementReconciler;
				yield* channel(true);
				const fake = yield* FakeAgentDeployment;
				const loop = yield* Effect.forkChild(updaterLoop('1.0.0'));
				while ((yield* image) !== v2.image) yield* TestClock.adjust('1 second');
				yield* fake.settle;
				yield* channel(false);
				for (let tick = 0; tick < 40; tick += 1) yield* TestClock.adjust('10 seconds');
				assert.strictEqual(yield* image, v2.image, 'kept while observations are unknown');
				yield* channel(true);
				yield* push({
					desired: null,
					verify_seconds: 120,
					observed: { version: v2.version, online_at: 1, accepted_at: 2 }
				});
				let phase = '';
				for (let tick = 0; tick < 20 && phase !== 'steady'; tick += 1) {
					yield* TestClock.adjust('10 seconds');
					phase = (yield* phases).at(-1)?._tag ?? '';
				}
				assert.strictEqual(phase, 'steady');
				assert.strictEqual(yield* image, v2.image);
				// One report per phase change, not one per tick.
				const tags = (yield* phases).map((reported) => reported._tag);
				assert.deepStrictEqual(
					tags.filter((tag, index) => tag !== tags[index - 1]),
					tags
				);
				yield* Fiber.interrupt(loop);
			}).pipe(Effect.provide(layer))
	);

	it.effect('rolls back with no-presence when no push ever shows the new release', () =>
		Effect.gen(function* () {
			yield* PlacementReconciler;
			yield* channel(true);
			const fake = yield* FakeAgentDeployment;
			const loop = yield* Effect.forkChild(updaterLoop('1.0.0'));
			while ((yield* image) !== v2.image) yield* TestClock.adjust('1 second');
			yield* fake.settle;
			yield* push({
				desired: null,
				verify_seconds: 120,
				observed: null
			});
			for (let tick = 0; tick < 20 && (yield* image) !== v1.image; tick += 1)
				yield* TestClock.adjust('10 seconds');
			assert.strictEqual(yield* image, v1.image);
			for (let tick = 0; tick < 5; tick += 1) yield* TestClock.adjust('10 seconds');
			const reported = (yield* phases).at(-1);
			assert.strictEqual(reported?._tag === 'rolled-back' ? reported.reason : '', 'no-presence');
			yield* Fiber.interrupt(loop);
		}).pipe(Effect.provide(layer))
	);
});
