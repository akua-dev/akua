import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Ref, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { applySetLabels, PlacementReconciler } from '../ClusterConnector';
import { applySetParentName, inventoryOf } from './ApplySet';
import {
	DesiredRevision,
	DesiredSignal,
	desiredStateLoop,
	ReservedNames
} from './PlacementReconciler';
import { answerEverything, FakeEngine } from '../testing/FakeEngine';
import { FakeKubernetes, fakeKubernetesState } from '../testing/FakeKubernetes';
import { emptyDesiredState, FakePlatform, placementId } from '../testing/FakePlatform';
import {
	clusterConnectorHarness,
	configMap,
	desiredPlacement,
	file,
	revisionA,
	revisionB
} from '../testing/ClusterConnectorHarness';

const revisions = new Map([
	[
		revisionA,
		[
			file('app.yaml', `${configMap('a')}---\n${configMap('shared')}`),
			file('README.md', 'not a manifest')
		]
	],
	[revisionB, [file('app.yaml', configMap('b') + '---\n' + configMap('shared'))]]
]);

const parentKey = `app/${applySetParentName(desiredPlacement().placement_id)}`;

const parentInventory = Effect.gen(function* () {
	const kubernetes = yield* FakeKubernetes;
	const parent = (yield* Ref.get(kubernetes.state)).secrets.get(parentKey);
	return parent === undefined ? null : (inventoryOf(parent) ?? []).map((entry) => entry.key);
});

