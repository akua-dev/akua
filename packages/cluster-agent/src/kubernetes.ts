import { Config, Context, Effect, FileSystem, Layer, Predicate, Schema } from 'effect';
import { HttpClient, HttpClientRequest, type HttpClientError } from 'effect/http';
import { ClusterUid } from '@platform/api-contract/services/cluster-agent';
import { Secret } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/Secret';
import { Namespace } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/Namespace';
import { Node } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/Node';
import { NodeList } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/NodeList';
import { APIResourceList } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/APIResourceList';
import { SelfSubjectAccessReview } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/authorization.k8s.io/v1/SelfSubjectAccessReview';
import { SelfSubjectRulesReview } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/authorization.k8s.io/v1/SelfSubjectRulesReview';
import {
	agentNamespace,
	engineImpersonation,
	fieldManager,
	KubernetesApi,
	KubernetesFailure
} from './contract';

/**
 * Where and as whom the agent reaches its own kube-apiserver. In cluster:
 * the service host from the environment and the projected ServiceAccount
 * token, re-read on every request because the kubelet rotates it. The CA is
 * trusted through NODE_EXTRA_CA_CERTS, set by the chart.
 */
export class KubernetesConnection extends Context.Service<
	KubernetesConnection,
	{
		readonly baseUrl: string;
		readonly token: Effect.Effect<string, KubernetesFailure>;
	}
>()('akua/cluster-agent/KubernetesConnection') {
	static readonly inCluster = Layer.effect(
		KubernetesConnection,
		Effect.gen(function* () {
			const host = yield* Config.NonEmptyString('KUBERNETES_SERVICE_HOST');
			const port = yield* Config.Port('KUBERNETES_SERVICE_PORT').pipe(Config.withDefault(443));
			const fs = yield* FileSystem.FileSystem;
			const token = fs.readFileString('/var/run/secrets/kubernetes.io/serviceaccount/token').pipe(
				Effect.map((value) => value.trim()),
				Effect.mapError(
					(cause) =>
						new KubernetesFailure({
							reason: 'unavailable',
							status: 0,
							message: `service account token unreadable: ${cause.message}`.slice(0, 2048)
						})
				)
			);
			const hostPart = host.includes(':') ? `[${host}]` : host;
			return KubernetesConnection.of({ baseUrl: `https://${hostPart}:${port}`, token });
		})
	);
}

export const failureFor = (status: number, body: unknown): KubernetesFailure => {
	const message =
		Predicate.isObject(body) &&
		Predicate.hasProperty(body, 'message') &&
		Predicate.isString(body.message)
			? body.message
			: `kube-apiserver answered ${status}`;
	const reason =
		status === 403 || status === 401
			? 'forbidden'
			: status === 404
				? 'not-found'
				: status === 409
					? 'conflict'
					: status === 400 || status === 422
						? 'invalid'
						: status === 408 || status === 504
							? 'timeout'
							: 'unavailable';
	return new KubernetesFailure({ reason, status, message: message.slice(0, 2048) });
};

/**
 * managedFields are dropped before decoding: the agent never reads them,
 * and the generated FieldsV1 schema (`Record(String, Never)`) cannot hold a
 * populated field set.
 */
const stripManagedFields = (value: unknown): unknown => {
	if (!Predicate.isObject(value) || !Predicate.hasProperty(value, 'metadata')) return value;
	const metadata = value.metadata;
	if (!Predicate.isObject(metadata) || !Predicate.hasProperty(metadata, 'managedFields'))
		return value;
	const { managedFields: _managedFields, ...rest } = metadata;
	return { ...value, metadata: rest };
};

const withoutManagedFields = (value: unknown): unknown => {
	const stripped = stripManagedFields(value);
	if (!Predicate.isObject(stripped) || !Predicate.hasProperty(stripped, 'items')) return stripped;
	const items = stripped.items;
	return Array.isArray(items) ? { ...stripped, items: items.map(stripManagedFields) } : stripped;
};

