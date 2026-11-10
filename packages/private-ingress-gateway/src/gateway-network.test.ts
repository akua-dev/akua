import { BunFileSystem, BunHttpServer, BunSocket } from '@effect/platform-bun';
import { expect, it } from '@effect/vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Clock, ConfigProvider, Context, Effect, Layer, Ref, Schedule } from 'effect';
import { Socket } from 'effect/socket';
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { privateIngressGatewayApp } from './gateway';
import { privateIngressGatewayServices, privateIngressUpstreamClient } from './index';

const issuer = 'https://id.akua.dev';
const clusterAudience = 'private-ingress-gateway:clu_gateway123';

/**
 * Identity in front of the gateway: a JWKS endpoint publishing a current and a
 * retiring key, and the dispatcher's tokens signed with either.
 */
const identityAuthority = Effect.gen(function* () {
	const current = yield* Effect.promise(() => generateKeyPair('ES256', { extractable: true }));
	const retiring = yield* Effect.promise(() => generateKeyPair('ES256', { extractable: true }));
	const published = {
		keys: [
			{
				...(yield* Effect.promise(() => exportJWK(current.publicKey))),
				kid: 'current',
				alg: 'ES256',
				use: 'sig'
			},
			{
				...(yield* Effect.promise(() => exportJWK(retiring.publicKey))),
				kid: 'retiring',
				alg: 'ES256',
				use: 'sig'
			}
		]
	};
	const state = { available: true, reads: 0 };
	const server = yield* Effect.acquireRelease(
		Effect.sync(() =>
			Bun.serve({
				hostname: '127.0.0.1',
				port: 0,
				fetch: () => {
					state.reads++;
					return state.available ? Response.json(published) : new Response(null, { status: 503 });
				}
			})
		),
		(server) => Effect.promise(() => server.stop(true))
	);
	const origin = `http://127.0.0.1:${server.port}`;
	const sign = Effect.fnUntraced(function* (
		kid = 'current',
		audience = clusterAudience,
		expired = false,
		overrides: {
			readonly issuer?: string;
			readonly subject?: string;
			readonly scope?: string;
			readonly issuedOffset?: number;
			readonly lifetime?: number;
			readonly omitKid?: boolean;
		} = {}
	) {
		const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
		return yield* Effect.promise(() =>
			new SignJWT({ scope: overrides.scope ?? 'gateway:route' })
				.setProtectedHeader({ alg: 'ES256', ...(overrides.omitKid ? {} : { kid }) })
				.setIssuer(overrides.issuer ?? issuer)
				.setSubject(overrides.subject ?? 'service:domain-dispatcher')
				.setAudience(audience)
				.setIssuedAt(expired ? now - 61 : now + (overrides.issuedOffset ?? 0))
				.setExpirationTime(expired ? now - 1 : now + (overrides.lifetime ?? 60))
				.sign(kid === 'retiring' ? retiring.privateKey : current.privateKey)
		);
	});
	return { server, origin, state, sign };
});

/** The gateway's own configuration: Identity for this Cluster and a table of one route. */
const gatewayEnvironment = (jwksOrigin: string, backendUrl: string) =>
	privateIngressGatewayServices.pipe(
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PRIVATE_INGRESS_GATEWAY_CLUSTER_ID: 'clu_gateway123',
					PRIVATE_INGRESS_GATEWAY_IDENTITY_ISSUER: issuer,
					PRIVATE_INGRESS_GATEWAY_IDENTITY_JWKS_URL: `${jwksOrigin}/.well-known/jwks.json`,
					PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE: JSON.stringify({
						routes: [{ public_host: 'app.acme.example', backend_url: backendUrl }]
					})
				})
			)
		),
		Layer.provide(BunFileSystem.layer)
	);

