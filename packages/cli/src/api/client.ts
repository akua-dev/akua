import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Predicate,
	Redacted,
	Result,
	Schema,
	Stream
} from 'effect';
import { Sse } from 'effect/encoding';
import { HttpClient, HttpClientRequest, type HttpClientResponse } from 'effect/http';

import { optionalEnv, resolveCredential } from '../runtime/credentials';
import { SecureConfig, type SecureConfigFailure } from '../runtime/services';
import type { ApiOperation } from './contract';
import { decodeApiErrorBody, OperationFailure } from './failure';
import { decodeJsonText, decodeJsonTextOption, type JsonRecord } from './json';
import type { ApiRequest } from './request';

export const DEFAULT_API_URL = 'https://api.akua.dev/v1';
const MAX_RAW_ERROR_CHARS = 2000;

export type ApiResult =
	| { readonly _tag: 'Value'; readonly value: Schema.Json }
	| { readonly _tag: 'Stream'; readonly stream: Stream.Stream<ApiEvent, OperationFailure> };

/** One Server-Sent Event of a streaming operation. */
export interface ApiEvent {
	readonly event: string;
	readonly data: string;
}

/**
 * Executes any operation of the generated contract over HTTP. One generic
 * executor serves every operation: the contract supplies method, path
 * template, and parameter locations; the request was validated before it
 * gets here. Responses are returned as the JSON the API sent.
 */
export class ApiClient extends Context.Service<
	ApiClient,
	{
		readonly execute: (
			operation: ApiOperation,
			request: ApiRequest
		) => Effect.Effect<ApiResult, OperationFailure | SecureConfigFailure>;
	}
>()('platform/cli/ApiClient') {
	static readonly layer = Layer.effect(
		ApiClient,
		Effect.gen(function* () {
			const http = yield* HttpClient.HttpClient;
			const secureConfig = yield* SecureConfig;
			const baseUrl = Option.getOrElse(
				yield* optionalEnv('AKUA_API_URL'),
				() => DEFAULT_API_URL
			).replace(/\/+$/, '');

			// A missing credential is an auth failure; an unreadable config file is not.
			const bearerToken = (operation: ApiOperation) =>
				resolveCredential.pipe(
					Effect.provideService(SecureConfig, secureConfig),
					Effect.flatMap((credential) =>
						Effect.fromOption(credential.token).pipe(
							Effect.mapError(
								() => new OperationFailure({ operationId: operation.id, reason: 'auth' })
							)
						)
					)
				);

			const execute = Effect.fn('ApiClient.execute')(function* (
				operation: ApiOperation,
				request: ApiRequest
			) {
				const path = yield* Effect.fromResult(expandPath(operation.path, request.path ?? {})).pipe(
					Effect.mapError(
						(name) =>
							new OperationFailure({
								operationId: operation.id,
								reason: 'input',
								issues: [{ path: ['path', name], message: 'Expected a value other than . or ..' }]
							})
					)
				);
				const token = operation.auth ? Option.some(yield* bearerToken(operation)) : Option.none();
				const httpRequest = HttpClientRequest.make(operation.method)(baseUrl + path, {
					urlParams: textEntries(request.query ?? {}),
					headers: Object.fromEntries(textEntries(request.headers ?? {}))
				}).pipe(
					(base) =>
						Option.match(token, {
							onNone: () => base,
							onSome: (value) => HttpClientRequest.bearerToken(base, Redacted.value(value))
						}),
					(base) =>
						request.body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, request.body)
				);
				const transport = () =>
					new OperationFailure({ operationId: operation.id, reason: 'transport' });
				const response = yield* http.execute(httpRequest).pipe(Effect.mapError(transport));
				if (response.status >= 400) {
					return yield* errorResponse(operation, response);
				}
				if (operation.stream !== undefined) {
					return {
						_tag: 'Stream',
						stream: eventStream(operation.id, operation.stream.failureEvent, response)
					} satisfies ApiResult;
				}
				const text = yield* response.text.pipe(Effect.mapError(transport));
				if (text === '') return { _tag: 'Value', value: null } satisfies ApiResult;
				return {
					_tag: 'Value',
					value: yield* decodeJsonText(text).pipe(
						Effect.mapError(
							() =>
								new OperationFailure({
									operationId: operation.id,
									reason: 'response',
									status: response.status
								})
						)
					)
				} satisfies ApiResult;
			});

			return ApiClient.of({ execute });
		})
	);
}

