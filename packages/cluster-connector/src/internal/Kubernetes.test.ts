import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Ref } from 'effect';
import { HttpClient, HttpClientResponse, UrlParams } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { KubernetesApi } from '../ClusterConnector';
import { KubernetesConnection, KubernetesExtras, kubernetesLayer } from './Kubernetes';

interface Seen {
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

const bodyText = (request: HttpClientRequest.HttpClientRequest): string =>
	request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : '';

const harness = (respond: (request: Seen) => { readonly status: number; readonly body: unknown }) =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<ReadonlyArray<Seen>>([]);
		const client = HttpClient.make((request) =>
			Effect.gen(function* () {
				const query = UrlParams.toString(request.urlParams);
				const entry: Seen = {
					method: request.method,
					url: query === '' ? request.url : `${request.url}?${query}`,
					headers: request.headers,
					body: bodyText(request)
				};
				yield* Ref.update(seen, (all) => [...all, entry]);
				const answer = respond(entry);
				return HttpClientResponse.fromWeb(
					request,
					new Response(JSON.stringify(answer.body), {
						status: answer.status,
						headers: { 'content-type': 'application/json' }
					})
				);
			})
		);
		const layer = kubernetesLayer.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(HttpClient.HttpClient, client),
					Layer.succeed(
						KubernetesConnection,
						KubernetesConnection.of({
							baseUrl: 'https://10.0.0.1:443',
							token: Effect.succeed('sa-token')
						})
					)
				)
			)
		);
		return { seen, layer };
	});

const managedFields = [
	{
		manager: 'kubectl',
		operation: 'Apply',
		fieldsType: 'FieldsV1',
		fieldsV1: { 'f:data': { 'f:x': {} } }
	}
];

describe('KubernetesApi', () => {
	it.effect('reads ApplySet parents as akua-apply and tolerates managedFields', () =>
		Effect.gen(function* () {
			const { seen, layer } = yield* harness(() => ({
				status: 200,
				body: {
					apiVersion: 'v1',
					kind: 'Secret',
					metadata: { name: 'p', namespace: 'app', managedFields },
					data: {}
				}
			}));
			const parent = yield* Effect.gen(function* () {
				const kubernetes = yield* KubernetesApi;
				return yield* kubernetes.getApplySetParent({ namespace: 'app', name: 'p' });
			}).pipe(Effect.provide(layer));
			assert.strictEqual(parent?.metadata?.name, 'p');
			const [request] = yield* Ref.get(seen);
			assert.strictEqual(request?.url, 'https://10.0.0.1:443/api/v1/namespaces/app/secrets/p');
			assert.strictEqual(
				request?.headers['impersonate-user'],
				'system:serviceaccount:akua-system:akua-apply'
			);
			assert.strictEqual(request?.headers.authorization, 'Bearer sa-token');
		})
	);

	it.effect('returns null for a missing parent and maps 403 to forbidden', () =>
		Effect.gen(function* () {
			const { layer } = yield* harness((request) =>
				request.url.endsWith('/missing')
					? { status: 404, body: { kind: 'Status', message: 'not found' } }
					: { status: 403, body: { kind: 'Status', message: 'secrets "x" is forbidden' } }
			);
			yield* Effect.gen(function* () {
				const kubernetes = yield* KubernetesApi;
				assert.isNull(yield* kubernetes.getApplySetParent({ namespace: 'app', name: 'missing' }));
				const failure = yield* kubernetes
					.getApplySetParent({ namespace: 'app', name: 'x' })
					.pipe(Effect.flip);
				assert.strictEqual(failure._tag === 'KubernetesFailure' ? failure.reason : '', 'forbidden');
				assert.strictEqual(
					failure._tag === 'KubernetesFailure' ? failure.message : '',
					'secrets "x" is forbidden'
				);
			}).pipe(Effect.provide(layer));
		})
	);

	it.effect('applies the parent with server-side apply as field manager akua-agent', () =>
		Effect.gen(function* () {
			const { seen, layer } = yield* harness((request) => ({
				status: 200,
				body: JSON.parse(request.body)
			}));
			yield* Effect.gen(function* () {
				const kubernetes = yield* KubernetesApi;
				yield* kubernetes.applyApplySetParent({
					parent: { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'p', namespace: 'app' } }
				});
			}).pipe(Effect.provide(layer));
			const [request] = yield* Ref.get(seen);
			assert.strictEqual(request?.method, 'PATCH');
			assert.strictEqual(
				request?.url,
				'https://10.0.0.1:443/api/v1/namespaces/app/secrets/p?fieldManager=akua-agent&force=true'
			);
			assert.strictEqual(request?.headers['content-type'], 'application/apply-patch+yaml');
		})
	);

	it.effect(
		'lists nodes as full Node objects and reads the cluster UID and version as itself',
		() =>
			Effect.gen(function* () {
				const { seen, layer } = yield* harness((request) => {
					if (request.url.includes('/api/v1/nodes?')) {
						return {
							status: 200,
							body: {
								apiVersion: 'v1',
								kind: 'NodeList',
								items: [{ metadata: { name: 'n1', managedFields } }]
							}
						};
					}
					if (request.url.endsWith('/version'))
						return { status: 200, body: { gitVersion: 'v1.34.1+k0s', major: '1' } };
					return {
						status: 200,
						body: {
							apiVersion: 'v1',
							kind: 'Namespace',
							metadata: { name: 'kube-system', uid: '6f1c1b0e-2f4b-4b7a-9d0e-0c6b1f2a3d4e' }
						}
					};
				});
				yield* Effect.gen(function* () {
					const kubernetes = yield* KubernetesApi;
					const extras = yield* KubernetesExtras;
					const { nodes } = yield* kubernetes.listNodes({ limit: 500, continue: null });
					assert.deepStrictEqual(
						nodes.map((node) => [node.kind, node.metadata?.name]),
						[['Node', 'n1']]
					);
					assert.strictEqual(
						yield* kubernetes.readClusterUid(),
						'6f1c1b0e-2f4b-4b7a-9d0e-0c6b1f2a3d4e'
					);
					assert.strictEqual(yield* extras.readVersion(), 'v1.34.1+k0s');
				}).pipe(Effect.provide(layer));
				assert.isTrue(
					(yield* Ref.get(seen)).every(
						(request) => request.headers['impersonate-user'] === undefined
					)
				);
			})
	);
});
