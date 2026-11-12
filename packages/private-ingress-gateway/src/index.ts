import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunSocket from '@effect/platform-bun/BunSocket';
import { RouteTable, toDispatcherKvKey } from './protocol';
import { ClusterId } from './identity';
import { GatewayIdentityVerifier } from './identity';
import { Config, Context, Effect, FileSystem, Layer, Option, Ref, Result, Schema } from 'effect';
import { FetchHttpClient, HttpServer } from 'effect/http';
import {
	PrivateIngressRouteResolver,
	PrivateIngressRouteTableError,
	privateIngressGatewayApp,
	type PrivateIngressRouteBackend
} from './gateway';
import { privateIngressTelemetryLayer } from './telemetry';

const RouteTableJsonSchema = Schema.fromJsonString(RouteTable);

export class PrivateIngressGatewayStartupError extends Schema.TaggedError<
	PrivateIngressGatewayStartupError,
	{ readonly brand: unique symbol }
>()('PrivateIngressGatewayStartupError', {
	operation: Schema.Literals(['configuration', 'route_table']),
	cause: Schema.Defect()
}) {}

const environmentConfig = Effect.all({
	identityAudience: Config.option(
		Config.NonEmptyString('PRIVATE_INGRESS_GATEWAY_IDENTITY_AUDIENCE')
	),
	identityJwksUrl: Config.option(
		Config.schema(
			Schema.URLFromString.check(
				Schema.makeFilter((url) => ['http:', 'https:'].includes(url.protocol))
			),
			'PRIVATE_INGRESS_GATEWAY_IDENTITY_JWKS_URL'
		)
	),
	clusterId: Config.option(Config.schema(ClusterId, 'PRIVATE_INGRESS_GATEWAY_CLUSTER_ID')),
	identityIssuer: Config.NonEmptyString('PRIVATE_INGRESS_GATEWAY_IDENTITY_ISSUER').pipe(
		Config.withDefault('https://id.akua.dev')
	),
	routeTable: Config.option(Config.NonEmptyString('PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE')),
	routeTablePath: Config.option(Config.NonEmptyString('PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE_PATH'))
});

type GatewayEnvironment = Effect.Success<typeof environmentConfig>;

const parseRouteTable = (source: string) =>
	Schema.decodeEffect(RouteTableJsonSchema, { onExcessProperty: 'error' })(source).pipe(
		Effect.mapError(
			(cause) => new PrivateIngressGatewayStartupError({ operation: 'route_table', cause })
		)
	);

/** Host to backend; a host listed twice serves nothing, since no request can choose between them. */
function compileRouteTable(
	routeTable: typeof RouteTable.Type
): ReadonlyMap<string, PrivateIngressRouteBackend | null> {
	const routes = new Map<string, PrivateIngressRouteBackend | null>();
	for (const route of routeTable.routes) {
		const host = toDispatcherKvKey(route.public_host);
		routes.set(host, routes.has(host) ? null : { url: route.backend_url.toString() });
	}
	return routes;
}

function fileFingerprint(info: FileSystem.File.Info): string {
	return [
		info.dev,
		Option.getOrElse(info.ino, () => -1),
		Option.match(info.mtime, { onNone: () => -1, onSome: (value) => value.getTime() }),
		info.size
	].join(':');
}

