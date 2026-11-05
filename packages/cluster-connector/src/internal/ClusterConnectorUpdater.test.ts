import { assert, describe, it } from '@effect/vitest';
import { Effect, Option, Ref, Result, Schema } from 'effect';
import { Base64 } from 'effect/encoding';
import { TestClock } from 'effect/testing';
import {
	ClusterConnectorImage,
	type UpdaterInstruction
} from '@platform/api-contract/services/ClusterConnector';
import { applySetParentName, inventoryOf } from './ApplySet';
import { ClusterConnectorUpdater } from '../ClusterConnector';
import {
	clusterConnectorBundleSecret as bundleSecret,
	type BundleState,
	bundleStateSecret,
	updaterBundleSecret
} from './BundleState';
import { KubernetesExtras } from './Kubernetes';
import { releaseOfBundle, sameContent } from './BundleApply';
import { FakeClusterConnectorDeployment } from '../testing/FakeClusterConnectorDeployment';
import { FakeEngine, type FakeRequest } from '../testing/FakeEngine';
import { FakeKubernetes } from '../testing/FakeKubernetes';
import { FakePlatform } from '../testing/FakePlatform';
import {
	bundlePlacementId,
	kubernetesWithBundleSecret,
	placeBundle,
	revisionV1,
	revisionV2,
	revisionV3,
	rollingEngine,
	updaterHarness,
	v1,
	v2,
	v3
} from '../testing/BundleFixture';

const instruction = (
	overrides: Partial<typeof UpdaterInstruction.Type> = {}
): typeof UpdaterInstruction.Type => ({
	desired: null,
	verify_seconds: 300,
	observed: null,
	...overrides
});

/** A step of the updater, which runs `v1` (the agent applies its part later). */
const step = (overrides: Partial<typeof UpdaterInstruction.Type> = {}, running = v1) =>
	Effect.flatMap(ClusterConnectorUpdater, (updater) =>
		updater.step({
			instruction: instruction(overrides),
			running,
			version: v1.version,
			observations: 'known'
		})
	);

/** One key of the updater's state Secret, read as the updater reads it (gzip-compressed JSON). */
const stateField = <K extends keyof BundleState>(key: K) =>
	Effect.flatMap(KubernetesExtras, (extras) => bundleStateSecret(extras, bundleSecret).read).pipe(
		Effect.map((state) => state[key])
	);

const members = Effect.gen(function* () {
	const kubernetes = yield* FakeKubernetes;
	const parent = (yield* Ref.get(kubernetes.state)).secrets.get(
		`akua-system/${applySetParentName(bundlePlacementId)}`
	);
	return parent === undefined ? [] : (inventoryOf(parent) ?? []).map((entry) => entry.key);
});

const requestsOf = <Tag extends FakeRequest['_tag']>(tag: Tag) =>
	Effect.flatMap(FakeEngine, (engine) => engine.requests).pipe(
		Effect.map((requests) =>
			requests.filter(
				(request): request is Extract<FakeRequest, { readonly _tag: Tag }> => request._tag === tag
			)
		)
	);

const appliedNames = (request: Extract<FakeRequest, { readonly _tag: 'apply' }> | undefined) =>
	(request?.manifests ?? []).map((manifest) => {
		const metadata = Schema.decodeUnknownOption(
			Schema.Struct({ kind: Schema.String, metadata: Schema.Struct({ name: Schema.String }) })
		)(manifest);
		return Option.isSome(metadata)
			? `${metadata.value.kind}/${metadata.value.metadata.name}`
			: 'unknown';
	});

const reports = Effect.gen(function* () {
	return (yield* Ref.get((yield* FakePlatform).state)).reports
		.filter((entry) => entry.placementId === bundlePlacementId)
		.map((entry) => entry.report.outcome._tag);
});

/** Adopts v1's bundle, then offers v2's: the common start of an update. */
const startUpdate = Effect.gen(function* () {
	yield* rollingEngine;
	yield* placeBundle(1, revisionV1, 1);
	yield* step();
	yield* placeBundle(2, revisionV2, 2);
	return yield* step({ desired: v2 });
});

