import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Option, Ref, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { Deployment } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/apps/v1/Deployment';
import { inventoryOf } from './applyset';
import {
	agentBundleSecret,
	type BundleUpdate,
	bundleStateSecret,
	updaterBundleSecret,
	writeReported
} from './bundle-state';
import { KubernetesExtras } from './kubernetes';
import { UpdaterRollout, updaterParentName } from './updater-rollout';
import { agentHarness } from './testing/agent-harness';
import {
	bundlePlacementId,
	bundleFiles,
	kubernetesWithBundleSecret,
	placeBundle,
	revisionV1,
	revisionV2,
	v1,
	v2
} from './testing/bundle';
import { answerEverything, FakeEngine, type FakeRequest } from './testing/fake-engine';
import { FakeKubernetes, objectKey } from './testing/fake-kubernetes';
import { testSettings } from './testing/settings';

type DeploymentObject = typeof Deployment.Type;

const updaterKey = objectKey({
	apiVersion: 'apps/v1',
	resource: 'deployments',
	namespace: 'akua-system',
	name: 'akua-agent-updater'
});

/** The updater Deployment as Helm installed it: release `v1`, rolled out. */
const liveUpdater = (release = v1): DeploymentObject => ({
	apiVersion: 'apps/v1',
	kind: 'Deployment',
	metadata: {
		name: 'akua-agent-updater',
		namespace: 'akua-system',
		generation: 1,
		labels: { 'app.kubernetes.io/component': 'updater' }
	},
	spec: {
		replicas: 1,
		selector: { matchLabels: { 'app.kubernetes.io/component': 'updater' } },
		template: {
			metadata: { labels: { 'app.kubernetes.io/component': 'updater' } },
			spec: {
				containers: [
					{
						name: 'updater',
						image: release.image,
						env: [{ name: 'AKUA_AGENT_VERSION', value: release.version }]
					}
				]
			}
		}
	},
	status: {
		observedGeneration: 1,
		replicas: 1,
		updatedReplicas: 1,
		readyReplicas: 1,
		availableReplicas: 1
	}
});

const encodeDeployment = Schema.encodeSync(Deployment);
const decodeDeployment = Schema.decodeUnknownOption(Deployment);

/** The agent, now running `v2`, beside an updater still at `v1`. */
const layer = UpdaterRollout.layer.pipe(
	Layer.provideMerge(
		agentHarness({
			settings: testSettings({ release: v2 }),
			kubernetes: kubernetesWithBundleSecret({
				objects: new Map([[updaterKey, encodeDeployment(liveUpdater())]])
			}),
			revisions: new Map([
				[revisionV1, bundleFiles(v1, { configMap: 'agent-v1' })],
				[revisionV2, bundleFiles(v2, { configMap: 'agent-v2' })]
			])
		})
	)
);

const updaterDeployment = Effect.gen(function* () {
	const kubernetes = yield* FakeKubernetes;
	const object = (yield* Ref.get(kubernetes.state)).objects.get(updaterKey);
	return Option.getOrNull(decodeDeployment(object));
});

const setUpdater = (update: (deployment: DeploymentObject) => DeploymentObject) =>
	Effect.gen(function* () {
		const kubernetes = yield* FakeKubernetes;
		const current = yield* updaterDeployment;
		if (current === null) return yield* Effect.die('no updater Deployment');
		yield* Ref.update(kubernetes.state, (state) => ({
			...state,
			objects: new Map([...state.objects, [updaterKey, encodeDeployment(update(current))]])
		}));
	});

/** Marks the updater Deployment's current generation rolled out and ready (`/readyz` passing). */
const settleUpdater = setUpdater((deployment) => ({
	...deployment,
	status: {
		observedGeneration: deployment.metadata?.generation ?? 1,
		replicas: 1,
		updatedReplicas: 1,
		readyReplicas: 1,
		availableReplicas: 1
	}
}));