const makeRouteResolver = Effect.fn('PrivateIngressGateway.makeRouteResolver')(function* (
	environment: GatewayEnvironment
) {
	const fs = yield* FileSystem.FileSystem;
	const inline = Option.isSome(environment.routeTable)
		? Option.some(compileRouteTable(yield* parseRouteTable(environment.routeTable.value)))
		: Option.none<ReadonlyMap<string, PrivateIngressRouteBackend | null>>();
	const snapshot = yield* Ref.make<
		Option.Option<{
			readonly fingerprint: string;
			readonly result: Result.Result<
				ReadonlyMap<string, PrivateIngressRouteBackend | null>,
				PrivateIngressGatewayStartupError
			>;
		}>
	>(Option.none());
	const resolve = Effect.fn('PrivateIngressGateway.resolveRoute')(function* (publicHost: string) {
		const host = toDispatcherKvKey(publicHost);
		if (Option.isSome(inline)) return inline.value.get(host) ?? null;
		if (Option.isNone(environment.routeTablePath)) {
			return yield* new PrivateIngressGatewayStartupError({
				operation: 'configuration',
				cause: 'route_table inline value or path is required'
			});
		}
		const info = yield* fs
			.stat(environment.routeTablePath.value)
			.pipe(
				Effect.mapError(
					(cause) => new PrivateIngressGatewayStartupError({ operation: 'route_table', cause })
				)
			);
		const fingerprint = fileFingerprint(info);
		const current = yield* Ref.get(snapshot);
		if (Option.isSome(current) && current.value.fingerprint === fingerprint) {
			return (yield* Effect.fromResult(current.value.result)).get(host) ?? null;
		}
		const result = yield* fs.readFileString(environment.routeTablePath.value).pipe(
			Effect.mapError(
				(cause) => new PrivateIngressGatewayStartupError({ operation: 'route_table', cause })
			),
			Effect.andThen(parseRouteTable),
			Effect.map(compileRouteTable),
			Effect.result
		);
		yield* Ref.set(snapshot, Option.some({ fingerprint, result }));
		return (yield* Effect.fromResult(result)).get(host) ?? null;
	});
	return PrivateIngressRouteResolver.of({
		resolve: (publicHost) =>
			resolve(publicHost).pipe(
				Effect.mapError((cause) => new PrivateIngressRouteTableError({ cause }))
			)
	});
});

export const privateIngressGatewayServices = Layer.effectContext(
	Effect.gen(function* () {
		const environment = yield* environmentConfig.pipe(
			Effect.mapError(
				(cause) => new PrivateIngressGatewayStartupError({ operation: 'configuration', cause })
			)
		);
		const identityAudience = Option.orElse(environment.identityAudience, () =>
			Option.map(environment.clusterId, (id) => `private-ingress-gateway:${id}`)
		);
		if (Option.isNone(identityAudience))
			return yield* new PrivateIngressGatewayStartupError({
				operation: 'configuration',
				cause: 'Identity audience or cluster ID is required'
			});
		const resolver = yield* makeRouteResolver(environment);
		const verifier = yield* GatewayIdentityVerifier.pipe(
			Effect.provide(
				GatewayIdentityVerifier.layer({
					issuer: environment.identityIssuer,
					audience: identityAudience.value,
					jwksUrl: Option.getOrUndefined(environment.identityJwksUrl)
				})
			)
		);
		return Context.make(PrivateIngressRouteResolver, resolver).pipe(
			Context.add(GatewayIdentityVerifier, verifier)
		);
	})
);

const upstreamRequestInit: BunFetchRequestInit = { redirect: 'manual', decompress: false };

export const privateIngressUpstreamClient = FetchHttpClient.layer.pipe(
	Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)(upstreamRequestInit))
);

const gatewayServices = privateIngressGatewayServices.pipe(Layer.provide(BunFileSystem.layer));
const server = Layer.unwrap(
	Config.Port('PRIVATE_INGRESS_GATEWAY_PORT').pipe(
		Config.withDefault(8080),
		Effect.map((port) => BunHttpServer.layerServer({ hostname: '0.0.0.0', port }))
	)
);

export const PrivateIngressGatewayServer = HttpServer.serve(privateIngressGatewayApp).pipe(
	Layer.provide(privateIngressUpstreamClient),
	Layer.provide(BunSocket.layerWebSocketConstructor),
	Layer.provide(gatewayServices),
	Layer.provide(server)
);

const observability = Layer.unwrap(
	Config.option(Config.NonEmptyString('OTEL_EXPORTER_OTLP_ENDPOINT')).pipe(
		Effect.map((endpoint) =>
			Option.match(endpoint, {
				onNone: () => Layer.empty,
				onSome: privateIngressTelemetryLayer
			})
		)
	)
);

if (import.meta.main) {
	Layer.launch(PrivateIngressGatewayServer.pipe(Layer.provide(observability))).pipe(
		BunRuntime.runMain
	);
}