it.live('accepts cluster tokens and overlapping kids while surviving a JWKS outage', () =>
	Effect.gen(function* () {
		const identity = yield* identityAuthority;
		const jwksOrigin = identity.origin;
		const handler = HttpRouter.toWebHandler(
			HttpRouter.add('*', '/*', privateIngressGatewayApp).pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						gatewayEnvironment(jwksOrigin, jwksOrigin),
						BunSocket.layerWebSocketConstructor,
						privateIngressUpstreamClient
					)
				)
			),
			{ disableLogger: true }
		);
		yield* Effect.addFinalizer(() => Effect.promise(() => handler.dispose()));
		const sign = identity.sign;
		const request = (token: string, path = '/one') =>
			Effect.promise(() =>
				handler.handler(
					new Request(`http://gateway${path}`, {
						headers: { 'x-forwarded-host': 'app.acme.example', 'x-platform-route': token }
					})
				)
			);
		const token = yield* sign();
		expect((yield* request(token)).status).toBe(200);
		expect((yield* request(token, '/another?query=yes')).status).toBe(200);
		expect((yield* request(yield* sign('retiring'))).status).toBe(200);
		expect(
			(yield* request(yield* sign('current', 'private-ingress-gateway:clu_other'))).status
		).toBe(403);
		expect((yield* request(yield* sign('current', undefined, true))).status).toBe(403);
		expect((yield* request(yield* sign('unknown'))).status).toBe(403);
		for (const overrides of [
			{ issuer: 'https://attacker.example' },
			{ subject: 'service:platform-api' },
			{ subject: 'user:dispatcher' },
			{ scope: '' },
			{ scope: 'gateway:route broker:access' },
			{ issuedOffset: 10 },
			{ lifetime: 61 },
			{ omitKid: true }
		]) {
			expect((yield* request(yield* sign('current', undefined, false, overrides))).status).toBe(
				403
			);
		}
		identity.state.available = false;
		const warmedReads = identity.state.reads;
		expect((yield* request(token)).status).toBe(503); // backend is the same HTTP origin; auth still succeeds
		expect(identity.state.reads).toBe(warmedReads + 1);
		yield* Effect.promise(() => identity.server.stop(true));
		// The endpoint is now actually unreachable. The cached JWKS still verifies.
		// Authentication still succeeds; only the separate backend hop returns 502.
		expect((yield* request(yield* sign())).status).toBe(502);
	}).pipe(Effect.scoped)
);

it.live('forwards a routed request to its table backend without duplicating its query', () =>
	Effect.gen(function* () {
		const identity = yield* identityAuthority;
		const compressed = Bun.gzipSync('upstream-response');
		const upstreamContext = yield* Layer.build(BunHttpServer.layerTest);
		const upstream = Context.get(upstreamContext, HttpServer.HttpServer);
		if (upstream.address._tag === 'UnixPathAddress')
			return yield* Effect.die('Expected TCP upstream');
		const upstreamRequests = yield* Ref.make<
			ReadonlyArray<{ readonly url: string; readonly headers: Readonly<Record<string, string>> }>
		>([]);
		yield* upstream.serve(
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				yield* Ref.update(upstreamRequests, (requests) => [
					...requests,
					{ url: request.url, headers: request.headers }
				]);
				return HttpServerResponse.uint8Array(compressed, {
					headers: { 'content-encoding': 'gzip', 'content-type': 'text/plain' }
				});
			})
		);
		const gateway = HttpRouter.toWebHandler(
			HttpRouter.add('*', '/*', privateIngressGatewayApp).pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						gatewayEnvironment(identity.origin, `http://127.0.0.1:${upstream.address.port}`),
						BunSocket.layerWebSocketConstructor,
						privateIngressUpstreamClient
					)
				)
			),
			{ disableLogger: true }
		);
		yield* Effect.addFinalizer(() => Effect.promise(() => gateway.dispose()));
		const token = yield* identity.sign();
		const request = new Request('http://gateway/orders?include=items', {
			headers: {
				'X-Forwarded-Host': 'App.Acme.Example.',
				'X-Platform-Route': token,
				'X-Forwarded-For': 'attacker',
				'CF-Connecting-IP': 'attacker'
			}
		});
		const response = yield* Effect.promise(() => gateway.handler(request));
		expect(response.status).toBe(200);
		expect(response.headers.get('content-encoding')).toBe('gzip');
		expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(compressed);
		const forwarded = (yield* Ref.get(upstreamRequests))[0];
		expect(forwarded?.url).toBe('/orders?include=items');
		expect(forwarded?.headers.host).toBe('app.acme.example');
		expect(forwarded?.headers['x-forwarded-host']).toBe('app.acme.example');
		expect(forwarded?.headers['x-forwarded-proto']).toBe('https');
		expect(forwarded?.headers['x-platform-route']).toBeUndefined();
		expect(forwarded?.headers['x-forwarded-for']).toBeUndefined();
		expect(forwarded?.headers['cf-connecting-ip']).toBeUndefined();
	}).pipe(Effect.scoped)
);

