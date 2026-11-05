import { Context, Effect, Layer, Redacted } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { HttpApiClient, HttpApiMiddleware } from 'effect/http-api';
import type { HttpApi } from 'effect/http-api';
import {
	ClusterConnectorAuthorization,
	ClusterConnectorApi
} from '@platform/api-contract/services/ClusterConnector';
import { PlatformOrigin } from './config';

type ClusterAgentGroups =
	typeof ClusterConnectorApi extends HttpApi.HttpApi<string, infer Groups> ? Groups : never;
export type PlatformClientShape = HttpApiClient.Client<ClusterAgentGroups>;

/** Identity endpoints: enrollment and token exchange, no bearer. */
export class IdentityApi extends Context.Service<
	IdentityApi,
	PlatformClientShape['clusterConnectorIdentity']
>()('akua/cluster-agent/IdentityApi') {}

/** Every other agent and updater call, authorized by the exchanged WorkloadAssertion. */
export class AgentApi extends Context.Service<AgentApi, PlatformClientShape['clusterConnector']>()(
	'akua/cluster-agent/AgentApi'
) {}

/**
 * The bearer for AgentApi calls. `invalidate` drops a cached assertion the
 * platform answered 401 for, so the next call exchanges a fresh one.
 */
export class AgentCredentials extends Context.Service<
	AgentCredentials,
	{
		readonly accessToken: Effect.Effect<Redacted.Redacted<string>>;
		readonly invalidate: Effect.Effect<void>;
	}
>()('akua/cluster-agent/AgentCredentials') {}

/** Attaches the bearer; one retry with a fresh assertion after a 401. */
export const agentAuthorizationClient = HttpApiMiddleware.layerClient(
	ClusterConnectorAuthorization,
	Effect.gen(function* () {
		const credentials = yield* AgentCredentials;
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

export const identityApiLive = Layer.effect(
	IdentityApi,
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

export const agentApiLive = Layer.effect(
	AgentApi,
	Effect.gen(function* () {
		const platformOrigin = yield* PlatformOrigin;
		const httpClient = yield* HttpClient.HttpClient;
		return yield* HttpApiClient.group(ClusterConnectorApi, {
			group: 'clusterConnector',
			httpClient,
			baseUrl: platformOrigin
		});
	})
).pipe(Layer.provide(agentAuthorizationClient));
