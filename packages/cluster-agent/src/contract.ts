import { Context, Effect, Schema, Stream } from 'effect';
import type { Layer } from 'effect';
import type { HttpClient, HttpClientError } from 'effect/http';
import ids from '@platform/ids';
import {
	AgentRelease,
	ClusterUid,
	DesiredPlacement,
	ObjectKey,
	ObjectStatus,
	ResourceNode,
	WarningEvent,
	PlacementReport,
	UpdaterInstruction,
	UpdaterPhase
} from '@platform/api-contract/services/cluster-agent';
import { Secret } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/Secret';
import { Node } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/Node';
import { SelfSubjectAccessReview } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/authorization.k8s.io/v1/SelfSubjectAccessReview';
import { SelfSubjectRulesReview } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/authorization.k8s.io/v1/SelfSubjectRulesReview';
import type { ClusterRole } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/rbac.authorization.k8s.io/v1/ClusterRole';
import type { Role } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/rbac.authorization.k8s.io/v1/Role';
import type { Deployment } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/apps/v1/Deployment';

/**
 * Proposal: the in-cluster agent's own contract, to live in
 * oss/akua/packages/cluster-agent. Orchestration is TypeScript and Effect
 * (one Bun binary, like the private ingress gateway). Applying is done by
 * an embedded Go engine, `akua-apply`, built only from fluxcd/pkg/ssa and
 * fluxcd/cli-utils (kstatus, object) and shipped in the same image: no Flux
 * controllers, no CRDs, invisible to customers. Inventory is a KEP-3659
 * ApplySet with a Secret parent. Kubernetes types are the generated schemas
 * of @platform/kubernetes-schemas; the agent's own API calls use the Effect
 * HTTP client.
 */

export const agentNamespace = 'akua-system';
/** Runs the agent; holds only the permissions in `agentClusterRole` and `agentRole`. */
export const agentServiceAccount = 'akua-agent';
/** Impersonated for every apply and prune; the customer's RoleBindings to it are the authority. */
export const applyServiceAccount = 'akua-apply';
/** Runs the updater; applies the agent bundle as `akua-apply` and keeps its own state Secret. */
export const updaterServiceAccount = 'akua-agent-updater';
export const agentDeployment = 'akua-agent';
export const updaterDeployment = 'akua-agent-updater';
/**
 * User-Agent of every request the agent makes: to the platform, to the git
 * origin and to the customer's kube-apiserver, and passed to the engine for
 * its own kube-apiserver requests (`rest.Config.UserAgent`). RFC 9110
 * product and comment, like the CLI's `buildUserAgent`. For diagnostics,
 * logs and edge blocking of a broken release only, never for
 * authorization; the authoritative version is `release` in the channel's Hello.
 */
/** The Kubernetes distribution, detected from the server version or set by the chart. */
export const Distribution = Schema.Literals([
	'k0s',
	'k3s',
	'kubeadm',
	'eks',
	'gke',
	'aks',
	'other'
]);

export const agentUserAgent = (args: {
	readonly version: string;
	readonly distribution: typeof Distribution.Type;
	readonly kubernetesVersion: string;
	readonly arch: string;
}): string =>
	`akua-cluster-agent/${args.version} (${args.distribution}; k8s ${args.kubernetesVersion}; ${args.arch})`;

export const updaterUserAgent = (version: string): string => `akua-agent-updater/${version}`;

/**
 * The one HttpClient layer agent and updater build every request on, as
 * oss/akua/packages/cli/src/runtime/http-client-live.ts `AkuaHttpClientLive`
 * does for the CLI: FetchHttpClient plus `HttpClient.mapRequest` setting
 * User-Agent, so no call site sets it itself. KubernetesApi uses it too.
 */
export type AgentHttpClientLive = (userAgent: string) => Layer.Layer<HttpClient.HttpClient>;

/** One field manager for every object the agent applies (kustomize-controller uses its controller name). */
export const fieldManager = 'akua-agent';

