import { Clock, Effect, Option, Result, Schema } from 'effect';
import {
	ClusterConnectorRelease,
	type DesiredPlacement
} from '@platform/api-contract/services/ClusterConnector';
import type { Deployment } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/apps/v1/Deployment';
import type { SelfSubjectAccessReview } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/authorization.k8s.io/v1/SelfSubjectAccessReview';
import {
	applySetIdOf,
	buildParent,
	computeApplySetId,
	inventoryOf,
	staleEntries,
	unionInventory
} from './ApplySet';
import type { BundleUpdate } from './BundleState';
import {
	clusterConnectorDeployment,
	clusterConnectorNamespace,
	type ApplySetId,
	Engine,
	type InventoryEntry,
	KubernetesApi,
	Manifest
} from '../ClusterConnector';
import { GitSource } from './GitSource';
import { KubernetesExtras } from './Kubernetes';
import { parseManifests, planObjects, type PlannedObject } from './Manifests';
import { ClusterConnectorClient } from './ClusterConnectorClient';
import { exclusionSelector, forceSelector, requiredAccess } from './PlacementReconciler';

/**
 * The building blocks the updater (the agent's objects) and the agent (the
 * updater's own objects) share to apply their part of the agent bundle:
 * the bundle read without acknowledging a revision, ApplySet parents in
 * akua-system, planning, access reviews, the engine's apply and prune,
 * and the live copy of what a first update replaces.
 */

type Release = typeof ClusterConnectorRelease.Type;
type Json = typeof Manifest.Type;
type Entry = typeof InventoryEntry.Type;
type Review = typeof SelfSubjectAccessReview.Type;
type ApplySetIdValue = typeof ApplySetId.Type;
type DeploymentObject = typeof Deployment.Type;

/** The agent container, whose image identifies the running release. */
export const clusterConnectorContainer = 'agent';

/** The chart writes the release it rendered here on the agent Deployment. */
export const releaseAnnotation = 'akua.dev/release';

/** Objects the chart labels as the updater's own; the agent applies those, never the updater. */
export const updaterComponentLabel = ['app.kubernetes.io/component', 'updater'] as const;

export const decodeReleaseJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(ClusterConnectorRelease)
);

const BundleDeployment = Schema.Struct({
	kind: Schema.Literal('Deployment'),
	metadata: Schema.Struct({
		name: Schema.Literal(clusterConnectorDeployment),
		annotations: Schema.Struct({ [releaseAnnotation]: Schema.String })
	}),
	spec: Schema.Struct({
		template: Schema.Struct({
			spec: Schema.Struct({
				containers: Schema.Array(Schema.Struct({ name: Schema.String, image: Schema.String }))
			})
		})
	})
});
const decodeBundleDeployment = Schema.decodeUnknownOption(BundleDeployment);

/**
 * The release a rendered bundle carries: the agent Deployment's release
 * annotation, only when its agent container runs that release's image (the
 * gate waits for that image).
 */
export const releaseOfBundle = (objects: ReadonlyArray<Json>): Release | null => {
	for (const object of objects) {
		const deployment = decodeBundleDeployment(object);
		if (Option.isNone(deployment)) continue;
		const release = Option.getOrNull(
			decodeReleaseJson(deployment.value.metadata.annotations[releaseAnnotation])
		);
		const image = deployment.value.spec.template.spec.containers.find(
			(container) => container.name === clusterConnectorContainer
		)?.image;
		return release !== null && release.image === image ? release : null;
	}
	return null;
};

const LabelsOnly = Schema.Struct({
	metadata: Schema.optionalKey(
		Schema.Struct({ labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) })
	)
});
const isUpdaterOwned = (object: Json): boolean => {
	const decoded = Schema.decodeUnknownOption(LabelsOnly)(object);
	return (
		Option.isSome(decoded) &&
		decoded.value.metadata?.labels?.[updaterComponentLabel[0]] === updaterComponentLabel[1]
	);
};

/** The objects the updater applies: the bundle without the updater's own, which the agent applies. */
export const clusterConnectorObjectsOf = (objects: ReadonlyArray<Json>): ReadonlyArray<Json> =>
	objects.filter((object) => !isUpdaterOwned(object));

/** The objects the agent applies: only the updater's own. */
export const updaterObjectsOf = (objects: ReadonlyArray<Json>): ReadonlyArray<Json> =>
	objects.filter(isUpdaterOwned);

const metadataOf = (object: Json): Json =>
	Option.getOrElse(Schema.decodeUnknownOption(Manifest)(object.metadata), () => ({}));

