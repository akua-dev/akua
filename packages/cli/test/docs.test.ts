import { BunCrypto, BunServices } from '@effect/platform-bun';
import { expect, it } from '@effect/vitest';
import { ConfigProvider, Effect, Fiber, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';

import { runAkua } from '../src/cli/main';
import { Console } from '../src/runtime/services';
import { CliLive } from '../src/runtime/services-live';

const invoke = Effect.fnUntraced(function* (
	argv: readonly string[],
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = yield* runAkua(argv, 'test').pipe(
		Effect.provideService(Console, {
			stdoutIsTTY: false,
			stdinIsTTY: false,
			writeStdout: (value) =>
				Effect.sync(() => {
					stdout.push(value);
				}),
			writeStdoutBytes: (value) =>
				Effect.sync(() => {
					stdout.push(new TextDecoder().decode(value));
				}),
			writeStderr: (value) =>
				Effect.sync(() => {
					stderr.push(value);
				})
		}),
		Effect.provide(
			CliLive('test').pipe(Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer)))
		),
		Effect.provideService(FetchHttpClient.Fetch, fetch),
		Effect.provide(
			ConfigProvider.layer(
				ConfigProvider.fromEnvRecord({
					AKUA_API_TOKEN: 'fixture-token-must-not-be-sent',
					AKUA_API_URL: 'https://wrong.example.test'
				})
			)
		)
	);
	return { code, stdout: stdout.join(''), stderr: stderr.join('') };
});

const unavailable = () => Promise.reject(new Error('offline'));
const searchResponse = (texts: readonly string[]) => ({
	jsonrpc: '2.0',
	id: 1,
	result: { content: texts.map((text) => ({ type: 'text', text })) }
});
const matchText = (title: string, content = 'Connect a cluster') =>
	`Title: ${title}\nLink: https://docs.akua.dev/clusters/import#prerequisites\nPage: clusters/import\nContent: ${content}`;

it.effect('orients an agent from root help without a network or sign-in', () =>
	Effect.gen(function* () {
		const result = yield* invoke(['--help'], unavailable);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('DOCUMENTATION');
		expect(result.stdout).toContain('https://docs.akua.dev/llms.txt');
		expect(result.stdout).toContain('akua docs search');
		expect(result.stdout).toContain('akua docs <path>');
	})
);

it.effect('fetches current Markdown from the fixed docs origin without credentials', () =>
	Effect.gen(function* () {
		const requests: Request[] = [];
		let options: RequestInit | undefined;
		const result = yield* invoke(['docs', '/clusters/import', '--json'], (input, init) => {
			options = init;
			requests.push(new Request(input, init));
			return Promise.resolve(
				new Response('# Attach a cluster\n', {
					headers: { 'content-type': 'text/markdown' }
				})
			);
		});
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			data: { url: 'https://docs.akua.dev/clusters/import', content: '# Attach a cluster\n' }
		});
		expect(requests.map((request) => request.url)).toEqual([
			'https://docs.akua.dev/clusters/import'
		]);
		expect(requests[0]?.headers.get('accept')).toBe('text/markdown');
		expect(requests[0]?.headers.get('authorization')).toBeNull();
		expect(requests[0]?.headers.get('cookie')).toBeNull();
		// Bun's Request.credentials getter reports "include" even for "omit".
		expect(options?.credentials).toBe('omit');
		expect(options?.redirect).toBe('error');
	})
);

it.effect('prints Markdown directly in agent mode and refetches rather than bundling content', () =>
	Effect.gen(function* () {
		let revision = 0;
		const fetch = () =>
			Promise.resolve(
				new Response(`# Current ${++revision}\n`, {
					headers: { 'content-type': 'text/markdown' }
				})
			);
		expect((yield* invoke(['docs', 'quickstart'], fetch)).stdout).toBe('# Current 1\n');
		expect((yield* invoke(['docs', 'quickstart'], fetch)).stdout).toBe('# Current 2\n');
	})
);