/** ApplySet keys as kubectl v1.37.1 writes them (applyset.go), not the KEP text's older spelling. */
export const applySetLabels = {
	id: 'applyset.kubernetes.io/id',
	partOf: 'applyset.kubernetes.io/part-of'
} as const;
export const applySetAnnotations = {
	tooling: 'applyset.kubernetes.io/tooling',
	containsGroupKinds: 'applyset.kubernetes.io/contains-group-kinds',
	additionalNamespaces: 'applyset.kubernetes.io/additional-namespaces'
} as const;

/**
 * `applyset-` + base64url(sha256(`<name>.<namespace>.Secret.`)) + `-v1`, the
 * kubectl `ID()` formula; verified on every read, a mismatch is a conflict.
 */
export const ApplySetId = Schema.String.check(
	Schema.isPattern(/^applyset-[A-Za-z0-9_-]{43}-v1$/)
).pipe(Schema.brand('ApplySetId'));

/** `akua-agent/<semver>`; kubectl and other tools refuse to mutate this set. */
export const ApplySetTooling = Schema.TemplateLiteral(['akua-agent/', Schema.String]);

/**
 * One parent per Placement: Secret `akua-applyset-<placement>` in the
 * Placement's namespace, with the ApplySet id label and annotations. Its
 * data key `inventory` holds the exact member list (ObjectKey plus API
 * version), the Flux inventory, so members that lost their `part-of` label
 * are still pruned. A Secret keeps it out of list-style reads.
 */
export const ApplySetParent = Secret;
export const InventoryEntry = Schema.Struct({ key: ObjectKey, version: Schema.NonEmptyString });
export const Inventory = Schema.Array(InventoryEntry).check(Schema.isMaxLength(5000));

/** The embedded engine's actions: fluxcd/pkg/ssa `Action` values (changeset.go). */
export const ChangeAction = Schema.Literals([
	'created',
	'configured',
	'unchanged',
	'deleted',
	'skipped',
	'unknown'
]);
export const ChangeEntry = Schema.Struct({
	key: ObjectKey,
	version: Schema.NonEmptyString,
	action: ChangeAction
});

export class KubernetesFailure extends Schema.TaggedError<
	KubernetesFailure,
	{ readonly brand: unique symbol }
>()('KubernetesFailure', {
	reason: Schema.Literals([
		'forbidden',
		'not-found',
		'conflict',
		'invalid',
		'unavailable',
		'timeout'
	]),
	status: Schema.Int,
	message: Schema.String.check(Schema.isMaxLength(2048))
}) {}

/** An arbitrary rendered manifest; the engine decodes it as unstructured.Unstructured. */
export const Manifest = Schema.JsonObject;

/**
 * cli-utils v1.4.0 caches every watched object in full: `Watch` hardcodes
 * `NewDynamicInformerFactory` (default_status_watcher.go:99), the reporter
 * holds the concrete `*DynamicInformerFactory` and the allow-list filter
 * runs after the cache (object_status_reporter.go:486). Without a fix,
 * managedFields and every Secret value of a watched namespace sit in agent
 * memory. The engine therefore builds against cli-utils with `patch`, which
 * gives the factory and `DefaultStatusWatcher` a `cache.TransformFunc` and
 * `TweakListOptions`:
 * - the transform removes `stripped` before an object is cached; kstatus
 *   reads none of them;
 * - `memberSelector` narrows list and watch to ApplySet members when the
 *   Placement does not own its namespace (`WatchedPlacement.namespaceExclusive`
 *   false, connected clusters).
 * `safetyNet` is not the bound, only the backstop: past `maxWatchedObjects`
 * the engine reports `overloaded`, stops live status until it restarts
 * and the agent falls back to snapshots after each reconcile. There is no
 * hysteresis: with live status stopped the cache no longer measures the
 * watched set, so a lower threshold would only restart and stop it again.
 * Follow-up: upstream the factory hooks to
 * fluxcd/cli-utils and drop the patch once released.
 */
export const informerCache = {
	patch:
		'oss/akua/third_party/fluxcd-cli-utils/patches/0001-watcher-informer-transform-and-list-options.patch',
	stripped: [
		'metadata.managedFields',
		'metadata.annotations[kubectl.kubernetes.io/last-applied-configuration]',
		'Secret.data',
		'Secret.stringData',
		'ConfigMap.data',
		'ConfigMap.binaryData'
	],
	memberSelector: (applySetId: typeof ApplySetId.Type) => `${applySetLabels.partOf}=${applySetId}`,
	safetyNet: { goMemLimitMiB: 96, maxWatchedObjects: 2000 }
} as const;