describe('ClusterConnectorUpdater', () => {
	it.effect(
		'adopts the bundle of the running release as the last good one, without its own objects',
		() =>
			Effect.gen(function* () {
				yield* rollingEngine;
				yield* placeBundle(1, revisionV1, 1);
				const phase = yield* step();
				assert.deepStrictEqual(phase, { _tag: 'steady', running: v1 });
				const [applied] = yield* requestsOf('apply');
				assert.deepStrictEqual(appliedNames(applied), [
					'Deployment/akua-agent',
					'ClusterRole/akua-agent',
					'ConfigMap/agent-v1'
				]);
				assert.strictEqual((yield* stateField('current'))?.release.version, '1.0.0');
				assert.deepStrictEqual([...(yield* members)].sort(), [
					'_akua-agent_rbac.authorization.k8s.io_ClusterRole',
					'akua-system_agent-v1__ConfigMap',
					'akua-system_akua-agent_apps_Deployment'
				]);
				assert.deepStrictEqual(yield* reports, ['ready']);
			}).pipe(Effect.provide(updaterHarness()))
	);

	it.effect('stays steady while the offered release has no bundle yet', () =>
		Effect.gen(function* () {
			yield* rollingEngine;
			yield* placeBundle(1, revisionV1, 1);
			yield* step();
			const phase = yield* step({ desired: v2 });
			assert.deepStrictEqual(phase, { _tag: 'steady', running: v1 });
			assert.strictEqual((yield* requestsOf('apply')).length, 1);
		}).pipe(Effect.provide(updaterHarness()))
	);

	it.effect('takes no release from a registry other than its own image came from', () => {
		const elsewhere = {
			...v2,
			image: ClusterConnectorImage.make(
				`registry.example/akua/cluster-agent@sha256:${'2'.repeat(64)}`
			)
		};
		return Effect.gen(function* () {
			yield* rollingEngine;
			yield* placeBundle(1, revisionV1, 1);
			yield* step();
			yield* placeBundle(2, revisionV2, 2);
			const phase = yield* step({ desired: elsewhere });
			assert.deepStrictEqual(phase, { _tag: 'steady', running: v1 });
			assert.strictEqual((yield* requestsOf('apply')).length, 1);
		}).pipe(Effect.provide(updaterHarness({ v2Release: elsewhere })));
	});

	it.effect('applies the new bundle, gates it and keeps it once verified', () =>
		Effect.gen(function* () {
			const fake = yield* FakeClusterConnectorDeployment;
			const started = yield* startUpdate;
			assert.strictEqual(started._tag, 'updating');
			assert.strictEqual((yield* stateField('update'))?.to.version, '1.1.0');
			assert.strictEqual(
				(yield* Ref.get(fake.deployment)).spec?.template.spec?.containers[0]?.image,
				v2.image
			);
			assert.strictEqual((yield* step({}, v2))._tag, 'updating');
			yield* fake.settle;
			const verifying = yield* step({}, v2);
			assert.strictEqual(verifying._tag, 'verifying');
			const verified = yield* step(
				{ observed: { version: v2.version, online_at: 1, accepted_at: 2 } },
				v2
			);
			assert.deepStrictEqual(verified, { _tag: 'steady', running: v2 });
			// The updater reads its bundle without acknowledging the agent's desired revision.
			assert.strictEqual((yield* Ref.get((yield* FakePlatform).state)).desiredFetches, 0);
			// What only v1 had is pruned once v2 is verified.
			const [prune] = yield* requestsOf('prune');
			assert.deepStrictEqual(
				prune?.stale.map((entry) => entry.key),
				['akua-system_agent-v1__ConfigMap']
			);
			assert.strictEqual((yield* stateField('current'))?.release.version, '1.1.0');
			assert.strictEqual(yield* stateField('update'), null);
			assert.isFalse((yield* members).includes('akua-system_agent-v1__ConfigMap'));
			assert.deepStrictEqual(yield* reports, ['ready', 'ready']);
		}).pipe(Effect.provide(updaterHarness()))
	);

	it.effect(
		'rolls back to the kept bundle, prunes what the new one created and never offers it again',
		() =>
			Effect.gen(function* () {
				const fake = yield* FakeClusterConnectorDeployment;
				yield* startUpdate;
				yield* fake.settle;
				assert.strictEqual((yield* step({}, v2))._tag, 'verifying');
				yield* TestClock.adjust('301 seconds');
				const rolledBack = yield* step({}, v2);
				assert.strictEqual(rolledBack._tag, 'rolled-back');
				assert.strictEqual(
					rolledBack._tag === 'rolled-back' ? rolledBack.reason : '',
					'no-presence'
				);
				// v1's objects again, from the copy in the cluster.
				const applies = yield* requestsOf('apply');
				assert.deepStrictEqual(appliedNames(applies.at(-1)), [
					'Deployment/akua-agent',
					'ClusterRole/akua-agent',
					'ConfigMap/agent-v1'
				]);
				assert.strictEqual(
					(yield* Ref.get(fake.deployment)).spec?.template.spec?.containers[0]?.image,
					v1.image
				);
				const [prune] = yield* requestsOf('prune');
				assert.deepStrictEqual(
					prune?.stale.map((entry) => entry.key),
					['akua-system_agent-v2__ConfigMap']
				);
				assert.isFalse((yield* members).includes('akua-system_agent-v2__ConfigMap'));
				assert.strictEqual((yield* stateField('rolled-back'))?.rejected.version, '1.1.0');
				assert.strictEqual((yield* stateField('current'))?.release.version, '1.0.0');
				assert.deepStrictEqual(yield* reports, ['ready', 'failed']);
				// The rejected release is not applied again.
				const again = yield* step({ desired: v2 });
				assert.strictEqual(again._tag, 'rolled-back');
				assert.strictEqual((yield* requestsOf('apply')).length, applies.length);
			}).pipe(Effect.provide(updaterHarness()))
	);

	it.effect('rolls back at once when the new image cannot be pulled', () =>
		Effect.gen(function* () {
			const fake = yield* FakeClusterConnectorDeployment;
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
			const phase = yield* step({}, v2);
			assert.strictEqual(phase._tag === 'rolled-back' ? phase.reason : '', 'image-unavailable');
		}).pipe(Effect.provide(updaterHarness()))
	);

	it.effect(
		'keeps the live objects as the last good bundle when none was kept yet, and rolls back to them',
		() =>
			Effect.gen(function* () {
				const fake = yield* FakeClusterConnectorDeployment;
				const kubernetes = yield* FakeKubernetes;
				yield* rollingEngine;
				const live = yield* Ref.get(fake.deployment);
				yield* Ref.update(kubernetes.state, (state) => ({
					...state,
					objects: new Map([
						[
							'apps/v1|deployments|akua-system|akua-agent',
							Schema.decodeUnknownSync(Schema.JsonObject)(live)
						]
					])
				}));
				yield* placeBundle(2, revisionV2, 2);
				assert.strictEqual((yield* step({ desired: v2 }))._tag, 'updating');
				const kept = yield* stateField('current');
				assert.strictEqual(kept?.release.version, '1.0.0');
				assert.strictEqual(kept?.objects.length, 1);
				assert.isFalse(JSON.stringify(kept?.objects).includes('status'));
				yield* TestClock.adjust('301 seconds');
				assert.strictEqual((yield* step({}, v2))._tag, 'rolled-back');
				assert.deepStrictEqual(appliedNames((yield* requestsOf('apply')).at(-1)), [
					'Deployment/akua-agent'
				]);
				// The objects v2 created (all of them here) go; the live Deployment stays.
				const [prune] = yield* requestsOf('prune');
				assert.deepStrictEqual([...(prune?.stale ?? [])].map((entry) => entry.key).sort(), [
					'_akua-agent_rbac.authorization.k8s.io_ClusterRole',
					'akua-system_agent-v2__ConfigMap'
				]);
			}).pipe(Effect.provide(updaterHarness()))
	);

	it.effect(
		'reports needs-customer-upgrade when the bundle changes what the grant does not cover',
		() =>
			Effect.gen(function* () {
				yield* rollingEngine;
				const platform = yield* FakePlatform;
				yield* placeBundle(1, revisionV1, 1);
				// Adoption leaves what the grant does not cover as the customer's install made it.
				assert.strictEqual((yield* step())._tag, 'steady');
				assert.deepStrictEqual(appliedNames((yield* requestsOf('apply'))[0]), [
					'Deployment/akua-agent',
					'ConfigMap/agent-v1'
				]);
				yield* placeBundle(2, revisionV2, 2);
				const phase = yield* step({ desired: v2 });
				assert.strictEqual(phase._tag, 'needs-customer-upgrade');
				if (phase._tag !== 'needs-customer-upgrade') return;
				assert.deepStrictEqual(
					phase.missing.map((review) => review.spec.resourceAttributes?.verb),
					['get', 'create', 'patch']
				);
				assert.isTrue(
					phase.missing.every(
						(review) => review.spec.resourceAttributes?.resource === 'clusterroles'
					)
				);
				assert.strictEqual((yield* requestsOf('apply')).length, 1, 'nothing applied');
				assert.strictEqual(yield* stateField('update'), null);
				const last = (yield* Ref.get(platform.state)).reports.at(-1)?.report.outcome;
				assert.strictEqual(last?._tag, 'access-denied');
			}).pipe(
				Effect.provide(
					updaterHarness({
						kubernetes: kubernetesWithBundleSecret({
							allow: (attributes) => attributes.resource !== 'clusterroles'
						}),
						v2NodeVerbs: ['get', 'list', 'watch', 'patch']
					})
				)
			)
	);

	it.effect('updates without the customer when objects outside the grant only change labels', () =>
		Effect.gen(function* () {
			yield* rollingEngine;
			yield* placeBundle(1, revisionV1, 1);
			yield* step();
			yield* placeBundle(2, revisionV2, 2);
			const phase = yield* step({ desired: v2 });
			assert.strictEqual(phase._tag, 'updating');
			assert.deepStrictEqual(appliedNames((yield* requestsOf('apply')).at(-1)), [
				'Deployment/akua-agent',
				'ConfigMap/agent-v2'
			]);
		}).pipe(
			Effect.provide(
				updaterHarness({
					kubernetes: kubernetesWithBundleSecret({
						allow: (attributes) => attributes.resource !== 'clusterroles'
					})
				})
			)
		)
	);

	it.effect(
		'starts no agent update while the agent applies the updater, nor as an updater the agent rejected',
		() =>
			Effect.gen(function* () {
				yield* rollingEngine;
				yield* placeBundle(1, revisionV1, 1);
				yield* step();
				yield* placeBundle(2, revisionV2, 2);
				const agentState = Effect.map(KubernetesExtras, (extras) =>
					bundleStateSecret(extras, updaterBundleSecret)
				);
				// The agent's record of its apply of the updater's own objects, in flight.
				yield* Effect.flatMap(agentState, (state) =>
					state
						.write({
							update: {
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
							}
						})
						.pipe(Effect.orDie)
				);
				assert.deepStrictEqual(yield* step({ desired: v2 }), { _tag: 'steady', running: v1 });
				assert.deepStrictEqual(
					yield* Effect.flatMap(ClusterConnectorUpdater, (u) => u.agentApply),
					{
						inFlight: true,
						rejected: null
					}
				);
				// The agent rejected this updater's own release: it is being replaced, it starts nothing.
				yield* Effect.flatMap(agentState, (state) =>
					state
						.write({ update: null, 'rolled-back': { rejected: v1, reason: 'no-presence', at: 1 } })
						.pipe(Effect.orDie)
				);
				assert.deepStrictEqual(yield* step({ desired: v2 }), { _tag: 'steady', running: v1 });
				assert.strictEqual((yield* requestsOf('apply')).length, 1);
				// Done and not about this updater: the update starts.
				yield* Effect.flatMap(agentState, (state) =>
					state.write({ 'rolled-back': null }).pipe(Effect.orDie)
				);
				assert.strictEqual((yield* step({ desired: v2 }))._tag, 'updating');
			}).pipe(Effect.provide(updaterHarness()))
	);

	it.effect('keeps its state gzip-compressed', () =>
		Effect.gen(function* () {
			yield* rollingEngine;
			yield* placeBundle(1, revisionV1, 1);
			yield* step();
			const kubernetes = yield* FakeKubernetes;
			const raw = (yield* Ref.get(kubernetes.state)).secrets.get(`akua-system/${bundleSecret}`)
				?.data?.current;
			const bytes = Base64.decode(raw ?? '');
			assert.isTrue(Result.isSuccess(bytes));
			// The gzip member header (RFC 1952).
			assert.deepStrictEqual(
				Result.isSuccess(bytes) ? [...bytes.success.subarray(0, 2)] : [],
				[0x1f, 0x8b]
			);
		}).pipe(Effect.provide(updaterHarness()))
	);

	it.effect(
		'refuses a bundle whose rollback state would not fit below the Secret limit, applying nothing',
		() =>
			Effect.gen(function* () {
				yield* rollingEngine;
				yield* placeBundle(1, revisionV1, 1);
				yield* step();
				yield* placeBundle(2, revisionV3, 2);
				const refused = yield* step({ desired: v3 });
				assert.deepStrictEqual(refused, {
					_tag: 'rolled-back',
					running: v1,
					rejected: v3,
					reason: 'bundle-too-large',
					at: 0
				});
				// Only the adoption applied anything; the cluster still runs v1 from its kept bundle.
				assert.strictEqual((yield* requestsOf('apply')).length, 1);
				assert.strictEqual(yield* stateField('update'), null);
				assert.strictEqual((yield* stateField('current'))?.release.version, '1.0.0');
				assert.strictEqual((yield* stateField('rolled-back'))?.reason, 'bundle-too-large');
				assert.deepStrictEqual(yield* reports, ['ready', 'failed']);
				// Rejected here: never tried again.
				assert.strictEqual((yield* step({ desired: v3 }))._tag, 'rolled-back');
				assert.strictEqual((yield* requestsOf('apply')).length, 1);
			}).pipe(Effect.provide(updaterHarness({ v3Padding: 1_500_000 })))
	);
});

describe('bundle content', () => {
	it('reads the release from the agent Deployment and compares without labels', () => {
		const deployment = (image: string) => ({
			kind: 'Deployment',
			metadata: { name: 'akua-agent', annotations: { 'akua.dev/release': JSON.stringify(v2) } },
			spec: { template: { spec: { containers: [{ name: 'agent', image }] } } }
		});
		assert.deepStrictEqual(releaseOfBundle([{ kind: 'ConfigMap' }, deployment(v2.image)]), v2);
		// A release whose agent container runs another image could never pass the gate.
		assert.isNull(releaseOfBundle([deployment(v1.image)]));
		assert.isTrue(
			sameContent(
				{ kind: 'ClusterRole', metadata: { name: 'a', labels: { v: '1' } }, rules: [] },
				{ rules: [], metadata: { labels: { v: '2' }, name: 'a' }, kind: 'ClusterRole' }
			)
		);
		assert.isFalse(
			sameContent(
				{ kind: 'ClusterRole', metadata: { name: 'a' }, rules: [] },
				{ kind: 'ClusterRole', metadata: { name: 'a' }, rules: [{ verbs: ['get'] }] }
			)
		);
	});
});
