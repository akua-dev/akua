import { Context, Effect, Layer, Ref, Stream } from 'effect';
import type { Schema } from 'effect';
import { ClusterUid } from '@platform/api-contract/services/cluster-agent';
import type { Secret } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/Secret';
import type { Node } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/Node';
import type { EventList } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/EventList';
import type { PodList } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/PodList';
import { KubernetesApi, KubernetesFailure } from '../contract';
import { type DiscoveredResource, KubernetesExtras } from '../kubernetes';

/**
 * An in-memory kube-apiserver for the calls the agent makes itself:
 * Secrets by namespace and name, nodes, discovery, version and access
 * reviews decided by `allow`.
 */
export interface FakeKubernetesState {
	readonly secrets: ReadonlyMap<string, typeof Secret.Type>;
	readonly nodes: ReadonlyArray<typeof Node.Type>;
	readonly clusterUid: string;
	readonly gitVersion: string;
	readonly discovery: ReadonlyMap<string, ReadonlyMap<string, DiscoveredResource>>;
	/** Decides SelfSubjectAccessReviews made as akua-apply. */
	readonly allow: (attributes: {
		readonly verb: string;
		readonly group: string;
		readonly resource: string;
		readonly namespace: string;
	}) => boolean;
	readonly rulesNamespaces: ReadonlySet<string>;
	/** Pods for drains, as listed by node. */
	readonly pods: (typeof PodList.Type)['items'];
	/** Pods whose eviction a PodDisruptionBudget refuses (`namespace/name`). */
	readonly evictionBlocked: ReadonlySet<string>;
	/** Objects by `apiVersion|resource|namespace|name` (namespace empty when cluster-scoped). */
	readonly objects: ReadonlyMap<string, typeof Schema.JsonObject.Type>;
	readonly events: (typeof EventList.Type)['items'];
	/** Log text by `namespace/pod/container`. */
	readonly logs: ReadonlyMap<string, string>;
}

export const objectKey = (args: {
	readonly apiVersion: string;
	readonly resource: string;
	readonly namespace: string | null;
	readonly name: string;
}) => [args.apiVersion, args.resource, args.namespace ?? '', args.name].join('|');

export class FakeKubernetes extends Context.Service<
	FakeKubernetes,
	{ readonly state: Ref.Ref<FakeKubernetesState> }
>()('akua/cluster-agent/testing/FakeKubernetes') {}

const key = (namespace: string, name: string) => `${namespace}/${name}`;

export const defaultDiscovery: ReadonlyMap<
	string,
	ReadonlyMap<string, DiscoveredResource>
> = new Map([
	[
		'v1',
		new Map([
			['ConfigMap', { resource: 'configmaps', namespaced: true }],
			['Secret', { resource: 'secrets', namespaced: true }],
			['Service', { resource: 'services', namespaced: true }],
			['Namespace', { resource: 'namespaces', namespaced: false }]
		])
	],
	['apps/v1', new Map([['Deployment', { resource: 'deployments', namespaced: true }]])],
	[
		'rbac.authorization.k8s.io/v1',
		new Map([['ClusterRole', { resource: 'clusterroles', namespaced: false }]])
	]
]);

export const fakeKubernetesState = (
	overrides: Partial<FakeKubernetesState> = {}
): FakeKubernetesState => ({
	secrets: new Map([
		[
			key('akua-system', 'akua-agent-identity'),
			{
				apiVersion: 'v1',
				kind: 'Secret',
				metadata: { name: 'akua-agent-identity', namespace: 'akua-system' }
			}
		]
	]),
	nodes: [],
	clusterUid: '6f1c1b0e-2f4b-4b7a-9d0e-0c6b1f2a3d4e',
	gitVersion: 'v1.34.1+k0s',
	discovery: defaultDiscovery,
	allow: () => true,
	rulesNamespaces: new Set(),
	pods: [],
	evictionBlocked: new Set(),
	objects: new Map(),
	events: [],
	logs: new Map(),
	...overrides
});

