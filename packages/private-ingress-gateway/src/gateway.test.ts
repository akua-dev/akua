import { beforeAll, expect, layer } from '@effect/vitest';
import { BunSocket } from '@effect/platform-bun';
import { RouteTokenCrypto, signRouteToken } from './route-token/index';
import { Effect, Layer, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import {
	HttpClient,
	HttpClientError,
	HttpClientRequest,
	HttpClientResponse,
	HttpBody,
	HttpServerRequest,
	HttpServerResponse,
	Cookies,
	UrlParams
} from 'effect/http';

import {
	PrivateIngressGatewayConfig,
	PrivateIngressRouteResolver,
	PrivateIngressRouteTableError,
	privateIngressGatewayApp
} from './gateway';

const NOW = 1_700_000_000_000;
let privateKeyPem: string;
let publicKeyPem: string;

function bytesToPem(label: string, bytes: ArrayBuffer): string {
	const binary = String.fromCharCode(...new Uint8Array(bytes));
	const base64 = btoa(binary);
	const lines = base64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

const BoundaryServices = Layer.merge(RouteTokenCrypto.layer, BunSocket.layerWebSocketConstructor);

layer(BoundaryServices)('gateway request boundary', (it) => {
	beforeAll(() =>
		Effect.runPromise(
			Effect.gen(function* () {
				const keys = yield* Effect.promise(() =>
					crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
						'sign',
						'verify'
					])
				);
				privateKeyPem = bytesToPem(
					'PRIVATE KEY',
					yield* Effect.promise(() => crypto.subtle.exportKey('pkcs8', keys.privateKey))
				);
				publicKeyPem = bytesToPem(
					'PUBLIC KEY',
					yield* Effect.promise(() => crypto.subtle.exportKey('spki', keys.publicKey))
				);
			})
		)
	);

	const runRequest = (
		request: Request,
		options: {
			readonly execute?: HttpClient.HttpClient['execute'];
			readonly resolve?: PrivateIngressRouteResolver['Service']['resolve'];
			readonly upstream?: Response;
		} = {}
	) => {
		const dependencies = Layer.mergeAll(
			Layer.succeed(PrivateIngressGatewayConfig)({ publicKeyPem }),
			Layer.succeed(PrivateIngressRouteResolver)({
				resolve:
					options.resolve ??
					(() => Effect.succeed({ url: 'http://orders.default.svc.cluster.local:8080' }))
			}),
			Layer.succeed(HttpClient.HttpClient)(
				HttpClient.make(
					options.execute ??
						((clientRequest) =>
							Effect.succeed(
								HttpClientResponse.fromWeb(
									clientRequest,
									options.upstream ?? new Response(null, { status: 204 })
								)
							))
				)
			)
		);
		return TestClock.setTime(NOW).pipe(
			Effect.andThen(privateIngressGatewayApp),
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(request)
			),
			Effect.provide(dependencies)
		);
	};

	const signedRequest = Effect.fn('PrivateIngressGatewayTest.signedRequest')(function* (
		headers: Record<string, string> = {}
	) {
		const token = yield* signRouteToken({
			privateKeyPem,
			now: NOW,
			jti: 'gateway-test',
			claims: {
				workspace_id: 'ws_gateway',
				install_id: 'inst_gateway',
				origin_route_id: 'oro_123',
				public_host: 'app.acme.example',
				method: 'GET',
				path: '/orders?include=items'
			}
		});
		return new Request('https://origin.example/orders?include=items', {
			headers: {
				'X-Forwarded-Host': 'app.acme.example',
				'X-Platform-Route': token,
				...headers
			}
		});
	});

	it.effect('serves health checks without route dependencies', () =>
		Effect.gen(function* () {
			const response = yield* runRequest(new Request('http://127.0.0.1/healthz'));
			expect(response.status).toBe(200);
		})
	);

	it.effect(
		'forwards signed application health checks instead of replacing their JSON response',
		() =>
			Effect.gen(function* () {
				const token = yield* signRouteToken({
					privateKeyPem,
					now: NOW,
					jti: 'app-health-test',
					claims: {
						workspace_id: 'ws_gateway',
						install_id: 'inst_gateway',
						origin_route_id: 'oro_123',
						public_host: 'app.acme.example',
						method: 'GET',
						path: '/healthz'
					}
				});
				const request = new Request('http://gateway/healthz', {
					headers: { 'x-platform-route': token, 'x-forwarded-host': 'app.acme.example' }
				});
				const response = yield* runRequest(request, {
					upstream: Response.json({ status: 'ok' })
				});
				expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).json())).toEqual({
					status: 'ok'
				});
				expect(
					(yield* runRequest(
						new Request(request, {
							headers: { 'x-platform-route': 'invalid', 'x-forwarded-host': 'app.acme.example' }
						})
					)).status
				).toBe(403);
			})
	);

	it.effect('rejects a missing route token before it resolves or forwards a request', () =>
		Effect.gen(function* () {
			const response = yield* runRequest(
				new Request('https://origin.example/orders', {
					headers: { 'X-Forwarded-Host': 'app.acme.example' }
				})
			);

			expect(response.status).toBe(403);
		})
	);

	it.effect('forwards only a route whose signed claims match the request', () =>
		Effect.gen(function* () {
			const response = yield* runRequest(yield* signedRequest());

			expect(response.status).toBe(204);
		})
	);

	it.effect('preserves multiple upstream cookies on bodyless responses without duplication', () =>
		Effect.gen(function* () {
			const headers = new globalThis.Headers();
			headers.append('set-cookie', 'session=one; Path=/');
			headers.append('set-cookie', 'preference=two; Path=/');
			const response = yield* runRequest(yield* signedRequest(), {
				upstream: new Response(null, { status: 204, headers })
			});

			expect(response.headers['set-cookie']).toBeUndefined();
			expect(Cookies.toRecord(response.cookies)).toEqual({
				preference: 'two',
				session: 'one'
			});
		})
	);

	it.effect('preserves routing failure status contracts', () =>
		Effect.gen(function* () {
			const request = yield* signedRequest();
			expect((yield* runRequest(request, { resolve: () => Effect.succeed(null) })).status).toBe(
				404
			);
			expect(
				(yield* runRequest(request, {
					resolve: () => Effect.fail(new PrivateIngressRouteTableError({ cause: 'unavailable' }))
				})).status
			).toBe(503);
			expect(
				(yield* runRequest(request, { resolve: () => Effect.succeed({ url: 'not a URL' }) })).status
			).toBe(502);
		})
	);

	it.effect(
		'rebuilds the verified public origin while scrubbing untrusted forwarding metadata',
		() =>
			Effect.gen(function* () {
				let forwarded: HttpClientRequest.HttpClientRequest | undefined;
				const response = yield* runRequest(
					yield* signedRequest({
						'CF-Connecting-IP': '203.0.113.1',
						'X-Real-IP': '203.0.113.2',
						Forwarded: 'host=attacker.example;proto=http',
						'X-Forwarded-For': '203.0.113.3',
						'X-Forwarded-Proto': 'http',
						'X-Platform-Forwarded-Host': 'attacker.example',
						'User-Agent': 'gateway-test'
					}),
					{
						execute: (request) => {
							forwarded = request;
							return Effect.succeed(
								HttpClientResponse.fromWeb(
									request,
									new Response('redirect', {
										status: 307,
										headers: { location: 'https://login.example/' }
									})
								)
							);
						}
					}
				);
				expect(response.status).toBe(307);
				expect(response.headers.location).toBe('https://login.example/');
				expect(forwarded?.url).toBe('http://orders.default.svc.cluster.local:8080/orders');
				expect(UrlParams.toString(forwarded?.urlParams ?? [])).toBe('include=items');
				expect(forwarded?.headers.host).toBe('app.acme.example');
				expect(forwarded?.headers['user-agent']).toBe('gateway-test');
				expect(forwarded?.headers['x-forwarded-host']).toBe('app.acme.example');
				expect(forwarded?.headers['x-forwarded-proto']).toBe('https');
				expect(forwarded?.headers.forwarded).toBeUndefined();
				expect(forwarded?.headers['x-forwarded-for']).toBeUndefined();
				expect(forwarded?.headers['x-platform-forwarded-host']).toBeUndefined();
				expect(forwarded?.headers['x-platform-route']).toBeUndefined();
				expect(forwarded?.headers['cf-connecting-ip']).toBeUndefined();
				expect(forwarded?.headers['x-real-ip']).toBeUndefined();
			})
	);

	it.effect('rejects a public host that differs from the signed route before forwarding', () =>
		Effect.gen(function* () {
			const response = yield* runRequest(
				yield* signedRequest({ 'X-Forwarded-Host': 'attacker.example' })
			);
			expect(response.status).toBe(403);
		})
	);

	it.effect('translates upstream transport failures to bad gateway', () =>
		Effect.gen(function* () {
			const response = yield* runRequest(yield* signedRequest(), {
				execute: (request) =>
					Effect.fail(
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({ request, cause: 'offline' })
						})
					)
			});
			expect(response.status).toBe(502);
		})
	);

	it.effect('keeps request and response bodies streaming in both directions', () =>
		Effect.gen(function* () {
			const encoder = new TextEncoder();
			const decoder = new TextDecoder();
			const token = yield* signRouteToken({
				privateKeyPem,
				now: NOW,
				jti: 'gateway-stream-test',
				claims: {
					workspace_id: 'ws_gateway',
					install_id: 'inst_gateway',
					origin_route_id: 'oro_123',
					public_host: 'app.acme.example',
					method: 'POST',
					path: '/stream'
				}
			});
			const request = new Request('https://origin.example/stream', {
				method: 'POST',
				duplex: 'half',
				headers: {
					'Content-Type': 'application/octet-stream',
					'X-Forwarded-Host': 'app.acme.example',
					'X-Platform-Route': token
				},
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode('request-'));
						controller.enqueue(encoder.encode('body'));
						controller.close();
					}
				})
			} as RequestInit & { readonly duplex: 'half' });
			let received = '';
			const response = yield* runRequest(request, {
				execute: Effect.fn('PrivateIngressGatewayTest.streamingClient')(function* (outgoing) {
					expect(outgoing.body._tag).toBe('Stream');
					if (outgoing.body._tag !== 'Stream') return yield* Effect.die('Expected stream body');
					received = Array.from(yield* Stream.runCollect(outgoing.body.stream).pipe(Effect.orDie))
						.map((chunk) => decoder.decode(chunk))
						.join('');
					return HttpClientResponse.fromWeb(
						outgoing,
						new Response(
							new ReadableStream({
								start(controller) {
									controller.enqueue(encoder.encode('response-'));
									controller.enqueue(encoder.encode('body'));
									controller.close();
								}
							})
						)
					);
				})
			});
			expect(received).toBe('request-body');
			expect(response.body._tag).toBe('Stream');
			if (response.body._tag !== 'Stream') return yield* Effect.die('Expected stream body');
			const returned = Array.from(yield* Stream.runCollect(response.body.stream))
				.map((chunk) => decoder.decode(chunk))
				.join('');
			expect(returned).toBe('response-body');
			expect(response.body).toBeInstanceOf(HttpBody.Stream);
		})
	);
});
