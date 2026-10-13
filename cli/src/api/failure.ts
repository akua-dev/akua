import { Schema } from 'effect';

export const InputIssue = Schema.Struct({
	/** Location inside the request envelope, for example `["body", "name"]`. */
	path: Schema.Array(Schema.String),
	message: Schema.String
});
export type InputIssue = typeof InputIssue.Type;

/**
 * Why a public API operation did not produce a result. One error per
 * operation keeps the command boundary to a single `catchTag`; `reason`
 * tells the renderer which next action to suggest.
 */
export class OperationFailure extends Schema.TaggedError<OperationFailure>()('OperationFailure', {
	operationId: Schema.String,
	reason: Schema.Literals([
		/** The request input (flags, arguments, or `--input`) is malformed or invalid. */
		'input',
		/** An input option names a file or stream that cannot be read. */
		'source',
		/** The operation needs a credential and none is configured. */
		'auth',
		/** A workspace name or slug did not resolve to exactly one workspace. */
		'workspace',
		/** The API answered with an error status. */
		'api',
		/** The API answered successfully with a body that is not JSON. */
		'response',
		/** The request or a stream could not be completed. */
		'transport'
	]),
	/** Server or input message to show the user. */
	detail: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(Schema.Int),
	/** API error code, for example `7004`, when the body carries one. */
	code: Schema.optionalKey(Schema.Union([Schema.Int, Schema.String])),
	/** Parsed error body (or `{ raw }` for a non-JSON body). Never contains request values. */
	response: Schema.optionalKey(Schema.Json),
	issues: Schema.optionalKey(Schema.Array(InputIssue))
}) {}

/** The public API error envelope `{ errors: [{ code, message, path }] }`, as far as the CLI reads it. */
export const ApiErrorBody = Schema.Struct({
	errors: Schema.Array(
		Schema.Struct({
			code: Schema.optionalKey(Schema.Union([Schema.Int, Schema.String])),
			message: Schema.optionalKey(Schema.String),
			path: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Int])))
		})
	)
});
export const decodeApiErrorBody = Schema.decodeUnknownOption(ApiErrorBody);
