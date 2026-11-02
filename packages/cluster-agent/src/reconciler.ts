import {
	Clock,
	Context,
	Duration,
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Random,
	Redacted,
	Ref,
	Result,
	Schedule,
	Schema,
	Semaphore
} from 'effect';
import type ids from '@platform/ids';
import type {
	DesiredPlacement,
	DesiredState,
	ObjectStatus,
	PlacementReport
} from '@platform/api-contract/services/cluster-agent';
import type { SelfSubjectAccessReview } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/authorization.k8s.io/v1/SelfSubjectAccessReview';
import { AcceptedTracker } from './accepted';
import {
	applySetIdOf,
	applySetParentName,
	buildParent,
	computeApplySetId,
	inventoryOf,
	parseObjectKey,
	staleEntries,
	unionInventory
} from './applyset';
import { AgentConfig } from './config';
import {
	applySetLabels,
	Engine,
	type EngineFailure,
	type InventoryEntry,
	KubernetesApi,
	PlacementReconciler,
	type WatchedPlacement
} from './contract';
import { GitSource } from './git-source';
import { DesiredRevision, WatchedNamespaces } from './heartbeat';
import { KubernetesExtras } from './kubernetes';
import { LiveStatus } from './live-status';
import {
	generatedSecretManifest,
	mountedSecretManifests,
	parseManifests,
	planObjects,
	type PlannedObject,
	reservedViolation
} from './manifests';
import { AgentApi } from './platform';

type PlacementId = typeof ids.placement.prefixedEffect.Type;
type Desired = typeof DesiredPlacement.Type;
type Report = typeof PlacementReport.Type;
type Outcome = Report['outcome'];
type Entry = typeof InventoryEntry.Type;

/** Opt-in and opt-out labels, the Flux annotations' counterparts. */
export const forceSelector = { 'akua.dev/force': 'enabled' } as const;
export const exclusionSelector = { 'akua.dev/reconcile': 'disabled' } as const;

/** What non-privileged Placements may not touch; replaced by every DesiredState. */
export class ReservedNames extends Context.Service<
	ReservedNames,
	Ref.Ref<(typeof DesiredState.Type)['reserved']>
>()('akua/cluster-agent/ReservedNames') {
	static readonly layer = Layer.effect(
		ReservedNames,
		Ref.make<(typeof DesiredState.Type)['reserved']>({ namespaces: [], names: [] })
	);
}

/**
 * The live-status watch set: every Placement's current inventory. Updates
 * are serialized and always send the whole set, as `subscribe` replaces it.
 */
export class WatchSet extends Context.Service<
	WatchSet,
	{
		readonly put: (placement: typeof WatchedPlacement.Type) => Effect.Effect<void>;
		readonly remove: (placementId: PlacementId) => Effect.Effect<void>;
	}
>()('akua/cluster-agent/WatchSet') {
	static readonly layer = Layer.effect(
		WatchSet,
		Effect.gen(function* () {
			const engine = yield* Engine;
			const live = yield* LiveStatus;
			const watched = new Map<PlacementId, typeof WatchedPlacement.Type>();
			const lock = yield* Semaphore.make(1);
			const publish = Effect.gen(function* () {
				const placements = [...watched.values()];
				yield* live.watch(
					placements.map((p) => ({ placementId: p.placementId, generation: p.generation }))
				);
				yield* engine.subscribe({ placements }).pipe(
					Effect.tapError((error) =>
						Effect.logWarning('engine subscribe failed').pipe(
							Effect.annotateLogs({ reason: error._tag })
						)
					),
					Effect.ignore
				);
			});
			return WatchSet.of({
				put: (placement) =>
					lock.withPermits(1)(
						Effect.gen(function* () {
							const previous = watched.get(placement.placementId);
							// Each subscribe carries every Placement's inventory; skip one that changes nothing.
							if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(placement))
								return;
							watched.set(placement.placementId, placement);
							yield* publish;
						})
					),
				remove: (placementId) =>
					lock.withPermits(1)(
						Effect.sync(() => watched.delete(placementId)).pipe(Effect.andThen(publish))
					)
			});
		})
	);
}

const failed = (
	reason: Extract<Outcome, { readonly _tag: 'failed' }>['reason'],
	message: string,
	object: string | null = null
): Outcome => ({ _tag: 'failed', reason, object, message: message.slice(0, 2048) });