/** An engine whose apply of the updater Deployment changes the live one, as a real apply would. */
const rollingUpdaterEngine = Effect.gen(function* () {
	const engine = yield* FakeEngine;
	const kubernetes = yield* FakeKubernetes;
	yield* engine.setBehavior((request, process) =>
		Effect.gen(function* () {
			if (request._tag === 'apply')
				for (const manifest of request.manifests) {
					const applied = decodeDeployment(manifest);
					if (Option.isNone(applied) || applied.value.metadata?.name !== 'akua-agent-updater')
						continue;
					const current = Option.getOrNull(
						decodeDeployment((yield* Ref.get(kubernetes.state)).objects.get(updaterKey))
					);
					const generation = (current?.metadata?.generation ?? 1) + 1;
					const next: DeploymentObject = {
						...applied.value,
						metadata: { ...applied.value.metadata, generation },
						status: { observedGeneration: generation, replicas: 1 }
					};
					yield* Ref.update(kubernetes.state, (state) => ({
						...state,
						objects: new Map([...state.objects, [updaterKey, encodeDeployment(next)]])
					}));
				}
			yield* answerEverything(request, process);
		})
	);
});

const updaterState = Effect.flatMap(
	KubernetesExtras,
	(extras) => bundleStateSecret(extras, agentBundleSecret).read
);
const agentState = Effect.flatMap(
	KubernetesExtras,
	(extras) => bundleStateSecret(extras, updaterBundleSecret).read
);

/** What the updater writes once it verified the agent's part of `release`. */
const updaterVerified = (release = v2) =>
	Effect.flatMap(KubernetesExtras, (extras) =>
		bundleStateSecret(extras, agentBundleSecret)
			.write({ current: { release, objects: [] } })
			.pipe(Effect.orDie)
	);

const inFlight: typeof BundleUpdate.Type = {
	from: v1,
	to: v2,
	startedAt: 0,
	deadline: 300_000,
	placementId: bundlePlacementId,
	generation: 2,
	revision: revisionV2,
	objects: [],
	planned: [],
	applied: [],
	created: [],
	appliedAt: null
};

const step = Effect.flatMap(UpdaterRollout, (rollout) => rollout.step(v2));

const applies = Effect.flatMap(FakeEngine, (engine) => engine.requests).pipe(
	Effect.map((requests) =>
		requests.filter(
			(request): request is Extract<FakeRequest, { readonly _tag: 'apply' }> =>
				request._tag === 'apply'
		)
	)
);
const prunes = Effect.flatMap(FakeEngine, (engine) => engine.requests).pipe(
	Effect.map((requests) =>
		requests.filter(
			(request): request is Extract<FakeRequest, { readonly _tag: 'prune' }> =>
				request._tag === 'prune'
		)
	)
);

const namesOf = (request: Extract<FakeRequest, { readonly _tag: 'apply' }> | undefined) =>
	(request?.manifests ?? []).map((manifest) => {
		const decoded = Schema.decodeUnknownOption(
			Schema.Struct({ kind: Schema.String, metadata: Schema.Struct({ name: Schema.String }) })
		)(manifest);
		return Option.isSome(decoded)
			? `${decoded.value.kind}/${decoded.value.metadata.name}`
			: 'unknown';
	});

const imageOfUpdater = Effect.map(
	updaterDeployment,
	(deployment) => deployment?.spec?.template.spec?.containers[0]?.image
);

const members = Effect.gen(function* () {
	const kubernetes = yield* FakeKubernetes;
	const parent = (yield* Ref.get(kubernetes.state)).secrets.get(`akua-system/${updaterParentName}`);
	return parent === undefined ? [] : (inventoryOf(parent) ?? []).map((entry) => entry.key);
});

/** The updater verified v2's agent part and is idle; v2's bundle is placed. */
const ready = Effect.gen(function* () {
	yield* rollingUpdaterEngine;
	yield* placeBundle(2, revisionV2, 2);
	yield* updaterVerified();
});

