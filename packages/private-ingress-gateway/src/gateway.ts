import {
	DEFAULT_ROUTE_TOKEN_AUDIENCE,
	verifyRouteToken,
	type RouteTokenClaims
} from './route-token/index';
import {
	FORWARDED_HOST_HEADER_NAME,
	ROUTE_TOKEN_HEADER_NAME,
	isTrustedForwardHeaderName,
	requestPathForRouteToken,
	resolveRouteTargetUrl,
	toDispatcherKvKey
} from './protocol';
import { Clock, Context, Effect, Option, Redacted, Result, Schema } from 'effect';
import { GatewayIdentityVerifier } from './identity';
import { Socket } from 'effect/socket';
import {
	HttpClient,
	Headers,
	HttpClientRequest,
	type HttpClientResponse,
	HttpServerRequest,
	HttpServerResponse
} from 'effect/http';

export type PrivateIngressRouteBackend = {
	readonly url: string;
};
export type PrivateIngressRouteReference = Pick<RouteTokenClaims, 'public_host'> &
	Partial<Pick<RouteTokenClaims, 'origin_route_id' | 'workspace_id' | 'install_id'>>;

export class PrivateIngressRouteTableError extends Schema.TaggedError<
	PrivateIngressRouteTableError,
	{ readonly brand: unique symbol }
>()('PrivateIngressRouteTableError', { cause: Schema.Defect() }) {}

export class PrivateIngressRouteResolver extends Context.Service<
	PrivateIngressRouteResolver,
	{
		readonly resolve: (
			claims: PrivateIngressRouteReference
		) => Effect.Effect<PrivateIngressRouteBackend | null, PrivateIngressRouteTableError>;
	}
>()('platform/private-ingress-gateway/PrivateIngressRouteResolver') {}

export class PrivateIngressGatewayConfig extends Context.Service<
	PrivateIngressGatewayConfig,
	{
		readonly publicKeyPem?: string;
		readonly identityAudience?: string;
	}
>()('platform/private-ingress-gateway/PrivateIngressGatewayConfig') {}

function sanitizedForwardedHost(headers: Readonly<Record<string, string>>): string | null {
	const header = headers[FORWARDED_HOST_HEADER_NAME];
	if (header === undefined || header.includes(',')) return null;
	const normalized = toDispatcherKvKey(header);
	return normalized === '' ? null : normalized;
}

function scrubTrustedForwardHeaders(
	request: HttpClientRequest.HttpClientRequest,
	headers: Readonly<Record<string, string>>
): HttpClientRequest.HttpClientRequest {
	const names = Object.keys(headers).filter(isTrustedForwardHeaderName);
	return HttpClientRequest.updateHeaders(request, Headers.removeMany(names));
}

const forbidden = HttpServerResponse.text('forbidden', { status: 403 });
const routeNotFound = HttpServerResponse.text('route not found', { status: 404 });
const routeTableUnavailable = HttpServerResponse.text('route table unavailable', { status: 503 });
const badGateway = HttpServerResponse.text('bad gateway', { status: 502 });

const relayWebSocket = Effect.fn('PrivateIngressGateway.relayWebSocket')(function* (
	request: HttpServerRequest.HttpServerRequest,
	target: URL,
	headers: Readonly<Record<string, string>>,
	publicHost: string
) {
	// Bun's server adapter cannot return a negotiated subprotocol header.
	if (request.headers['sec-websocket-protocol'] !== undefined)
		return HttpServerResponse.text('WebSocket subprotocols are not supported', { status: 400 });
	const hopHeaders = new Set([
		'connection',
		'upgrade',
		'keep-alive',
		'proxy-authenticate',
		'proxy-authorization',
		'te',
		'trailer',
		'transfer-encoding',
		'content-length',
		...(request.headers.connection ?? '')
			.toLowerCase()
			.split(',')
			.map((name) => name.trim())
	]);
	const handshakeHeaders = {
		...Object.fromEntries(
			Object.entries(headers).filter(
				([name]) => !hopHeaders.has(name) && !name.startsWith('sec-websocket-')
			)
		),
		host: publicHost,
		[FORWARDED_HOST_HEADER_NAME]: publicHost,
		'x-forwarded-proto': 'https'
	};
	const url = new URL(target);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const upstream = yield* Socket.makeWebSocket(url.href, { headers: handshakeHeaders });
			// Finish the origin handshake before acknowledging the public upgrade.
			const upstreamReader = yield* upstream.reader;
			const upstreamWriter = yield* upstream.writer;
			const downstream = yield* request.upgrade;
			const downstreamReader = yield* downstream.reader;
			const downstreamWriter = yield* downstream.writer;
			const pump = (reader: Socket.Reader, writer: Socket.Writer) =>
				reader.pull.pipe(
					Effect.flatMap(writer.writeAll),
					Effect.forever,
					Effect.catchReason('SocketError', 'SocketCloseError', (reason) =>
						writer.write(
							new Socket.CloseEvent(
								reason.code === 1005 || reason.code === 1006 || reason.code === 1015
									? 1001
									: reason.code,
								reason.closeReason
							)
						)
					)
				);
			yield* Effect.raceFirst(
				pump(upstreamReader, downstreamWriter),
				pump(downstreamReader, upstreamWriter)
			);
			return HttpServerResponse.empty();
		})
	);
});

