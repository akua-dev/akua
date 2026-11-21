import { Effect, Option, Schema, Stream } from 'effect';
import { Argument, Command } from 'effect/cli';
import { Sse } from 'effect/encoding';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';

import { AkuaCliError, UsageFailure } from '../runtime/errors';
import { ExitCodes } from '../runtime/exit-codes';
import type { RenderEnvelope } from '../runtime/render';
import { Invocation, respond } from './invocation';

const DOCS_ORIGIN = 'https://docs.akua.dev';
const DOCS_INDEX = `${DOCS_ORIGIN}/llms.txt`;
const SEARCH_URL = `${DOCS_ORIGIN}/mcp`;
const MAX_BYTES = 1_048_576;
const PagePath = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/));
const SearchResponse = Schema.Struct({
	jsonrpc: Schema.Literal('2.0'),
	id: Schema.Literal(1),
	result: Schema.optionalKey(
		Schema.Struct({
			isError: Schema.optionalKey(Schema.Boolean),
			content: Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }))
		})
	),
	error: Schema.optionalKey(Schema.Unknown)
});
const SearchMessage = Schema.Union([
	SearchResponse,
	Schema.Struct({ jsonrpc: Schema.Literal('2.0'), method: Schema.String })
]);
const SearchMatch = Schema.Struct({
	title: Schema.String,
	url: Schema.URLFromString.check(
		Schema.makeFilter(
			(url) =>
				url.origin === DOCS_ORIGIN &&
				!url.username &&
				!url.password &&
				!url.search &&
				!url.pathname.startsWith('//')
		)
	),
	snippet: Schema.String
});

export const docsHelp = [
	'DOCUMENTATION',
	`  Current docs index: ${DOCS_INDEX}`,
	'  akua docs search "<query>"    Search current docs; keep queries free of secrets and identifying values.',
	'  akua docs <path>              Read a docs page as Markdown, for example: akua docs quickstart',
	'  No sign-in required. Use --json for structured output.',
	''
].join('\n');

const docsError = (url: string, reason: string, cause?: unknown) =>
	Object.defineProperty(
		new AkuaCliError({
			type: 'docs_error',
			code: 'AKUA_DOCS_ERROR',
			message: `${reason} URL: ${url}. Current docs index: ${DOCS_INDEX}`,
			exitCode: ExitCodes.Runtime
		}),
		'cause',
		{ value: cause }
	);

/** Limits the whole exchange, including streamed response bodies, without following redirects. */
const requestText = Effect.fn('docs.request')(function* (
	request: HttpClientRequest.HttpClientRequest
) {
	const client = yield* HttpClient.HttpClient;
	const url = request.url;
	return yield* Effect.gen(function* () {
		const response = yield* client.execute(request);
		if (response.status < 200 || response.status >= 300) {
			return yield* docsError(url, `Documentation request failed (HTTP ${response.status}).`);
		}
		if (Number(response.headers['content-length'] ?? 0) > MAX_BYTES) {
			return yield* docsError(url, 'Documentation response exceeds 1 MiB.');
		}
		let size = 0;
		const text = yield* response.stream.pipe(
			Stream.mapEffect((chunk) => {
				size += chunk.byteLength;
				return size > MAX_BYTES
					? Effect.fail(docsError(url, 'Documentation response exceeds 1 MiB.'))
					: Effect.succeed(chunk);
			}),
			Stream.decodeText(),
			Stream.mkString
		);
		return { text, contentType: response.headers['content-type']?.split(';')[0]?.trim() };
	}).pipe(
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error', credentials: 'omit' }),
		Effect.timeout('30 seconds'),
		Effect.mapError((error) =>
			error._tag === 'AkuaCliError'
				? error
				: docsError(
						url,
						error._tag === 'TimeoutError'
							? 'Documentation request timed out after 30 seconds.'
							: 'Unable to retrieve documentation. Check your connection and try again.',
						error
					)
		)
	);
});