it.effect('searches Mintlify with a generic query and returns five compact ranked matches', () =>
	Effect.gen(function* () {
		let request: Request | undefined;
		const result = yield* invoke(
			['docs', 'search', 'attach a cluster', '--json'],
			(input, init) => {
				request = new Request(input, init);
				return Promise.resolve(
					Response.json(
						searchResponse(
							Array.from({ length: 7 }, (_, index) =>
								matchText(
									`Result ${index}`,
									index === 0 ? 'Connect a cluster' : 'Connect a cluster. '.repeat(30)
								)
							)
						)
					)
				);
			}
		);
		expect(result.code).toBe(0);
		expect(request?.url).toBe('https://docs.akua.dev/mcp');
		expect(request?.method).toBe('POST');
		expect(request?.headers.get('authorization')).toBeNull();
		expect(request?.headers.get('mcp-session-id')).toBeNull();
		expect(request?.headers.get('accept')).toBe('application/json, text/event-stream');
		expect(yield* Effect.promise(() => request?.json() ?? Promise.resolve(null))).toEqual({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'search_akua_docs', arguments: { query: 'attach a cluster' } }
		});
		const output = JSON.parse(result.stdout);
		expect(output.data).toHaveLength(5);
		expect(output.data[1].snippet).toHaveLength(300);
		expect(output.data[1].snippet).toMatch(/\.\.\.$/);
		expect(output.data[0]).toEqual({
			title: 'Result 0',
			snippet: 'Connect a cluster',
			url: 'https://docs.akua.dev/clusters/import#prerequisites'
		});
	})
);

it.effect('reports an empty search without inventing a result', () =>
	Effect.gen(function* () {
		const result = yield* invoke(['docs', 'search', 'no match', '--json'], () =>
			Promise.resolve(Response.json(searchResponse([])))
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).data).toEqual([]);
	})
);

it.effect('parses MCP SSE with comments, notifications and multiline JSON data', () =>
	Effect.gen(function* () {
		const text = [
			': heartbeat\r\n\r\n',
			'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n',
			'event: message\r\n',
			JSON.stringify(searchResponse([matchText('Attach a cluster')]), null, 2)
				.split('\n')
				.map((line) => `data: ${line}\r\n`)
				.join(''),
			'\r\n'
		].join('');
		const result = yield* invoke(['docs', 'search', 'attach a cluster', '--json'], () =>
			Promise.resolve(new Response(text, { headers: { 'content-type': 'text/event-stream' } }))
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).data).toEqual([
			{
				title: 'Attach a cluster',
				url: 'https://docs.akua.dev/clusters/import#prerequisites',
				snippet: 'Connect a cluster'
			}
		]);
	})
);

it.effect('recognizes an explicit MCP no-results message', () =>
	Effect.gen(function* () {
		const result = yield* invoke(['docs', 'search', 'no match', '--json'], () =>
			Promise.resolve(Response.json(searchResponse(['No results found.'])))
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).data).toEqual([]);
	})
);

for (const path of [
	'https://evil.test/page',
	'//evil.test/page',
	'../private',
	'%2e%2e/private',
	'page?token=secret',
	'page\\escape'
]) {
	it.effect(`rejects a non-docs path before requesting it: ${path}`, () =>
		Effect.gen(function* () {
			const result = yield* invoke(['docs', path, '--json'], unavailable);
			expect(result.code).toBe(2);
			expect(JSON.parse(result.stdout).error.code).toBe('AKUA_USAGE_ERROR');
			expect(result.stdout).toContain('https://docs.akua.dev/llms.txt');
			expect(result.stdout).not.toContain('token=secret');
		})
	);
}

for (const response of [
	() => new Response('', { status: 302, headers: { location: 'https://evil.test/page' } }),
	() => new Response('not found', { status: 404 }),
	() => new Response('<html>not markdown</html>', { headers: { 'content-type': 'text/html' } }),
	() =>
		new Response('too large', {
			headers: { 'content-type': 'text/markdown', 'content-length': '2000000' }
		}),
	() => new Response('x'.repeat(1_048_577), { headers: { 'content-type': 'text/markdown' } })
]) {
	it.effect('fails closed on HTTP errors, HTML, and oversized pages with the source URL', () =>
		Effect.gen(function* () {
			const result = yield* invoke(['docs', 'quickstart', '--json'], () =>
				Promise.resolve(response())
			);
			expect(result.code).not.toBe(0);
			expect(result.stdout).toContain('https://docs.akua.dev/quickstart');
			expect(result.stdout).toContain('https://docs.akua.dev/llms.txt');
		})
	);
}