/** Key-sorted JSON, so two objects compare by content. */
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_key, inner: unknown) =>
		inner !== null && typeof inner === 'object' && !Array.isArray(inner)
			? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
			: inner
	);

/** One SelfSubjectAccessReview's question, as a key. */
export const attributesKey = (review: Review) => canonical(review.spec.resourceAttributes ?? {});

/**
 * Equal apart from labels and annotations. Every release changes the
 * version labels; an object the customer's grant does not cover is only
 * worth a `helm upgrade` when what it grants or runs changed.
 */
export const sameContent = (a: Json, b: Json): boolean => {
	const strip = (object: Json) => {
		const { labels: _labels, annotations: _annotations, ...metadata } = metadataOf(object);
		return { ...object, metadata };
	};
	return canonical(strip(a)) === canonical(strip(b));
};

const serverFields = [
	'managedFields',
	'resourceVersion',
	'uid',
	'creationTimestamp',
	'generation',
	'selfLink'
];

/** A live object as an apply manifest: no status and none of the fields the server owns. */
export const asManifest = (live: Json): Json => {
	const { status: _status, ...object } = live;
	return {
		...object,
		metadata: Object.fromEntries(
			Object.entries(metadataOf(live)).filter(([key]) => !serverFields.includes(key))
		)
	};
};

export interface Bundle {
	readonly placement: typeof DesiredPlacement.Type;
	readonly release: Release;
	/** Every object as rendered; each applier takes its part. */
	readonly objects: ReadonlyArray<Json>;
}

/**
 * The `applier: updater` Placement with its rendered objects, or null when
 * absent or unreadable. Read through `updaterBundle`, never `desiredState`,
 * which acknowledges the agent's revision.
 */
export const readBundle = Effect.gen(function* () {
	const platform = yield* ClusterConnectorClient;
	const git = yield* GitSource;
	const fetched = yield* platform.updaterBundle().pipe(
		Effect.tapError((error) =>
			Effect.logWarning('agent bundle unavailable').pipe(
				Effect.annotateLogs({ reason: error._tag })
			)
		),
		Effect.option
	);
	if (Option.isNone(fetched)) return null;
	const placement = fetched.value.placement;
	if (placement === null || placement.presence !== 'present') return null;
	const files = yield* git
		.fetchManifests({
			url: placement.source.url,
			revision: placement.source.revision,
			credential: placement.source.credential
		})
		.pipe(
			Effect.tapError((error) =>
				Effect.logWarning('bundle source unavailable').pipe(
					Effect.annotateLogs({ message: error.message })
				)
			),
			Effect.option
		);
	if (Option.isNone(files)) return null;
	const parsed = parseManifests(files.value);
	if (Result.isFailure(parsed)) {
		yield* Effect.logWarning('bundle manifests unreadable').pipe(
			Effect.annotateLogs({ message: parsed.failure.message })
		);
		return null;
	}
	const release = releaseOfBundle(parsed.success);
	if (release === null) {
		yield* Effect.logWarning('bundle names no release its agent Deployment runs');
		return null;
	}
	return { placement, release, objects: parsed.success } satisfies Bundle;
});

/** kstatus Current for a Deployment: observed, fully updated, ready and available, no old replicas left. */
export const rolloutCurrent = (deployment: DeploymentObject): boolean => {
	const replicas = deployment.spec?.replicas ?? 1;
	const status = deployment.status;
	return (
		(status?.observedGeneration ?? 0) >= (deployment.metadata?.generation ?? 0) &&
		(status?.updatedReplicas ?? 0) === replicas &&
		(status?.readyReplicas ?? 0) === replicas &&
		(status?.availableReplicas ?? 0) === replicas &&
		(status?.replicas ?? 0) === replicas
	);
};

export const progressDeadlineExceeded = (deployment: DeploymentObject): boolean =>
	(deployment.status?.conditions ?? []).some(
		(condition) =>
			condition.type === 'Progressing' && condition.reason === 'ProgressDeadlineExceeded'
	);

const engineTimeoutSeconds = 300;