export const WatchedPlacement = Schema.Struct({
	placementId: ids.placement.prefixedEffect,
	generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	applySetId: ApplySetId,
	namespaces: Schema.Array(Schema.String.check(Schema.isMaxLength(63))).check(
		Schema.isMaxLength(16)
	),
	/** false: other workloads share the namespace, so informers list only `informerCache.memberSelector`. */
	namespaceExclusive: Schema.Boolean,
	inventory: Inventory
});

/** The service account every engine request impersonates; the engine refuses any other. */
export const engineImpersonation =
	`system:serviceaccount:${agentNamespace}:${applyServiceAccount}` as const;

/**
 * Inside the agent image (`AgentImage`), next to the agent binary; there is
 * no separate engine image or download, so the engine updates and rolls
 * back with the agent's release.
 */
export const enginePath = '/usr/local/bin/akua-apply';

/**
 * `akua-apply serve`: the only engine process, one per agent, long-running,
 * with no network listener. A Go binary in the agent image built only from
 * fluxcd/pkg/ssa and fluxcd/cli-utils (with `informerCache.patch`); it runs
 * no controller and installs no CRD. It speaks NDJSON: `EngineRequest` on
 * stdin, `EngineMessage` on stdout, logs on stderr.
 *
 * One rest.Config impersonating `engineImpersonation`, with `UserAgent` set
 * to the agent's `--user-agent` argument, and one informer
 * cache, built with the patched factory (transform, member selector), serve
 * every request:
 * - the cli-utils `DefaultStatusWatcher` gets the cache as its informer
 *   factory and as `ClusterReader` for generated children (Deployment ->
 *   ReplicaSet -> Pod, StatefulSet -> Pod);
 * - the ssa `ResourceManager` waits through `polling.NewStatusPoller` over a
 *   controller-runtime `client.Reader` on the same cache, so `wait` costs no
 *   extra watch or poll against the API server;
 * - informers start lazily for any (kind, namespace) read and stop when no
 *   subscribed Placement or in-flight request needs them.
 * The engine adds namespace-scoped informers only for Pods (container and
 * scheduling reasons), Jobs owned by CronJobs and Warning Events
 * (`fieldSelector type=Warning`), and resolves PersistentVolumes of bound
 * claims by GET.
 *
 * Requests for one `applySetId` run in arrival order, different ApplySets
 * concurrently. The engine never reads or writes an ApplySet parent: the TS
 * agent is the only inventory writer, widens the parent before `apply`,
 * computes the stale set itself and shrinks the parent after `prune`
 * (KEP-3659 superset-then-shrink).
 */
export const RequestId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
	Schema.brand('EngineRequestId')
);

