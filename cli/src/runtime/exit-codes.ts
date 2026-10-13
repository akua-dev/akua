import { Runtime, Schema } from 'effect';

export const ExitCode = Schema.Union([
	Schema.Literal(0),
	Schema.Literal(1),
	Schema.Literal(2),
	Schema.Literal(3),
	Schema.Literal(4),
	Schema.Literal(5),
	Schema.Literal(6)
]);
export type ExitCode = typeof ExitCode.Type;

export const ExitCodes = {
	Ok: 0,
	Runtime: 1,
	Usage: 2,
	AuthRequired: 3,
	ConfirmationRequired: 4,
	Conflict: 5,
	Retryable: 6
} satisfies Record<string, ExitCode>;

/** A run that ends with a non-zero exit code; its output is already written. */
export class ExitStatus extends Schema.TaggedError<ExitStatus>()('ExitStatus', {
	code: Schema.Int
}) {
	override get [Runtime.errorExitCode]() {
		return this.code;
	}
	override get [Runtime.errorReported]() {
		return false;
	}
}
