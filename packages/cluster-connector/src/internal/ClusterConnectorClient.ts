import { Context, Effect, Layer, Redacted } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { HttpApiClient, HttpApiMiddleware } from 'effect/http-api';
import type { HttpApi } from 'effect/http-api';
import {
	ClusterConnectorAuthorization,
	ClusterConnectorApi
} from '@platform/api-contract/services/ClusterConnector';
import { PlatformOrigin } from './ClusterConnectorConfig';

type ClusterConnectorGroups =
	typeof ClusterConnectorApi extends HttpApi.HttpApi<string, infer Groups> ? Groups : never;
export type ClusterConnectorClientShape = HttpApiClient.Client<ClusterConnectorGroups>;

/** Identity endpoints: enrollment and token exchange, no bearer. */
export class ClusterConnectorIdentityClient extends Context.Service<
	ClusterConnectorIdentityClient,
	ClusterConnectorClientShape['clusterConnectorIdentity']
>()('akua/cluster-connector/ClusterConnectorIdentityClient') {}

/** Every other agent and updater call, authorized by the exchanged WorkloadAssertion. */
export class ClusterConnectorClient extends Context.Service<
	ClusterConnectorClient,
	ClusterConnectorClientShape['clusterConnector']
>()('akua/cluster-connector/ClusterConnectorClient') {}

/**
 * The bearer for ClusterConnectorClient calls. `invalidate` drops a cached assertion the
 * platform answered 401 for, so the next call exchanges a fresh one.
 */
export class ClusterConnectorCredentials extends Context.Service<
	ClusterConnectorCredentials,
	{
		readonly accessToken: Effect.Effect<Redacted.Redacted<string>>;
		readonly invalidate: Effect.Effect<void>;
	}
>()('akua/cluster-connector/ClusterConnectorCredentials') {}

/** Attaches the bearer; one retry with a fresh assertion after a 401. */
export const clusterConnectorAuthorizationClient = HttpApiMiddleware.layerClient(
	ClusterConnectorAuthorization,
	Effect.gen(function* () {
		const credentials = yield* ClusterConnectorCredentials;
		return ({ next, request }) =>
			Effect.gen(function* () {
				const token = yield* credentials.accessToken;
				const response = yield* next(HttpClientRequest.bearerToken(request, Redacted.value(token)));
				if (response.status !== 401) return response;
				yield* credentials.invalidate;
				const fresh = yield* credentials.accessToken;
				return yield* next(HttpClientRequest.bearerToken(request, Redacted.value(fresh)));
			});
	})
);

export const clusterConnectorIdentityClientLive = Layer.effect(
	ClusterConnectorIdentityClient,
	Effect.gen(function* () {
		const platformOrigin = yield* PlatformOrigin;
		const httpClient = yield* HttpClient.HttpClient;
		return yield* HttpApiClient.group(ClusterConnectorApi, {
			group: 'clusterConnectorIdentity',
			httpClient,
			baseUrl: platformOrigin
		});
	})
);

export const clusterConnectorClientLive = Layer.effect(
	ClusterConnectorClient,
	Effect.gen(function* () {
		const platformOrigin = yield* PlatformOrigin;
		const httpClient = yield* HttpClient.HttpClient;
		return yield* HttpApiClient.group(ClusterConnectorApi, {
			group: 'clusterConnector',
			httpClient,
			baseUrl: platformOrigin
		});
	})
).pipe(Layer.provide(clusterConnectorAuthorizationClient));