export const EngineRequest = Schema.Union([
	/**
	 * `ResourceManager.ApplyAllStaged` with `Owner.Field = fieldManager`.
	 * Every manifest already carries the ApplySet `part-of` label; the engine
	 * refuses any object without it. Before any write it reads every object
	 * (shared cache, else GET); one that exists with another ApplySet's
	 * `part-of` label fails the whole request with `applyset-conflict` and
	 * that object, and is never adopted or overwritten. Server-side apply
	 * would not report it, since all Placements share `fieldManager`.
	 */
	Schema.TaggedStruct('apply', {
		id: RequestId,
		applySetId: ApplySetId,
		fieldManager: Schema.Literal(fieldManager),
		impersonate: Schema.Literal(engineImpersonation),
		manifests: Schema.Array(Manifest).check(Schema.isMaxLength(5000)),
		/** false: the same commit as the last successful pass, so every `configured` is a drift correction. */
		revisionChanged: Schema.Boolean,
		/** ssa `ApplyOptions.ForceSelector`: recreate on immutable-field errors only for opted-in objects. */
		forceSelector: Schema.Record(Schema.String, Schema.String),
		/** ssa `ApplyOptions.ExclusionSelector`: customer opt-out. */
		exclusionSelector: Schema.Record(Schema.String, Schema.String),
		timeoutSeconds: Schema.Int.check(
			Schema.isGreaterThanOrEqualTo(10),
			Schema.isLessThanOrEqualTo(600)
		)
	}),
	/**
	 * `ResourceManager.Delete` per `stale` entry in `DeleteAll` order with
	 * `DeleteOptions.Exclusions` = `exclusionSelector` and no label
	 * inclusion: the inventory decides membership, so members that lost
	 * their `part-of` label are pruned too; an excluded object is neither
	 * deleted nor a survivor. The agent computes `stale` (previous inventory
	 * minus applied, cli-utils `ObjMetadataSet.Diff` semantics); removing a
	 * Placement prunes its whole inventory.
	 */
	Schema.TaggedStruct('prune', {
		id: RequestId,
		applySetId: ApplySetId,
		impersonate: Schema.Literal(engineImpersonation),
		stale: Inventory,
		exclusionSelector: Schema.Record(Schema.String, Schema.String),
		timeoutSeconds: Schema.Int.check(
			Schema.isGreaterThanOrEqualTo(10),
			Schema.isLessThanOrEqualTo(600)
		)
	}),
	/**
	 * `current`: `ResourceManager.WaitForSetWithContext`, then kstatus
	 * `status.Compute` per member. `terminated`: `WaitForTermination` after a
	 * full prune. Both read only the shared cache.
	 */
	Schema.TaggedStruct('wait', {
		id: RequestId,
		applySetId: ApplySetId,
		members: Inventory,
		until: Schema.Literals(['current', 'terminated']),
		intervalSeconds: Schema.Int.check(
			Schema.isGreaterThanOrEqualTo(1),
			Schema.isLessThanOrEqualTo(60)
		),
		timeoutSeconds: Schema.Int.check(
			Schema.isGreaterThanOrEqualTo(30),
			Schema.isLessThanOrEqualTo(3600)
		),
		failFast: Schema.Boolean
	}),
	/** Replaces the whole live-status set; sent after every inventory change and after each engine start. */
	Schema.TaggedStruct('subscribe', {
		id: RequestId,
		impersonate: Schema.Literal(engineImpersonation),
		placements: Schema.Array(WatchedPlacement).check(Schema.isMaxLength(500))
	}),
	/** Finish in-flight requests up to their timeouts, answer `stopping`, exit 0. */
	Schema.TaggedStruct('shutdown', { id: RequestId })
]);

export const EngineFailure = Schema.Struct({
	stage: Schema.Literals(['decode', 'definitions', 'classes', 'resources', 'prune', 'health']),
	reason: Schema.Literals([
		'forbidden',
		'immutable',
		'invalid',
		'conflict',
		'applyset-conflict',
		'unhealthy',
		'timeout',
		'unavailable'
	]),
	object: Schema.NullOr(ObjectKey),
	message: Schema.String.check(Schema.isMaxLength(4096))
});

/** Answers, exactly one per request, correlated by `id`. */
export const EngineResponse = Schema.Union([
	Schema.TaggedStruct('applied', {
		id: RequestId,
		changes: Schema.Array(ChangeEntry).check(Schema.isMaxLength(10_000)),
		driftCorrected: Schema.Array(ObjectKey).check(Schema.isMaxLength(5000)),
		/** null: every stage applied. A failure still lists the changes made before it. */
		failure: Schema.NullOr(EngineFailure)
	}),
	Schema.TaggedStruct('pruned', {
		id: RequestId,
		deleted: Inventory,
		/** Stale members whose delete failed; the agent keeps them in the inventory (Flux pruneSurvivors). */
		survivors: Schema.Array(
			Schema.Struct({
				entry: InventoryEntry,
				message: Schema.String.check(Schema.isMaxLength(1024))
			})
		).check(Schema.isMaxLength(5000))
	}),
	Schema.TaggedStruct('waited', {
		id: RequestId,
		health: Schema.Array(ObjectStatus).check(Schema.isMaxLength(5000)),
		failure: Schema.NullOr(EngineFailure)
	}),
	Schema.TaggedStruct('subscribed', { id: RequestId, watchedObjects: Schema.Int }),
	/** The request was not run: undecodable, wrong impersonation, or the engine is shutting down. */
	Schema.TaggedStruct('rejected', { id: RequestId, failure: EngineFailure }),
	Schema.TaggedStruct('stopping', { id: RequestId })
]);

