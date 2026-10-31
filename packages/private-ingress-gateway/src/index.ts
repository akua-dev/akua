import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunSocket from '@effect/platform-bun/BunSocket';
import {
	ORIGIN_ROUTE_WIRE_ID_MESSAGE,
	ORIGIN_ROUTE_WIRE_ID_PATTERN,
	toDispatcherKvKey
} from './protocol';
import { RouteTokenCrypto } from './route-token/index';
import { ClusterId } from './identity';
import { GatewayIdentityVerifier } from './identity';
import { Config, Context, Effect, FileSystem, Layer, Option, Ref, Result, Schema } from 'effect';
import { FetchHttpClient, HttpServer } from 'effect/http';
import {
	PrivateIngressGatewayConfig,
	PrivateIngressRouteResolver,
	PrivateIngressRouteTableError,
	privateIngressGatewayApp,
	type PrivateIngressRouteBackend
} from './gateway';
import { privateIngressTelemetryLayer } from './telemetry';

const OriginRouteWireIdSchema = Schema.String.pipe(
	Schema.check(
		Schema.isPattern(ORIGIN_ROUTE_WIRE_ID_PATTERN, {
			message: ORIGIN_ROUTE_WIRE_ID_MESSAGE
		})
	)
);

const RouteTableSchema = Schema.Struct({
	routes: Schema.Array(
		Schema.Struct({
			origin_route_id: OriginRouteWireIdSchema,
			public_host: Schema.NonEmptyString,
			workspace_id: Schema.NonEmptyString,
			install_id: Schema.NonEmptyString,
			backend_url: Schema.URLFromString
		})
	)
});
const RouteTableJsonSchema = Schema.fromJsonString(RouteTableSchema);
type RouteTable = typeof RouteTableSchema.Type;

export class PrivateIngressGatewayStartupError extends Schema.TaggedError<
	PrivateIngressGatewayStartupError,
	{ readonly brand: unique symbol }
>()('PrivateIngressGatewayStartupError', {
	operation: Schema.Literals(['configuration', 'public_key', 'route_table']),
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
	publicKey: Config.option(Config.NonEmptyString('PRIVATE_INGRESS_GATEWAY_PUBLIC_KEY')),
	publicKeyPath: Config.option(Config.NonEmptyString('PRIVATE_INGRESS_GATEWAY_PUBLIC_KEY_PATH')),
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

const readConfiguredText = Effect.fn('PrivateIngressGateway.readConfiguredText')(function* (args: {
	readonly inline: Option.Option<string>;
	readonly path: Option.Option<string>;
	readonly operation: 'public_key' | 'route_table';
}) {
	if (Option.isSome(args.inline)) return args.inline.value;
	if (Option.isNone(args.path)) {
		return yield* new PrivateIngressGatewayStartupError({
			operation: 'configuration',
			cause: `${args.operation} inline value or path is required`
		});
	}
	const fs = yield* FileSystem.FileSystem;
	return yield* fs
		.readFileString(args.path.value)
		.pipe(
			Effect.mapError(
				(cause) => new PrivateIngressGatewayStartupError({ operation: args.operation, cause })
			)
		);
});

function routeKey(args: {
	readonly originRouteId: string;
	readonly publicHost: string;
	readonly workspaceId: string;
	readonly installId: string;
}): string {
	return [
		args.originRouteId,
		toDispatcherKvKey(args.publicHost),
		args.workspaceId,
		args.installId
	].join('\0');
}

function compileRouteTable(
	routeTable: RouteTable
): ReadonlyMap<string, PrivateIngressRouteBackend | null> {
	const routes = new Map<string, PrivateIngressRouteBackend | null>();
	for (const route of routeTable.routes) {
		const hostKey = `host\0${toDispatcherKvKey(route.public_host)}`;
		// A duplicate host cannot be disambiguated by a cluster-scoped token.
		routes.set(hostKey, routes.has(hostKey) ? null : { url: route.backend_url.toString() });
		routes.set(
			routeKey({
				originRouteId: route.origin_route_id,
				publicHost: route.public_host,
				workspaceId: route.workspace_id,
				installId: route.install_id
			}),
			{ url: route.backend_url.toString() }
		);
	}
	return routes;
}

function resolveRoute(
	routes: ReadonlyMap<string, PrivateIngressRouteBackend | null>,
	claims: Parameters<PrivateIngressRouteResolver['Service']['resolve']>[0]
): PrivateIngressRouteBackend | null {
	if (
		claims.origin_route_id === undefined &&
		claims.workspace_id === undefined &&
		claims.install_id === undefined
	)
		return routes.get(`host\0${toDispatcherKvKey(claims.public_host)}`) ?? null;
	if (
		claims.origin_route_id === undefined ||
		claims.workspace_id === undefined ||
		claims.install_id === undefined
	)
		return null;
	return (
		routes.get(
			routeKey({
				originRouteId: claims.origin_route_id,
				publicHost: claims.public_host,
				workspaceId: claims.workspace_id,
				installId: claims.install_id
			})
		) ?? null
	);
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
	const resolve = Effect.fn('PrivateIngressGateway.resolveRoute')(function* (
		claims: Parameters<PrivateIngressRouteResolver['Service']['resolve']>[0]
	) {
		if (Option.isSome(inline)) return resolveRoute(inline.value, claims);
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
			return resolveRoute(yield* Effect.fromResult(current.value.result), claims);
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
		const routes = yield* Effect.fromResult(result);
		return resolveRoute(routes, claims);
	});
	return PrivateIngressRouteResolver.of({
		resolve: (claims) =>
			resolve(claims).pipe(Effect.mapError((cause) => new PrivateIngressRouteTableError({ cause })))
	});
});

export const privateIngressGatewayServices = Layer.effectContext(
	Effect.gen(function* () {
		const environment = yield* environmentConfig.pipe(
			Effect.mapError(
				(cause) => new PrivateIngressGatewayStartupError({ operation: 'configuration', cause })
			)
		);
		const publicKeyPem =
			Option.isNone(environment.publicKey) && Option.isNone(environment.publicKeyPath)
				? undefined
				: yield* readConfiguredText({
						inline: environment.publicKey,
						path: environment.publicKeyPath,
						operation: 'public_key'
					});
		const identityAudience = Option.orElse(environment.identityAudience, () =>
			Option.map(environment.clusterId, (id) => `private-ingress-gateway:${id}`)
		);
		if (publicKeyPem === undefined && Option.isNone(identityAudience))
			return yield* new PrivateIngressGatewayStartupError({
				operation: 'configuration',
				cause: 'Identity audience or migration public key is required'
			});
		const resolver = yield* makeRouteResolver(environment);
		const context = Context.make(PrivateIngressGatewayConfig, {
			publicKeyPem,
			identityAudience: Option.getOrUndefined(identityAudience)
		}).pipe(Context.add(PrivateIngressRouteResolver, resolver));
		if (Option.isNone(identityAudience)) return context;
		const verifier = yield* GatewayIdentityVerifier.pipe(
			Effect.provide(
				GatewayIdentityVerifier.layer({
					issuer: environment.identityIssuer,
					audience: identityAudience.value,
					jwksUrl: Option.getOrUndefined(environment.identityJwksUrl)
				})
			)
		);
		return Context.add(context, GatewayIdentityVerifier, verifier);
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
	Layer.provide(RouteTokenCrypto.layer),
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
