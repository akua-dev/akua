import { Context, Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import YAML from 'yaml';
import { type EngineIdentity, KubernetesFailure } from '../ClusterConnector';
import { KubernetesConnection, KubernetesTls } from './Kubernetes';

const Base64Text = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/=\s]+$/u));

/** The three kubeconfig fields the connector uses; the current context selects the cluster and user. */
const Kubeconfig = Schema.Struct({
	'current-context': Schema.NonEmptyString,
	contexts: Schema.Array(
		Schema.Struct({
			name: Schema.NonEmptyString,
			context: Schema.Struct({ cluster: Schema.NonEmptyString, user: Schema.NonEmptyString })
		})
	),
	clusters: Schema.Array(
		Schema.Struct({
			name: Schema.NonEmptyString,
			cluster: Schema.Struct({
				server: Schema.NonEmptyString,
				'certificate-authority-data': Base64Text
			})
		})
	),
	users: Schema.Array(
		Schema.Struct({
			name: Schema.NonEmptyString,
			user: Schema.Struct({
				'client-certificate-data': Base64Text,
				'client-key-data': Base64Text
			})
		})
	)
});

const pem = (data: string) => atob(data.replace(/\s+/gu, ''));

const unreadable = (message: string) =>
	new KubernetesFailure({ reason: 'unavailable', status: 0, message: message.slice(0, 2048) });

/**
 * The connector's own credential from a kubeconfig file: the current
 * context's server, CA and client certificate (inline data only). The
 * certificate authenticates every request, so `authenticate` adds nothing.
 */
export const kubeconfigLayer = (path: string, impersonate: EngineIdentity) =>
	Layer.effectContext(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const text = yield* fs
				.readFileString(path)
				.pipe(Effect.mapError((cause) => unreadable(`kubeconfig unreadable: ${cause.message}`)));
			const config = yield* Schema.decodeUnknownEffect(Kubeconfig)(YAML.parse(text)).pipe(
				Effect.mapError((cause) => unreadable(`kubeconfig invalid: ${cause.message}`))
			);
			const context = config.contexts.find((entry) => entry.name === config['current-context']);
			const cluster = config.clusters.find((entry) => entry.name === context?.context.cluster);
			const user = config.users.find((entry) => entry.name === context?.context.user);
			if (cluster === undefined || user === undefined)
				return yield* unreadable('kubeconfig current context names no cluster or user');
			return Context.make(
				KubernetesConnection,
				KubernetesConnection.of({
					baseUrl: cluster.cluster.server.replace(/\/+$/u, ''),
					authenticate: (request) => Effect.succeed(request),
					impersonate
				})
			).pipe(
				Context.add(
					KubernetesTls,
					Option.some({
						ca: pem(cluster.cluster['certificate-authority-data']),
						cert: pem(user.user['client-certificate-data']),
						key: pem(user.user['client-key-data'])
					})
				)
			);
		})
	);

/**
 * The HttpClient for kube-apiserver requests: with a client certificate,
 * fetch carrying it and the cluster CA on every request, never shared with
 * the platform or git requests; in cluster, the shared client.
 */
export const kubernetesHttpClient = <R>(
	userAgent: string,
	shared: Layer.Layer<HttpClient.HttpClient, never, R>
) =>
	Layer.unwrap(
		Effect.map(KubernetesTls.use(Effect.succeed), (tls) => {
			if (Option.isNone(tls)) return shared;
			const init: BunFetchRequestInit = { tls: tls.value };
			return Layer.effect(
				HttpClient.HttpClient,
				Effect.map(HttpClient.HttpClient.use(Effect.succeed), (client) =>
					client.pipe(
						HttpClient.mapRequest(HttpClientRequest.setHeader('User-Agent', userAgent)),
						HttpClient.transform((response) =>
							Effect.provideService(response, FetchHttpClient.RequestInit, init)
						)
					)
				)
			).pipe(Layer.provide(FetchHttpClient.layer));
		})
	);