describe('UpdaterRollout', () => {
	it.effect('applies only the updater objects, gates the new updater and keeps them', () =>
		Effect.gen(function* () {
			yield* ready;
			assert.deepStrictEqual(yield* step, { _tag: 'updating', to: v2 });
			const [applied] = yield* applies;
			assert.deepStrictEqual(namesOf(applied), [
				'Deployment/akua-agent-updater',
				'ConfigMap/agent-v2-updater'
			]);
			assert.strictEqual(yield* imageOfUpdater, v2.image);
			// The agent's own record holds the update; the updater reads it and waits.
			assert.strictEqual((yield* agentState).update?.to.version, '1.1.0');
			// Not rolled out yet, then rolled out but the new updater has not reported.
			assert.strictEqual((yield* step)._tag, 'updating');
			yield* settleUpdater;
			assert.strictEqual((yield* step)._tag, 'verifying');
			// The new updater's channel is open and the platform answered its phase.
			yield* Effect.flatMap(KubernetesExtras, (extras) =>
				writeReported(extras, { version: v2.version, at: 1 })
			);
			assert.deepStrictEqual(yield* step, { _tag: 'verified', running: v2 });
			const state = yield* agentState;
			assert.strictEqual(state.current?.release.version, '1.1.0');
			assert.strictEqual(state.update, null);
			assert.deepStrictEqual([...(yield* members)].sort(), [
				'akua-system_agent-v2-updater__ConfigMap',
				'akua-system_akua-agent-updater_apps_Deployment'
			]);
			// Current: nothing more to do.
			assert.deepStrictEqual(yield* step, { _tag: 'idle' });
			assert.strictEqual((yield* applies).length, 1);
		}).pipe(Effect.provide(layer))
	);

	it.effect(
		'rolls back to the updater kept in the cluster when the new one never reports, and never retries it',
		() =>
			Effect.gen(function* () {
				yield* ready;
				yield* step;
				yield* settleUpdater;
				assert.strictEqual((yield* step)._tag, 'verifying');
				// Only an attestation of the old version: not the new updater.
				yield* Effect.flatMap(KubernetesExtras, (extras) =>
					writeReported(extras, { version: v1.version, at: 1 })
				);
				yield* TestClock.adjust('301 seconds');
				assert.deepStrictEqual(yield* step, {
					_tag: 'rolled-back',
					rejected: v2,
					reason: 'no-presence'
				});
				// The v1 updater again, from the live copy kept before the update.
				const all = yield* applies;
				assert.deepStrictEqual(namesOf(all.at(-1)), ['Deployment/akua-agent-updater']);
				assert.strictEqual(yield* imageOfUpdater, v1.image);
				const [prune] = yield* prunes;
				assert.deepStrictEqual(
					prune?.stale.map((entry) => entry.key),
					['akua-system_agent-v2-updater__ConfigMap']
				);
				const state = yield* agentState;
				assert.strictEqual(state.update, null);
				assert.strictEqual(state['rolled-back']?.rejected.version, '1.1.0');
				assert.deepStrictEqual(yield* step, { _tag: 'idle' });
				assert.strictEqual((yield* applies).length, all.length);
			}).pipe(Effect.provide(layer))
	);

	it.effect('starts nothing while the updater is busy or has not verified this release', () =>
		Effect.gen(function* () {
			yield* rollingUpdaterEngine;
			yield* placeBundle(2, revisionV2, 2);
			// The updater still runs its own update of the agent (the agent may be the new one).
			yield* Effect.flatMap(KubernetesExtras, (extras) =>
				bundleStateSecret(extras, agentBundleSecret)
					.write({ current: { release: v1, objects: [] }, update: inFlight })
					.pipe(Effect.orDie)
			);
			assert.deepStrictEqual(yield* step, { _tag: 'idle' });
			// Idle, but the last good agent part is v1, not the release this agent runs.
			yield* Effect.flatMap(KubernetesExtras, (extras) =>
				bundleStateSecret(extras, agentBundleSecret).write({ update: null }).pipe(Effect.orDie)
			);
			assert.deepStrictEqual(yield* step, { _tag: 'idle' });
			assert.strictEqual((yield* applies).length, 0);
			assert.strictEqual((yield* updaterState).current?.release.version, '1.0.0');
			// Verified at v2 and idle: now the agent updates the updater.
			yield* updaterVerified();
			assert.strictEqual((yield* step)._tag, 'updating');
		}).pipe(Effect.provide(layer))
	);
});
