import { describe, expect, it } from '@effect/vitest';
import { ConfigProvider, Effect, Fiber, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';

import { login } from '../src/cli/auth';
import {
	DeviceAuthorizationFailure,
	DeviceCancelledFailure,
	DeviceRequestFailure,
	runCli,
	UsageFailure
} from '../src/runtime/effect-runtime';
import {
	Browser,
	Console,
	Http,
	Process,
	SecureConfig,
	SecureConfigFailure
} from '../src/runtime/services';
import type { RenderEnvelope } from '../src/runtime/render';

const loginWithBrowser = (noBrowser: boolean) =>
	login({ token: Option.none(), noBrowser }).pipe(
		Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: '/test-home' })))
	);

const memoryConfig = (saved: Array<{ path: string; token: string }> = []) =>
	Layer.succeed(SecureConfig, {
		readToken: () => Effect.succeed(undefined),
		saveToken: (path, token) => Effect.sync(() => saved.push({ path, token })),
		removeToken: () => Effect.succeed(false),
		readWorkspace: () => Effect.succeed(undefined),
		saveWorkspace: () => Effect.void,
		removeWorkspace: () => Effect.succeed(false)
	});

describe('Effect auth command', () => {
	it.effect('runs the device flow through injected services and TestClock', () =>
		Effect.gen(function* () {
			const requests: Array<{ url: string; body: Readonly<Record<string, string>> }> = [];
			const launched: string[] = [];
			const stderr: string[] = [];
			const saved: Array<{ path: string; token: string }> = [];
			let tokenRequests = 0;
			const services = Layer.mergeAll(
				Layer.succeed(Http, {
					postJson: ({ url, body }) =>
						Effect.sync(() => {
							requests.push({ url, body });
							if (url.endsWith('/device/code')) {
								return {
									status: 200,
									body: {
										device_code: 'device-code',
										user_code: 'ABCD-EFGH',
										verification_uri: 'https://example.test/device',
										expires_in: 60,
										interval: 2
									}
								};
							}
							tokenRequests += 1;
							return tokenRequests === 1
								? { status: 400, body: { error: 'authorization_pending' } }
								: { status: 200, body: { access_token: 'access-token' } };
						})
				}),
				Layer.succeed(Browser, {
					launch: (url) => Effect.sync(() => launched.push(url))
				}),
				Layer.succeed(Process, { awaitSignal: Effect.never }),
				Layer.succeed(Console, {
					stdoutIsTTY: false,
					stdinIsTTY: false,
					writeStderr: (value) => Effect.sync(() => stderr.push(value)),
					writeStdout: () => Effect.void
				}),
				memoryConfig(saved),
				TestClock.layer()
			);
			const program = Effect.gen(function* () {
				const fiber = yield* loginWithBrowser(false).pipe(Effect.forkChild);
				yield* TestClock.adjust('2 seconds');
				return yield* Fiber.join(fiber);
			});

			const envelope = yield* Effect.provide(program, services) as Effect.Effect<RenderEnvelope>;

			expect(requests).toEqual([
				{
					url: 'https://akua.dev/api/auth/device/code',
					body: { client_id: 'akua-cli', scope: 'platform' }
				},
				{
					url: 'https://akua.dev/api/auth/device/token',
					body: {
						client_id: 'akua-cli',
						device_code: 'device-code',
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
					}
				},
				{
					url: 'https://akua.dev/api/auth/device/token',
					body: {
						client_id: 'akua-cli',
						device_code: 'device-code',
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
					}
				}
			]);
			expect(launched).toEqual(['https://example.test/device']);
			expect(stderr).toEqual(['Open https://example.test/device\nEnter code: ABCD-EFGH\n']);
			expect(saved).toEqual([
				{ path: '/test-home/.config/akua/config.json', token: 'access-token' }
			]);
			expect(envelope.data).toMatchObject({
				authenticated: true,
				source: 'config'
			});
		})
	);

	it.effect('renders terminal device authorization failures through runCli', () =>
		Effect.gen(function* () {
			const render = (reason: 'access_denied' | 'expired_token') =>
				Effect.gen(function* () {
					const stdout: string[] = [];
					const responses = [
						{
							status: 200,
							body: {
								device_code: 'device-code',
								user_code: 'ABCD-EFGH',
								verification_uri: 'https://example.test/device',
								expires_in: 60
							}
						},
						{ status: 400, body: { error: reason } }
					];
					const services = Layer.mergeAll(
						Layer.succeed(Http, {
							postJson: () => Effect.fromNullishOr(responses.shift()).pipe(Effect.orDie)
						}),
						Layer.succeed(Browser, { launch: () => Effect.void }),
						Layer.succeed(Process, { awaitSignal: Effect.never }),
						Layer.succeed(Console, {
							stdoutIsTTY: false,
							stdinIsTTY: false,
							writeStderr: () => Effect.void,
							writeStdout: (value) => Effect.sync(() => stdout.push(value))
						}),
						memoryConfig(),
						TestClock.layer()
					);

					const exitCode = yield* Effect.provide(
						runCli(loginWithBrowser(true), { mode: 'json' }),
						services
					);
					return { exitCode, payload: JSON.parse(stdout.join('')) };
				});

			expect(yield* render('access_denied')).toMatchObject({
				exitCode: 3,
				payload: { error: { code: 'AKUA_DEVICE_ACCESS_DENIED' } }
			});
			expect(yield* render('expired_token')).toMatchObject({
				exitCode: 3,
				payload: { error: { code: 'AKUA_DEVICE_EXPIRED_TOKEN' } }
			});
		})
	);

	it.effect('maps tagged failures to distinct rendered error envelopes', () =>
		Effect.gen(function* () {
			const render = (
				failure:
					| UsageFailure
					| SecureConfigFailure
					| DeviceRequestFailure
					| DeviceCancelledFailure
					| DeviceAuthorizationFailure
			) =>
				Effect.gen(function* () {
					const stdout: string[] = [];
					const exitCode = yield* Effect.provide(
						runCli(Effect.fail(failure), { mode: 'json' }),
						Layer.succeed(Console, {
							stdoutIsTTY: false,
							stdinIsTTY: false,
							writeStderr: () => Effect.void,
							writeStdout: (value) => Effect.sync(() => stdout.push(value))
						})
					);
					return { exitCode, payload: JSON.parse(stdout.join('')) };
				});

			expect(yield* render(new UsageFailure({ message: 'Bad command.' }))).toMatchObject({
				exitCode: 2,
				payload: { error: { type: 'usage_error', code: 'AKUA_USAGE_ERROR' } }
			});
			expect(
				yield* render(
					new SecureConfigFailure({
						operation: 'read',
						path: '/config',
						cause: new Error('denied')
					})
				)
			).toMatchObject({
				exitCode: 1,
				payload: { error: { type: 'runtime_error', code: 'AKUA_CONFIG_ERROR' } }
			});
			expect(yield* render(new DeviceRequestFailure({}))).toMatchObject({
				exitCode: 3,
				payload: {
					error: {
						type: 'authentication_error',
						code: 'AKUA_DEVICE_REQUEST_FAILED'
					}
				}
			});
			expect(yield* render(new DeviceCancelledFailure({}))).toMatchObject({
				exitCode: 1,
				payload: {
					error: { type: 'runtime_error', code: 'AKUA_DEVICE_CANCELLED' }
				}
			});
			expect(
				yield* render(new DeviceAuthorizationFailure({ reason: 'access_denied' }))
			).toMatchObject({
				exitCode: 3,
				payload: {
					error: {
						type: 'authentication_error',
						code: 'AKUA_DEVICE_ACCESS_DENIED'
					}
				}
			});
			expect(
				yield* render(new DeviceAuthorizationFailure({ reason: 'expired_token' }))
			).toMatchObject({
				exitCode: 3,
				payload: {
					error: {
						type: 'authentication_error',
						code: 'AKUA_DEVICE_EXPIRED_TOKEN'
					}
				}
			});
		})
	);
});
