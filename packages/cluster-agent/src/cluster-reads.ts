import { Clock, Effect, Schema } from 'effect';
import { ClusterNamespace } from '@platform/api-contract/ClusterNamespace';
import type { AgentNode, GrantedAccess } from '@platform/api-contract/services/cluster-agent';
import type { NodePage } from '@platform/api-contract/services/cluster-agent-channel';
import type { Node } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/Node';
import { type Distribution, KubernetesApi } from './contract';

type Namespace = typeof ClusterNamespace.Type;

/**
 * What the platform reads from the cluster on demand over the channel
 * (`ListNodes.v1`, `GetAccess.v1`), and the distribution the User-Agent
 * names. Nothing here is sent unless the platform asks.
 */

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

/** One page of trimmed nodes, as `ListNodes.v1` answers. */
export const listNodePage = Effect.fn('ClusterReads.listNodePage')(function* (args: {
	readonly limit: number;
	readonly continue: string | null;
}) {
	const kubernetes = yield* KubernetesApi;
	const page = yield* kubernetes.listNodes(args);
	return {
		nodes: page.nodes.map(trimNode),
		continue: page.continue
	} satisfies typeof NodePage.Type;
});

const isClusterNamespace = Schema.is(ClusterNamespace);

/**
 * The customer's grant as Kubernetes evaluates it for `akua-apply`: one
 * rules review per namespace plus one without a namespace. Scope is
 * `cluster` when `*` on `*` is allowed cluster-wide; otherwise the
 * namespaces whose review holds a resource rule beyond the self-review
 * defaults every authenticated user has.
 */
export const reviewGrantedAccess = Effect.fn('ClusterReads.reviewGrantedAccess')(function* (
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
	const unique = [...new Set(namespaces.filter(isClusterNamespace))].slice(0, 256);
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
					// One failed review must not cost the others; it is simply absent.
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
