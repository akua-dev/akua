import { Effect, Schema, Stream } from 'effect';

import { AkuaCliError, usageError } from './errors';
import type { OutputMode } from './mode';
import { renderError, renderStreamSuccess, renderSuccess, type RenderEnvelope } from './render';
import { Console, type SecureConfigFailure } from './services';

export class UsageFailure extends Schema.TaggedError<UsageFailure>()('UsageFailure', {
	message: Schema.String,
	/** Help command to suggest, for example `akua clusters create --help`. */
	help: Schema.optionalKey(Schema.String)
}) {}

export class DeviceRequestFailure extends Schema.TaggedError<DeviceRequestFailure>()(
	'DeviceRequestFailure',
	{}
) {}

export class DeviceCancelledFailure extends Schema.TaggedError<DeviceCancelledFailure>()(
	'DeviceCancelledFailure',
	{}
) {}

export class DeviceAuthorizationFailure extends Schema.TaggedError<DeviceAuthorizationFailure>()(
	'DeviceAuthorizationFailure',
	{ reason: Schema.Literals(['access_denied', 'expired_token']) }
) {}

export type CliFailure =
	| UsageFailure
	| SecureConfigFailure
	| DeviceRequestFailure
	| DeviceCancelledFailure
	| DeviceAuthorizationFailure
	| AkuaCliError;

export interface CliRenderer {
	readonly mode: OutputMode;
}

/** Runs a command, writes its result or failure for the output mode, and returns the exit code. */
export const runCli = Effect.fnUntraced(function* <R>(
	command: Effect.Effect<RenderEnvelope<CliFailure>, CliFailure, R>,
	renderer: CliRenderer
): Effect.fn.Return<number, never, R | Console> {
	const console = yield* Console;
	return yield* Effect.matchEffect(command, {
		onSuccess: (envelope) =>
			envelope.bytes !== undefined
				? Stream.runForEach(envelope.bytes, console.writeStdoutBytes).pipe(
						Effect.matchEffect({
							onFailure: (failure) => writeCliFailure(console, failure, renderer.mode),
							onSuccess: () => Effect.succeed(0)
						})
					)
				: envelope.stream === undefined
					? console.writeStdout(renderSuccess(envelope, renderer.mode)).pipe(Effect.as(0))
					: Stream.runForEach(envelope.stream, (value) =>
							console.writeStdout(renderStreamSuccess(envelope, value, renderer.mode))
						).pipe(
							Effect.matchEffect({
								onFailure: (failure) => writeCliFailure(console, failure, renderer.mode),
								onSuccess: () => Effect.succeed(0)
							})
						),
		onFailure: (failure) => writeCliFailure(console, failure, renderer.mode)
	});
});

function writeCliFailure(
	console: {
		readonly writeStdout: (value: string) => Effect.Effect<void>;
	},
	failure: CliFailure,
	mode: OutputMode
): Effect.Effect<number> {
	const error = toCliError(failure);
	return console.writeStdout(renderError(error, mode)).pipe(Effect.as(error.exitStatus));
}

export function toCliError(failure: CliFailure): AkuaCliError {
	switch (failure._tag) {
		case 'UsageFailure':
			return usageError(failure.message, failure.help);
		case 'SecureConfigFailure':
			return new AkuaCliError({
				type: 'runtime_error',
				code: 'AKUA_CONFIG_ERROR',
				message: `Failed to ${failure.operation} Akua config at ${failure.path}: ${errorMessage(failure.cause)}`
			});
		case 'DeviceRequestFailure':
			return deviceError(
				'AKUA_DEVICE_REQUEST_FAILED',
				'Device authorization could not be completed.'
			);
		case 'DeviceCancelledFailure':
			return new AkuaCliError({
				type: 'runtime_error',
				code: 'AKUA_DEVICE_CANCELLED',
				message: 'Device authorization was cancelled.'
			});
		case 'DeviceAuthorizationFailure':
			return failure.reason === 'access_denied'
				? deviceError('AKUA_DEVICE_ACCESS_DENIED', 'Device authorization was denied.')
				: deviceError(
						'AKUA_DEVICE_EXPIRED_TOKEN',
						'Device authorization expired. Start login again.'
					);
		case 'AkuaCliError':
			return failure;
	}
}

function deviceError(code: string, message: string): AkuaCliError {
	return new AkuaCliError({
		type: 'authentication_error',
		code,
		message,
		exitCode: 3
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