it.live(
	'relays routed WebSocket text and binary frames with exact public request metadata and peer close',
	() =>
		Effect.gen(function* () {
			const identity = yield* identityAuthority;
			const upstreamContext = yield* Layer.build(BunHttpServer.layerTest);
			const upstream = Context.get(upstreamContext, HttpServer.HttpServer);
			const gatewayContext = yield* Layer.build(BunHttpServer.layerTest);
			const gateway = Context.get(gatewayContext, HttpServer.HttpServer);
			if (upstream.address._tag === 'UnixPathAddress' || gateway.address._tag === 'UnixPathAddress')
				return yield* Effect.die('Expected TCP servers');
			const gatewayPort = gateway.address.port;
			const requests = yield* Ref.make<ReadonlyArray<Readonly<Record<string, string>>>>([]);
			const closed = yield* Ref.make(0);
			yield* upstream.serve(
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					expect(request.url).toBe('/rest/push?pushRef=signed');
					yield* Ref.update(requests, (all) => [...all, request.headers]);
					const socket = yield* request.upgrade;
					return yield* Effect.scoped(
						Effect.gen(function* () {
							const reader = yield* socket.reader;
							const writer = yield* socket.writer;
							yield* writer.write('connected');
							return yield* reader.pull.pipe(
								Effect.flatMap((frames) =>
									Effect.forEach(frames, (frame) =>
										frame === 'close'
											? writer.write(new Socket.CloseEvent(1000, 'finished'))
											: writer.write(frame)
									)
								),
								Effect.forever
							);
						})
					).pipe(
						Effect.catchTag('SocketError', () => Effect.void),
						Effect.ensuring(Ref.update(closed, (n) => n + 1)),
						Effect.as(HttpServerResponse.empty())
					);
				})
			);
			const services = Layer.mergeAll(
				gatewayEnvironment(identity.origin, `http://127.0.0.1:${upstream.address.port}`),
				privateIngressUpstreamClient,
				BunSocket.layerWebSocketConstructor
			);
			yield* gateway.serve(privateIngressGatewayApp).pipe(Effect.provide(services));
			const token = yield* identity.sign();
			const connect = (host = 'app.acme.example', routeToken = token, protocols?: string[]) =>
				Socket.makeWebSocket(`ws://127.0.0.1:${gatewayPort}/rest/push?pushRef=signed`, {
					protocols,
					headers: {
						'x-platform-route': routeToken,
						'x-forwarded-host': host,
						'x-forwarded-proto': 'http',
						'x-forwarded-for': 'spoofed',
						'cf-connecting-ip': 'spoofed',
						'proxy-authorization': 'remove-me',
						cookie: 'n8n-auth=application-cookie',
						origin: 'https://app.acme.example'
					}
				});
			for (const socket of [
				yield* connect('unlisted.acme.example'),
				yield* connect(undefined, 'invalid'),
				yield* connect(undefined, token, ['unsupported'])
			]) {
				expect((yield* Effect.scoped(socket.reader).pipe(Effect.result))._tag).toBe('Failure');
			}
			expect(yield* Ref.get(requests)).toHaveLength(0);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const socket = yield* connect();
					const reader = yield* socket.reader;
					const writer = yield* socket.writer;
					expect(yield* reader.pull).toEqual(['connected']);
					yield* writer.write('text');
					expect(yield* reader.pull).toEqual(['text']);
					yield* writer.write(new Uint8Array([0, 255, 42]));
					expect(yield* reader.pull).toEqual([new Uint8Array([0, 255, 42])]);
					yield* writer.write('close');
					const close = yield* reader.pull.pipe(Effect.flip);
					expect(close.reason).toMatchObject({ _tag: 'SocketCloseError', code: 1000 });
				})
			);
			const headers = (yield* Ref.get(requests))[0];
			expect(headers).toMatchObject({
				host: 'app.acme.example',
				'x-forwarded-host': 'app.acme.example',
				'x-forwarded-proto': 'https',
				cookie: 'n8n-auth=application-cookie',
				origin: 'https://app.acme.example'
			});
			for (const name of [
				'x-platform-route',
				'x-forwarded-for',
				'cf-connecting-ip',
				'proxy-authorization',
				'sec-websocket-protocol'
			])
				expect(headers?.[name]).toBeUndefined();
			yield* Effect.scoped(
				Effect.gen(function* () {
					const socket = yield* connect();
					const reader = yield* socket.reader;
					yield* reader.pull;
					yield* (yield* socket.writer).write(new Socket.CloseEvent(1000, 'client finished'));
				})
			);
			yield* Ref.get(closed).pipe(
				Effect.repeat({ while: (count) => count < 2, schedule: Schedule.spaced('10 millis') })
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(BunSocket.layerWebSocketConstructor),
			Effect.timeout('10 seconds')
		)
);