/** The PlacementReport outcome for an engine failure inside an `applied` or `waited` answer. */
export const outcomeForEngineFailure = (failure: typeof EngineFailure.Type): Outcome => {
	switch (failure.reason) {
		case 'immutable':
			return failed('immutable-field', failure.message, failure.object);
		case 'conflict':
			return failed('field-conflict', failure.message, failure.object);
		case 'applyset-conflict':
			return failed('applyset-conflict', failure.message, failure.object);
		case 'unhealthy':
			return failed('unhealthy', failure.message, failure.object);
		case 'timeout':
			return failed('health-timeout', failure.message, failure.object);
		case 'forbidden':
		case 'invalid':
		case 'unavailable':
			return failed('manifests-rejected', failure.message, failure.object);
	}
};

const accessReview = (attributes: {
	readonly verb: string;
	readonly group: string;
	readonly resource: string;
	readonly namespace: string;
}): typeof SelfSubjectAccessReview.Type => ({
	apiVersion: 'authorization.k8s.io/v1',
	kind: 'SelfSubjectAccessReview',
	spec: {
		resourceAttributes: {
			verb: attributes.verb,
			group: attributes.group,
			resource: attributes.resource,
			...(attributes.namespace !== '' && { namespace: attributes.namespace })
		}
	}
});

/** Every (verb, group, resource, namespace) an apply needs, deduplicated. */
export const requiredAccess = (objects: ReadonlyArray<PlannedObject>) => {
	const seen = new Map<string, ReturnType<typeof accessReview>>();
	for (const object of objects) {
		if (object.resource === null) continue;
		for (const verb of ['get', 'create', 'patch']) {
			const attributes = {
				verb,
				group: object.group,
				resource: object.resource,
				namespace: object.namespace
			};
			seen.set(JSON.stringify(attributes), accessReview(attributes));
		}
	}
	return [...seen.values()];
};

/** A pass that could not finish for a reason expected to clear; the loop retries with backoff. */
export class Transient extends Schema.TaggedError<Transient>()('Transient', {
	message: Schema.String
}) {}

const healthyOutcome = (
	revision: string,
	objects: ReadonlyArray<typeof ObjectStatus.Type>,
	corrected: ReadonlyArray<string>
): Outcome => ({
	_tag: 'ready',
	revision,
	health: objects.every((object) => object.status === 'Current') ? 'healthy' : 'degraded',
	objects: objects.slice(0, 500),
	corrected: corrected.slice(0, 500)
});