export const decodeAs =
	<S extends Schema.Constraint>(schema: S) =>
	(status: number) =>
	(value: unknown) =>
		Schema.decodeUnknownEffect(schema)(withoutManagedFields(value)).pipe(
			Effect.mapError(
				(cause) =>
					new KubernetesFailure({
						reason: 'invalid',
						status,
						message: `unexpected kube-apiserver response: ${cause.message}`.slice(0, 2048)
					})
			)
		);

/** One discovered resource: what an SSAR and an ObjectKey need. */
export interface DiscoveredResource {
	readonly resource: string;
	readonly namespaced: boolean;
}

/**
 * The contract's KubernetesApi plus what the agent needs beyond it: its
 * own Secrets in akua-system, an impersonated Secret read for generated
 * secrets, discovery for access reviews, and the server version.
 */
export class KubernetesExtras extends Context.Service<
	KubernetesExtras,
	{
		readOwnSecret(
			name: string
		): Effect.Effect<
			typeof Secret.Type | null,
			KubernetesFailure | HttpClientError.HttpClientError
		>;
		/** JSON merge patch of `data`; a null value removes the key. */
		patchOwnSecretData(
			name: string,
			data: Readonly<Record<string, string | null>>
		): Effect.Effect<void, KubernetesFailure | HttpClientError.HttpClientError>;
		/** GET as `akua-apply`; the customer's grant decides whether it may. */
		getSecretAsApply(args: {
			readonly namespace: string;
			readonly name: string;
		}): Effect.Effect<
			typeof Secret.Type | null,
			KubernetesFailure | HttpClientError.HttpClientError
		>;
		discover(
			apiVersion: string
		): Effect.Effect<
			ReadonlyMap<string, DiscoveredResource> | null,
			KubernetesFailure | HttpClientError.HttpClientError
		>;
		readVersion(): Effect.Effect<string, KubernetesFailure | HttpClientError.HttpClientError>;
	}
>()('akua/cluster-agent/KubernetesExtras') {}

const VersionInfo = Schema.Struct({ gitVersion: Schema.NonEmptyString });

