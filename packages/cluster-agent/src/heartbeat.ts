import { Clock, Context, Duration, Effect, Layer, Option, Ref, Schedule, Schema } from 'effect';
import { ClusterNamespace } from '@platform/api-contract/ClusterNamespace';
import type {
	AgentNode,
	GrantedAccess,
	Heartbeat
} from '@platform/api-contract/services/cluster-agent';
import type { Node } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/Node';
import { AcceptedTracker } from './accepted';
import { AgentConfig, type Distribution } from './config';
import { KubernetesApi } from './contract';
import { KubernetesExtras } from './kubernetes';
import { AgentApi } from './platform';

type Namespace = typeof ClusterNamespace.Type;

/** The distribution from the server's gitVersion; the chart value wins when set. */
export const detectDistribution = (
	gitVersion: string,
	nodes: ReadonlyArray<typeof Node.Type>
): typeof Distribution.Type => {
	if (gitVersion.includes('+k0s')) return 'k0s';
	if (gitVersion.includes('+k3s')) return 'k3s';
	if (gitVersion.includes('-eks-')) return 'eks';
	if (gitVersion.includes('-gke.')) return 'gke';
	if (nodes.some((node) => node.metadata?.labels?.['kubernetes.azure.com/cluster'] !== undefined)) {
		return 'aks';
	}
	if (
		nodes.some(
			(node) => node.metadata?.labels?.['node-role.kubernetes.io/control-plane'] !== undefined
		)
	) {
		return 'kubeadm';
	}
	return 'other';
};

/** Trimmed to metadata.name, metadata.labels, status.conditions and status.nodeInfo. */
export const trimNode = (node: typeof Node.Type): typeof AgentNode.Type => ({
	apiVersion: 'v1',
	kind: 'Node',
	metadata: {
		...(node.metadata?.name !== undefined && { name: node.metadata.name }),
		...(node.metadata?.labels !== undefined && { labels: node.metadata.labels })
	},
	status: {
		...(node.status?.conditions !== undefined && { conditions: node.status.conditions }),
		...(node.status?.nodeInfo !== undefined && { nodeInfo: node.status.nodeInfo })
	}
});

const isClusterNamespace = Schema.is(ClusterNamespace);

/** Namespaces the agent has reason to review: the chart's grant and every Placement's. */
export class WatchedNamespaces extends Context.Service<
	WatchedNamespaces,
	{
		readonly set: (namespaces: ReadonlyArray<string>) => Effect.Effect<void>;
		readonly get: Effect.Effect<ReadonlyArray<Namespace>>;
	}
>()('akua/cluster-agent/WatchedNamespaces') {
	static readonly layer = Layer.effect(
		WatchedNamespaces,
		Effect.gen(function* () {
			const ref = yield* Ref.make<ReadonlyArray<Namespace>>([]);
			return WatchedNamespaces.of({
				set: (namespaces) => Ref.set(ref, namespaces.filter(isClusterNamespace)),
				get: Ref.get(ref)
			});
		})
	);
}

/**
 * The customer's grant as Kubernetes evaluates it for `akua-apply`: one
 * rules review per namespace plus one without a namespace. Scope is
 * `cluster` when `*` on `*` is allowed cluster-wide; otherwise the
 * namespaces whose review holds a resource rule beyond the self-review
 * defaults every authenticated user has.
 */
