import {
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Result,
	Schema,
	Stream,
	SubscriptionRef
} from 'effect';
import { Base64 } from 'effect/encoding';
import { HttpClient, HttpClientRequest, type HttpClientError } from 'effect/http';
import ids from '@platform/ids';
import {
	AgentRelease,
	type DesiredPlacement,
	type PlacementReport,
	UpdateRollbackReason,
	type UpdaterInstruction,
	type UpdaterPhase
} from '@platform/api-contract/services/cluster-agent';
import { GitCommit } from '@platform/api-contract/services/repositories';
import { Deployment } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/apps/v1/Deployment';
import { PodList } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/PodList';
import type { SelfSubjectAccessReview } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/authorization.k8s.io/v1/SelfSubjectAccessReview';
import { UpdaterChannelRpcs } from '@platform/api-contract/services/cluster-agent-channel';
import {
	applySetIdOf,
	applySetParentName,
	buildParent,
	computeApplySetId,
	inventoryOf,
	staleEntries,
	unionInventory
} from './applyset';
import type { ChannelState } from './channel';
import {
	agentDeployment,
	agentNamespace,
	type ApplySetId,
	AgentUpdater,
	Engine,
	Inventory,
	type InventoryEntry,
	KubernetesApi,
	type KubernetesFailure,
	Manifest
} from './contract';
import { GitSource } from './git-source';
import { decodeAs, failureFor, KubernetesConnection, KubernetesExtras } from './kubernetes';
import { parseManifests, planObjects, type PlannedObject } from './manifests';
import { AgentApi } from './platform';
import { exclusionSelector, forceSelector, requiredAccess } from './reconciler';

type Release = typeof AgentRelease.Type;
type Phase = typeof UpdaterPhase.Type;
type Instruction = typeof UpdaterInstruction.Type;
type Reason = typeof UpdateRollbackReason.Type;
type AgentDeploymentObject = typeof Deployment.Type;
type Pods = typeof PodList.Type;
type Json = typeof Manifest.Type;
type Entry = typeof InventoryEntry.Type;
type Review = typeof SelfSubjectAccessReview.Type;
type Outcome = (typeof PlacementReport.Type)['outcome'];
type PlacementId = typeof ids.placement.prefixedEffect.Type;
type ApplySetIdValue = typeof ApplySetId.Type;

/** The agent container, whose image identifies the running release. */
export const agentContainer = 'agent';

/** The chart writes the release it rendered here on the agent Deployment. */
export const releaseAnnotation = 'akua.dev/release';

/**
 * The updater's own state, in a Secret the chart creates empty in
 * akua-system and only the updater writes (its Role: get, update, patch):
 * - `current`: the last good bundle as rendered (or, before the first
 *   bundle, the live copy of what the first bundle replaces); a rollback
 *   re-applies it and nothing is ever fetched from the platform for it;
 * - `update`: the bundle being applied and gated, so an updater restart
 *   mid-update still finishes or rolls back;
 * - `rolled-back`: the release rejected here, never applied again.
 */
export const bundleSecret = 'akua-agent-bundle';

/** Objects the chart labels as the updater's own; the agent applies those, never the updater. */
export const updaterComponentLabel = ['app.kubernetes.io/component', 'updater'] as const;

const BundleObjects = Schema.Array(Manifest).check(Schema.isMaxLength(200));

export const CurrentBundle = Schema.Struct({ release: AgentRelease, objects: BundleObjects });

export const BundleUpdate = Schema.Struct({
	from: AgentRelease,
	to: AgentRelease,
	startedAt: Schema.Finite,
	deadline: Schema.Finite,
	placementId: ids.placement.prefixedEffect,
	generation: Schema.Int,
	revision: GitCommit,
	/** The new bundle as rendered, stored as `current` once verified. */
	objects: BundleObjects,
	/** Every object of the new bundle; members not in it are pruned once verified. */
	planned: Inventory,
	/** What the updater applies: `planned` without what the customer's grant leaves to the customer. */
	applied: Inventory,
	/**
	 * What a rollback prunes. Before the apply finished: every applied object
	 * the last good bundle lacks; after it: those the apply reported created.
	 */
	created: Inventory,
	/** null until the engine answered the apply; a restart before that applies again. */
	appliedAt: Schema.NullOr(Schema.Finite)
});