/** Applies one part of the bundle in akua-system as `akua-apply`, recording members in its own ApplySet parent. */
export const bundleApplier = Effect.gen(function* () {
	const api = yield* KubernetesApi;
	const extras = yield* KubernetesExtras;
	const engine = yield* Engine;

	const applySet = Effect.fnUntraced(function* (name: string) {
		const applySetId = yield* computeApplySetId({ name, namespace: clusterConnectorNamespace });
		const parent = yield* api
			.getApplySetParent({ name, namespace: clusterConnectorNamespace })
			.pipe(Effect.orDie);
		const inventory =
			parent === null || applySetIdOf(parent) !== applySetId ? [] : (inventoryOf(parent) ?? []);
		return { applySetId, inventory };
	});

	const writeParent = (
		name: string,
		applySetId: ApplySetIdValue,
		release: Release,
		inventory: ReadonlyArray<Entry>
	) =>
		api
			.applyApplySetParent({
				parent: buildParent({
					name,
					namespace: clusterConnectorNamespace,
					applySetId,
					agentVersion: release.version,
					inventory
				})
			})
			.pipe(Effect.orDie);

	/** Labels the objects as ApplySet members, with one discovery per API version. */
	const plan = Effect.fnUntraced(function* (
		bundles: ReadonlyArray<ReadonlyArray<Json>>,
		applySetId: ApplySetIdValue
	) {
		const apiVersions = [
			...new Set(
				bundles
					.flat()
					.flatMap((object) => (typeof object.apiVersion === 'string' ? [object.apiVersion] : []))
			)
		];
		const discovery = new Map(
			yield* Effect.forEach(
				apiVersions,
				(apiVersion) =>
					extras.discover(apiVersion).pipe(
						Effect.orDie,
						Effect.map((resources) => [apiVersion, resources] as const)
					),
				{ concurrency: 4 }
			)
		);
		return yield* Effect.forEach(bundles, (manifests) => {
			const planned = planObjects({
				manifests,
				namespace: clusterConnectorNamespace,
				applySetId,
				discovery
			});
			return Result.isFailure(planned)
				? Effect.die(planned.failure)
				: Effect.succeed(planned.success);
		});
	});

	/** Per object, the checks the customer's grant to `akua-apply` denies (empty: covered). */
	const deniedOf = Effect.fnUntraced(function* (objects: ReadonlyArray<PlannedObject>) {
		const reviewed = new Map(
			yield* Effect.forEach(
				requiredAccess(objects),
				(review) =>
					api.reviewAccess({ review }).pipe(
						Effect.orDie,
						Effect.map((answer) => [attributesKey(review), answer] as const)
					),
				{ concurrency: 8 }
			)
		);
		return objects.map((object) => ({
			object,
			denied: requiredAccess([object]).flatMap((review) => {
				const answer = reviewed.get(attributesKey(review));
				return answer?.status?.allowed === true ? [] : [answer ?? review];
			})
		}));
	});

	const apply = (applySetId: ApplySetIdValue, objects: ReadonlyArray<PlannedObject>) =>
		engine
			.apply({
				applySetId,
				manifests: objects.map((object) => object.manifest),
				revisionChanged: true,
				forceSelector,
				// The bundle replaces what Helm installed, so the updater is the explicit case that takes over.
				takeOwnership: true,
				exclusionSelector,
				timeoutSeconds: engineTimeoutSeconds
			})
			.pipe(Effect.orDie);

	const prune = (applySetId: ApplySetIdValue, stale: ReadonlyArray<Entry>) =>
		stale.length === 0
			? Effect.succeed<ReadonlyArray<Entry>>([])
			: engine
					.prune({ applySetId, stale, exclusionSelector, timeoutSeconds: engineTimeoutSeconds })
					.pipe(
						Effect.orDie,
						Effect.map((pruned) => pruned.survivors.map((survivor) => survivor.entry))
					);

	/** The live copy of each object the first bundle replaces, readable as `akua-apply`. */
	const snapshot = Effect.fnUntraced(function* (objects: ReadonlyArray<PlannedObject>) {
		const live = yield* Effect.forEach(
			objects,
			(object) =>
				object.resource === null || typeof object.manifest.apiVersion !== 'string'
					? Effect.succeed(null)
					: extras
							.getObjectAsApply({
								apiVersion: object.manifest.apiVersion,
								resource: object.resource,
								namespace: object.namespace === '' ? null : object.namespace,
								name: object.name
							})
							.pipe(Effect.orElseSucceed(() => null)),
			{ concurrency: 4 }
		);
		return live.flatMap((object) => (object === null ? [] : [asManifest(object)]));
	});

	/** The objects the customer's grant to `akua-apply` covers; the rest stay as their install made them. */
	const allowedOf = (objects: ReadonlyArray<PlannedObject>) =>
		Effect.map(deniedOf(objects), (reviewed) =>
			reviewed.filter((entry) => entry.denied.length === 0).map((entry) => entry.object)
		);

	/**
	 * Runs (or, after a restart, repeats) a recorded update's apply into the
	 * ApplySet `name`; the engine's answer narrows `created`. The caller
	 * records the result before it acts on `failure`.
	 */
	const applyRecorded = Effect.fnUntraced(function* (
		name: string,
		update: typeof BundleUpdate.Type
	) {
		const { applySetId, inventory } = yield* applySet(name);
		const [objects = []] = yield* plan([update.objects], applySetId);
		const applying = new Set(update.applied.map((entry) => entry.key));
		yield* writeParent(name, applySetId, update.to, unionInventory(inventory, update.applied));
		const applied = yield* apply(
			applySetId,
			objects.filter((object) => applying.has(object.key))
		);
		const created = new Set(
			applied.changes.filter((change) => change.action === 'created').map((change) => change.key)
		);
		return {
			recorded: {
				...update,
				created: update.created.filter((entry) => created.has(entry.key)),
				appliedAt: yield* Clock.currentTimeMillis
			},
			failure: applied.failure
		};
	});

	/**
	 * Applies the last good objects (kept in the cluster) again where the
	 * grant allows, prunes what the update created and records the restored
	 * members.
	 */
	const rollBack = Effect.fnUntraced(function* (
		name: string,
		lastGood: ReadonlyArray<Json>,
		update: typeof BundleUpdate.Type
	) {
		const { applySetId } = yield* applySet(name);
		const [previous = []] = yield* plan([lastGood], applySetId);
		const allowed = yield* allowedOf(previous);
		if (allowed.length > 0) {
			const reapplied = yield* apply(applySetId, allowed);
			if (reapplied.failure !== null)
				yield* Effect.logError('last good objects not fully re-applied').pipe(
					Effect.annotateLogs({ applySet: name, message: reapplied.failure.message })
				);
		}
		const keep = new Set(previous.map((object) => object.key));
		const survivors = yield* prune(
			applySetId,
			update.created.filter((entry) => !keep.has(entry.key))
		);
		yield* writeParent(
			name,
			applySetId,
			update.from,
			unionInventory(
				allowed.map((object) => object.entry),
				survivors
			)
		);
	});

	/** A verified update: prunes what the new objects dropped and records their members. */
	const settle = Effect.fnUntraced(function* (name: string, update: typeof BundleUpdate.Type) {
		const { applySetId, inventory } = yield* applySet(name);
		// A member the grant no longer lets Akua write is the customer's now, never pruned.
		const survivors = yield* prune(applySetId, staleEntries(inventory, update.planned));
		yield* writeParent(name, applySetId, update.to, unionInventory(update.applied, survivors));
	});

	/**
	 * The record of an update applying `allowed` (planned from `objects`)
	 * over what runs, and the last good objects it rolls back to: the kept
	 * ones, or before the first update the live copy of what it replaces,
	 * read before anything changes.
	 */
	const prepare = Effect.fnUntraced(function* (args: {
		readonly applySetId: ApplySetIdValue;
		readonly objects: ReadonlyArray<Json>;
		readonly planned: ReadonlyArray<PlannedObject>;
		readonly previous: ReadonlyArray<PlannedObject>;
		readonly allowed: ReadonlyArray<PlannedObject>;
		readonly current: { readonly release: Release; readonly objects: ReadonlyArray<Json> } | null;
		readonly from: Release;
		readonly bundle: Bundle;
		readonly verifySeconds: number;
	}) {
		const now = yield* Clock.currentTimeMillis;
		const entries = args.allowed.map((object) => object.entry);
		const current = args.current ?? {
			release: args.from,
			objects: yield* snapshot(args.allowed)
		};
		const kept = new Set(
			(args.current === null
				? (yield* plan([current.objects], args.applySetId)).flat()
				: args.previous
			).map((object) => object.key)
		);
		const update: typeof BundleUpdate.Type = {
			from: args.from,
			to: args.bundle.release,
			startedAt: now,
			deadline: now + args.verifySeconds * 1000,
			placementId: args.bundle.placement.placement_id,
			generation: args.bundle.placement.generation,
			revision: args.bundle.placement.source.revision,
			objects: args.objects,
			planned: args.planned.map((object) => object.entry),
			applied: entries,
			created: entries.filter((entry) => !kept.has(entry.key)),
			appliedAt: null
		};
		return { current, update };
	});

	return {
		applySet,
		writeParent,
		plan,
		deniedOf,
		allowedOf,
		apply,
		prune,
		snapshot,
		applyRecorded,
		rollBack,
		settle,
		prepare
	};
});