/** Live-status events, not tied to a request. */
export const EngineEvent = Schema.Union([
	/** First line after start; the agent sends `subscribe` only after it. */
	Schema.TaggedStruct('ready', {
		protocol: Schema.Literal(1),
		version: Schema.NonEmptyString,
		ssa: Schema.NonEmptyString,
		cliUtils: Schema.NonEmptyString
	}),
	Schema.TaggedStruct('node', { placementId: ids.placement.prefixedEffect, node: ResourceNode }),
	Schema.TaggedStruct('removed', { placementId: ids.placement.prefixedEffect, key: ObjectKey }),
	Schema.TaggedStruct('warning', {
		placementId: ids.placement.prefixedEffect,
		event: WarningEvent
	}),
	/** Informers for this Placement have listed once; the agent may now send a snapshot. */
	Schema.TaggedStruct('synced', { placementId: ids.placement.prefixedEffect }),
	Schema.TaggedStruct('overloaded', { watchedObjects: Schema.Int }),
	Schema.TaggedStruct('error', {
		placementId: Schema.NullOr(ids.placement.prefixedEffect),
		reason: Schema.Literals(['forbidden', 'unavailable', 'invalid']),
		message: Schema.String.check(Schema.isMaxLength(1024))
	})
]);

/** One stdout line, decoded with effect/encoding `Ndjson.decodeSchema(EngineMessage)`. */
export const EngineMessage = Schema.Union([EngineResponse, EngineEvent]);

/** A request got no response: the engine was not found, exited, hung past the deadline or wrote an invalid line. */
export class EngineFailed extends Schema.TaggedError<
	EngineFailed,
	{ readonly brand: unique symbol }
>()('EngineFailed', {
	/** `restarted`: the engine exited while the request was in flight; apply and prune are safe to repeat. */
	reason: Schema.Literals(['spawn', 'restarted', 'timeout', 'decode']),
	exitCode: Schema.NullOr(Schema.Int),
	stderr: Schema.String.check(Schema.isMaxLength(4096))
}) {}

/** The engine answered `rejected`: it did not run the request. */
export class EngineRejected extends Schema.TaggedError<
	EngineRejected,
	{ readonly brand: unique symbol }
>()('EngineRejected', { failure: EngineFailure }) {}

/**
 * Restart policy of the `serve` process and when the agent marks live
 * status stale (LiveStaleness). A first exit restarts after
 * `firstRestartSeconds` and is not stale: the informers' first LIST brings
 * the full state back in about 1 to 2 s. An exit within
 * `crashLoopWindowSeconds` of the previous restart is a crash loop: the
 * delay doubles up to `maxRestartSeconds` and every subscribed Placement
 * gets a `stale` entry `engine-crash-looping`. Independently, a Placement
 * without `synced` `snapshotGraceSeconds` after `ready` gets
 * `engine-no-snapshot`. Running `crashLoopWindowSeconds` without an exit
 * resets the delay.
 */
export const engineSupervision = {
	firstRestartSeconds: 1,
	maxRestartSeconds: 60,
	crashLoopWindowSeconds: 300,
	snapshotGraceSeconds: 10
} as const;

type EngineRequestOf<Tag extends (typeof EngineRequest.Type)['_tag']> = Omit<
	Extract<typeof EngineRequest.Type, { readonly _tag: Tag }>,
	'_tag' | 'id' | 'impersonate' | 'fieldManager'
>;
type EngineResponseOf<Tag extends (typeof EngineResponse.Type)['_tag']> = Extract<
	typeof EngineResponse.Type,
	{ readonly _tag: Tag }
>;