export const BundleRejection = Schema.Struct({
	rejected: AgentRelease,
	reason: UpdateRollbackReason,
	at: Schema.Finite
});

const fields = {
	current: Schema.fromJsonString(CurrentBundle),
	update: Schema.fromJsonString(BundleUpdate),
	'rolled-back': Schema.fromJsonString(BundleRejection)
} as const;
type Field = keyof typeof fields;
const encodeCurrent = Schema.encodeSync(fields.current);
const encodeUpdate = Schema.encodeSync(fields.update);
const encodeRejection = Schema.encodeSync(fields['rolled-back']);

export interface BundleState {
	readonly current: typeof CurrentBundle.Type | null;
	readonly update: typeof BundleUpdate.Type | null;
	readonly 'rolled-back': typeof BundleRejection.Type | null;
}

/**
 * Reads one key of the state Secret; a missing key is absent. An
 * undecodable one is a defect, never absent: treating a corrupt update as
 * none would abandon it without a rollback.
 */
const readField = <K extends Field>(
	data: Readonly<Record<string, string>> | undefined,
	key: K
): Effect.Effect<(typeof fields)[K]['Type'] | null> => {
	const raw = data?.[key];
	if (raw === undefined) return Effect.succeed(null);
	const text = Base64.decodeString(raw);
	if (Result.isFailure(text)) return Effect.die(`${bundleSecret} key ${key} is not base64`);
	return Schema.decodeUnknownEffect(fields[key])(text.success).pipe(Effect.orDie);
};

/** The Secret data merge patch for the given keys; null removes a key. */
export const stateData = (patch: Partial<BundleState>): Record<string, string | null> => {
	const data: Record<string, string | null> = {};
	const encoded = <A>(value: A | null, encode: (value: A) => string) =>
		value === null ? null : Base64.encode(encode(value));
	if (patch.current !== undefined) data.current = encoded(patch.current, encodeCurrent);
	if (patch.update !== undefined) data.update = encoded(patch.update, encodeUpdate);
	if (patch['rolled-back'] !== undefined)
		data['rolled-back'] = encoded(patch['rolled-back'], encodeRejection);
	return data;
};

/** The updater's reads of the agent Deployment and its Pods, for the health gate. */
export class UpdaterKubernetes extends Context.Service<
	UpdaterKubernetes,
	{
		readonly getAgentDeployment: Effect.Effect<
			AgentDeploymentObject,
			KubernetesFailure | HttpClientError.HttpClientError
		>;
		readonly listPods: (
			selector: string
		) => Effect.Effect<Pods, KubernetesFailure | HttpClientError.HttpClientError>;
	}
>()('akua/cluster-agent/UpdaterKubernetes') {
	static readonly layer = Layer.effect(
		UpdaterKubernetes,
		Effect.gen(function* () {
			const connection = yield* KubernetesConnection;
			const client = yield* HttpClient.HttpClient;
			const deploymentPath = `/apis/apps/v1/namespaces/${agentNamespace}/deployments/${agentDeployment}`;
			const send = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
				const token = yield* connection.token;
				const response = yield* client.execute(
					request.pipe(
						HttpClientRequest.prependUrl(connection.baseUrl),
						HttpClientRequest.bearerToken(token),
						HttpClientRequest.acceptJson
					)
				);
				const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
				if (response.status < 200 || response.status >= 300)
					return yield* failureFor(response.status, body);
				return { status: response.status, body };
			});
			return UpdaterKubernetes.of({
				getAgentDeployment: send(HttpClientRequest.get(deploymentPath)).pipe(
					Effect.flatMap((result) => decodeAs(Deployment)(result.status)(result.body))
				),
				listPods: (selector) =>
					send(
						HttpClientRequest.get(`/api/v1/namespaces/${agentNamespace}/pods`).pipe(
							HttpClientRequest.setUrlParams({ labelSelector: selector })
						)
					).pipe(Effect.flatMap((result) => decodeAs(PodList)(result.status)(result.body)))
			});
		})
	);
}

