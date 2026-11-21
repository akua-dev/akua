import { BunCrypto, BunServices } from '@effect/platform-bun';
import { Clock, ConfigProvider, Duration, Effect, Layer, Option } from 'effect';

import { login } from '../src/cli/auth';
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
		login({ token: Option.none(), noBrowser: argv.includes('--no-browser') }).pipe(
			Effect.catchIf(
				(failure): failure is DeviceRequestFailure =>
					dependencies.signal?.aborted === true && failure._tag === 'DeviceRequestFailure',
				(cause) => Effect.fail(new DeviceCancelledFailure({ cause }))
			),
			Effect.mapError(toCliError),
			Effect.provide(testServices(dependencies)),
			Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))
		)
	);
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
					catch: (cause) => new DeviceRequestFailure({ cause })
				}).pipe(Effect.orDie)
		}),
		SecureConfigLive.pipe(Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer)))
	);
}
