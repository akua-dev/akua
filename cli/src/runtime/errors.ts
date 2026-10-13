import { Effect, Schema } from 'effect';

import { ExitCode, ExitCodes } from './exit-codes';

const NextStepSchema = Schema.Struct({
	command: Schema.String,
	description: Schema.optional(Schema.String)
});
export type NextStep = typeof NextStepSchema.Type;

/** A failure as the CLI prints it: the error document plus the exit code. */
export class AkuaCliError extends Schema.TaggedError<AkuaCliError>()('AkuaCliError', {
	type: Schema.String,
	code: Schema.String,
	message: Schema.String,
	status: Schema.optionalKey(Schema.Number),
	path: Schema.Array(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
	requestId: Schema.optionalKey(Schema.String),
	retryAfter: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
	response: Schema.optionalKey(Schema.Unknown),
	nextSteps: Schema.Array(NextStepSchema).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
	/** Defaults to the code for `status`. */
	exitCode: Schema.optionalKey(ExitCode)
}) {
	/** The process exit code for this failure. */
	get exitStatus(): ExitCode {
		return this.exitCode ?? exitCodeForStatus(this.status);
	}

	toPayload() {
		return {
			error: {
				type: this.type,
				code: this.code,
				status: this.status,
				message: this.message,
				path: this.path.length > 0 ? this.path : undefined,
				request_id: this.requestId,
				retry_after: this.retryAfter ?? undefined,
				response: this.response,
				next_steps: this.nextSteps.length > 0 ? this.nextSteps : undefined
			}
		};
	}
}

export function usageError(message: string, helpCommand = 'akua --help'): AkuaCliError {
	return new AkuaCliError({
		type: 'usage_error',
		code: 'AKUA_USAGE_ERROR',
		message,
		exitCode: ExitCodes.Usage,
		nextSteps: [{ command: helpCommand }]
	});
}

export function packageCommandError(): AkuaCliError {
	return new AkuaCliError({
		type: 'runtime_error',
		code: 'AKUA_PACKAGE_UNAVAILABLE',
		message: 'The package toolchain (the akuapkg executable next to akua) could not be run.',
		exitCode: ExitCodes.Runtime,
		nextSteps: [
			{
				command: 'brew reinstall akua-dev/tap/akua',
				description: 'Reinstall the CLI together with its package toolchain.'
			}
		]
	});
}

function exitCodeForStatus(status: number | undefined): ExitCode {
	if (status === 401) {
		return ExitCodes.AuthRequired;
	}
	if (status === 409) {
		return ExitCodes.Conflict;
	}
	if (status === 429 || (status !== undefined && status >= 500)) {
		return ExitCodes.Retryable;
	}
	return ExitCodes.Runtime;
}
