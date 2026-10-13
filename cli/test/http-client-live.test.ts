import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';

import { AkuaHttpClientLive, buildUserAgent } from '../src/runtime/http-client-live';

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
