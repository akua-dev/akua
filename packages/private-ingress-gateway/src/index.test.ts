import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import { expect, layer } from '@effect/vitest';
import { ConfigProvider, Effect, FileSystem, Layer, Path } from 'effect';
import { PrivateIngressRouteResolver } from './gateway';
import { privateIngressGatewayServices } from './index';

const backend = { url: 'http://orders.default.svc.cluster.local:8080/' };

const routeTable = (publicHost = 'App.Acme.Example.') =>
	JSON.stringify({
		routes: [
			{ public_host: publicHost, backend_url: 'http://orders.default.svc.cluster.local:8080' }
		]
	});

const withGatewayEnvironment = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	env: Record<string, string>
) =>
	effect.pipe(
		Effect.provide(privateIngressGatewayServices),
		Effect.provideService(
			ConfigProvider.ConfigProvider,
			ConfigProvider.fromEnvRecord({ PRIVATE_INGRESS_GATEWAY_CLUSTER_ID: 'clu_gateway123', ...env })
		)
	);

layer(Layer.merge(BunFileSystem.layer, BunPath.layer))(
	'private ingress gateway configuration',
	(it) => {
		it.effect('resolves a public host from an inline host-only route table', () =>
			withGatewayEnvironment(
				Effect.gen(function* () {
					const resolver = yield* PrivateIngressRouteResolver;
					expect(yield* resolver.resolve('app.acme.example')).toEqual(backend);
					expect(yield* resolver.resolve('APP.acme.example.')).toEqual(backend);
					expect(yield* resolver.resolve('other.acme.example')).toBeNull();
				}),
				{ PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE: routeTable() }
			)
		);

		it.effect('refuses to start without an Identity audience for its Cluster', () =>
			Effect.gen(function* () {
				const exit = yield* Effect.void.pipe(
					Effect.provide(privateIngressGatewayServices),
					Effect.provideService(
						ConfigProvider.ConfigProvider,
						ConfigProvider.fromEnvRecord({ PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE: routeTable() })
					),
					Effect.exit
				);
				expect(exit._tag).toBe('Failure');
			})
		);

		it.effect('rejects the retired signed-token route fields at the configuration boundary', () =>
			Effect.gen(function* () {
				const exit = yield* withGatewayEnvironment(Effect.void, {
					PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE: JSON.stringify({
						routes: [
							{
								origin_route_id: 'oro_123',
								public_host: 'app.acme.example',
								workspace_id: 'ws_route',
								install_id: 'inst_route',
								backend_url: 'http://orders.default.svc.cluster.local:8080'
							}
						]
					})
				}).pipe(Effect.exit);
				expect(exit._tag).toBe('Failure');
			})
		);

		it.effect('serves no backend for a public host the table lists twice', () =>
			withGatewayEnvironment(
				Effect.gen(function* () {
					const resolver = yield* PrivateIngressRouteResolver;
					expect(yield* resolver.resolve('app.acme.example')).toBeNull();
				}),
				{
					PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE: JSON.stringify({
						routes: [
							{
								public_host: 'app.acme.example',
								backend_url: 'http://orders.default.svc.cluster.local:8080'
							},
							{
								public_host: 'App.Acme.Example',
								backend_url: 'http://replacement.default.svc.cluster.local:8080'
							}
						]
					})
				}
			)
		);

		it.effect(
			'routes from its mounted table file, a missing file is unavailable, and a rewrite applies without a restart',
			() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const path = yield* Path.Path;
					const directory = yield* fs.makeTempDirectoryScoped({
						prefix: 'private-ingress-gateway-'
					});
					const routeTablePath = path.join(directory, 'routes.json');
					// As the kubelet updates a mounted ConfigMap: a new file swapped in, never an edit.
					const replace = (text: string) =>
						fs
							.writeFileString(`${routeTablePath}.next`, text)
							.pipe(Effect.andThen(fs.rename(`${routeTablePath}.next`, routeTablePath)));

					yield* withGatewayEnvironment(
						Effect.gen(function* () {
							const resolver = yield* PrivateIngressRouteResolver;
							// The ConfigMap is optional: until Akua writes it, nothing routes.
							expect((yield* resolver.resolve('app.acme.example').pipe(Effect.flip))._tag).toBe(
								'PrivateIngressRouteTableError'
							);
							yield* replace(JSON.stringify({ routes: [] }));
							expect(yield* resolver.resolve('app.acme.example')).toBeNull();
							yield* replace(routeTable());
							expect(yield* resolver.resolve('app.acme.example')).toEqual(backend);
							yield* replace(JSON.stringify({ routes: [] }));
							expect(yield* resolver.resolve('app.acme.example')).toBeNull();
						}),
						{ PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE_PATH: routeTablePath }
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
						expect(yield* resolver.resolve('app.acme.example')).not.toBeNull();
						expect(yield* resolver.resolve('app.acme.example')).not.toBeNull();
					}),
					{ PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE_PATH: routeTablePath }
				).pipe(Effect.provideService(FileSystem.FileSystem, countingFileSystem));

				expect(routeTableReads).toBe(1);
			})
		);
	}
);
