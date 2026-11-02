import { Context, Effect, Layer, Ref } from 'effect';
import { ClusterUid } from '@platform/api-contract/services/cluster-agent';
import type { Secret } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/Secret';
import type { Node } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/Node';
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
}

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
				listNodes: () => Ref.get(state).pipe(Effect.map((current) => current.nodes)),
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
				readVersion: () => Ref.get(state).pipe(Effect.map((current) => current.gitVersion))
			});
			return Context.make(KubernetesApi, kubernetes).pipe(
				Context.add(KubernetesExtras, extras),
				Context.add(FakeKubernetes, FakeKubernetes.of({ state }))
			);
		})
	);
