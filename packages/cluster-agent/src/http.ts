import { Effect, Layer } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import type { AgentHttpClientLive as AgentHttpClientLiveShape } from './contract';

/**
 * The one HttpClient every agent and updater request is built on: platform,
 * git origin and kube-apiserver. The User-Agent is set here, never at a call
 * site, so the header names the release that made each request.
 */
export const AgentHttpClientLive: AgentHttpClientLiveShape = (userAgent) =>
	Layer.effect(
		HttpClient.HttpClient,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			return client.pipe(
				HttpClient.mapRequest(HttpClientRequest.setHeader('User-Agent', userAgent))
			);
		})
	).pipe(Layer.provide(FetchHttpClient.layer));
