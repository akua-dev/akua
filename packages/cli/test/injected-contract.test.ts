import { BunCrypto, BunServices } from '@effect/platform-bun';
import { expect, it } from '@effect/vitest';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { buildContract, OpenApiDocument } from '../scripts/generate-contract';
import { runAkua } from '../src/cli/main';
import { Console } from '../src/runtime/services';
import { CliLive } from '../src/runtime/services-live';
import { authenticationBaseUrl } from '../src/runtime/credentials';

it.effect('keeps device login on an explicitly selected authentication server', () =>
	Effect.gen(function* () {
		expect(
			yield* authenticationBaseUrl.pipe(
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromEnvRecord({ AKUA_AUTH_URL: 'http://127.0.0.1:3211/api/auth/' })
					)
				)
			)
		).toBe('http://127.0.0.1:3211/api/auth');
	})
);

it.effect('runs an explicitly supplied admin contract without changing the public CLI', () =>
	Effect.gen(function* () {
		const document = yield* Schema.decodeEffect(OpenApiDocument)({
			paths: {
				'/user/admin_status': {
					get: {
						operationId: 'auth.getAdminStatus',
						'x-platform-visibility': 'ADMIN',
						responses: {
							'200': { content: { 'application/json': { schema: { type: 'object' } } } }
						}
					}
				},
				'/admin/access_overrides': {
					get: {
						operationId: 'adminAccess.listOverrides',
						'x-platform-visibility': 'ADMIN',
						responses: {
							'200': { content: { 'application/json': { schema: { type: 'object' } } } }
						}
					}
				}
			},
			components: { schemas: {} }
		});
		expect((yield* buildContract(document)).operations).toEqual([]);
		const api = yield* buildContract(document, ['ADMIN']);
		const output: string[] = [];
		const code = yield* runAkua(['admin-access', '--help'], 'test', api).pipe(
			Effect.provideService(Console, {
				stdoutIsTTY: true,
				stdinIsTTY: false,
				writeStdout: (value) =>
					Effect.sync(() => {
						output.push(value);
					}),
				writeStdoutBytes: () => Effect.void,
				writeStderr: () => Effect.void
			}),
			Effect.provide(
				Layer.mergeAll(
					CliLive('test').pipe(Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer))),
					ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))
				)
			)
		);
		expect(code).toBe(0);
		expect(output.join('')).toContain('list-overrides');
	})
);
