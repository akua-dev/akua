import { describe, expect, it } from '@effect/vitest';
import { Cause, ConfigProvider, Effect, Layer } from 'effect';
import { BunCrypto, BunServices } from '@effect/platform-bun';
import {
	FetchHttpClient,
	HttpClient,
	HttpClientError,
	HttpClientRequest,
	HttpClientResponse
} from 'effect/http';
import { ApiClient } from '../src/api/client';
import { contract } from '../src/generated/contract.gen';
import { SecureConfigLive } from '../src/runtime/services-live';
import { operationContext } from '../src/cli/operation-context';
import { diagnoseContractFailure } from '../src/cli/contract-diagnostic';

import { AkuaHttpClientLive, buildUserAgent } from '../src/runtime/http-client-live';

it.effect.each(['broken', 'empty', 'json'] as const)(
	'retains the error-response body outcome through API diagnosis (%s)',
	(mode) =>
		Effect.gen(function* () {
			const operation = yield* Effect.fromNullishOr(contract.operations[0]);
			const original = new Error('private-response-stream-canary');
			const http = HttpClient.make((request) =>
				Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						mode === 'json'
							? Response.json({ message: 'safe server refusal' }, { status: 500 })
							: new Response(
									mode === 'empty'
										? ''
										: new ReadableStream({
												start(controller) {
													controller.error(original);
												}
											}),
									{ status: 500 }
								)
					)
				)
			);
			const failure = yield* ApiClient.use((client) =>
				client.execute(operation, { path: { id: 'fixture' } })
			).pipe(
				Effect.provide(ApiClient.layer.pipe(Layer.provide(SecureConfigLive))),
				Effect.provideService(HttpClient.HttpClient, http),
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromEnvRecord({
							HOME: '/nonexistent-test-home',
							AKUA_API_TOKEN: 'fixture-token'
						})
					)
				),
				Effect.flip
			);
			if (failure._tag !== 'OperationFailure')
				return expect.unreachable('expected operation failure');
			expect(failure.reason).toBe('api');
			expect(failure.status).toBe(500);
			const translated = yield* diagnoseContractFailure(
				operationContext(contract, operation),
				{},
				failure
			).pipe(Effect.provideService(HttpClient.HttpClient, http));
			expect(translated.cause).toBe(failure);
			expect(JSON.stringify(translated.toPayload())).not.toContain(original.message);
			if (mode === 'broken') {
				expect(failure.cause).toBeInstanceOf(HttpClientError.HttpClientError);
				if (
					failure.cause instanceof HttpClientError.HttpClientError &&
					failure.cause.reason._tag === 'DecodeError'
				)
					expect(failure.cause.reason.cause).toBe(original);
				else return expect.unreachable('expected body decoding error');
				expect(Cause.pretty(Cause.fail(translated))).toContain(original.message);
			} else expect(failure.cause).toBeUndefined();
			expect(failure.detail).toBe(mode === 'json' ? 'safe server refusal' : undefined);
		}).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer)))
);

describe('buildUserAgent', () => {
	it('follows RFC 9110 product/comment syntax with the CLI, platform, and Bun runtime', () => {
		expect(
			buildUserAgent({
				cliVersion: '1.2.3',
				platform: 'darwin',
				arch: 'arm64',
				bunVersion: '1.4.2'
			})
		).toBe('akua-cli/1.2.3 (darwin; arm64) bun/1.4.2');
	});

	it('reflects a different platform, arch, and Bun version without guessing at defaults', () => {
		expect(
			buildUserAgent({
				cliVersion: '0.11.0',
				platform: 'linux',
				arch: 'x64',
				bunVersion: '1.5.0'
			})
		).toBe('akua-cli/0.11.0 (linux; x64) bun/1.5.0');
	});
});

describe('AkuaHttpClientLive', () => {
	it.effect('stamps every request with the single CLI User-Agent header', () =>
		Effect.gen(function* () {
			let received: Request | undefined;
			// Mocks the `fetch` global's Promise-returning contract: FetchHttpClient
			// requires this exact interop shape, which has no Effect replacement.
			const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
				received = new Request(input, init);
				return Promise.resolve(Response.json({ ok: true }));
			};

			const program = Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				return yield* client.execute(HttpClientRequest.get('https://api.example.test/probe'));
			});

			yield* program.pipe(
				Effect.provide(AkuaHttpClientLive('1.2.3')),
				Effect.provideService(FetchHttpClient.Fetch, fetch)
			);

			const userAgent = received?.headers.get('user-agent');
			expect(userAgent).not.toBeNull();
			expect(userAgent).toMatch(/^akua-cli\/1\.2\.3 \([^;]+; [^)]+\) bun\/.+$/);
		})
	);

	it.effect('does not vary the header across requests made through the same layer', () =>
		Effect.gen(function* () {
			const received: Array<Request> = [];
			const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
				received.push(new Request(input, init));
				return Promise.resolve(Response.json({ ok: true }));
			};

			const program = Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				yield* client.execute(HttpClientRequest.get('https://api.example.test/first'));
				yield* client.execute(HttpClientRequest.post('https://api.example.test/second'));
			});

			yield* program.pipe(
				Effect.provide(AkuaHttpClientLive('9.9.9')),
				Effect.provideService(FetchHttpClient.Fetch, fetch)
			);

			expect(received).toHaveLength(2);
			const [first, second] = received;
			expect(first?.headers.get('user-agent')).toBe(second?.headers.get('user-agent'));
			expect(first?.headers.get('user-agent')).toContain('akua-cli/9.9.9');
		})
	);
});