export const fakeKubernetesLayer = (initial: FakeKubernetesState = fakeKubernetesState()) =>
	Layer.effectContext(
		Effect.gen(function* () {
			const state = yield* Ref.make(initial);
			const read = (namespace: string, name: string) =>
				Ref.get(state).pipe(
					Effect.map((current) => current.secrets.get(key(namespace, name)) ?? null)
				);
			const write = (secret: typeof Secret.Type) =>
				Ref.update(state, (current) => ({
					...current,
					secrets: new Map([
						...current.secrets,
						[key(secret.metadata?.namespace ?? '', secret.metadata?.name ?? ''), secret]
					])
				}));
			const kubernetes = KubernetesApi.of({
				getApplySetParent: (args) => read(args.namespace, args.name),
				applyApplySetParent: (args) => write(args.parent).pipe(Effect.as(args.parent)),
				deleteApplySetParent: (args) =>
					Ref.update(state, (current) => {
						const secrets = new Map(current.secrets);
						secrets.delete(key(args.namespace, args.name));
						return { ...current, secrets };
					}),
				reviewAccess: (args) =>
					Ref.get(state).pipe(
						Effect.map((current) => {
							const attributes = args.review.spec.resourceAttributes;
							const allowed = current.allow({
								verb: attributes?.verb ?? '',
								group: attributes?.group ?? '',
								resource: attributes?.resource ?? '',
								namespace: attributes?.namespace ?? ''
							});
							return { ...args.review, status: { allowed } };
						})
					),
				reviewRules: (args) =>
					Ref.get(state).pipe(
						Effect.map((current) => ({
							...args.review,
							status: {
								incomplete: false,
								nonResourceRules: [],
								resourceRules: current.rulesNamespaces.has(args.review.spec.namespace ?? '')
									? [{ verbs: ['*'], apiGroups: ['*'], resources: ['*'] }]
									: []
							}
						}))
					),
				listNodes: (args) =>
					Ref.get(state).pipe(
						Effect.map((current) => {
							const start = args.continue === null ? 0 : Number(args.continue);
							const end = start + args.limit;
							return {
								nodes: current.nodes.slice(start, end),
								continue: end < current.nodes.length ? String(end) : null
							};
						})
					),
				readClusterUid: () =>
					Ref.get(state).pipe(Effect.map((current) => ClusterUid.make(current.clusterUid)))
			});
			const extras = KubernetesExtras.of({
				readOwnSecret: (name) => read('akua-system', name),
				patchOwnSecretData: (name, data) =>
					Effect.gen(function* () {
						const existing = yield* read('akua-system', name);
						if (existing === null) {
							return yield* new KubernetesFailure({
								reason: 'not-found',
								status: 404,
								message: name
							});
						}
						const merged: Record<string, string> = { ...existing.data };
						for (const [entry, value] of Object.entries(data)) {
							if (value === null) delete merged[entry];
							else merged[entry] = value;
						}
						yield* write({ ...existing, data: merged });
					}),
				getSecretAsApply: (args) => read(args.namespace, args.name),
				discover: (apiVersion) =>
					Ref.get(state).pipe(Effect.map((current) => current.discovery.get(apiVersion) ?? null)),
				readVersion: () => Ref.get(state).pipe(Effect.map((current) => current.gitVersion)),
				getNode: (name) =>
					Ref.get(state).pipe(
						Effect.map(
							(current) => current.nodes.find((node) => node.metadata?.name === name) ?? null
						)
					),
				cordonNode: (name) =>
					Ref.update(state, (current) => ({
						...current,
						nodes: current.nodes.map((node) =>
							node.metadata?.name === name
								? { ...node, spec: { ...node.spec, unschedulable: true } }
								: node
						)
					})),
				listPodsOnNode: (name) =>
					Ref.get(state).pipe(
						Effect.map((current) => ({
							apiVersion: 'v1' as const,
							kind: 'PodList' as const,
							metadata: {},
							items: current.pods.filter((pod) => pod.spec?.nodeName === name)
						}))
					),
				evictPod: (args) =>
					Ref.modify(state, (current) =>
						current.evictionBlocked.has(`${args.namespace}/${args.name}`)
							? (['blocked' as const, current] as const)
							: ([
									'evicted' as const,
									{
										...current,
										pods: current.pods.filter(
											(pod) =>
												pod.metadata?.namespace !== args.namespace ||
												pod.metadata?.name !== args.name
										)
									}
								] as const)
					),
				deleteNode: (name) =>
					Ref.update(state, (current) => ({
						...current,
						nodes: current.nodes.filter((node) => node.metadata?.name !== name)
					})),
				getObjectAsApply: (args) =>
					Ref.get(state).pipe(
						Effect.map((current) => current.objects.get(objectKey(args)) ?? null)
					),
				listEventsAsApply: (args) =>
					Ref.get(state).pipe(
						Effect.map((current) => ({
							apiVersion: 'v1' as const,
							kind: 'EventList' as const,
							metadata: {},
							items: current.events.filter((event) => event.involvedObject.uid === args.uid)
						}))
					),
				podLogsAsApply: (args) =>
					Stream.unwrap(
						Ref.get(state).pipe(
							Effect.map((current) => {
								const text = current.logs.get(`${args.namespace}/${args.pod}/${args.container}`);
								return text === undefined
									? Stream.fail(
											new KubernetesFailure({ reason: 'not-found', status: 404, message: args.pod })
										)
									: Stream.make(new TextEncoder().encode(text));
							})
						)
					)
			});
			return Context.make(KubernetesApi, kubernetes).pipe(
				Context.add(KubernetesExtras, extras),
				Context.add(FakeKubernetes, FakeKubernetes.of({ state }))
			);
		})
	);