const readPage = Effect.fn('docs.read')(function* (
	path: string
): Effect.fn.Return<
	RenderEnvelope,
	AkuaCliError | UsageFailure,
	HttpClient.HttpClient | Invocation
> {
	const decoded = yield* Schema.decodeUnknownEffect(PagePath)(path.replace(/^\//, '')).pipe(
		Effect.mapError(
			(cause) =>
				new UsageFailure({
					cause,
					message: `Expected a docs-relative path, for example quickstart. Current docs index: ${DOCS_INDEX}`,
					help: 'akua docs --help'
				})
		)
	);
	const url = `${DOCS_ORIGIN}/${decoded}`;
	const response = yield* requestText(
		HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader('Accept', 'text/markdown'))
	);
	if (
		response.contentType !== 'text/markdown' &&
		!(decoded === 'llms.txt' && response.contentType === 'text/plain')
	) {
		return yield* docsError(url, 'The documentation server did not return Markdown.');
	}
	const { mode } = yield* Invocation;
	return {
		command: 'akua docs',
		data: { url, content: response.text },
		...(mode === 'human' || mode === 'agent'
			? { bytes: Stream.make(new TextEncoder().encode(response.text)) }
			: {})
	};
});

/** Decode one stateless JSON-RPC response, allowing SSE notifications before the result. */
const searchResponse = Effect.fnUntraced(function* (response: {
	readonly text: string;
	readonly contentType: string | undefined;
}) {
	const invalid = (cause?: unknown) =>
		docsError(SEARCH_URL, 'Mintlify returned an invalid search response.', cause);
	const decoded = yield* (
		response.contentType === 'text/event-stream'
			? Stream.make(response.text).pipe(
					Stream.pipeThroughChannel(
						Sse.decodeDataSchema(SearchMessage, { maxEventSize: MAX_BYTES })
					),
					Stream.map((event) => event.data),
					Stream.filter((message) => 'id' in message),
					Stream.runHead,
					Effect.flatMap(
						Option.match({ onNone: () => Effect.fail(invalid()), onSome: Effect.succeed })
					)
				)
			: response.contentType === 'application/json'
				? Schema.decodeUnknownEffect(Schema.fromJsonString(SearchResponse))(response.text)
				: Effect.fail(invalid())
	).pipe(Effect.mapError(invalid));
	if (decoded.error !== undefined || decoded.result === undefined || decoded.result.isError) {
		return yield* docsError(SEARCH_URL, 'Mintlify could not complete the documentation search.');
	}
	return yield* Effect.forEach(
		decoded.result.content.filter(({ text }) => text.trim() !== 'No results found.').slice(0, 5),
		Effect.fnUntraced(function* ({ text }) {
			const fields =
				/^Title: ([^\r\n]+)\r?\nLink: ([^\r\n]+)\r?\n(?:Page: [^\r\n]*\r?\n)?Content: ([\s\S]*)$/.exec(
					text
				);
			const match = yield* Schema.decodeUnknownEffect(SearchMatch)({
				title: fields?.[1],
				url: fields?.[2],
				snippet: fields?.[3]
			}).pipe(Effect.mapError(invalid));
			const snippet = match.snippet.replace(/\s+/g, ' ').trim();
			return {
				title: match.title,
				url: match.url.href,
				snippet: snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet
			};
		})
	);
});

const searchDocs = Effect.fn('docs.search')(function* (
	query: string
): Effect.fn.Return<RenderEnvelope, AkuaCliError | UsageFailure, HttpClient.HttpClient> {
	if (query.trim() === '') {
		return yield* new UsageFailure({
			message: 'Provide a non-empty documentation search query.',
			help: 'akua docs search --help'
		});
	}
	const response = yield* requestText(
		HttpClientRequest.post(SEARCH_URL).pipe(
			HttpClientRequest.setHeader('Accept', 'application/json, text/event-stream'),
			HttpClientRequest.bodyJsonUnsafe({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'search_akua_docs', arguments: { query: query.trim() } }
			})
		)
	);
	const data = yield* searchResponse(response);
	return {
		command: 'akua docs search',
		data,
		observations: data.length === 0 ? ['No documentation matches found.'] : undefined,
		next_steps: [{ command: 'akua docs <path>', description: 'Read a result page as Markdown.' }]
	};
});

export const docsCommand = Command.make(
	'docs',
	{ path: Argument.String('path').pipe(Argument.optional) },
	({ path }) => respond(readPage(Option.getOrElse(path, () => 'llms.txt')))
).pipe(
	Command.withDescription(
		'Search current documentation or read a page from https://docs.akua.dev (no sign-in).'
	),
	Command.withSubcommands([
		Command.make('search', { query: Argument.String('query') }, ({ query }) =>
			respond(searchDocs(query))
		).pipe(
			Command.withDescription(
				'Search live Mintlify docs. Quote the query; never include secrets or identifying values.'
			)
		)
	])
);