function fromUpstreamResponse(
	requestMethod: string,
	response: HttpClientResponse.HttpClientResponse
): HttpServerResponse.HttpServerResponse {
	return requestMethod === 'HEAD' || [204, 205, 304].includes(response.status)
		? HttpServerResponse.empty({
				status: response.status,
				headers: Headers.remove(response.headers, 'set-cookie'),
				cookies: response.cookies
			})
		: HttpServerResponse.fromClientResponse(response);
}

export const privateIngressGatewayApp = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest;
	const incomingUrl = new URL(request.originalUrl);
	const routeToken = request.headers[ROUTE_TOKEN_HEADER_NAME];
	if (incomingUrl.pathname === '/healthz' && routeToken === undefined) {
		return HttpServerResponse.text('ok');
	}

	const forwardedHost = sanitizedForwardedHost(request.headers);
	if (routeToken === undefined || forwardedHost === null) return forbidden;

	const config = yield* PrivateIngressGatewayConfig;
	const now = yield* Clock.currentTimeMillis;
	const claims =
		config.publicKeyPem === undefined
			? Option.none<RouteTokenClaims>()
			: yield* verifyRouteToken(routeToken, {
					publicKeyPem: config.publicKeyPem,
					now,
					expectedAudience: DEFAULT_ROUTE_TOKEN_AUDIENCE,
					expectedHost: forwardedHost,
					expectedMethod: request.method,
					expectedPath: requestPathForRouteToken(incomingUrl)
				}).pipe(Effect.option);
	let reference: PrivateIngressRouteReference;
	if (Option.isSome(claims)) {
		// Migration only: A still verifies the complete old request-bound contract.
		reference = claims.value;
	} else {
		if (config.identityAudience === undefined) return forbidden;
		const verifier = yield* Effect.serviceOption(GatewayIdentityVerifier);
		if (Option.isNone(verifier)) return forbidden;
		const verified = yield* verifier.value.verify(Redacted.make(routeToken)).pipe(Effect.result);
		if (Result.isFailure(verified)) return forbidden;
		// Identity authenticates the dispatcher for this Cluster. Only the local
		// authoritative route table selects a backend; headers never name a URL.
		reference = { public_host: forwardedHost };
	}

	const resolver = yield* PrivateIngressRouteResolver;
	const backendResult = yield* resolver.resolve(reference).pipe(Effect.result);
	if (Result.isFailure(backendResult)) return routeTableUnavailable;
	const backend = backendResult.success;
	if (backend === null) return routeNotFound;

	const targetOption = yield* Effect.try({
		try: () => resolveRouteTargetUrl(backend.url, incomingUrl),
		catch: () => undefined
	}).pipe(Effect.option);
	if (Option.isNone(targetOption)) return badGateway;
	const target = targetOption.value;

	const outgoing = scrubTrustedForwardHeaders(
		HttpServerRequest.toClientRequest(request),
		request.headers
	).pipe(
		HttpClientRequest.setUrl(target),
		// Managed public routes are canonical HTTPS, even when their backend is HTTP.
		// Rebuild origin metadata only after verifying the signed public host; the
		// incoming forwarded protocol is not a signed claim and must stay scrubbed.
		HttpClientRequest.setHeader('host', forwardedHost),
		HttpClientRequest.setHeader(FORWARDED_HOST_HEADER_NAME, forwardedHost),
		HttpClientRequest.setHeader('x-forwarded-proto', 'https')
	);
	const response = Effect.gen(function* () {
		if (request.headers.upgrade?.toLowerCase() === 'websocket')
			return yield* relayWebSocket(request, target, outgoing.headers, forwardedHost);
		return yield* HttpClient.execute(outgoing).pipe(
			Effect.map((response) => fromUpstreamResponse(request.method, response))
		);
	});
	return yield* response.pipe(
		Effect.catch((error) =>
			Effect.logWarning('Private ingress upstream request failed').pipe(
				Effect.annotateLogs({
					event: 'private_ingress_upstream_request_failed',
					target_host: target.host,
					error_name: error._tag
				}),
				Effect.as(badGateway)
			)
		)
	);
}).pipe(Effect.withSpan('privateIngressGateway.request'));