/**
 * Supervises the one `akua-apply serve` process: spawned through
 * ChildProcessSpawner as `akua-apply serve --user-agent <agentUserAgent>`, requests encoded with `Ndjson.encodeSchema(EngineRequest)`
 * into stdin, stdout piped through `Ndjson.decodeSchema(EngineMessage)`
 * (Stream.pipeThroughChannel), responses matched to pending requests by `id`.
 * A request not answered within its `timeoutSeconds` plus 30 s means the
 * engine is hung: it is killed (SIGTERM, then SIGKILL) and restarted. On
 * exit every pending request fails with `EngineFailed` `restarted`, the
 * engine restarts per `engineSupervision` and, after `ready`, the current
 * `subscribe` is re-sent; each Placement's first `synced` yields a
 * snapshot. The PlacementReconciler retries a failed pass on its own
 * schedule. Events are folded per Placement into deltas and flushed as
 * StatusBatch at most every 2 s.
 */
export class Engine extends Context.Service<
	Engine,
	{
		apply(
			request: EngineRequestOf<'apply'>
		): Effect.Effect<EngineResponseOf<'applied'>, EngineFailed | EngineRejected>;
		prune(
			request: EngineRequestOf<'prune'>
		): Effect.Effect<EngineResponseOf<'pruned'>, EngineFailed | EngineRejected>;
		wait(
			request: EngineRequestOf<'wait'>
		): Effect.Effect<EngineResponseOf<'waited'>, EngineFailed | EngineRejected>;
		/** Replace the live-status set after a reconcile or a Placement change. */
		subscribe(
			request: EngineRequestOf<'subscribe'>
		): Effect.Effect<EngineResponseOf<'subscribed'>, EngineFailed | EngineRejected>;
		/** Live-status events, surviving engine restarts; one consumer, buffered from the first start. */
		readonly events: Stream.Stream<typeof EngineEvent.Type>;
	}
>()('akua/cluster-agent/Engine') {}

/**
 * Test fixtures for the LiveReason and ContainerState mapping; declared
 * here, not recorded yet. Paths are relative to the public akua module
 * (oss/akua). Both targets join the root `core_verification_roots` when
 * they land.
 *
 * `argoCd`: Argo CD's health testdata at a pinned commit, copied with its
 * Apache-2.0 LICENSE and an UPSTREAM file naming tag, commit and source
 * paths. The core fixtures (Pod crash loop, image pull back-off, pending,
 * error, failed, running not ready; Deployment, Job, PVC states) live in
 * gitops-engine/pkg/health/testdata (46 files); resource_customizations
 * holds 1293 CRD fixtures under `testdata` directories, with the expected
 * Lua verdicts in 238 `health_test.yaml` files. `reasonTest` feeds every
 * object through the engine's node builder: core fixtures must match a
 * stated LiveReason and kstatus; CRD fixtures must not report a reason
 * Argo CD would not, and kstatus differences from Argo's verdicts are kept
 * as a reviewed expectation list, not hidden.
 *
 * `recorded`: scenarios Argo CD's testdata lacks (it has no OOMKilled,
 * Unschedulable or FailedMount fixture), recorded once from `akua-apply
 * serve` stdout against a kind cluster as golden EngineMessage NDJSON plus
 * the expected LiveHealth and liveReasonFailures. `recordedTest` checks
 * that each stream decodes and shows its scenario's reasons; `goldenTest`
 * replays them through the agent's fold into LiveSnapshot; no cluster runs
 * in CI. Engine targets live in the akua module's `bazel/cluster-agent`.
 * Re-recorded only when the engine protocol changes.
 */
export const liveReasonFixtures = {
	argoCd: {
		repository: 'github.com/argoproj/argo-cd',
		tag: 'v3.5.6',
		commit: 'c2b1e3017e2cec86b122172e861dcd026453ae44',
		license: 'Apache-2.0',
		sources: [
			'gitops-engine/pkg/health/testdata/*.yaml',
			'resource_customizations/**/testdata/*.yaml'
		],
		destination: 'packages/cluster-agent/engine/testdata/argo-cd'
	},
	recorded: {
		destination: 'packages/cluster-agent/engine/testdata/kind',
		scenarios: ['bad-image', 'crash-loop-back-off', 'oom-killed', 'unschedulable', 'failed-mount']
	},
	reasonTest: '@akua//bazel/cluster-agent:live_reason_fixtures_test',
	recordedTest: '@akua//bazel/cluster-agent:recorded_scenarios_test',
	goldenTest: '//packages/cluster-agent:live_status_golden_test'
} as const;