it.effect('rejects an empty search without sending it to Mintlify', () =>
	Effect.gen(function* () {
		const result = yield* invoke(['docs', 'search', '   ', '--json'], unavailable);
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error.code).toBe('AKUA_USAGE_ERROR');
	})
);

it.effect('keeps help machine-readable in JSON mode', () =>
	Effect.gen(function* () {
		const result = yield* invoke(['--help', '--json'], unavailable);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).data.help).toContain('https://docs.akua.dev/llms.txt');
	})
);

it.effect('keeps a requested quiet page read quiet', () =>
	Effect.gen(function* () {
		const result = yield* invoke(['docs', 'quickstart', '--quiet'], () =>
			Promise.resolve(new Response('# Page', { headers: { 'content-type': 'text/markdown' } }))
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe('');
	})
);

it.effect('names the page URL when offline instead of returning stale guidance', () =>
	Effect.gen(function* () {
		const result = yield* invoke(['docs', 'quickstart', '--json'], unavailable);
		expect(result.code).not.toBe(0);
		expect(JSON.parse(result.stdout).error.code).toBe('AKUA_DOCS_ERROR');
		expect(result.stdout).toContain('https://docs.akua.dev/quickstart');
	})
);

for (const body of [
	searchResponse(['Title: Wrong\nLink: https://evil.test\nPage: clusters\nContent: Wrong']),
	searchResponse(['unrecognized result format']),
	{ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'internal detail must not be echoed' } },
	{ ...searchResponse([matchText('Wrong')]), id: 2 },
	{
		jsonrpc: '2.0',
		id: 1,
		result: { isError: true, content: [{ type: 'text', text: matchText('Not a success') }] }
	},
	{ result: 'invalid' }
]) {
	it.effect('rejects malformed search results and links outside the docs origin', () =>
		Effect.gen(function* () {
			const result = yield* invoke(['docs', 'search', 'clusters', '--json'], () =>
				Promise.resolve(Response.json(body))
			);
			expect(result.code).not.toBe(0);
			expect(result.stdout).toContain('https://docs.akua.dev/llms.txt');
			expect(result.stdout).not.toContain('evil.test');
			expect(result.stdout).not.toContain('internal detail');
		})
	);
}

for (const text of ['event: message\ndata: {not json}\n\n', ': heartbeat\n\n']) {
	it.effect('rejects malformed or missing MCP SSE results', () =>
		Effect.gen(function* () {
			const result = yield* invoke(['docs', 'search', 'clusters', '--json'], () =>
				Promise.resolve(new Response(text, { headers: { 'content-type': 'text/event-stream' } }))
			);
			expect(result.code).not.toBe(0);
			expect(result.stdout).toContain('https://docs.akua.dev/mcp');
		})
	);
}

it.effect('reports MCP rate limiting without retrying or hiding its URL', () =>
	Effect.gen(function* () {
		let requests = 0;
		const result = yield* invoke(['docs', 'search', 'clusters', '--json'], () => {
			requests += 1;
			return Promise.resolve(new Response('rate limited', { status: 429 }));
		});
		expect(requests).toBe(1);
		expect(result.code).not.toBe(0);
		expect(result.stdout).toContain('HTTP 429');
		expect(result.stdout).toContain('https://docs.akua.dev/mcp');
	})
);

it.effect('bounds the complete request including a stalled response body', () =>
	Effect.gen(function* () {
		const fiber = yield* invoke(['docs', 'quickstart', '--json'], () =>
			Promise.resolve(
				new Response(new ReadableStream(), {
					headers: { 'content-type': 'text/markdown' }
				})
			)
		).pipe(Effect.forkChild);
		yield* TestClock.adjust('31 seconds');
		const result = yield* Fiber.join(fiber);
		expect(result.code).not.toBe(0);
		expect(result.stdout).toContain('https://docs.akua.dev/quickstart');
	})
);