/**
 * Fills `{name}` with the encoded value and `{name:*}` with a slash-separated
 * value whose segments are encoded one by one. Literal suffixes such as
 * `:resume` are kept. A `.` or `..` segment would make the URL resolve to a
 * different route, so it fails with the parameter's name.
 */
export function expandPath(
	template: string,
	values: Readonly<Record<string, Schema.Json>>
): Result.Result<string, string> {
	let rejected: string | undefined;
	const path = template.replace(
		/\{([^}:]+)(:\*)?\}/g,
		(_match, name: string, wildcard?: string) => {
			const text = scalarText(values[name]);
			const segments = wildcard === undefined ? [text] : text.split('/');
			if (segments.some((segment) => segment === '.' || segment === '..')) rejected ??= name;
			return segments.map(encodeURIComponent).join('/');
		}
	);
	return rejected === undefined ? Result.succeed(path) : Result.fail(rejected);
}

/** Query and header values as text; `null` means "not sent". */
function textEntries(record: JsonRecord): Array<[string, string]> {
	return Object.entries(record)
		.filter(([, value]) => value !== null)
		.map(([key, value]) => [key, scalarText(value)]);
}

function scalarText(value: Schema.Json | undefined): string {
	if (value === undefined || value === null) return '';
	return Predicate.isObjectOrArray(value) ? JSON.stringify(value) : String(value);
}

/** Error bodies are kept as parsed JSON (or `{ raw }`) and summarized into a code and message. */
const errorResponse = Effect.fnUntraced(function* (
	operation: ApiOperation,
	response: HttpClientResponse.HttpClientResponse
): Effect.fn.Return<never, OperationFailure> {
	const text = yield* response.text.pipe(Effect.orElseSucceed(() => ''));
	const json = decodeJsonTextOption(text);
	const body: Option.Option<Schema.Json> = Option.isSome(json)
		? json
		: text === ''
			? Option.none()
			: // One line, so a proxy's HTML page cannot spill across the terminal.
				Option.some({
					raw: text
						.slice(0, MAX_RAW_ERROR_CHARS)
						.split(/\r\n|[\r\n]/)
						.join('\\n')
				});
	return yield* new OperationFailure({
		operationId: operation.id,
		reason: 'api',
		status: response.status,
		...Option.match(json, { onNone: () => ({}), onSome: summarizeError }),
		...(Option.isSome(body) ? { response: body.value } : {})
	});
});

/**
 * Reads `{ errors: [{ code, message }] }` (the public API envelope),
 * `{ message }`, or a tagged `{ _tag }` error into a code and message.
 */
function summarizeError(json: Schema.Json): { detail?: string; code?: number | string } {
	const first = decodeApiErrorBody(json).pipe(Option.flatMap((body) => Arr.head(body.errors)));
	if (Option.isSome(first)) {
		const { code, message } = first.value;
		return {
			...(message === undefined || message === '' ? {} : { detail: message }),
			...(code === undefined ? {} : { code })
		};
	}
	if (!Predicate.isObject(json)) return {};
	if (Predicate.isString(json.message) && json.message !== '') return { detail: json.message };
	if (Predicate.isString(json._tag)) return { detail: json._tag };
	return {};
}

function eventStream(
	operationId: string,
	failureEvent: string,
	response: HttpClientResponse.HttpClientResponse
): Stream.Stream<ApiEvent, OperationFailure> {
	return response.stream.pipe(
		Stream.decodeText,
		Stream.pipeThroughChannel(Sse.decode()),
		Stream.mapError(() => new OperationFailure({ operationId, reason: 'transport' })),
		Stream.mapEffect((event) =>
			event.event === failureEvent
				? Effect.fail(
						new OperationFailure({
							operationId,
							reason: 'api',
							status: response.status,
							...streamFailureDetail(event.data)
						})
					)
				: Effect.succeed({ event: event.event, data: event.data })
		)
	);
}

/** The failure event carries a serialized Effect cause; its first `Fail` names the error. */
function streamFailureDetail(data: string): { detail?: string } {
	const cause = decodeJsonTextOption(data);
	if (Option.isNone(cause) || !Array.isArray(cause.value)) return {};
	const failure = cause.value.find(
		(reason) => Predicate.isObject(reason) && reason._tag === 'Fail'
	);
	if (!Predicate.isObject(failure) || !Predicate.isObject(failure.error)) return {};
	const message = failure.error.error ?? failure.error.message;
	return Predicate.isString(message) ? { detail: message } : {};
}