/**
 * What the TS agent still talks to Kubernetes for, through the Effect HTTP
 * client with its projected ServiceAccount token: the ApplySet parent,
 * access reviews made while impersonating `akua-apply`, nodes, and its own
 * Secrets. All object application, pruning and waiting goes through Engine.
 */
export class KubernetesApi extends Context.Service<
	KubernetesApi,
	{
		getApplySetParent(args: {
			readonly namespace: string;
			readonly name: string;
		}): Effect.Effect<
			typeof ApplySetParent.Type | null,
			KubernetesFailure | HttpClientError.HttpClientError
		>;
		/** Server-side apply of the parent as `akua-agent`, impersonating `akua-apply`. */
		applyApplySetParent(args: {
			readonly parent: typeof ApplySetParent.Type;
		}): Effect.Effect<
			typeof ApplySetParent.Type,
			KubernetesFailure | HttpClientError.HttpClientError
		>;
		deleteApplySetParent(args: {
			readonly namespace: string;
			readonly name: string;
		}): Effect.Effect<void, KubernetesFailure | HttpClientError.HttpClientError>;
		reviewAccess(args: {
			readonly review: typeof SelfSubjectAccessReview.Type;
		}): Effect.Effect<
			typeof SelfSubjectAccessReview.Type,
			KubernetesFailure | HttpClientError.HttpClientError
		>;
		reviewRules(args: {
			readonly review: typeof SelfSubjectRulesReview.Type;
		}): Effect.Effect<
			typeof SelfSubjectRulesReview.Type,
			KubernetesFailure | HttpClientError.HttpClientError
		>;
		/** One page of nodes; `continue` is the Kubernetes list token of the next page, null on the last. */
		listNodes(args: {
			readonly limit: number;
			readonly continue: string | null;
		}): Effect.Effect<
			{ readonly nodes: ReadonlyArray<typeof Node.Type>; readonly continue: string | null },
			KubernetesFailure | HttpClientError.HttpClientError
		>;
		/** GET namespace `kube-system`, `metadata.uid` only. */
		readClusterUid(): Effect.Effect<
			typeof ClusterUid.Type,
			KubernetesFailure | HttpClientError.HttpClientError
		>;
	}
>()('akua/cluster-agent/KubernetesApi') {}

/**
 * One Placement end to end, in TS: fetch the revision, preflight with
 * SelfSubjectAccessReviews for every (group, resource, verb, namespace) the
 * manifests need, refuse a non-privileged Placement that touches DesiredState `reserved`
 * (`reserved-name`), generate missing secrets, label members, widen the parent
 * to previous plus desired, Engine `apply`, `subscribe` the widened set,
 * Engine `wait` `current`, compute stale = previous minus applied, Engine
 * `prune` `stale`, shrink the parent to applied plus survivors, `subscribe`
 * again, then the report. Removing a Placement prunes its whole inventory,
 * waits `terminated` and deletes the parent. Drift
 * correction: re-run at `reconcile_interval_seconds` with jitter; a failed
 * pass retries with exponential backoff from 750 ms to 15 min.
 */
export class PlacementReconciler extends Context.Service<
	PlacementReconciler,
	{
		reconcile(args: {
			readonly desired: typeof DesiredPlacement.Type;
		}): Effect.Effect<typeof PlacementReport.Type>;
	}
>()('akua/cluster-agent/PlacementReconciler') {}

/**
 * The updater: a second, rarely changing Deployment that applies the agent
 * bundle (the Placement marked `applier: updater`, the whole rendered
 * chart without the updater's own objects) with the agent's building
 * blocks and its own engine process. Health gate, all within
 * `verify_seconds`: the agent Deployment runs the new image and is kstatus
 * Current (its readiness probe is the agent's `/readyz`: engine `ready`
 * with the same version), and `UpdaterInstruction.observed` shows the new
 * release online on its channel and an accepted Placement report or
 * StatusBatch from it. An agent that starts but cannot apply or report is
 * rolled back (`no-reconcile`), not kept. A rollback re-applies the last
 * good bundle kept in the cluster and prunes what the new one created. The
 * updater's own objects are excluded; the agent is to apply them (not yet
 * implemented), never both at once.
 */
