import { Effect, Layer } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';

export interface UserAgentContext {
	readonly cliVersion: string;
	readonly platform: string;
	readonly arch: string;
	readonly bunVersion: string;
}

/**
 * Builds the single User-Agent value every CLI HTTP request sends, in RFC
 * 9110 product/comment syntax: a product identifying the CLI and its
 * version, a comment carrying coarse OS/arch, and a product identifying the
 * Bun runtime. Pure and host-independent so it stays unit-testable without
 * touching `process`; the live values are read by `AkuaHttpClientLive`
 * below.
 */
export function buildUserAgent(context: UserAgentContext): string {
	return `akua-cli/${context.cliVersion} (${context.platform}; ${context.arch}) bun/${context.bunVersion}`;
}

/**
 * The single `HttpClient.HttpClient` layer every CLI request path builds on.
 * It wraps Effect's `FetchHttpClient.layer` and stamps every outgoing
 * request with the CLI's User-Agent header, so a new HTTP call site inherits
 * the header automatically by depending on this layer (directly, or through
 * a service built on top of it, such as `Http` or `PublicApiClient`) instead
 * of `FetchHttpClient.layer` on its own.
 */
export function AkuaHttpClientLive(cliVersion: string): Layer.Layer<HttpClient.HttpClient> {
	return Layer.effect(
		HttpClient.HttpClient,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			const userAgent = buildUserAgent({
				cliVersion,
				platform: process.platform,
				arch: process.arch,
				bunVersion: process.versions.bun ?? 'unknown'
			});
			return client.pipe(
				HttpClient.mapRequest(HttpClientRequest.setHeader('User-Agent', userAgent))
			);
		})
	).pipe(Layer.provide(FetchHttpClient.layer));
}