describe('PlacementReconciler', () => {
	it.effect('applies a revision as ApplySet members, waits for health and reports ready', () =>
		Effect.gen(function* () {
			const reconciler = yield* PlacementReconciler;
			const report = yield* reconciler.reconcile({ desired: desiredPlacement() });
			assert.strictEqual(report.outcome._tag, 'ready');
			assert.strictEqual(report.outcome._tag === 'ready' ? report.outcome.health : '', 'healthy');
			assert.deepStrictEqual(yield* parentInventory, ['app_a__ConfigMap', 'app_shared__ConfigMap']);

			const requests = yield* (yield* FakeEngine).requests;
			const apply = requests.find((request) => request._tag === 'apply');
			assert.isDefined(apply);
			if (apply?._tag !== 'apply') return;
			const [first] = apply.manifests;
			const metadata = first?.metadata;
			assert.deepStrictEqual(metadata, {
				name: 'a',
				namespace: 'app',
				labels: { [applySetLabels.partOf]: apply.applySetId }
			});
			assert.isTrue(apply.revisionChanged);
			assert.deepStrictEqual(
				requests.map((request) => request._tag),
				// The shrunk inventory equals the widened one, so no second subscribe.
				['apply', 'subscribe', 'wait']
			);
		}).pipe(Effect.provide(clusterConnectorHarness({ revisions })))
	);

	it.effect('prunes members the next revision dropped and shrinks the parent', () =>
		Effect.gen(function* () {
			const reconciler = yield* PlacementReconciler;
			yield* reconciler.reconcile({ desired: desiredPlacement() });
			const report = yield* reconciler.reconcile({
				desired: desiredPlacement({
					generation: 2,
					source: { ...desiredPlacement().source, revision: revisionB }
				})
			});
			assert.strictEqual(report.outcome._tag, 'ready');
			const prune = (yield* (yield* FakeEngine).requests).find(
				(request) => request._tag === 'prune'
			);
			assert.deepStrictEqual(prune?._tag === 'prune' ? prune.stale.map((entry) => entry.key) : [], [
				'app_a__ConfigMap'
			]);
			assert.deepStrictEqual(yield* parentInventory, ['app_b__ConfigMap', 'app_shared__ConfigMap']);
			const subscribes = (yield* (yield* FakeEngine).requests).filter(
				(request) => request._tag === 'subscribe'
			);
			assert.deepStrictEqual(
				subscribes.at(-1)?._tag === 'subscribe'
					? subscribes.at(-1)?.placements[0]?.inventory.map((entry) => entry.key)
					: [],
				['app_b__ConfigMap', 'app_shared__ConfigMap']
			);
		}).pipe(Effect.provide(clusterConnectorHarness({ revisions })))
	);

	it.effect(
		'never prunes an object the revision still renders, even if the engine did not list it',
		() =>
			Effect.gen(function* () {
				const reconciler = yield* PlacementReconciler;
				yield* reconciler.reconcile({ desired: desiredPlacement() });
				const engine = yield* FakeEngine;
				yield* engine.setBehavior((request, process) =>
					request._tag === 'apply'
						? process.emit({
								_tag: 'applied',
								id: request.id,
								changes: [{ key: 'app_b__ConfigMap', version: 'v1', action: 'created' }],
								driftCorrected: [],
								failure: null
							})
						: answerEverything(request, process)
				);
				yield* reconciler.reconcile({
					desired: desiredPlacement({
						generation: 2,
						source: { ...desiredPlacement().source, revision: revisionB }
					})
				});
				const prune = (yield* engine.requests).find((request) => request._tag === 'prune');
				assert.deepStrictEqual(
					prune?._tag === 'prune' ? prune.stale.map((entry) => entry.key) : [],
					['app_a__ConfigMap']
				);
				assert.deepStrictEqual(yield* parentInventory, [
					'app_b__ConfigMap',
					'app_shared__ConfigMap'
				]);
			}).pipe(Effect.provide(clusterConnectorHarness({ revisions })))
	);

	it.effect('keeps the parent while removed members are still terminating', () =>
		Effect.gen(function* () {
			const reconciler = yield* PlacementReconciler;
			yield* reconciler.reconcile({ desired: desiredPlacement() });
			const engine = yield* FakeEngine;
			yield* engine.setBehavior((request, process) =>
				request._tag === 'wait'
					? process.emit({
							_tag: 'waited',
							id: request.id,
							health: [],
							failure: {
								stage: 'health',
								reason: 'timeout',
								object: null,
								message: 'finalizer pending'
							}
						})
					: answerEverything(request, process)
			);
			const report = yield* reconciler.reconcile({
				desired: desiredPlacement({ generation: 2, presence: 'absent' })
			});
			assert.strictEqual(report.outcome._tag, 'progressing');
			assert.deepStrictEqual(yield* parentInventory, ['app_a__ConfigMap', 'app_shared__ConfigMap']);
		}).pipe(Effect.provide(clusterConnectorHarness({ revisions })))
	);

	it.effect('reports a re-run of the same revision as a drift pass', () =>
		Effect.gen(function* () {
			const reconciler = yield* PlacementReconciler;
			yield* reconciler.reconcile({ desired: desiredPlacement() });
			yield* reconciler.reconcile({ desired: desiredPlacement() });
			const applies = (yield* (yield* FakeEngine).requests).filter(
				(request) => request._tag === 'apply'
			);
			assert.deepStrictEqual(
				applies.map((request) => (request._tag === 'apply' ? request.revisionChanged : null)),
				[true, false]
			);
		}).pipe(Effect.provide(clusterConnectorHarness({ revisions })))
	);

	it.effect('refuses a non-privileged Placement in a reserved namespace before any write', () =>
		Effect.gen(function* () {
			yield* Ref.set(yield* ReservedNames, emptyDesiredState(1).reserved);
			const reconciler = yield* PlacementReconciler;
			const report = yield* reconciler.reconcile({
				desired: desiredPlacement({ namespace: 'akua-system' })
			});
			assert.strictEqual(
				report.outcome._tag === 'failed' ? report.outcome.reason : '',
				'reserved-name'
			);
			assert.strictEqual((yield* (yield* FakeEngine).requests).length, 0);
		}).pipe(Effect.provide(clusterConnectorHarness({ revisions })))
	);

	it.effect('reports access-denied with the reviews Kubernetes denied', () =>
		Effect.gen(function* () {
			const reconciler = yield* PlacementReconciler;
			const report = yield* reconciler.reconcile({ desired: desiredPlacement() });
			assert.strictEqual(report.outcome._tag, 'access-denied');
			if (report.outcome._tag !== 'access-denied') return;
			assert.deepStrictEqual(
				report.outcome.missing.map((review) => review.spec.resourceAttributes?.verb),
				['create']
			);
			assert.isNull(yield* parentInventory);
		}).pipe(
			Effect.provide(
				clusterConnectorHarness({
					revisions,
					kubernetes: fakeKubernetesState({ allow: (attributes) => attributes.verb !== 'create' })
				})
			)
		)
	);

	it.effect('maps an engine applyset-conflict to a failed report naming the object', () =>
		Effect.gen(function* () {
			const engine = yield* FakeEngine;
			yield* engine.setBehavior((request, process) =>
				request._tag === 'apply'
					? process.emit({
							_tag: 'applied',
							id: request.id,
							changes: [],
							driftCorrected: [],
							failure: {
								stage: 'resources',
								reason: 'applyset-conflict',
								object: 'app_a__ConfigMap',
								message: 'owned by another ApplySet'
							}
						})
					: process.emit({ _tag: 'subscribed', id: request.id, watchedObjects: 0 })
			);
			const report = yield* (yield* PlacementReconciler).reconcile({ desired: desiredPlacement() });
			assert.deepStrictEqual(report.outcome, {
				_tag: 'failed',
				reason: 'applyset-conflict',
				object: 'app_a__ConfigMap',
				message: 'owned by another ApplySet'
			});
		}).pipe(Effect.provide(clusterConnectorHarness({ revisions })))
	);

	it.effect('removes an absent Placement: prunes every member and deletes the parent', () =>
		Effect.gen(function* () {
			const reconciler = yield* PlacementReconciler;
			yield* reconciler.reconcile({ desired: desiredPlacement() });
			const report = yield* reconciler.reconcile({
				desired: desiredPlacement({ generation: 2, presence: 'absent' })
			});
			assert.strictEqual(report.outcome._tag, 'removed');
			assert.isNull(yield* parentInventory);
			const requests = yield* (yield* FakeEngine).requests;
			const wait = requests.filter((request) => request._tag === 'wait').at(-1);
			assert.strictEqual(wait?._tag === 'wait' ? wait.until : '', 'terminated');
		}).pipe(Effect.provide(clusterConnectorHarness({ revisions })))
	);

	it.effect('keeps existing generated secret values and adds the Secret as a member', () =>
		Effect.gen(function* () {
			const reconciler = yield* PlacementReconciler;
			const report = yield* reconciler.reconcile({
				desired: desiredPlacement({
					generated_secrets: [
						{
							name: 'db',
							namespace: 'app',
							keys: [{ key: 'password', inputPath: 'db.password', length: 24, encoding: 'hex' }],
							manifest: {
								apiVersion: 'v1',
								kind: 'Secret',
								metadata: { name: 'db', namespace: 'app' }
							}
						}
					]
				})
			});
			assert.strictEqual(report.outcome._tag, 'ready');
			const apply = (yield* (yield* FakeEngine).requests).find(
				(request) => request._tag === 'apply'
			);
			const secret =
				apply?._tag === 'apply'
					? apply.manifests.find((manifest) => manifest.kind === 'Secret')
					: undefined;
			const data = secret?.data;
			assert.isTrue(typeof data === 'object' && data !== null && 'password' in data);
		}).pipe(Effect.provide(clusterConnectorHarness({ revisions })))
	);

	it.effect('refuses to take over a generated Secret another owner created', () =>
		Effect.gen(function* () {
			const report = yield* (yield* PlacementReconciler).reconcile({
				desired: desiredPlacement({
					generated_secrets: [
						{
							name: 'db',
							namespace: 'app',
							keys: [{ key: 'password', inputPath: 'p' }],
							manifest: {}
						}
					]
				})
			});
			assert.strictEqual(
				report.outcome._tag === 'failed' ? report.outcome.reason : '',
				'secret-conflict'
			);
		}).pipe(
			Effect.provide(
				clusterConnectorHarness({
					revisions,
					kubernetes: fakeKubernetesState({
						secrets: new Map([
							...fakeKubernetesState().secrets,
							[
								'app/db',
								{ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'db', namespace: 'app' } }
							]
						])
					})
				})
			)
		)
	);
});