export class AgentUpdater extends Context.Service<
	AgentUpdater,
	{
		step(args: {
			readonly instruction: typeof UpdaterInstruction.Type;
			readonly running: typeof AgentRelease.Type;
		}): Effect.Effect<typeof UpdaterPhase.Type, HttpClientError.HttpClientError>;
		/**
		 * The update recorded in the cluster, as a phase, without acting on it:
		 * a restarted updater reports it instead of `steady`, so the platform
		 * answers with its observations before any deadline is judged.
		 */
		readonly inFlight: Effect.Effect<typeof UpdaterPhase.Type | null>;
	}
>()('akua/cluster-agent/AgentUpdater') {}

/** Read-only cluster scope for the platform's node reads; node actions run as `akua-apply`, so the customer's grant decides them. */
export const agentClusterRole = {
	apiVersion: 'rbac.authorization.k8s.io/v1',
	kind: 'ClusterRole',
	metadata: { name: 'akua-agent' },
	rules: [
		{ apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list', 'watch'] },
		/** Only to read `metadata.uid` as the ClusterUid. */
		{ apiGroups: [''], resources: ['namespaces'], resourceNames: ['kube-system'], verbs: ['get'] }
	]
} satisfies ClusterRole;

/** In akua-system only: impersonate the apply account, keep its own identity and state. */
export const agentRole = {
	apiVersion: 'rbac.authorization.k8s.io/v1',
	kind: 'Role',
	metadata: { name: 'akua-agent', namespace: agentNamespace },
	rules: [
		{
			apiGroups: [''],
			resources: ['serviceaccounts'],
			resourceNames: [applyServiceAccount],
			verbs: ['impersonate']
		},
		{
			apiGroups: [''],
			resources: ['secrets'],
			resourceNames: ['akua-agent-identity', 'akua-tunnel-connector'],
			verbs: ['get', 'update', 'patch']
		}
	]
} satisfies Role;

/** Only to read `metadata.uid` of `kube-system`, the ClusterUid its channel Hello names. */
export const updaterClusterRole = {
	apiVersion: 'rbac.authorization.k8s.io/v1',
	kind: 'ClusterRole',
	metadata: { name: 'akua-agent-updater' },
	rules: [
		{ apiGroups: [''], resources: ['namespaces'], resourceNames: ['kube-system'], verbs: ['get'] }
	]
} satisfies ClusterRole;

/**
 * In akua-system only: apply as `akua-apply` (whose grant decides what the
 * bundle may change), read the agent's rollout, keep the bundle state.
 */
export const updaterRole = {
	apiVersion: 'rbac.authorization.k8s.io/v1',
	kind: 'Role',
	metadata: { name: 'akua-agent-updater', namespace: agentNamespace },
	rules: [
		{
			apiGroups: [''],
			resources: ['serviceaccounts'],
			resourceNames: [applyServiceAccount],
			verbs: ['impersonate']
		},
		{
			apiGroups: ['apps'],
			resources: ['deployments'],
			resourceNames: [agentDeployment],
			verbs: ['get']
		},
		{ apiGroups: ['apps'], resources: ['replicasets'], verbs: ['get', 'list'] },
		{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
		{
			apiGroups: [''],
			resources: ['secrets'],
			resourceNames: ['akua-agent-identity'],
			verbs: ['get']
		},
		{
			apiGroups: [''],
			resources: ['secrets'],
			resourceNames: ['akua-agent-bundle'],
			verbs: ['get', 'update', 'patch']
		}
	]
} satisfies Role;

/** The agent Deployment whose rollout the updater gates. */
export type AgentDeployment = Deployment;

/**
 * Identity material the agent keeps in `akua-system/akua-agent-identity`;
 * the key never leaves it. On start an intact Secret wins over any
 * mounted enrollment code; only a missing or undecodable Secret makes the
 * agent enroll again (repair, see Cluster `AgentInstallCommand`).
 */
export const AgentIdentitySecret = Schema.Struct({
	agentId: ids.clusterAgent.prefixedEffect,
	privateKey: Schema.Redacted(Schema.NonEmptyString),
	previousPrivateKey: Schema.optionalKey(Schema.Redacted(Schema.NonEmptyString))
});
