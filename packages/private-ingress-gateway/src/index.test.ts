import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import { expect, layer } from '@effect/vitest';
import type { RouteTokenClaims } from './route-token/index';
import { ConfigProvider, Effect, FileSystem, Layer, Path } from 'effect';
import { PrivateIngressGatewayConfig, PrivateIngressRouteResolver } from './gateway';
import { privateIngressGatewayServices } from './index';

const claims: RouteTokenClaims = {
	iss: 'platform-hostname-dispatcher',
	aud: 'platform-private-ingress-gateway',
	workspace_id: 'ws_route',
	install_id: 'inst_route',
	origin_route_id: 'oro_123',
	public_host: 'app.acme.example',
	method: 'GET',
	path: '/orders/123?include=items',
	exp: 1_700_000_030,
	jti: 'rt_test'
};

const routeTable = (workspaceId = 'ws_route') =>
	JSON.stringify({
		routes: [
			{
				origin_route_id: 'oro_123',
				public_host: 'App.Acme.Example.',
				workspace_id: workspaceId,
				install_id: 'inst_route',
				backend_url: 'http://orders.default.svc.cluster.local:8080'
			}
		]
	});

const withGatewayEnvironment = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	env: Record<string, string>
) =>
	effect.pipe(
		Effect.provide(privateIngressGatewayServices),
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env))
	);

layer(Layer.merge(BunFileSystem.layer, BunPath.layer))(
	'private ingress gateway configuration',
	(it) => {
		it.effect('loads the public key and inline route table through Config and Schema', () =>
			withGatewayEnvironment(
				Effect.gen(function* () {
					const config = yield* PrivateIngressGatewayConfig;
					const resolver = yield* PrivateIngressRouteResolver;
					expect(config.publicKeyPem).toBe('public-key');
					expect(yield* resolver.resolve(claims)).toEqual({
						url: 'http://orders.default.svc.cluster.local:8080/'
					});
					expect(yield* resolver.resolve({ ...claims, workspace_id: 'ws_other' })).toBeNull();
				}),
				{
					PRIVATE_INGRESS_GATEWAY_PUBLIC_KEY: 'public-key',
					PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE: routeTable()
				}
			)
		);

		it.effect('rejects excess route-table fields at the configuration boundary', () =>
			Effect.gen(function* () {
				const exit = yield* withGatewayEnvironment(Effect.void, {
					PRIVATE_INGRESS_GATEWAY_PUBLIC_KEY: 'public-key',
					PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE: JSON.stringify({
						routes: [],
						unexpected: true
					})
				}).pipe(Effect.exit);
				expect(exit._tag).toBe('Failure');
			})
		);

		it.effect('uses the last route for duplicate projection keys', () =>
			withGatewayEnvironment(
				Effect.gen(function* () {
					const resolver = yield* PrivateIngressRouteResolver;
					expect(yield* resolver.resolve(claims)).toEqual({
						url: 'http://replacement.default.svc.cluster.local:8080/'
					});
				}),
				{
					PRIVATE_INGRESS_GATEWAY_PUBLIC_KEY: 'public-key',
					PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE: JSON.stringify({
						routes: [
							{
								origin_route_id: 'oro_123',
								public_host: 'app.acme.example',
								workspace_id: 'ws_route',
								install_id: 'inst_route',
								backend_url: 'http://orders.default.svc.cluster.local:8080'
							},
							{
								origin_route_id: 'oro_123',
								public_host: 'app.acme.example',
								workspace_id: 'ws_route',
								install_id: 'inst_route',
								backend_url: 'http://replacement.default.svc.cluster.local:8080'
							}
						]
					})
				}
			)
		);

		it.effect('reloads a file-backed route table without restarting the service layer', () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'private-ingress-gateway-' });
				const publicKeyPath = path.join(directory, 'public-key.pem');
				const routeTablePath = path.join(directory, 'routes.json');
				yield* fs.writeFileString(publicKeyPath, 'public-key');
				yield* fs.writeFileString(routeTablePath, JSON.stringify({ routes: [] }));

				yield* withGatewayEnvironment(
					Effect.gen(function* () {
						const resolver = yield* PrivateIngressRouteResolver;
						expect(yield* resolver.resolve(claims)).toBeNull();
						yield* fs.writeFileString(routeTablePath, routeTable());
						expect(yield* resolver.resolve(claims)).toEqual({
							url: 'http://orders.default.svc.cluster.local:8080/'
						});
					}),
					{
						PRIVATE_INGRESS_GATEWAY_PUBLIC_KEY_PATH: publicKeyPath,
						PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE_PATH: routeTablePath
					}
				);
			})
		);

		it.effect('does not reread an unchanged file-backed route table for every request', () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'private-ingress-gateway-' });
				const routeTablePath = path.join(directory, 'routes.json');
				yield* fs.writeFileString(routeTablePath, routeTable());
				let routeTableReads = 0;
				const countingFileSystem = FileSystem.makeNoop({
					stat: fs.stat,
					readFileString: (filePath, encoding) => {
						if (filePath === routeTablePath) routeTableReads += 1;
						return fs.readFileString(filePath, encoding);
					}
				});

				yield* withGatewayEnvironment(
					Effect.gen(function* () {
						const resolver = yield* PrivateIngressRouteResolver;
						expect(yield* resolver.resolve(claims)).not.toBeNull();
						expect(yield* resolver.resolve(claims)).not.toBeNull();
					}),
					{
						PRIVATE_INGRESS_GATEWAY_PUBLIC_KEY: 'public-key',
						PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE_PATH: routeTablePath
					}
				).pipe(Effect.provideService(FileSystem.FileSystem, countingFileSystem));

				expect(routeTableReads).toBe(1);
			})
		);
	}
);
