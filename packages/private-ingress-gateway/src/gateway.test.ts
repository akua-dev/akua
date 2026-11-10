import { expect, layer } from '@effect/vitest';
import { BunSocket } from '@effect/platform-bun';
import { Effect, Layer, Redacted, Stream } from 'effect';
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
import { GatewayIdentityError, GatewayIdentityVerifier } from './identity';
import {
	PrivateIngressRouteResolver,
	PrivateIngressRouteTableError,
	privateIngressGatewayApp
} from './gateway';

const dispatcherToken = 'dispatcher-token';

/** Identity's verdict on the dispatcher's token; the JWKS path itself is covered in gateway-network.test.ts. */
const verifier = Layer.succeed(GatewayIdentityVerifier)({
	verify: (token) =>
		Redacted.value(token) === dispatcherToken
			? Effect.succeed({
					iss: 'https://id.akua.dev',
					sub: 'service:domain-dispatcher' as const,
					aud: 'gateway:ro_gateway',
					iat: 1,
					exp: 2,
					scope: 'gateway:route'
				})
			: Effect.fail(new GatewayIdentityError())
});

/** The mounted table: one public host, one backend. */
const table: PrivateIngressRouteResolver['Service']['resolve'] = (publicHost) =>
	Effect.succeed(
		publicHost === 'app.acme.example'
			? { url: 'http://orders.default.svc.cluster.local:8080' }
			: null
	);

layer(BunSocket.layerWebSocketConstructor)('gateway request boundary', (it) => {
	const runRequest = (
		request: Request,
		options: {
			readonly execute?: HttpClient.HttpClient['execute'];
			readonly resolve?: PrivateIngressRouteResolver['Service']['resolve'];
			readonly upstream?: Response;
		} = {}
	) => {
		const dependencies = Layer.mergeAll(
			verifier,
			Layer.succeed(PrivateIngressRouteResolver)({ resolve: options.resolve ?? table }),
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
		return privateIngressGatewayApp.pipe(
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(request)
			),
			Effect.provide(dependencies)
		);
	};

	const routedRequest = (headers: Record<string, string> = {}) =>
		new Request('https://origin.example/orders?include=items', {
			headers: {
				'X-Forwarded-Host': 'app.acme.example',
				'X-Platform-Route': dispatcherToken,
				...headers
			}
		});

	it.effect('serves health checks without route dependencies', () =>
		Effect.gen(function* () {
			const response = yield* runRequest(new Request('http://127.0.0.1/healthz'));
			expect(response.status).toBe(200);
		})
	);

	it.effect(
		'forwards routed application health checks instead of replacing their JSON response',
		() =>
			Effect.gen(function* () {
				const request = new Request('http://gateway/healthz', {
					headers: { 'x-platform-route': dispatcherToken, 'x-forwarded-host': 'app.acme.example' }
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

	it.effect('forwards a request the dispatcher authenticated to the backend of its host', () =>
		Effect.gen(function* () {
			let resolved: string | undefined;
			const response = yield* runRequest(routedRequest(), {
				resolve: (publicHost) => {
					resolved = publicHost;
					return table(publicHost);
				}
			});
			expect(response.status).toBe(204);
			expect(resolved).toBe('app.acme.example');
		})
	);

	it.effect('preserves multiple upstream cookies on bodyless responses without duplication', () =>
		Effect.gen(function* () {
			const headers = new globalThis.Headers();
			headers.append('set-cookie', 'session=one; Path=/');
			headers.append('set-cookie', 'preference=two; Path=/');
			const response = yield* runRequest(routedRequest(), {
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
			const request = routedRequest();
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
					routedRequest({
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

	it.effect('answers 404 for a public host its table does not list, before forwarding', () =>
		Effect.gen(function* () {
			let forwarded = false;
			const response = yield* runRequest(
				routedRequest({ 'X-Forwarded-Host': 'attacker.example' }),
				{
					execute: (request) => {
						forwarded = true;
						return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('leak')));
					}
				}
			);
			expect(response.status).toBe(404);
			expect(forwarded).toBe(false);
		})
	);

	it.effect('translates upstream transport failures to bad gateway', () =>
		Effect.gen(function* () {
			const response = yield* runRequest(routedRequest(), {
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
			const request = new Request('https://origin.example/stream', {
				method: 'POST',
				duplex: 'half',
				headers: {
					'Content-Type': 'application/octet-stream',
					'X-Forwarded-Host': 'app.acme.example',
					'X-Platform-Route': dispatcherToken
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