describe('desiredStateLoop', () => {
	it.effect(
		'reconciles every Placement of a new revision, reports it and settles the revision',
		() =>
			Effect.gen(function* () {
				const platform = yield* FakePlatform;
				const loop = yield* Effect.forkChild(desiredStateLoop);
				yield* SubscriptionRef.set(platform.desired, emptyDesiredState(7, [desiredPlacement()]));
				yield* (yield* DesiredSignal).announce(7);
				const revision = yield* DesiredRevision;
				yield* Effect.gen(function* () {
					while ((yield* revision.get) !== 7) yield* TestClock.adjust('100 millis');
				});
				const state = yield* Ref.get(platform.state);
				assert.strictEqual(state.reports.length, 1);
				assert.strictEqual(state.reports[0]?.report.outcome._tag, 'ready');
				// The platform's DesiredChanged is answered once the loop fetched the revision.
				yield* (yield* DesiredSignal).reached(7);
				yield* Fiber.interrupt(loop);
			}).pipe(Effect.provide(clusterConnectorHarness({ revisions })))
	);

	it.effect('never applies or reports the agent bundle the updater applies', () =>
		Effect.gen(function* () {
			const platform = yield* FakePlatform;
			const engine = yield* FakeEngine;
			const loop = yield* Effect.forkChild(desiredStateLoop);
			const bundle = desiredPlacement({
				placement_id: placementId('bundle1'),
				namespace: 'akua-system',
				privileged: true,
				applier: 'updater'
			});
			yield* SubscriptionRef.set(
				platform.desired,
				emptyDesiredState(3, [bundle, desiredPlacement()])
			);
			yield* (yield* DesiredSignal).announce(3);
			const revision = yield* DesiredRevision;
			while ((yield* revision.get) !== 3) yield* TestClock.adjust('100 millis');
			const state = yield* Ref.get(platform.state);
			assert.deepStrictEqual(
				state.reports.map((entry) => entry.placementId),
				[placementId('app1')]
			);
			const applied = (yield* engine.requests).filter((request) => request._tag === 'apply');
			assert.strictEqual(applied.length, 1);
			yield* Fiber.interrupt(loop);
		}).pipe(Effect.provide(clusterConnectorHarness({ revisions })))
	);

	it.effect('runs a new pass when the generation changes', () =>
		Effect.gen(function* () {
			const platform = yield* FakePlatform;
			const loop = yield* Effect.forkChild(desiredStateLoop);
			yield* SubscriptionRef.set(platform.desired, emptyDesiredState(1, [desiredPlacement()]));
			const signal = yield* DesiredSignal;
			yield* signal.announce(1);
			const revision = yield* DesiredRevision;
			while ((yield* revision.get) !== 1) yield* TestClock.adjust('100 millis');
			yield* SubscriptionRef.set(
				platform.desired,
				emptyDesiredState(2, [
					desiredPlacement({
						generation: 2,
						source: { ...desiredPlacement().source, revision: revisionB }
					})
				])
			);
			yield* signal.announce(2);
			while ((yield* revision.get) !== 2) yield* TestClock.adjust('100 millis');
			const reports = (yield* Ref.get(platform.state)).reports;
			assert.deepStrictEqual(
				reports.map((entry) => entry.report.generation),
				[1, 2]
			);
			yield* Fiber.interrupt(loop);
		}).pipe(Effect.provide(clusterConnectorHarness({ revisions })))
	);
});
