import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { Http, HttpFailure } from '../src/runtime/services';
import { HttpLive } from '../src/runtime/services-live';

const TEST_CLI_VERSION = '1.2.3';

describe('device authorization HTTP', () => {
	it.effect("uses Effect's FetchHttpClient to encode JSON requests", () =>
		Effect.gen(function* () {
			let received: Request | undefined;
			// Mocks the `fetch` global's Promise-returning contract: FetchHttpClient
			// requires this exact interop shape, which has no Effect replacement.
			const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
				received = new Request(input, init);
				return Promise.resolve(Response.json({ access_token: 'token' }));
			};
			const program = Effect.gen(function* () {
				const http = yield* Http;
				return yield* http.postJson({
					url: 'https://api.example.test/device/token',
					body: {
						client_id: 'akua cli',
						scope: 'platform/read+write'
					}
				});
			});

			const response = yield* program.pipe(
				Effect.provide(HttpLive(TEST_CLI_VERSION)),
				Effect.provideService(FetchHttpClient.Fetch, fetch)
			);

			expect(response).toEqual({ status: 200, body: { access_token: 'token' } });
			expect(received?.headers.get('content-type')).toContain('application/json');
			expect(received?.headers.get('user-agent')).toMatch(
				/^akua-cli\/1\.2\.3 \([^;]+; [^)]+\) bun\/.+$/
			);
			const receivedRequest = received;
			const receivedBody =
				receivedRequest === undefined
					? undefined
					: yield* Effect.promise(() => receivedRequest.json());
			expect(receivedBody).toEqual({
				client_id: 'akua cli',
				scope: 'platform/read+write'
			});
		})
	);

	it.effect('maps invalid and oversized response bodies to HttpFailure', () =>
		Effect.gen(function* () {
			// Mocks the `fetch` global's Promise-returning contract; see above.
			const invalidJson = (_input: RequestInfo | URL, _init?: RequestInit) => {
				return Promise.resolve(
					new Response('not json', {
						headers: { 'content-type': 'application/json' }
					})
				);
			};
			const oversized = (_input: RequestInfo | URL, _init?: RequestInit) => {
				return Promise.resolve(
					new Response('x'.repeat(16_385), {
						headers: { 'content-type': 'application/json' }
					})
				);
			};
			const request = Effect.gen(function* () {
				const http = yield* Http;
				return yield* http.postJson({
					url: 'https://api.example.test/device/token',
					body: {}
				});
			});

			const invalidResult = yield* Effect.exit(
				request.pipe(
					Effect.provide(HttpLive(TEST_CLI_VERSION)),
					Effect.provideService(FetchHttpClient.Fetch, invalidJson)
				)
			);
			const oversizedResult = yield* Effect.exit(
				request.pipe(
					Effect.provide(HttpLive(TEST_CLI_VERSION)),
					Effect.provideService(FetchHttpClient.Fetch, oversized)
				)
			);

			expect(hasHttpFailure(invalidResult)).toBe(true);
			expect(hasHttpFailure(oversizedResult)).toBe(true);
		})
	);
});

function hasHttpFailure(exit: Exit.Exit<unknown, unknown>): boolean {
	if (!Exit.isFailure(exit)) return false;
	const failure = Cause.findErrorOption(exit.cause);
	return failure._tag === 'Some' && failure.value instanceof HttpFailure;
}