export const reviewGrantedAccess = Effect.fn('Heartbeat.reviewGrantedAccess')(function* (
	namespaces: ReadonlyArray<Namespace>
) {
	const kubernetes = yield* KubernetesApi;
	const access = (verb: string, group: string, resource: string) =>
		kubernetes
			.reviewAccess({
				review: {
					apiVersion: 'authorization.k8s.io/v1',
					kind: 'SelfSubjectAccessReview',
					spec: { resourceAttributes: { verb, group, resource } }
				}
			})
			.pipe(
				Effect.map((review) => review.status?.allowed === true),
				Effect.orElseSucceed(() => false)
			);
	const clusterWide = yield* access('*', '*', '*');
	const createNamespaces = yield* access('create', '', 'namespaces');
	const unique = [...new Set(namespaces)].slice(0, 256);
	const reviews = yield* Effect.forEach(
		[null, ...unique],
		(namespace) =>
			kubernetes
				.reviewRules({
					review: {
						apiVersion: 'authorization.k8s.io/v1',
						kind: 'SelfSubjectRulesReview',
						spec: { namespace: namespace ?? '' }
					}
				})
				.pipe(
					Effect.map((review) => [{ namespace, review }]),
					// One failed review must not cost the heartbeat; it is simply absent.
					Effect.orElseSucceed(() => [])
				),
		{ concurrency: 8 }
	).pipe(Effect.map((all) => all.flat()));
	const granted = reviews.flatMap(({ namespace, review }) =>
		namespace !== null &&
		(review.status?.resourceRules ?? []).some(
			(rule) => !(rule.apiGroups ?? []).every((group) => group === 'authorization.k8s.io')
		)
			? [namespace]
			: []
	);
	const now = yield* Clock.currentTimeMillis;
	const [first, ...rest] = granted.length > 0 ? granted : unique;
	const scope: (typeof GrantedAccess.Type)['scope'] =
		clusterWide || first === undefined
			? { _tag: 'cluster' }
			: { _tag: 'namespaces', namespaces: [first, ...rest] };
	return {
		scope,
		createNamespaces,
		reviews,
		observedAt: now
	} satisfies typeof GrantedAccess.Type;
});

/** The desired-state revision the agent has fully applied or reported. */
export class DesiredRevision extends Context.Service<
	DesiredRevision,
	{
		readonly set: (revision: number) => Effect.Effect<void>;
		readonly get: Effect.Effect<number>;
	}
>()('akua/cluster-agent/DesiredRevision') {
	static readonly layer = Layer.effect(
		DesiredRevision,
		Effect.gen(function* () {
			const ref = yield* Ref.make(0);
			return DesiredRevision.of({ set: (revision) => Ref.set(ref, revision), get: Ref.get(ref) });
		})
	);
}

export const buildHeartbeat = Effect.fn('Heartbeat.build')(function* () {
	const config = yield* AgentConfig;
	const kubernetes = yield* KubernetesApi;
	const extras = yield* KubernetesExtras;
	const watched = yield* WatchedNamespaces;
	const accepted = yield* AcceptedTracker;
	const revision = yield* DesiredRevision;
	const clusterUid = yield* kubernetes.readClusterUid();
	// Everything but the cluster UID degrades instead of failing: a missed
	// heartbeat makes the updater roll back a release that works.
	const gitVersion = yield* extras.readVersion().pipe(Effect.orElseSucceed(() => 'unknown'));
	const nodes = yield* kubernetes.listNodes().pipe(Effect.orElseSucceed(() => []));
	const namespaces = [...config.accessNamespaces, ...(yield* watched.get)];
	const access = yield* reviewGrantedAccess(namespaces);
	return {
		release: config.release,
		cluster_uid: clusterUid,
		kubernetes_version: gitVersion.slice(0, 64),
		distribution: Option.getOrElse(config.distribution, () =>
			detectDistribution(gitVersion, nodes)
		),
		access,
		nodes: nodes.slice(0, 1000).map(trimNode),
		desired_revision: yield* revision.get,
		last_accepted: yield* accepted.lastAccepted
	} satisfies typeof Heartbeat.Type;
});

/** Sends a heartbeat now and then at the interval the platform answers; failures retry sooner. */
export const heartbeatLoop = Effect.gen(function* () {
	const api = yield* AgentApi;
	let nextSeconds = 30;
	while (true) {
		const outcome = yield* buildHeartbeat().pipe(
			Effect.flatMap((payload) => api.heartbeat({ payload })),
			Effect.result
		);
		if (outcome._tag === 'Success') {
			nextSeconds = outcome.success.next_heartbeat_seconds;
		} else {
			yield* Effect.logWarning('heartbeat failed').pipe(
				Effect.annotateLogs({ reason: outcome.failure._tag })
			);
		}
		yield* Effect.sleep(
			Duration.seconds(outcome._tag === 'Success' ? nextSeconds : Math.min(nextSeconds, 15))
		);
	}
}).pipe(Effect.retry(Schedule.spaced('15 seconds')));
