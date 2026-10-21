import { BunServices } from '@effect/platform-bun';
import { Clock, ConfigProvider, Duration, Effect, Layer, Option } from 'effect';

import { login, logout, status } from '../src/cli/auth';
import {
	DeviceCancelledFailure,
	DeviceRequestFailure,
	toCliError
} from '../src/runtime/effect-runtime';
import type { RenderEnvelope } from '../src/runtime/render';
import {
	Browser,
	BrowserFailure,
	Console,
	Http,
	HttpFailure,
	Process
} from '../src/runtime/services';
import { SecureConfigLive } from '../src/runtime/services-live';

export interface AuthTestDependencies {
	request(request: {
		url: string;
		body: unknown;
		signal?: AbortSignal;
	}): Promise<{ status: number; body: unknown }>;
	sleep(milliseconds: number): Promise<void>;
	launchBrowser(url: string): Promise<void>;
	displayDeviceAuthorization?(details: {
		verification_uri_complete: string;
		user_code: string;
	}): void;
	now?(): number;
	signal?: AbortSignal;
}

export function runAuthView(
	argv: readonly string[],
	env: Record<string, string | undefined>,
	dependencies: AuthTestDependencies
): Promise<RenderEnvelope> {
	if (dependencies.signal?.aborted)
		return Promise.reject(toCliError(new DeviceCancelledFailure({})));
	return Effect.runPromise(
		authProgram(argv).pipe(
			Effect.catchIf(
				(failure): failure is DeviceRequestFailure =>
					dependencies.signal?.aborted === true && failure._tag === 'DeviceRequestFailure',
				() => Effect.fail(new DeviceCancelledFailure({}))
			),
			Effect.mapError(toCliError),
			Effect.provide(testServices(dependencies)),
			Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))
		) as Effect.Effect<RenderEnvelope, never>
	);
}

/** The `akua auth` subcommand an argv selects, run without the argument parser. */
function authProgram(argv: readonly string[]) {
	const [subcommand, ...flags] = argv;
	if (subcommand === 'status') return status;
	if (subcommand === 'logout') return logout;
	return login({ token: Option.none(), noBrowser: flags.includes('--no-browser') });
}

function testServices(dependencies: AuthTestDependencies) {
	const now = dependencies.now ?? Date.now;
	return Layer.mergeAll(
		Layer.succeed(Http, {
			postJson: ({ url, body }) =>
				Effect.tryPromise({
					try: () =>
						dependencies.request({
							url,
							body,
							signal: dependencies.signal
						}),
					catch: (cause) => new HttpFailure({ cause })
				})
		}),
		Layer.succeed(Browser, {
			launch: (url) =>
				Effect.tryPromise({
					try: () => dependencies.launchBrowser(url),
					catch: (cause) => new BrowserFailure({ cause })
				})
		}),
		Layer.succeed(Process, {
			awaitSignal: dependencies.signal?.aborted ? Effect.void : Effect.never
		}),
		Layer.succeed(Console, {
			stdoutIsTTY: false,
			stdinIsTTY: false,
			writeStderr: (value) =>
				Effect.sync(() => {
					const [open, code] = value.trimEnd().split('\n');
					dependencies.displayDeviceAuthorization?.({
						verification_uri_complete: open.slice('Open '.length),
						user_code: code.slice('Enter code: '.length)
					});
				}),
			writeStdoutBytes: () => Effect.void,
			writeStdout: () => Effect.void
		}),
		Layer.succeed(Clock.Clock, {
			currentTimeMillisUnsafe: now,
			currentTimeMillis: Effect.sync(now),
			currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
			currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
			monotonicTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
			monotonicTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
			sleep: (duration) =>
				Effect.tryPromise({
					try: () => dependencies.sleep(Duration.toMillis(duration)),
					catch: () => new DeviceRequestFailure({})
				}).pipe(Effect.orDie)
		}),
		SecureConfigLive.pipe(Layer.provide(BunServices.layer))
	);
}
