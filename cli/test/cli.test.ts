import { describe, expect, it, test } from '@effect/vitest';
import {
	chmodPath,
	joinPath,
	mkdirp,
	mkdtempPath,
	readFileString,
	removePath,
	statMode,
	writeFileString
} from './fs-test';
import { BunServices } from '@effect/platform-bun';
import { ConfigProvider, Effect, Layer } from 'effect';

import { main, VERSION } from '../src/bin/akua';
import { renderSuccess } from '../src/runtime/render';
import { CliLive } from '../src/runtime/services-live';
import { Console, PackageCli, PackageCliFailure } from '../src/runtime/services';
import { runAuthView } from './auth-test-layer';
import { runAkua } from './run-akua';

/** An empty environment, so the test runner's own variables do not pick the output mode. */
const noEnvironment = ConfigProvider.layer(ConfigProvider.fromEnvRecord({}));

describe('akua entrypoint', () => {
	it.effect('embeds package help under the akua pkg invocation', () =>
		Effect.gen(function* () {
			const calls: Array<readonly string[]> = [];
			const run = (argv: readonly string[]) =>
				main(argv).pipe(
					Effect.provide(noEnvironment),
					Effect.provideService(PackageCli, {
						execute: (args) =>
							Effect.sync(() => {
								calls.push(args);
								return 0;
							})
					}),
					Effect.provideService(Console, {
						stdoutIsTTY: true,
						stdinIsTTY: false,
						writeStderr: () => Effect.void,
						writeStdout: () => Effect.void
					}),
					Effect.provide(CliLive(VERSION).pipe(Layer.provide(BunServices.layer)))
				);

			expect(yield* run(['pkg'])).toBe(0);
			expect(yield* run(['pkg', 'render', '--help'])).toBe(0);
			expect(calls).toEqual([['--help'], ['render', '--help']]);
		})
	);

	it.effect('normalizes root output flags before dispatching package commands', () =>
		Effect.gen(function* () {
			const calls: Array<readonly string[]> = [];
			const run = (argv: readonly string[]) =>
				main(argv).pipe(
					Effect.provide(noEnvironment),
					Effect.provideService(PackageCli, {
						execute: (args) =>
							Effect.sync(() => {
								calls.push(args);
								return 0;
							})
					}),
					Effect.provide(CliLive(VERSION).pipe(Layer.provide(BunServices.layer)))
				);

			expect(yield* run(['--json', 'pkg', 'version'])).toBe(0);
			expect(yield* run(['pkg', 'version', '--output', 'json'])).toBe(0);
			expect(calls).toEqual([
				['version', '--json'],
				['version', '--json']
			]);
		})
	);

	it.effect('renders package loader failures through the Effect error boundary', () =>
		Effect.gen(function* () {
			const stdout: string[] = [];
			const exitCode = yield* main(['pkg', 'version']).pipe(
				Effect.provide(noEnvironment),
				Effect.provideService(PackageCli, {
					execute: () => Effect.fail(new PackageCliFailure({ cause: new Error('native detail') }))
				}),
				Effect.provideService(Console, {
					stdoutIsTTY: false,
					stdinIsTTY: false,
					writeStderr: () => Effect.void,
					writeStdout: (value) =>
						Effect.sync(() => {
							stdout.push(value);
						})
				}),
				Effect.provide(CliLive(VERSION).pipe(Layer.provide(BunServices.layer)))
			);

			expect(exitCode).toBe(1);
			expect(stdout.join('\n')).toContain('AKUA_PACKAGE_UNAVAILABLE');
			expect(stdout.join('\n')).not.toContain('native detail');
		})
	);

	test('uses Effect CLI to describe the interactive command tree', async () => {
		const root = await runAkua([]);
		const auth = await runAkua(['auth', '--help']);

		expect(root.exitCode).toBe(0);
		expect(root.stdout).toContain('SUBCOMMANDS');
		expect(root.stdout).toContain('auth');
		expect(root.stdout).toContain('commands');
		expect(root.stdout).toContain('pkg');
		expect(root.stdout).toContain('machines');
		expect(root.stdout).toContain('clusters');
		expect(root.stdout).toContain('Kubernetes clusters and cluster access operations.');

		expect(auth.exitCode).toBe(0);
		expect(auth.stdout).toContain('login');
		expect(auth.stdout).toContain('Sign in with your browser');
	});

	test('returns a usage exit code when Effect CLI rejects interactive input', async () => {
		const invalid = await runAkua(['commands', '--not-a-real-flag']);

		expect(invalid.exitCode).toBe(2);
		expect(invalid.stdout).toContain('type: usage_error');
		expect(invalid.stdout).toContain('code: AKUA_USAGE_ERROR');
		expect(invalid.stdout).toContain('--not-a-real-flag');
	});

	test('home and help lead with the human journey and keep machine output parseable', async () => {
		const home = await runAkua([]);
		const help = await runAkua(['--help']);
		const version = await runAkua(['--version', '--json']);

		expect(home.exitCode).toBe(0);
		expect(home.stdout).toBe(help.stdout);
		expect(help.stdout).toContain('akua auth login');
		expect(help.stdout).toContain('akua workspaces use my-team');
		expect(help.stdout).toContain('pkg');
		expect(help.stdout).toContain('--workspace, -w');
		expect(JSON.parse(version.stdout)).toEqual({
			status: 'ok',
			command: 'akua --version',
			data: { version: VERSION }
		});
	});

	test('shows command-specific help before parsing commands filters', async () => {
		const { stdout, exitCode } = await runAkua(['commands', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toContain('akua commands [flags]');
		expect(stdout).toContain('--operation-id string');
		expect(stdout).not.toContain('akua auth login');
	});

	test('discovers generated input requirements before executing an operation', async () => {
		const { stdout, exitCode } = await runAkua([
			'commands',
			'--operation-id',
			'offers.resolve',
			'--json'
		]);

		expect(exitCode).toBe(0);
		const payload = JSON.parse(stdout);
		expect(payload).toMatchObject({
			data: [
				{
					operation_id: 'offers.resolve',
					input: {
						parameters: [{ name: 'short_hash', in: 'query', required: true }],
						example: { query: { short_hash: '<short_hash>' } }
					}
				}
			]
		});
		expect(payload.data[0].usage).toBe('akua offers resolve --short-hash <short-hash>');
		expect(payload.next_steps[0]).toEqual({
			command: 'akua offers resolve --short-hash <short-hash>'
		});
	});

	test('shows browser/device login options in auth help', async () => {
		const { stdout, exitCode } = await runAkua(['auth', 'login', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toContain('akua auth login [flags]');
		expect(stdout).toContain('--no-browser');
		expect(stdout).toContain('Sign in with your browser');
	});

	test('fails loudly on unknown flags', async () => {
		const { stdout, exitCode } = await runAkua(['commands', '--bogus', '--output', 'json']);
		expect(exitCode).toBe(2);
		expect(JSON.parse(stdout)).toMatchObject({
			error: {
				type: 'usage_error',
				code: 'AKUA_USAGE_ERROR',
				message: 'Unrecognized flag: --bogus in command akua commands'
			}
		});
	});

	test('does not expose provider-specific commands in help or routing', async () => {
		const { stdout, exitCode } = await runAkua(['--help', '--json']);

		expect(exitCode).toBe(0);
		expect(stdout).not.toContain('agent-os');
		expect(stdout).not.toContain('hcloud');
		expect(stdout).not.toContain('token-file');

		const unknown = await runAkua(['agent-os', 'load-hcloud-provider', '--json']);
		expect(unknown.exitCode).toBe(2);
		expect(JSON.parse(unknown.stdout)).toMatchObject({
			error: {
				type: 'usage_error',
				code: 'AKUA_USAGE_ERROR',
				message: 'Unknown command for akua.'
			}
		});
	});

	test('fails invalid explicit output modes before routing', async () => {
		const { stdout, exitCode } = await runAkua(['--output', 'yaml', '--version']);
		expect(exitCode).toBe(2);
		expect(stdout).toContain('Invalid --output value: yaml');
	});

	test('rejects undocumented toon output mode', async () => {
		const flag = await runAkua(['--output', 'toon', '--version']);
		expect(flag.exitCode).toBe(2);
		expect(flag.stdout).toContain('Invalid --output value: toon');

		const env = await runAkua(['--version'], { AKUA_OUTPUT: 'toon' });
		expect(env.exitCode).toBe(2);
		expect(env.stdout).toContain('Invalid AKUA_OUTPUT value: toon');
	}, 15_000);

	test('fails missing explicit output mode values before routing', async () => {
		const { stdout, exitCode } = await runAkua(['--output', '--version']);
		expect(exitCode).toBe(2);
		expect(stdout).toContain('Missing value for --output');
	});

	test('fails invalid AKUA_OUTPUT values before routing', async () => {
		const { stdout, exitCode } = await runAkua(['--version'], {
			AKUA_OUTPUT: 'yaml'
		});
		expect(exitCode).toBe(2);
		expect(stdout).toContain('Invalid AKUA_OUTPUT value: yaml');
	});

	test('requires commands filter values', async () => {
		const { stdout, exitCode } = await runAkua(['commands', '--operation-id', '--json']);
		expect(exitCode).toBe(2);
		expect(JSON.parse(stdout)).toMatchObject({
			error: {
				type: 'usage_error',
				code: 'AKUA_USAGE_ERROR',
				message: 'Missing value for flag --operation-id. Expected: string'
			}
		});
	});

	test('requires resource filter values', async () => {
		const { stdout, exitCode } = await runAkua(['commands', '--resource=', '--json']);
		expect(exitCode).toBe(2);
		expect(JSON.parse(stdout)).toMatchObject({
			error: {
				message: 'Missing value for --resource.'
			}
		});
	});

	test('requires positive integer command limits', async () => {
		const invalid = await runAkua(['commands', '--limit', 'banana', '--json']);
		expect(invalid.exitCode).toBe(2);
		expect(JSON.parse(invalid.stdout)).toMatchObject({
			error: {
				message: 'Invalid value for flag --limit. Expected a string representing a finite number'
			}
		});

		const zero = await runAkua(['commands', '--limit=0', '--json']);
		expect(zero.exitCode).toBe(2);
		expect(JSON.parse(zero.stdout)).toMatchObject({
			error: {
				message: 'Invalid value for --limit: 0. Expected a positive integer.'
			}
		});
	});

	test('rejects unexpected commands positional arguments', async () => {
		const resource = await runAkua(['commands', 'workspaces', '--json']);
		expect(resource.exitCode).toBe(2);
		expect(JSON.parse(resource.stdout)).toMatchObject({
			error: {
				type: 'usage_error',
				code: 'AKUA_USAGE_ERROR',
				message: 'Unexpected argument for akua commands.'
			}
		});

		const extra = await runAkua(['commands', '--limit', '5', 'extra', '--json']);
		expect(extra.exitCode).toBe(2);
		expect(JSON.parse(extra.stdout)).toMatchObject({
			error: {
				message: 'Unexpected argument for akua commands.'
			}
		});
	});

	test('routes normal generated commands and redacts invalid request input', async () => {
		const home = await makeTempHome();
		const inputPath = joinPath(home, 'machine-input.json');
		const sentinel = 'request-value-must-not-be-rendered';
		try {
			await writeFileString(
				inputPath,
				JSON.stringify({
					body: {
						cluster_id: 'clu_123',
						instance_type: 'cx23',
						compute_config_id: 'ccfg_123',
						undeclared: sentinel
					}
				})
			);

			const result = await runAkua(['machines', 'create', '--input', inputPath, '--json'], {
				HOME: home,
				AKUA_API_TOKEN: 'test-token'
			});

			expect(result.exitCode).toBe(2);
			expect(JSON.parse(result.stdout)).toMatchObject({
				error: {
					code: 'AKUA_INPUT_INVALID',
					message:
						'Invalid input for akua machines create: body.undeclared: Expected no excess property.'
				}
			});
			expect(result.stdout).not.toContain(sentinel);
			expect(result.stderr).not.toContain(sentinel);
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth login stores a token with user-only permissions', async () => {
		const home = await makeTempHome();
		try {
			const token = 'sk_akua_test_login';
			const { stdout, exitCode } = await runAkua(['auth', 'login', '--token', token, '--json'], {
				HOME: home
			});
			const payload = JSON.parse(stdout);
			const configPath = joinPath(home, '.config', 'akua', 'config.json');

			expect(exitCode).toBe(0);
			expect(stdout).not.toContain(token);
			expect(payload).toMatchObject({
				status: 'ok',
				command: 'akua auth login',
				data: {
					authenticated: true,
					source: 'config',
					config_path: configPath
				}
			});
			expect(JSON.parse(await readFileString(configPath))).toEqual({ token });
			expect((await statMode(joinPath(home, '.config', 'akua'))) & 0o777).toBe(0o700);
			expect((await statMode(configPath)) & 0o777).toBe(0o600);
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth login replaces an existing protected config file', async () => {
		const home = await makeTempHome();
		try {
			const configPath = joinPath(home, '.config', 'akua', 'config.json');
			await runAkua(['auth', 'login', '--token', 'sk_akua_old', '--quiet'], {
				HOME: home
			});
			await chmodPath(configPath, 0o444);

			const { stdout, exitCode } = await runAkua(
				['auth', 'login', '--token', 'sk_akua_new', '--json'],
				{ HOME: home }
			);

			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout)).toMatchObject({
				status: 'ok',
				command: 'akua auth login'
			});
			expect(JSON.parse(await readFileString(configPath))).toEqual({
				token: 'sk_akua_new'
			});
			expect((await statMode(configPath)) & 0o777).toBe(0o600);
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth login preserves unrelated config keys', async () => {
		const home = await makeTempHome();
		try {
			const configDir = joinPath(home, '.config', 'akua');
			const configPath = joinPath(configDir, 'config.json');
			await mkdirp(configDir);
			await writeFileString(
				configPath,
				`${JSON.stringify({ profile: 'dev', endpoint: 'https://api.example.test', token: 'sk_akua_old' }, null, 2)}\n`
			);

			const { exitCode } = await runAkua(['auth', 'login', '--token', 'sk_akua_new', '--json'], {
				HOME: home
			});

			expect(exitCode).toBe(0);
			expect(JSON.parse(await readFileString(configPath))).toEqual({
				profile: 'dev',
				endpoint: 'https://api.example.test',
				token: 'sk_akua_new'
			});
			expect((await statMode(configPath)) & 0o777).toBe(0o600);
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth login completes device authorization, launches the browser, and saves only the access token', async () => {
		const home = await makeTempHome();
		try {
			const requests: Array<{ url: string; body: unknown }> = [];
			const sleeps: number[] = [];
			const launched: string[] = [];
			const displayed: Array<{
				verification_uri_complete: string;
				user_code: string;
			}> = [];
			let tokenRequests = 0;
			const deviceCode = 'device-code-must-not-be-rendered';
			const accessToken = 'access-token-must-not-be-rendered';

			const envelope = await runAuthView(
				['login'],
				{ HOME: home },
				{
					request: async ({ url, body }: { url: string; body: unknown }) => {
						requests.push({ url, body });
						if (url.endsWith('/device/code')) {
							return {
								status: 200,
								body: {
									device_code: deviceCode,
									user_code: 'ABCD-EFGH',
									verification_uri: 'https://akua.dev/device',
									verification_uri_complete: 'https://akua.dev/device?user_code=ABCD-EFGH',
									expires_in: 60,
									interval: 2
								}
							};
						}

						tokenRequests += 1;
						return tokenRequests === 1
							? { status: 400, body: { error: 'authorization_pending' } }
							: { status: 200, body: { access_token: accessToken } };
					},
					sleep: async (milliseconds: number) => {
						sleeps.push(milliseconds);
					},
					launchBrowser: async (url: string) => {
						launched.push(url);
					},
					displayDeviceAuthorization: (details) => {
						displayed.push(details);
					}
				}
			);

			expect(requests).toEqual([
				{
					url: 'https://akua.dev/api/auth/device/code',
					body: { client_id: 'akua-cli', scope: 'platform' }
				},
				{
					url: 'https://akua.dev/api/auth/device/token',
					body: {
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
						device_code: deviceCode,
						client_id: 'akua-cli'
					}
				},
				{
					url: 'https://akua.dev/api/auth/device/token',
					body: {
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
						device_code: deviceCode,
						client_id: 'akua-cli'
					}
				}
			]);
			expect(sleeps).toEqual([2_000]);
			expect(launched).toEqual(['https://akua.dev/device?user_code=ABCD-EFGH']);
			expect(displayed).toEqual([
				{
					verification_uri_complete: 'https://akua.dev/device?user_code=ABCD-EFGH',
					user_code: 'ABCD-EFGH'
				}
			]);
			expect(envelope).toMatchObject({
				command: 'akua auth login',
				data: {
					authenticated: true,
					source: 'config',
					verification_uri_complete: 'https://akua.dev/device?user_code=ABCD-EFGH',
					user_code: 'ABCD-EFGH'
				}
			});
			const rendered = renderSuccess(envelope, 'json');
			expect(rendered).not.toContain(deviceCode);
			expect(rendered).not.toContain(accessToken);
			expect(
				JSON.parse(await readFileString(joinPath(home, '.config', 'akua', 'config.json')))
			).toEqual({ token: accessToken });
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth login honors slow_down and continues when the browser cannot be opened', async () => {
		const home = await makeTempHome();
		try {
			const sleeps: number[] = [];
			let tokenRequests = 0;

			const envelope = await runAuthView(
				['login'],
				{ HOME: home },
				{
					request: async ({ url }: { url: string }) => {
						if (url.endsWith('/device/code')) {
							return {
								status: 200,
								body: {
									device_code: 'device-code-must-not-be-rendered',
									user_code: 'ABCD-EFGH',
									verification_uri: 'https://akua.dev/device',
									verification_uri_complete: 'https://akua.dev/device?user_code=ABCD-EFGH',
									expires_in: 60,
									interval: 2
								}
							};
						}

						tokenRequests += 1;
						return tokenRequests === 1
							? { status: 400, body: { error: 'authorization_pending' } }
							: tokenRequests === 2
								? { status: 400, body: { error: 'slow_down' } }
								: {
										status: 200,
										body: { access_token: 'access-token-must-not-be-rendered' }
									};
					},
					sleep: async (milliseconds: number) => {
						sleeps.push(milliseconds);
					},
					launchBrowser: async () => {
						throw new Error('browser unavailable');
					}
				}
			);

			expect(sleeps).toEqual([2_000, 7_000]);
			expect(envelope.observations).toContain(
				'Could not open a browser. Open the verification URL manually.'
			);
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth device login accepts RFC-compliant fallback responses', async () => {
		const home = await makeTempHome();
		try {
			const requests: Array<{ url: string; body: unknown }> = [];
			const envelope = await runAuthView(
				['login', '--no-browser'],
				{ HOME: home },
				{
					request: async ({ url, body }) => {
						requests.push({ url, body });
						return url.endsWith('/device/code')
							? {
									status: 200,
									body: {
										device_code: 'device-code-must-not-be-rendered',
										user_code: 'ABCD-EFGH',
										verification_uri: 'https://akua.dev/device',
										expires_in: 60
									}
								}
							: {
									status: 200,
									body: { access_token: 'access-token-must-not-be-rendered' }
								};
					},
					sleep: async () => undefined,
					launchBrowser: async () => undefined
				}
			);

			expect(requests[0]?.body).toEqual({
				client_id: 'akua-cli',
				scope: 'platform'
			});
			expect(envelope.data).toMatchObject({
				verification_uri_complete: 'https://akua.dev/device'
			});
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth login reports terminal device-flow outcomes without disclosing the device code', async () => {
		for (const error of ['access_denied', 'expired_token'] as const) {
			const home = await makeTempHome();
			try {
				const deviceCode = 'device-code-must-not-be-rendered';
				await expect(
					runAuthView(
						['login', '--no-browser'],
						{ HOME: home },
						{
							request: async ({ url }: { url: string }) =>
								url.endsWith('/device/code')
									? {
											status: 200,
											body: {
												device_code: deviceCode,
												user_code: 'ABCD-EFGH',
												verification_uri: 'https://akua.dev/device',
												verification_uri_complete: 'https://akua.dev/device?user_code=ABCD-EFGH',
												expires_in: 60,
												interval: 1
											}
										}
									: { status: 400, body: { error } },
							sleep: async () => undefined,
							launchBrowser: async () => undefined
						}
					)
				).rejects.toMatchObject({ code: `AKUA_DEVICE_${error.toUpperCase()}` });
			} finally {
				await removePath(home, { recursive: true, force: true });
			}
		}
	});

	test('auth login stops on cancellation or device-code expiry without saving a token', async () => {
		const cancelledHome = await makeTempHome();
		const controller = new AbortController();
		controller.abort();
		let cancelledRequested = false;
		try {
			await expect(
				runAuthView(
					['login', '--no-browser'],
					{ HOME: cancelledHome },
					{
						request: async () => {
							cancelledRequested = true;
							return { status: 500, body: {} };
						},
						sleep: async () => undefined,
						launchBrowser: async () => undefined,
						signal: controller.signal
					}
				)
			).rejects.toMatchObject({ code: 'AKUA_DEVICE_CANCELLED' });
			expect(cancelledRequested).toBe(false);
		} finally {
			await removePath(cancelledHome, { recursive: true, force: true });
		}

		const expiredHome = await makeTempHome();
		let requests = 0;
		let calls = 0;
		try {
			await expect(
				runAuthView(
					['login', '--no-browser'],
					{ HOME: expiredHome },
					{
						request: async () => {
							requests += 1;
							return {
								status: 200,
								body: {
									device_code: 'device-code-must-not-be-rendered',
									user_code: 'ABCD-EFGH',
									verification_uri: 'https://akua.dev/device',
									verification_uri_complete: 'https://akua.dev/device?user_code=ABCD-EFGH',
									expires_in: 1,
									interval: 1
								}
							};
						},
						sleep: async () => undefined,
						launchBrowser: async () => undefined,
						now: () => (calls++ === 0 ? 0 : 1_000)
					}
				)
			).rejects.toMatchObject({ code: 'AKUA_DEVICE_EXPIRED_TOKEN' });
			expect(requests).toBe(1);
		} finally {
			await removePath(expiredHome, { recursive: true, force: true });
		}
	});

	test('auth device login aborts an in-flight token request', async () => {
		const home = await makeTempHome();
		const controller = new AbortController();
		let tokenSignal: AbortSignal | undefined;
		let tokenRequestStarted: (() => void) | undefined;
		const tokenRequest = new Promise<void>((resolve) => {
			tokenRequestStarted = resolve;
		});
		try {
			const login = runAuthView(
				['login', '--no-browser'],
				{ HOME: home },
				{
					request: ({ url, signal }) => {
						if (url.endsWith('/device/code')) {
							return Promise.resolve({
								status: 200,
								body: {
									device_code: 'device-code-must-not-be-rendered',
									user_code: 'ABCD-EFGH',
									verification_uri: 'https://akua.dev/device',
									expires_in: 60,
									interval: 1
								}
							});
						}
						tokenSignal = signal;
						tokenRequestStarted?.();
						return new Promise((_, reject) =>
							signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
						);
					},
					sleep: async () => undefined,
					launchBrowser: async () => undefined,
					signal: controller.signal
				}
			);
			await tokenRequest;
			controller.abort();

			await expect(login).rejects.toMatchObject({
				code: 'AKUA_DEVICE_CANCELLED'
			});
			expect(tokenSignal?.aborted).toBe(true);
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth status gives AKUA_API_TOKEN precedence over stored tokens', async () => {
		const home = await makeTempHome();
		try {
			await runAkua(['auth', 'login', '--token', 'sk_akua_stored', '--quiet'], {
				HOME: home
			});
			const { stdout, exitCode } = await runAkua(['auth', 'status', '--json'], {
				HOME: home,
				AKUA_API_TOKEN: 'sk_akua_env'
			});

			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout)).toMatchObject({
				status: 'ok',
				command: 'akua auth status',
				observations: ['Authenticated with AKUA_API_TOKEN.'],
				data: {
					authenticated: true,
					source: 'env'
				}
			});
			expect(stdout).not.toContain('sk_akua_env');
			expect(stdout).not.toContain('sk_akua_stored');
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	it.effect('auth status honors AKUA_API_TOKEN without HOME', () =>
		Effect.gen(function* () {
			for (const home of [undefined, '']) {
				const envelope = yield* Effect.promise(() =>
					runAuthView(
						['status'],
						{ HOME: home, AKUA_API_TOKEN: 'sk_akua_env' },
						{
							request: () => Promise.reject(new Error('no device flow')),
							sleep: () => Promise.resolve(),
							launchBrowser: () => Promise.resolve()
						}
					)
				);
				const stdout = renderSuccess(envelope, 'json');
				const payload = JSON.parse(stdout);

				expect(payload).toMatchObject({
					status: 'ok',
					command: 'akua auth status',
					observations: ['Authenticated with AKUA_API_TOKEN.'],
					data: {
						authenticated: true,
						source: 'env'
					}
				});
				expect(payload.data).not.toHaveProperty('config_path');
				expect(stdout).not.toContain('sk_akua_env');
			}
		})
	);

	test('auth logout removes stored token without clearing AKUA_API_TOKEN', async () => {
		const home = await makeTempHome();
		try {
			await runAkua(['auth', 'login', '--token', 'sk_akua_stored', '--quiet'], {
				HOME: home
			});
			const { stdout, exitCode } = await runAkua(['auth', 'logout', '--json'], {
				HOME: home,
				AKUA_API_TOKEN: 'sk_akua_env'
			});
			const status = await runAkua(['auth', 'status', '--json'], {
				HOME: home
			});

			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout)).toMatchObject({
				observations: ['Stored authentication token removed. AKUA_API_TOKEN is still active.'],
				data: {
					authenticated: true,
					source: 'env'
				}
			});
			expect(JSON.parse(status.stdout)).toMatchObject({
				data: {
					authenticated: false,
					source: 'none'
				}
			});
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth logout removes only the stored token', async () => {
		const home = await makeTempHome();
		try {
			const configDir = joinPath(home, '.config', 'akua');
			const configPath = joinPath(configDir, 'config.json');
			await mkdirp(configDir);
			await writeFileString(
				configPath,
				`${JSON.stringify({ profile: 'dev', endpoint: 'https://api.example.test', token: 'sk_akua_stored' }, null, 2)}\n`
			);

			const { stdout, exitCode } = await runAkua(['auth', 'logout', '--json'], {
				HOME: home
			});
			const status = await runAkua(['auth', 'status', '--json'], {
				HOME: home
			});

			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout)).toMatchObject({
				observations: ['Stored authentication token removed.'],
				data: {
					authenticated: false,
					source: 'none'
				}
			});
			expect(JSON.parse(await readFileString(configPath))).toEqual({
				profile: 'dev',
				endpoint: 'https://api.example.test'
			});
			expect(JSON.parse(status.stdout)).toMatchObject({
				data: {
					authenticated: false,
					source: 'none'
				}
			});
			expect((await statMode(configPath)) & 0o777).toBe(0o600);
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth status reports malformed config as a runtime error', async () => {
		const home = await makeTempHome();
		try {
			const configPath = joinPath(home, '.config', 'akua', 'config.json');
			await runAkua(['auth', 'login', '--token', 'sk_akua_stored', '--quiet'], {
				HOME: home
			});
			await writeFileString(configPath, '{not json\n');

			const { stdout, exitCode } = await runAkua(['auth', 'status', '--json'], {
				HOME: home
			});

			expect(exitCode).toBe(1);
			expect(JSON.parse(stdout)).toMatchObject({
				error: {
					type: 'runtime_error',
					code: 'AKUA_CONFIG_ERROR'
				}
			});
			expect(stdout).toContain('Failed to read Akua config');
			expect(stdout).not.toContain('akua --help');
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth logout removes malformed stored config', async () => {
		const home = await makeTempHome();
		try {
			const configPath = joinPath(home, '.config', 'akua', 'config.json');
			await runAkua(['auth', 'login', '--token', 'sk_akua_stored', '--quiet'], {
				HOME: home
			});
			await writeFileString(configPath, '{not json\n');

			const { stdout, exitCode } = await runAkua(['auth', 'logout', '--json'], {
				HOME: home
			});
			const status = await runAkua(['auth', 'status', '--json'], {
				HOME: home
			});

			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout)).toMatchObject({
				observations: ['Stored authentication token removed.'],
				data: {
					authenticated: false,
					source: 'none'
				}
			});
			expect(JSON.parse(status.stdout)).toMatchObject({
				data: {
					authenticated: false,
					source: 'none'
				}
			});
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth login validates explicit token flag values', async () => {
		const home = await makeTempHome();
		try {
			const missingValue = await runAkua(['auth', 'login', '--token', '--json'], { HOME: home });
			expect(missingValue.exitCode).toBe(2);
			expect(JSON.parse(missingValue.stdout)).toMatchObject({
				error: {
					message: 'Missing value for flag --token. Expected: string'
				}
			});

			const tokenLikePositional = 'sk_akua_secret_positional';
			const positional = await runAkua(['auth', 'login', tokenLikePositional, '--json'], {
				HOME: home
			});
			expect(positional.exitCode).toBe(2);
			expect(JSON.parse(positional.stdout)).toMatchObject({
				error: {
					message: 'Unexpected argument for akua auth login.'
				}
			});
			expect(positional.stdout).not.toContain(tokenLikePositional);
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});

	test('auth positional usage errors do not echo token-like values', async () => {
		const home = await makeTempHome();
		try {
			const tokenLikeValue = 'sk_akua_secret_positional';
			const unknownSubcommand = await runAkua(['auth', tokenLikeValue, '--json'], { HOME: home });
			expect(unknownSubcommand.exitCode).toBe(2);
			expect(JSON.parse(unknownSubcommand.stdout)).toMatchObject({
				error: {
					message: 'Unknown command for akua auth.'
				}
			});
			expect(unknownSubcommand.stdout).not.toContain(tokenLikeValue);

			const statusExtra = await runAkua(['auth', 'status', tokenLikeValue, '--json'], {
				HOME: home
			});
			expect(statusExtra.exitCode).toBe(2);
			expect(JSON.parse(statusExtra.stdout)).toMatchObject({
				error: {
					message: 'Unexpected argument for akua auth status.'
				}
			});
			expect(statusExtra.stdout).not.toContain(tokenLikeValue);

			const logoutExtra = await runAkua(['auth', 'logout', tokenLikeValue, '--json'], {
				HOME: home
			});
			expect(logoutExtra.exitCode).toBe(2);
			expect(JSON.parse(logoutExtra.stdout)).toMatchObject({
				error: {
					message: 'Unexpected argument for akua auth logout.'
				}
			});
			expect(logoutExtra.stdout).not.toContain(tokenLikeValue);
		} finally {
			await removePath(home, { recursive: true, force: true });
		}
	});
});

async function makeTempHome(): Promise<string> {
	return mkdtempPath('.tmp-akua-home-');
}