const imageOf = (deployment: AgentDeploymentObject): string | undefined =>
	deployment.spec?.template.spec?.containers.find((container) => container.name === agentContainer)
		?.image;

/** kstatus Current for a Deployment: observed, fully updated, ready and available, no old replicas left. */
export const rolloutCurrent = (deployment: AgentDeploymentObject): boolean => {
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

const progressDeadlineExceeded = (deployment: AgentDeploymentObject): boolean =>
	(deployment.status?.conditions ?? []).some(
		(condition) =>
			condition.type === 'Progressing' && condition.reason === 'ProgressDeadlineExceeded'
	);

/** Why pods running `image` cannot become ready, read from their container states. */
export const podTrouble = (pods: Pods, image: string): 'image-unavailable' | 'unhealthy' | null => {
	let trouble: 'image-unavailable' | 'unhealthy' | null = null;
	for (const pod of pods.items) {
		// The spec holds the reference as written; status.image may be normalized by the runtime.
		const runsImage = pod.spec?.containers.some(
			(container) => container.name === agentContainer && container.image === image
		);
		if (runsImage !== true) continue;
		for (const status of pod.status?.containerStatuses ?? []) {
			if (status.name !== agentContainer) continue;
			const reason = status.state?.waiting?.reason;
			if (
				reason === 'ImagePullBackOff' ||
				reason === 'ErrImagePull' ||
				reason === 'InvalidImageName'
			) {
				return 'image-unavailable';
			}
			if (reason === 'CrashLoopBackOff' || (status.restartCount ?? 0) > 0) trouble = 'unhealthy';
		}
	}
	return trouble;
};

const selectorOf = (deployment: AgentDeploymentObject): string =>
	Object.entries(deployment.spec?.selector.matchLabels ?? {})
		.map(([key, value]) => `${key}=${value}`)
		.join(',');

const decodeReleaseJson = Schema.decodeUnknownOption(Schema.fromJsonString(AgentRelease));

/** What the agent Deployment says is running; the image wins over a stale annotation. */
export const runningRelease = (
	deployment: AgentDeploymentObject,
	fallbackVersion: string
): Option.Option<Release> => {
	const raw = deployment.metadata?.annotations?.[releaseAnnotation];
	const annotated = raw === undefined ? Option.none<Release>() : decodeReleaseJson(raw);
	const image = imageOf(deployment);
	if (Option.isSome(annotated) && annotated.value.image === image) return annotated;
	return Schema.decodeUnknownOption(AgentRelease)({
		version: Option.isSome(annotated) ? annotated.value.version : fallbackVersion,
		image,
		protocol: Option.isSome(annotated) ? annotated.value.protocol : 1
	});
};

const BundleDeployment = Schema.Struct({
	kind: Schema.Literal('Deployment'),
	metadata: Schema.Struct({
		name: Schema.Literal(agentDeployment),
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
			(container) => container.name === agentContainer
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
export const agentObjectsOf = (objects: ReadonlyArray<Json>): ReadonlyArray<Json> =>
	objects.filter((object) => !isUpdaterOwned(object));

const metadataOf = (object: Json): Json =>
	Option.getOrElse(Schema.decodeUnknownOption(Manifest)(object.metadata), () => ({}));

/** One SelfSubjectAccessReview's question, as a key. */
const attributesKey = (review: Review) => canonical(review.spec.resourceAttributes ?? {});

/** Key-sorted JSON, so two objects compare by content. */
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_key, inner: unknown) =>
		inner !== null && typeof inner === 'object' && !Array.isArray(inner)
			? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
			: inner
	);

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

interface Bundle {
	readonly placement: typeof DesiredPlacement.Type;
	readonly release: Release;
	/** As rendered, the updater's own objects removed. */
	readonly objects: ReadonlyArray<Json>;
}

const engineTimeoutSeconds = 300;

/**
 * One step of the updater against the live agent Deployment and its own
 * state Secret (`bundleSecret`). The bundle is the Placement the platform
 * marks `applier: updater`: the whole rendered agent chart, which the
 * updater applies with the agent's building blocks (git source, ApplySet
 * parent, engine, kstatus), impersonating `akua-apply` like every apply.
 *
 * - Offered a new release whose bundle is in desired state: every object
 *   the customer's grant does not cover must be unchanged from the last
 *   good bundle, else `needs-customer-upgrade` with the denied checks and
 *   nothing applied. Otherwise it records the update, applies the bundle
 *   and follows the rollout.
 * - Gate within `verify_seconds`: the agent Deployment kstatus Current,
 *   then a channel connection and an accepted report or StatusBatch from
 *   the new release as the platform observed them.
 * - Verified: prunes what the old bundle had and the new one dropped and
 *   keeps the new bundle as the last good one. Failed: re-applies the last
 *   good bundle, prunes what the new one created, rejects the release here.
 * - No last good bundle yet (installed by Helm): a bundle of the running
 *   release is adopted as is; before the first new release the live copy
 *   of what it replaces is kept as the last good bundle.
 */
export const agentUpdaterLayer = Layer.effect(
	AgentUpdater,
	Effect.gen(function* () {
		const kubernetes = yield* UpdaterKubernetes;
		const api = yield* KubernetesApi;
		const extras = yield* KubernetesExtras;
		const engine = yield* Engine;
		const git = yield* GitSource;
		const platform = yield* AgentApi;

		const readState = Effect.gen(function* () {
			const data = (yield* extras.readOwnSecret(bundleSecret).pipe(Effect.orDie))?.data;
			return {
				current: yield* readField(data, 'current'),
				update: yield* readField(data, 'update'),
				'rolled-back': yield* readField(data, 'rolled-back')
			} satisfies BundleState;
		});
		const writeState = (patch: Partial<BundleState>) =>
			extras.patchOwnSecretData(bundleSecret, stateData(patch)).pipe(Effect.orDie);

		/** Best effort: Placement's own wait covers a lost report. */
		const report = Effect.fnUntraced(function* (
			placementId: PlacementId,
			generation: number,
			outcome: Outcome
		) {
			const now = yield* Clock.currentTimeMillis;
			yield* platform
				.report({
					params: { placement_id: placementId },
					payload: { generation, observed_at: now, outcome }
				})
				.pipe(
					Effect.catch((error) =>
						Effect.logWarning('bundle report not accepted').pipe(
							Effect.annotateLogs({ placementId, reason: error._tag })
						)
					)
				);
		});

		/** The `applier: updater` Placement with its rendered objects, or null when absent or unreadable. */
		const readBundle = Effect.gen(function* () {
			const desired = yield* platform.desiredState().pipe(
				Effect.tapError((error) =>
					Effect.logWarning('desired state unavailable').pipe(
						Effect.annotateLogs({ reason: error._tag })
					)
				),
				Effect.option
			);
			if (Option.isNone(desired)) return null;
			const placement = desired.value.placements.find(
				(entry) => entry.applier === 'updater' && entry.presence === 'present'
			);
			if (placement === undefined) return null;
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
			return { placement, release, objects: agentObjectsOf(parsed.success) } satisfies Bundle;
		});

		const applySet = Effect.fnUntraced(function* (placementId: PlacementId) {
			const name = applySetParentName(placementId);
			const applySetId = yield* computeApplySetId({ name, namespace: agentNamespace });
			const parent = yield* api
				.getApplySetParent({ name, namespace: agentNamespace })
				.pipe(Effect.orDie);
			const inventory =
				parent === null || applySetIdOf(parent) !== applySetId ? [] : (inventoryOf(parent) ?? []);
			return { applySetId, inventory };
		});

		const writeParent = (
			placementId: PlacementId,
			applySetId: ApplySetIdValue,
			release: Release,
			inventory: ReadonlyArray<Entry>
		) =>
			api
				.applyApplySetParent({
					parent: buildParent({
						placementId,
						namespace: agentNamespace,
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
					namespace: agentNamespace,
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

		/** Runs (or, after a restart, repeats) the recorded apply; the engine's answer narrows `created`. */
		const applyUpdate = Effect.fnUntraced(function* (
			state: BundleState,
			update: typeof BundleUpdate.Type
		) {
			const { applySetId, inventory } = yield* applySet(update.placementId);
			const [objects = []] = yield* plan([update.objects], applySetId);
			const applying = new Set(update.applied.map((entry) => entry.key));
			yield* writeParent(
				update.placementId,
				applySetId,
				update.to,
				unionInventory(inventory, update.applied)
			);
			const applied = yield* apply(
				applySetId,
				objects.filter((object) => applying.has(object.key))
			);
			const created = new Set(
				applied.changes.filter((change) => change.action === 'created').map((change) => change.key)
			);
			const recorded = {
				...update,
				created: update.created.filter((entry) => created.has(entry.key)),
				appliedAt: yield* Clock.currentTimeMillis
			};
			yield* writeState({ update: recorded });
			if (applied.failure !== null)
				return yield* restore(state, recorded, 'apply-failed', applied.failure.message);
			return {
				_tag: 'updating',
				from: update.from,
				to: update.to,
				startedAt: update.startedAt
			} satisfies Phase;
		});

		const restore = Effect.fnUntraced(function* (
			state: BundleState,
			update: typeof BundleUpdate.Type,
			reason: Reason,
			detail: string | null = null
		): Effect.fn.Return<Phase> {
			const now = yield* Clock.currentTimeMillis;
			const { applySetId } = yield* applySet(update.placementId);
			const [previous = []] = yield* plan([state.current?.objects ?? []], applySetId);
			const allowed = (yield* deniedOf(previous))
				.filter((entry) => entry.denied.length === 0)
				.map((entry) => entry.object);
			if (allowed.length > 0) {
				const reapplied = yield* apply(applySetId, allowed);
				if (reapplied.failure !== null)
					yield* Effect.logError('last good bundle not fully re-applied').pipe(
						Effect.annotateLogs({ message: reapplied.failure.message })
					);
			}
			const keep = new Set(previous.map((object) => object.key));
			const survivors = yield* prune(
				applySetId,
				update.created.filter((entry) => !keep.has(entry.key))
			);
			yield* writeParent(
				update.placementId,
				applySetId,
				update.from,
				unionInventory(
					allowed.map((object) => object.entry),
					survivors
				)
			);
			yield* report(update.placementId, update.generation, {
				_tag: 'failed',
				reason: reason === 'apply-failed' ? 'manifests-rejected' : 'unhealthy',
				object: null,
				message:
					`Agent release ${update.to.version} failed its health gate (${reason}${detail === null ? '' : `: ${detail}`}); ${update.from.version} was restored.`.slice(
						0,
						2048
					)
			});
			yield* writeState({ update: null, 'rolled-back': { rejected: update.to, reason, at: now } });
			yield* Effect.logWarning('agent update rolled back').pipe(
				Effect.annotateLogs({ from: update.from.version, to: update.to.version, reason })
			);
			return {
				_tag: 'rolled-back',
				running: update.from,
				rejected: update.to,
				reason,
				at: now
			} satisfies Phase;
		});

		const complete = Effect.fnUntraced(function* (update: typeof BundleUpdate.Type) {
			const { applySetId, inventory } = yield* applySet(update.placementId);
			// A member the grant no longer lets Akua write is the customer's now, never pruned.
			const survivors = yield* prune(applySetId, staleEntries(inventory, update.planned));
			yield* writeParent(
				update.placementId,
				applySetId,
				update.to,
				unionInventory(update.applied, survivors)
			);
			yield* report(update.placementId, update.generation, {
				_tag: 'ready',
				revision: update.revision,
				health: 'healthy',
				objects: [],
				corrected: []
			});
			yield* writeState({
				current: { release: update.to, objects: update.objects },
				update: null,
				'rolled-back': null
			});
			yield* Effect.logInfo('agent update verified').pipe(
				Effect.annotateLogs({ version: update.to.version })
			);
			return { _tag: 'steady', running: update.to } satisfies Phase;
		});

		/** Follows an update in flight: rollout, then the platform's observations, until its deadline. */
		const follow = Effect.fnUntraced(function* (
			state: BundleState,
			update: typeof BundleUpdate.Type,
			instruction: Instruction
		) {
			if (update.appliedAt === null) return yield* applyUpdate(state, update);
			const { from, to, startedAt, deadline } = update;
			const deployment = yield* kubernetes.getAgentDeployment.pipe(Effect.orDie);
			const now = yield* Clock.currentTimeMillis;
			const pods = yield* kubernetes.listPods(selectorOf(deployment)).pipe(Effect.orDie);
			const trouble = podTrouble(pods, to.image);
			if (trouble === 'image-unavailable')
				return yield* restore(state, update, 'image-unavailable');
			if (imageOf(deployment) !== to.image || !rolloutCurrent(deployment)) {
				if (now < deadline && !progressDeadlineExceeded(deployment))
					return { _tag: 'updating', from, to, startedAt } satisfies Phase;
				return yield* restore(
					state,
					update,
					trouble === 'unhealthy' ? 'unhealthy' : 'rollout-failed'
				);
			}
			const observed = instruction.observed;
			const fromNewRelease = observed !== null && observed.version === to.version;
			if (fromNewRelease && observed.online_at !== null && observed.accepted_at !== null)
				return yield* complete(update);
			if (now >= deadline)
				return yield* restore(
					state,
					update,
					!fromNewRelease || observed.online_at === null ? 'no-presence' : 'no-reconcile'
				);
			return { _tag: 'verifying', from, to, deadline } satisfies Phase;
		});

		/**
		 * Applies `bundle` over the running release. `adopt`: the bundle is the
		 * running release (installed by Helm), applied without a gate.
		 */
		const start = Effect.fnUntraced(function* (args: {
			readonly state: BundleState;
			readonly bundle: Bundle;
			readonly running: Release;
			readonly adopt: boolean;
			readonly verifySeconds: number;
		}) {
			const { state, bundle, running } = args;
			const placementId = bundle.placement.placement_id;
			const now = yield* Clock.currentTimeMillis;
			const { applySetId, inventory } = yield* applySet(placementId);
			const [objects = [], previous = []] = yield* plan(
				[bundle.objects, state.current?.objects ?? []],
				applySetId
			);
			const previousByKey = new Map(previous.map((object) => [object.key, object]));
			const reviewed = yield* deniedOf(objects);
			const missing = new Map<string, Review>();
			for (const { object, denied } of reviewed) {
				if (denied.length === 0 || args.adopt) continue;
				const before = previousByKey.get(object.key);
				// The customer's rights: an unchanged object stays as the customer's install left it.
				if (before !== undefined && sameContent(before.manifest, object.manifest)) continue;
				for (const review of denied) missing.set(attributesKey(review), review);
			}
			const [first, ...rest] = [...missing.values()].slice(0, 64);
			if (first !== undefined) {
				yield* report(placementId, bundle.placement.generation, {
					_tag: 'access-denied',
					missing: [first, ...rest],
					message: `Agent release ${bundle.release.version} needs ${missing.size} permission(s) the cluster's grant to akua-system/akua-apply does not include.`
				});
				return {
					_tag: 'needs-customer-upgrade',
					running,
					to: bundle.release,
					missing: [first, ...rest],
					at: now
				} satisfies Phase;
			}
			const allowed = reviewed
				.filter((entry) => entry.denied.length === 0)
				.map((entry) => entry.object);
			const entries = allowed.map((object) => object.entry);

			if (args.adopt) {
				yield* writeParent(placementId, applySetId, running, unionInventory(inventory, entries));
				const applied = yield* apply(applySetId, allowed);
				if (applied.failure !== null) {
					yield* Effect.logWarning('bundle of the running release not adopted').pipe(
						Effect.annotateLogs({ message: applied.failure.message })
					);
					return { _tag: 'steady', running } satisfies Phase;
				}
				yield* writeParent(placementId, applySetId, running, entries);
				yield* report(placementId, bundle.placement.generation, {
					_tag: 'ready',
					revision: bundle.placement.source.revision,
					health: 'healthy',
					objects: [],
					corrected: []
				});
				yield* writeState({ current: { release: running, objects: bundle.objects } });
				return { _tag: 'steady', running } satisfies Phase;
			}

			// The rollback target is in the cluster before anything changes.
			const current = state.current ?? { release: running, objects: yield* snapshot(allowed) };
			const kept = new Set(
				state.current === null
					? (yield* plan([current.objects], applySetId)).flat().map((object) => object.key)
					: previous.map((object) => object.key)
			);
			const update: typeof BundleUpdate.Type = {
				from: running,
				to: bundle.release,
				startedAt: now,
				deadline: now + args.verifySeconds * 1000,
				placementId,
				generation: bundle.placement.generation,
				revision: bundle.placement.source.revision,
				objects: bundle.objects,
				planned: objects.map((object) => object.entry),
				applied: entries,
				created: entries.filter((entry) => !kept.has(entry.key)),
				appliedAt: null
			};
			yield* writeState(state.current === null ? { current, update } : { update });
			yield* Effect.logInfo('agent update started').pipe(
				Effect.annotateLogs({ from: running.version, to: bundle.release.version })
			);
			return yield* applyUpdate({ ...state, current }, update);
		});

		const step = Effect.fn('AgentUpdater.step')(function* (args: {
			readonly instruction: Instruction;
			readonly running: Release;
		}) {
			const state = yield* readState;
			if (state.update !== null) return yield* follow(state, state.update, args.instruction);

			const rejection = state['rolled-back'];
			const desired = args.instruction.desired;
			const offered =
				desired !== null &&
				desired.image !== args.running.image &&
				rejection?.rejected.image !== desired.image
					? desired
					: null;
			if (offered !== null || state.current === null) {
				const bundle = yield* readBundle;
				const adopt =
					bundle !== null && state.current === null && bundle.release.image === args.running.image;
				if (bundle !== null && (adopt || bundle.release.image === offered?.image))
					return yield* start({
						state,
						bundle,
						running: args.running,
						adopt,
						verifySeconds: args.instruction.verify_seconds
					});
			}
			if (rejection !== null)
				return {
					_tag: 'rolled-back',
					running: args.running,
					rejected: rejection.rejected,
					reason: rejection.reason,
					at: rejection.at
				} satisfies Phase;
			return { _tag: 'steady', running: args.running } satisfies Phase;
		});

		const inFlight = readState.pipe(
			Effect.map((state): Phase | null => {
				const update = state.update;
				if (update === null) return null;
				return update.appliedAt === null
					? { _tag: 'updating', from: update.from, to: update.to, startedAt: update.startedAt }
					: { _tag: 'verifying', from: update.from, to: update.to, deadline: update.deadline };
			})
		);

		return AgentUpdater.of({ step, inFlight });
	})
);

/**
 * What the platform pushed on the updater's own channel connection
 * (`Instruct.v1`), and whether that connection is open. The HTTP answer to
 * a phase report lands here too, so the loop always reads the newest.
 */
export class UpdaterInstructions extends Context.Service<
	UpdaterInstructions,
	{
		readonly latest: SubscriptionRef.SubscriptionRef<Instruction | null>;
		readonly channel: SubscriptionRef.SubscriptionRef<ChannelState>;
	}
>()('akua/cluster-agent/UpdaterInstructions') {
	static readonly layer = Layer.effect(
		UpdaterInstructions,
		Effect.gen(function* () {
			return UpdaterInstructions.of({
				latest: yield* SubscriptionRef.make<Instruction | null>(null),
				channel: yield* SubscriptionRef.make<ChannelState>({
					_tag: 'connecting',
					attempt: 0,
					since: 0
				})
			});
		})
	);
}

/** The updater's side of `UpdaterChannelRpcs`. */
export const updaterRpcHandlers = UpdaterChannelRpcs.toLayer(
	Effect.gen(function* () {
		const { latest } = yield* UpdaterInstructions;
		return UpdaterChannelRpcs.of({
			'Instruct.v1': (instruction) => SubscriptionRef.set(latest, instruction)
		});
	})
);

const initialInstruction: Instruction = {
	desired: null,
	verify_seconds: 300,
	observed: null
};

/** Without any push the updater looks again this often; the push is the normal path. */
const idleRecheck = Duration.minutes(15);

/**
 * The updater process: report its phase over HTTP whenever it changes,
 * take the newest instruction (the report's answer or a later push), step.
 * While an update is in flight it steps every 10 s; otherwise it waits for
 * the next push. While its channel is down the platform's observations are
 * unknown, not absent: an outage never rolls back a release it could not
 * see.
 */
export const updaterLoop = (updaterVersion: string) =>
	Effect.gen(function* () {
		const api = yield* AgentApi;
		const updater = yield* AgentUpdater;
		const kubernetes = yield* UpdaterKubernetes;
		const { latest, channel } = yield* UpdaterInstructions;
		let reported: string | null = null;
		let phase: Phase | null = null;
		while (true) {
			const deployment = yield* kubernetes.getAgentDeployment.pipe(Effect.result);
			const running = Result.isSuccess(deployment)
				? runningRelease(deployment.success, 'unknown')
				: Option.none<Release>();
			if (Option.isNone(running)) {
				yield* Effect.logWarning('agent Deployment not readable; retrying');
				yield* Effect.sleep(Duration.seconds(15));
				continue;
			}
			const current: Phase = phase ??
				(yield* updater.inFlight) ?? { _tag: 'steady', running: running.value };
			const key = JSON.stringify(current);
			let unreported = key !== reported;
			if (unreported) {
				const answered = yield* api
					.updaterPhase({ payload: { updater_version: updaterVersion, phase: current } })
					.pipe(Effect.result);
				if (Result.isSuccess(answered)) {
					yield* SubscriptionRef.set(latest, answered.success);
					reported = key;
					unreported = false;
				} else {
					yield* Effect.logWarning('updater phase not reported').pipe(
						Effect.annotateLogs({ reason: answered.failure._tag })
					);
				}
			}
			const open = (yield* SubscriptionRef.get(channel))._tag === 'open';
			if (current._tag === 'verifying' && (unreported || !open)) {
				yield* Effect.sleep(Duration.seconds(10));
				continue;
			}
			const instruction = (yield* SubscriptionRef.get(latest)) ?? initialInstruction;
			phase = yield* updater
				.step({ instruction, running: running.value })
				.pipe(
					Effect.catchDefect((defect) =>
						Effect.logWarning('updater step failed').pipe(
							Effect.annotateLogs({ defect: String(defect) }),
							Effect.as(current)
						)
					)
				);
			if (phase._tag === 'updating' || phase._tag === 'verifying') {
				yield* Effect.sleep(Duration.seconds(10));
				continue;
			}
			if (JSON.stringify(phase) !== reported) continue;
			// Settled: wait for the platform's next instruction.
			yield* SubscriptionRef.changes(latest).pipe(
				Stream.drop(1),
				Stream.runHead,
				Effect.timeoutOption(idleRecheck)
			);
		}
	});
