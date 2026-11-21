import { Effect, Option, Predicate, Schema } from 'effect';
import { constant as discardError } from 'effect/Function';
import { HttpClient } from 'effect/http';

import { buildContract, OpenApiDocument } from '../../scripts/generate-contract';
import { DEFAULT_API_URL } from '../api/client';
import { decodeApiErrorBody, type OperationFailure } from '../api/failure';
import { decodeRequest } from '../api/request';
import { optionalEnv } from '../runtime/credentials';
import { AkuaCliError } from '../runtime/errors';
import type { OperationCommandContext } from './operation-context';
import { operationError } from './operation-errors';

/**
 * Best-effort advice on schema failures only. Never retries the operation,
 * sends its input to discovery, or changes its original error/exit status.
 */
export const diagnoseContractFailure = Effect.fnUntraced(function* (
	context: OperationCommandContext,
	input: unknown,
	failure: OperationFailure
) {
	const error = operationError(failure, context);
	if (!isContractFailure(failure)) return error;
	const mismatch = yield* newerContractAccepts(context, input, failure).pipe(
		Effect.timeoutOption('2 seconds'),
		// Discovery is optional: network, decoding, or future-schema failures must not hide the error.
		Effect.catchCause(discardError(Effect.succeed(Option.none())))
	);
	if (Option.isNone(mismatch) || !mismatch.value) return error;
	return Object.defineProperty(
		new AkuaCliError({
			...error,
			message: error.message,
			nextSteps: [
				{
					command: 'brew upgrade akua',
					description: 'Your akua CLI is older than the API. Update with `brew upgrade akua`.'
				},
				...error.nextSteps
			]
		}),
		'cause',
		{ value: error.cause }
	);
});

const newerContractAccepts = Effect.fnUntraced(function* (
	context: OperationCommandContext,
	input: unknown,
	failure: OperationFailure
) {
	const baseUrl = Option.getOrElse(yield* optionalEnv('AKUA_API_URL'), () => DEFAULT_API_URL);
	const url = yield* Effect.try(() => new URL('/openapi.json', baseUrl).href);
	const response = yield* (yield* HttpClient.HttpClient).get(url);
	if (response.status !== 200) return false;
	const live = yield* response.json.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(OpenApiDocument)),
		Effect.flatMap(buildContract)
	);
	// Compare the same generated request projection, ignoring JSON object-key order.
	// info.version alone cannot detect a breaking change within v1.
	if (JSON.stringify(ordered(live)) === JSON.stringify(ordered(context.contract))) return false;
	const operation = live.operations.find((candidate) => candidate.id === context.operation.id);
	if (operation === undefined) return false;
	if (failure.reason !== 'input') return true;
	yield* decodeRequest(live, operation, input);
	return true;
});

function isContractFailure(failure: OperationFailure): boolean {
	if (failure.reason === 'input') return true;
	if (failure.reason !== 'api' || failure.status !== 400) return false;
	return Option.match(decodeApiErrorBody(failure.response), {
		onNone: () => false,
		onSome: (body) =>
			body.errors.some(
				(error) =>
					(error.code === 7001 || error.code === '7001') &&
					['path', 'query', 'headers', 'body'].some((part) => error.path?.[0] === part)
			)
	});
}

function ordered(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(ordered);
	if (!Predicate.isObject(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, ordered(child)])
	);
}