export const kubernetesLayer = Layer.effectContext(
	Effect.gen(function* () {
		const connection = yield* KubernetesConnection;
		const client = yield* HttpClient.HttpClient;

		const send = Effect.fnUntraced(function* (
			request: HttpClientRequest.HttpClientRequest,
			options: { readonly impersonate: boolean; readonly allowNotFound: boolean }
		) {
			const token = yield* connection.token;
			const prepared = request.pipe(
				HttpClientRequest.prependUrl(connection.baseUrl),
				HttpClientRequest.bearerToken(token),
				HttpClientRequest.acceptJson,
				options.impersonate
					? HttpClientRequest.setHeader('Impersonate-User', engineImpersonation)
					: (self) => self
			);
			const response = yield* client.execute(prepared);
			if (options.allowNotFound && response.status === 404) return null;
			const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
			if (response.status < 200 || response.status >= 300) {
				return yield* failureFor(response.status, body);
			}
			return { status: response.status, body };
		});

		const jsonBody = (contentType: string, value: unknown) =>
			HttpClientRequest.bodyText(JSON.stringify(value), contentType);

		const secretPath = (namespace: string, name: string) =>
			`/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`;

		const getSecret = Effect.fnUntraced(function* (
			namespace: string,
			name: string,
			impersonate: boolean
		) {
			const result = yield* send(HttpClientRequest.get(secretPath(namespace, name)), {
				impersonate,
				allowNotFound: true
			});
			if (result === null) return null;
			return yield* decodeAs(Secret)(result.status)(result.body);
		});

		const kubernetes = KubernetesApi.of({
			getApplySetParent: Effect.fn('KubernetesApi.getApplySetParent')(function* (args) {
				return yield* getSecret(args.namespace, args.name, true);
			}),
			applyApplySetParent: Effect.fn('KubernetesApi.applyApplySetParent')(function* (args) {
				const name = args.parent.metadata?.name ?? '';
				const namespace = args.parent.metadata?.namespace ?? '';
				const result = yield* send(
					HttpClientRequest.patch(secretPath(namespace, name)).pipe(
						HttpClientRequest.setUrlParams({ fieldManager, force: 'true' }),
						jsonBody('application/apply-patch+yaml', args.parent)
					),
					{ impersonate: true, allowNotFound: false }
				);
				if (result === null) return yield* failureFor(404, null);
				return yield* decodeAs(Secret)(result.status)(result.body);
			}),
			deleteApplySetParent: Effect.fn('KubernetesApi.deleteApplySetParent')(function* (args) {
				yield* send(HttpClientRequest.delete(secretPath(args.namespace, args.name)), {
					impersonate: true,
					allowNotFound: true
				});
			}),
			reviewAccess: Effect.fn('KubernetesApi.reviewAccess')(function* (args) {
				const result = yield* send(
					HttpClientRequest.post('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews').pipe(
						jsonBody('application/json', args.review)
					),
					{ impersonate: true, allowNotFound: false }
				);
				if (result === null) return yield* failureFor(404, null);
				return yield* decodeAs(SelfSubjectAccessReview)(result.status)(result.body);
			}),
			reviewRules: Effect.fn('KubernetesApi.reviewRules')(function* (args) {
				const result = yield* send(
					HttpClientRequest.post('/apis/authorization.k8s.io/v1/selfsubjectrulesreviews').pipe(
						jsonBody('application/json', args.review)
					),
					{ impersonate: true, allowNotFound: false }
				);
				if (result === null) return yield* failureFor(404, null);
				return yield* decodeAs(SelfSubjectRulesReview)(result.status)(result.body);
			}),
			listNodes: Effect.fn('KubernetesApi.listNodes')(function* () {
				const result = yield* send(HttpClientRequest.get('/api/v1/nodes'), {
					impersonate: false,
					allowNotFound: false
				});
				if (result === null) return [];
				const list = yield* decodeAs(NodeList)(result.status)(result.body);
				// List items omit apiVersion and kind; the list's decode already validated the rest.
				return list.items.map((item): typeof Node.Type => ({
					...item,
					apiVersion: 'v1',
					kind: 'Node'
				}));
			}),
			readClusterUid: Effect.fn('KubernetesApi.readClusterUid')(function* () {
				const result = yield* send(HttpClientRequest.get('/api/v1/namespaces/kube-system'), {
					impersonate: false,
					allowNotFound: false
				});
				if (result === null) return yield* failureFor(404, null);
				const namespace = yield* decodeAs(Namespace)(result.status)(result.body);
				return yield* decodeAs(ClusterUid)(result.status)(namespace.metadata?.uid);
			})
		});

		const extras = KubernetesExtras.of({
			readOwnSecret: Effect.fn('KubernetesApi.readOwnSecret')(function* (name) {
				return yield* getSecret(agentNamespace, name, false);
			}),
			patchOwnSecretData: Effect.fn('KubernetesApi.patchOwnSecretData')(function* (name, data) {
				yield* send(
					HttpClientRequest.patch(secretPath(agentNamespace, name)).pipe(
						jsonBody('application/merge-patch+json', { data })
					),
					{ impersonate: false, allowNotFound: false }
				);
			}),
			getSecretAsApply: Effect.fn('KubernetesApi.getSecretAsApply')(function* (args) {
				return yield* getSecret(args.namespace, args.name, true);
			}),
			discover: Effect.fn('KubernetesApi.discover')(function* (apiVersion) {
				const path = apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
				const result = yield* send(HttpClientRequest.get(path), {
					impersonate: false,
					allowNotFound: true
				});
				if (result === null) return null;
				const list = yield* decodeAs(APIResourceList)(result.status)(result.body);
				const byKind = new Map<string, DiscoveredResource>();
				for (const resource of list.resources) {
					if (resource.name.includes('/')) continue;
					byKind.set(resource.kind, { resource: resource.name, namespaced: resource.namespaced });
				}
				return byKind;
			}),
			readVersion: Effect.fn('KubernetesApi.readVersion')(function* () {
				const result = yield* send(HttpClientRequest.get('/version'), {
					impersonate: false,
					allowNotFound: false
				});
				if (result === null) return yield* failureFor(404, null);
				const info = yield* decodeAs(VersionInfo)(result.status)(result.body);
				return info.gitVersion;
			})
		});

		return Context.make(KubernetesApi, kubernetes).pipe(Context.add(KubernetesExtras, extras));
	})
);
