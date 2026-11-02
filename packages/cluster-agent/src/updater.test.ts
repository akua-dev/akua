import { assert, describe, it } from '@effect/vitest';
import { Effect, Option, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import type { UpdaterInstruction } from '@platform/api-contract/services/cluster-agent';
import { AgentUpdater } from './contract';
import { agentUpdaterLayer, runningRelease, updaterAnnotations } from './updater';
import {
	agentDeploymentObject,
	FakeAgentDeployment,
	fakeAgentDeploymentLayer
} from './testing/fake-agent-deployment';
import { testImage } from './testing/settings';
import { Layer } from 'effect';

const v1 = { version: '1.0.0', image: testImage('1'), protocol: 1 };
const v2 = { version: '1.1.0', image: testImage('2'), protocol: 1 };

const instruction = (
	overrides: Partial<typeof UpdaterInstruction.Type> = {}
): typeof UpdaterInstruction.Type => ({
	desired: null,
	verify_seconds: 300,
	observed: null,
	...overrides
});

const layer = agentUpdaterLayer.pipe(
	Layer.provideMerge(
		fakeAgentDeploymentLayer(
			agentDeploymentObject(v1.image, { [updaterAnnotations.release]: JSON.stringify(v1) })
		)
	)
);

const imageNow = Effect.gen(function* () {
	const fake = yield* FakeAgentDeployment;
	const deployment = yield* Ref.get(fake.deployment);
	const container = deployment.spec?.template.spec?.containers[0];
	return {
		image: container?.image,
		env: container?.env?.find((entry) => entry.name === 'AKUA_AGENT_IMAGE')?.value
	};
});

const startUpdate = Effect.gen(function* () {
	const updater = yield* AgentUpdater;
	return yield* updater.step({ instruction: instruction({ desired: v2 }), running: v1 });
});

describe('AgentUpdater', () => {
	it.effect('stays steady when the platform offers nothing new', () =>
		Effect.gen(function* () {
			const updater = yield* AgentUpdater;
			const phase = yield* updater.step({ instruction: instruction({ desired: v1 }), running: v1 });
			assert.deepStrictEqual(phase, { _tag: 'steady', running: v1 });
			assert.strictEqual((yield* Ref.get((yield* FakeAgentDeployment).patches)).length, 0);
		}).pipe(Effect.provide(layer))
	);

	it.effect('patches only the agent image and its env mirror to start an update', () =>
		Effect.gen(function* () {
			const phase = yield* startUpdate;
			assert.strictEqual(phase._tag, 'updating');
			assert.deepStrictEqual(yield* imageNow, { image: v2.image, env: v2.image });
			const deployment = yield* Ref.get((yield* FakeAgentDeployment).deployment);
			assert.deepStrictEqual(runningRelease(deployment, 'unknown'), Option.some(v2));
		}).pipe(Effect.provide(layer))
	);

	it.effect(
		'verifies once rolled out, connected and with an accepted reconcile from the new release',
		() =>
			Effect.gen(function* () {
				const updater = yield* AgentUpdater;
				const fake = yield* FakeAgentDeployment;
				yield* startUpdate;
				const waiting = yield* updater.step({ instruction: instruction(), running: v2 });
				assert.strictEqual(waiting._tag, 'updating');
				yield* fake.settle;
				const verifying = yield* updater.step({
					instruction: instruction({
						observed: { version: v2.version, online_at: 10, accepted_at: null }
					}),
					running: v2
				});
				assert.strictEqual(verifying._tag, 'verifying');
				const verified = yield* updater.step({
					instruction: instruction({
						observed: { version: v2.version, online_at: 10, accepted_at: 20 }
					}),
					running: v2
				});
				assert.deepStrictEqual(verified, { _tag: 'steady', running: v2 });
				const deployment = yield* Ref.get(fake.deployment);
				assert.isUndefined(deployment.metadata?.annotations?.[updaterAnnotations.update]);
			}).pipe(Effect.provide(layer))
	);

	it.effect('rolls back with no-reconcile when the new release connects but never reconciles', () =>
		Effect.gen(function* () {
			const updater = yield* AgentUpdater;
			const fake = yield* FakeAgentDeployment;
			yield* startUpdate;
			yield* fake.settle;
			yield* TestClock.adjust('301 seconds');
			const phase = yield* updater.step({
				instruction: instruction({
					observed: { version: v2.version, online_at: 10, accepted_at: null }
				}),
				running: v2
			});
			assert.strictEqual(phase._tag, 'rolled-back');
			assert.strictEqual(phase._tag === 'rolled-back' ? phase.reason : '', 'no-reconcile');
			assert.deepStrictEqual(yield* imageNow, { image: v1.image, env: v1.image });
		}).pipe(Effect.provide(layer))
	);

	it.effect('rolls back with no-presence when the platform never saw the new release connect', () =>
		Effect.gen(function* () {
			const updater = yield* AgentUpdater;
			const fake = yield* FakeAgentDeployment;
			yield* startUpdate;
			yield* fake.settle;
			yield* TestClock.adjust('301 seconds');
			const phase = yield* updater.step({ instruction: instruction(), running: v2 });
			assert.strictEqual(phase._tag === 'rolled-back' ? phase.reason : '', 'no-presence');
		}).pipe(Effect.provide(layer))
	);

	it.effect('rolls back at once when the new image cannot be pulled', () =>
		Effect.gen(function* () {
			const updater = yield* AgentUpdater;
			const fake = yield* FakeAgentDeployment;
			yield* startUpdate;
			yield* Ref.set(fake.pods, {
				apiVersion: 'v1',
				kind: 'PodList',
				items: [
					{
						spec: { containers: [{ name: 'agent', image: v2.image }] },
						status: {
							containerStatuses: [
								{
									name: 'agent',
									image: v2.image,
									imageID: '',
									ready: false,
									restartCount: 0,
									state: { waiting: { reason: 'ImagePullBackOff' } }
								}
							]
						}
					}
				]
			});
			const phase = yield* updater.step({ instruction: instruction(), running: v2 });
			assert.strictEqual(phase._tag === 'rolled-back' ? phase.reason : '', 'image-unavailable');
			assert.deepStrictEqual(yield* imageNow, { image: v1.image, env: v1.image });
		}).pipe(Effect.provide(layer))
	);

	it.effect(
		'rolls back with rollout-failed when the rollout never completes before the deadline',
		() =>
			Effect.gen(function* () {
				const updater = yield* AgentUpdater;
				yield* startUpdate;
				yield* TestClock.adjust('301 seconds');
				const phase = yield* updater.step({ instruction: instruction(), running: v2 });
				assert.strictEqual(phase._tag === 'rolled-back' ? phase.reason : '', 'rollout-failed');
			}).pipe(Effect.provide(layer))
	);

	it.effect('does not retry a release it rolled back and keeps reporting rolled-back', () =>
		Effect.gen(function* () {
			const updater = yield* AgentUpdater;
			const fake = yield* FakeAgentDeployment;
			yield* startUpdate;
			yield* TestClock.adjust('301 seconds');
			yield* updater.step({ instruction: instruction(), running: v2 });
			yield* fake.settle;
			const patches = (yield* Ref.get(fake.patches)).length;
			const phase = yield* updater.step({ instruction: instruction({ desired: v2 }), running: v1 });
			assert.strictEqual(phase._tag, 'rolled-back');
			assert.strictEqual((yield* Ref.get(fake.patches)).length, patches);
		}).pipe(Effect.provide(layer))
	);

	it.effect('resumes an in-flight update from the Deployment after an updater restart', () =>
		Effect.gen(function* () {
			const fake = yield* FakeAgentDeployment;
			yield* startUpdate;
			yield* fake.settle;
			const deployment = yield* Ref.get(fake.deployment);
			// A new updater process over the same Deployment.
			const phase = yield* Effect.gen(function* () {
				const updater = yield* AgentUpdater;
				return yield* updater.step({ instruction: instruction(), running: v2 });
			}).pipe(
				Effect.provide(
					agentUpdaterLayer.pipe(Layer.provideMerge(fakeAgentDeploymentLayer(deployment)))
				)
			);
			assert.strictEqual(phase._tag, 'verifying');
			assert.strictEqual(phase._tag === 'verifying' ? phase.from.version : '', v1.version);
		}).pipe(Effect.provide(layer))
	);
});