export const placementReconcilerLayer = Layer.effect(
	PlacementReconciler,
	Effect.gen(function* () {
		const config = yield* AgentConfig;
		const kubernetes = yield* KubernetesApi;
		const extras = yield* KubernetesExtras;
		const engine = yield* Engine;
		const git = yield* GitSource;
		const api = yield* AgentApi;
		const reserved = yield* ReservedNames;
		const watchSet = yield* WatchSet;
		const live = yield* LiveStatus;
		const lastRevision = new Map<PlacementId, string>();

		const readParent = Effect.fnUntraced(function* (desired: Desired) {
			const name = applySetParentName(desired.placement_id);
			const applySetId = yield* computeApplySetId({ name, namespace: desired.namespace });
			const parent = yield* kubernetes.getApplySetParent({ name, namespace: desired.namespace });
			const none: ReadonlyArray<Entry> = [];
			if (parent === null)
				return { name, applySetId, previous: none, exists: false, conflict: null };
			const previous = inventoryOf(parent);
			const conflict =
				applySetIdOf(parent) !== applySetId || previous === null
					? failed(
							'applyset-conflict',
							`Secret ${desired.namespace}/${name} is not this Placement's ApplySet parent`,
							`${desired.namespace}_${name}__Secret`
						)
					: null;
			return { name, applySetId, previous: previous ?? [], exists: true, conflict };
		});

		const applyTimeout = (desired: Desired) =>
			Math.min(600, Math.max(10, desired.health_timeout_seconds));
		const waitTimeout = (desired: Desired) =>
			Math.min(3600, Math.max(30, desired.health_timeout_seconds));

		const writeParent = (
			desired: Desired,
			applySetId: Parameters<typeof buildParent>[0]['applySetId'],
			inventory: ReadonlyArray<Entry>
		) =>
			kubernetes.applyApplySetParent({
				parent: buildParent({
					placementId: desired.placement_id,
					namespace: desired.namespace,
					applySetId,
					agentVersion: config.release.version,
					inventory
				})
			});

		const watch = (
			desired: Desired,
			applySetId: Parameters<typeof buildParent>[0]['applySetId'],
			inventory: ReadonlyArray<Entry>,
			exclusive: boolean
		) =>
			watchSet.put({
				placementId: desired.placement_id,
				generation: desired.generation,
				applySetId,
				namespaces: [
					...new Set(
						inventory
							.map((entry) => parseObjectKey(entry.key).namespace)
							.filter((namespace) => namespace !== '')
					)
				].slice(0, 16),
				namespaceExclusive: exclusive,
				inventory: inventory.slice(0, 5000)
			});

		const present = Effect.fnUntraced(function* (desired: Desired) {
			const revision = desired.source.revision;
			const files = yield* git
				.fetchManifests({
					url: desired.source.url,
					revision,
					credential: desired.source.credential
				})
				.pipe(Effect.result);
			if (Result.isFailure(files)) return failed('source-unavailable', files.failure.message);
			const rendered = parseManifests(files.success);
			if (Result.isFailure(rendered)) return failed('manifests-rejected', rendered.failure.message);

			const parent = yield* readParent(desired);
			if (parent.conflict !== null) return parent.conflict;

			// Generated secrets keep their existing values; mounted secrets come by reference.
			const extra: Array<(typeof rendered.success)[number]> = [];
			for (const plan of desired.generated_secrets) {
				const existing = yield* extras.getSecretAsApply({
					namespace: plan.namespace,
					name: plan.name
				});
				if (
					existing !== null &&
					existing.metadata?.labels?.[applySetLabels.partOf] !== parent.applySetId
				) {
					return failed(
						'secret-conflict',
						`Secret ${plan.namespace}/${plan.name} exists and is not managed by this Placement`,
						`${plan.namespace}_${plan.name}__Secret`
					);
				}
				extra.push(generatedSecretManifest(plan, existing?.data ?? {}));
			}
			if (desired.secret_mounts.length > 0) {
				const secrets = yield* api
					.placementSecrets({
						params: { placement_id: desired.placement_id },
						query: { generation: desired.generation }
					})
					.pipe(Effect.result);
				if (Result.isFailure(secrets) || secrets.success.generation !== desired.generation) {
					return yield* Effect.fail(new Transient({ message: 'placement secrets unavailable' }));
				}
				extra.push(
					...mountedSecretManifests(
						desired.namespace,
						secrets.success.values.map((value) => ({
							name: value.name,
							key: value.key,
							value: Redacted.value(value.value)
						}))
					)
				);
			}

			const manifests = [...rendered.success, ...extra];
			const apiVersions = [
				...new Set(
					manifests.flatMap((manifest) =>
						typeof manifest.apiVersion === 'string' ? [manifest.apiVersion] : []
					)
				)
			];
			const discovery = new Map(
				yield* Effect.forEach(apiVersions, (apiVersion) =>
					extras
						.discover(apiVersion)
						.pipe(Effect.map((resources) => [apiVersion, resources] as const))
				)
			);
			const planned = planObjects({
				manifests,
				namespace: desired.namespace,
				applySetId: parent.applySetId,
				discovery
			});
			if (Result.isFailure(planned)) {
				return failed('manifests-rejected', planned.failure.message, planned.failure.object);
			}
			const objects = planned.success;

			if (!desired.privileged) {
				const violation = reservedViolation(objects, yield* Ref.get(reserved));
				if (violation !== null) {
					return failed(
						'reserved-name',
						`${violation.key} is reserved for Akua's baseline`,
						violation.key
					);
				}
			}

			const reviews = yield* Effect.forEach(
				requiredAccess(objects),
				(review) => kubernetes.reviewAccess({ review }),
				{
					concurrency: 8
				}
			);
			const missing = reviews.filter((review) => review.status?.allowed !== true);
			const [firstMissing, ...moreMissing] = missing.slice(0, 64);
			if (firstMissing !== undefined) {
				const outcome: Outcome = {
					_tag: 'access-denied',
					missing: [firstMissing, ...moreMissing],
					message: `akua-system/akua-apply lacks ${missing.length} permission(s) this Placement needs`
				};
				return outcome;
			}

			const desiredEntries = objects.map((object) => object.entry);
			const widened = unionInventory(parent.previous, desiredEntries);
			const exclusive = objects.some(
				(object) =>
					object.group === '' && object.kind === 'Namespace' && object.name === desired.namespace
			);
			yield* writeParent(desired, parent.applySetId, widened);
			const timeoutSeconds = applyTimeout(desired);
			const applied = yield* engine.apply({
				applySetId: parent.applySetId,
				manifests: objects.map((object) => object.manifest),
				revisionChanged: lastRevision.get(desired.placement_id) !== revision,
				forceSelector,
				exclusionSelector,
				timeoutSeconds
			});
			yield* watch(desired, parent.applySetId, widened, exclusive);
			if (applied.failure !== null) return outcomeForEngineFailure(applied.failure);

			// Members are what this revision renders, whatever the engine reported
			// changing: an object it skipped is still desired and must never be pruned.
			const members = unionInventory(
				desiredEntries,
				applied.changes.map((change) => ({ key: change.key, version: change.version }))
			);
			const waited = yield* engine.wait({
				applySetId: parent.applySetId,
				members,
				until: 'current',
				intervalSeconds: 2,
				timeoutSeconds: waitTimeout(desired),
				failFast: true
			});
			if (waited.failure !== null) return outcomeForEngineFailure(waited.failure);

			const stale = staleEntries(parent.previous, members);
			let survivors: ReadonlyArray<Entry> = [];
			if (stale.length > 0) {
				const pruned = yield* engine.prune({
					applySetId: parent.applySetId,
					stale,
					exclusionSelector,
					timeoutSeconds
				});
				survivors = pruned.survivors.map((survivor) => survivor.entry);
			}
			const final = unionInventory(members, survivors);
			yield* writeParent(desired, parent.applySetId, final);
			yield* watch(desired, parent.applySetId, final, exclusive);
			lastRevision.set(desired.placement_id, revision);
			yield* live.requestSnapshot(desired.placement_id);
			return healthyOutcome(revision, waited.health, applied.driftCorrected);
		});

		const absent = Effect.fnUntraced(function* (desired: Desired) {
			const parent = yield* readParent(desired);
			if (parent.conflict !== null) return parent.conflict;
			if (!parent.exists) {
				yield* watchSet.remove(desired.placement_id);
				return { _tag: 'removed' } satisfies Outcome;
			}
			const timeoutSeconds = applyTimeout(desired);
			const pruned =
				parent.previous.length === 0
					? { deleted: [], survivors: [] }
					: yield* engine.prune({
							applySetId: parent.applySetId,
							stale: parent.previous,
							exclusionSelector,
							timeoutSeconds
						});
			if (pruned.survivors.length > 0) {
				const survivors = pruned.survivors.map((survivor) => survivor.entry);
				yield* writeParent(desired, parent.applySetId, survivors);
				return yield* Effect.fail(
					new Transient({
						message: `${survivors.length} object(s) could not be deleted: ${pruned.survivors[0]?.message ?? ''}`
					})
				);
			}
			if (pruned.deleted.length > 0) {
				const terminated = yield* engine.wait({
					applySetId: parent.applySetId,
					members: pruned.deleted,
					until: 'terminated',
					intervalSeconds: 2,
					timeoutSeconds: waitTimeout(desired),
					failFast: false
				});
				// Keep the parent until the members are gone, or the inventory would be lost.
				if (terminated.failure !== null) {
					return yield* new Transient({
						message: `members still terminating: ${terminated.failure.message}`
					});
				}
			}
			yield* kubernetes.deleteApplySetParent({ name: parent.name, namespace: desired.namespace });
			yield* watchSet.remove(desired.placement_id);
			lastRevision.delete(desired.placement_id);
			return { _tag: 'removed' } satisfies Outcome;
		});

		return PlacementReconciler.of({
			reconcile: Effect.fn('PlacementReconciler.reconcile')(
				function* (args) {
					const desired = args.desired;
					const outcome = yield* (
						desired.presence === 'present' ? present(desired) : absent(desired)
					).pipe(
						Effect.catch((error) =>
							Effect.succeed<Outcome>({
								_tag: 'progressing',
								revision: desired.source.revision,
								objects: []
							}).pipe(
								Effect.tap(() =>
									Effect.logWarning('reconcile did not finish').pipe(
										Effect.annotateLogs({
											placementId: desired.placement_id,
											reason: error._tag,
											message: 'message' in error ? String(error.message) : ''
										})
									)
								)
							)
						)
					);
					return {
						generation: desired.generation,
						observed_at: yield* Clock.currentTimeMillis,
						outcome
					};
				},
				Effect.annotateLogs({ component: 'reconciler' })
			)
		});
	})
);

/** 750 ms doubling to 15 minutes, per failed pass. */
export const backoffMillis = (attempt: number): number => Math.min(750 * 2 ** attempt, 15 * 60_000);

interface Worker {
	readonly latest: Ref.Ref<Desired>;
	readonly wake: Queue.Queue<void>;
	reported: number | null;
	fiber: Fiber.Fiber<void> | null;
}

/**
 * Pulls desired state with the long poll and runs one worker per
 * Placement: reconcile on change, again at `reconcile_interval_seconds`
 * with 10% jitter while ready, and with exponential backoff after a pass
 * that did not end ready. Reports go to the platform after every pass.
 */
export const desiredStateLoop = Effect.gen(function* () {
	const api = yield* AgentApi;
	const reconciler = yield* PlacementReconciler;
	const reserved = yield* ReservedNames;
	const accepted = yield* AcceptedTracker;
	const revision = yield* DesiredRevision;
	const watchedNamespaces = yield* WatchedNamespaces;
	const workers = new Map<PlacementId, Worker>();
	const concurrency = yield* Semaphore.make(4);
	let current: typeof DesiredState.Type | null = null;

	const settleRevision = Effect.gen(function* () {
		if (current === null) return;
		const done = current.placements.every(
			(placement) => workers.get(placement.placement_id)?.reported === placement.generation
		);
		if (done) yield* revision.set(current.revision);
	});

	const postReport = (placementId: PlacementId, report: Report) =>
		api.report({ params: { placement_id: placementId }, payload: report }).pipe(
			Effect.retry({ schedule: Schedule.exponential('1 second'), times: 4 }),
			Effect.tap(() => accepted.markAccepted('report')),
			Effect.as(true),
			Effect.catch((error) =>
				Effect.logWarning('report not accepted').pipe(
					Effect.annotateLogs({ placementId, reason: error._tag }),
					Effect.as(false)
				)
			)
		);

	const runWorker = (placementId: PlacementId, worker: Worker) =>
		Effect.gen(function* () {
			let attempt = 0;
			while (true) {
				const desired = yield* Ref.get(worker.latest);
				const pass = yield* concurrency
					.withPermits(1)(reconciler.reconcile({ desired }))
					.pipe(Effect.exit);
				if (Exit.isFailure(pass)) {
					// A defect must not end the worker: log it, back off, try again.
					yield* Effect.logError('reconcile defect', pass.cause).pipe(
						Effect.annotateLogs({ placementId })
					);
					attempt += 1;
					yield* Effect.sleep(Duration.millis(backoffMillis(attempt - 1)));
					continue;
				}
				const report = pass.value;
				if (yield* postReport(placementId, report)) {
					worker.reported = desired.generation;
					yield* settleRevision;
				}
				if (desired.presence === 'absent' && report.outcome._tag === 'removed') {
					workers.delete(placementId);
					return;
				}
				const settled = report.outcome._tag === 'ready';
				attempt = settled ? 0 : attempt + 1;
				const jitter = 0.9 + (yield* Random.next) * 0.2;
				const delay = settled
					? desired.reconcile_interval_seconds * 1000 * jitter
					: backoffMillis(attempt - 1) * jitter;
				yield* Effect.raceFirst(Effect.sleep(Duration.millis(delay)), Queue.take(worker.wake));
			}
		});

	const apply = Effect.fnUntraced(function* (state: typeof DesiredState.Type) {
		current = state;
		yield* Ref.set(reserved, state.reserved);
		yield* watchedNamespaces.set(state.placements.map((placement) => placement.namespace));
		// A Placement no longer listed is not reconciled any more; `absent` is how removal arrives.
		const listed = new Set(state.placements.map((placement) => placement.placement_id));
		for (const [placementId, worker] of workers) {
			if (listed.has(placementId)) continue;
			workers.delete(placementId);
			if (worker.fiber !== null) yield* Fiber.interrupt(worker.fiber);
		}
		for (const placement of state.placements) {
			const worker = workers.get(placement.placement_id);
			if (worker === undefined) {
				const created: Worker = {
					latest: yield* Ref.make(placement),
					wake: yield* Queue.sliding<void>(1),
					reported: null,
					fiber: null
				};
				workers.set(placement.placement_id, created);
				created.fiber = yield* Effect.forkChild(runWorker(placement.placement_id, created));
				continue;
			}
			const previous = yield* Ref.get(worker.latest);
			yield* Ref.set(worker.latest, placement);
			if (
				previous.generation !== placement.generation ||
				previous.presence !== placement.presence ||
				previous.source.revision !== placement.source.revision
			) {
				yield* Queue.offer(worker.wake, undefined);
			}
		}
		yield* settleRevision;
	});

	let after: number | null = null;
	while (true) {
		const state: typeof DesiredState.Type = yield* api
			.desiredState({ query: after === null ? {} : { after } })
			.pipe(
				Effect.tapError((error) =>
					Effect.logWarning('desired state unavailable').pipe(
						Effect.annotateLogs({ reason: error._tag })
					)
				),
				Effect.retry(
					Schedule.min([Schedule.exponential('1 second'), Schedule.spaced('1 minute')]).pipe(
						Schedule.jittered
					)
				),
				Effect.orDie
			);
		if (after !== null && state.revision <= after) continue;
		after = state.revision;
		yield* apply(state);
	}
});
