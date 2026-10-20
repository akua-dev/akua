import { BunServices } from '@effect/platform-bun';
import { ConfigProvider, Effect, FileSystem, Layer, Ref, Stream } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';

import { main } from '../src/bin/akua';
import {
	Browser,
	Console,
	Http,
	PackageCli,
	Process,
	PublicInput,
	PublicInputFailure,
	PublicOutput
} from '../src/runtime/services';
import { SecureConfigLive } from '../src/runtime/services-live';

/** One request the CLI sent to the fake API. */
export interface RecordedRequest {
	readonly method: string;
	readonly url: URL;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: unknown;
	/** The body of an `application/octet-stream` request. */
	readonly bytes?: Uint8Array;
}

export interface FakeResponse {
	readonly status?: number;
	readonly body?: unknown;
	/** Raw response text, for streams and non-JSON bodies. */
	readonly text?: string;
	/** Raw response bytes, for `application/octet-stream`. */
	readonly bytes?: Uint8Array<ArrayBuffer>;
	readonly contentType?: string;
}

export type FakeApi = (request: RecordedRequest) => FakeResponse;

export interface RunOptions {
	readonly env?: Readonly<Record<string, string>>;
	readonly api?: FakeApi;
	/** `--input` sources by name (`-` is stdin). */
	readonly inputs?: Readonly<Record<string, string>>;
	/** Pretend stdout is a terminal (human mode unless flags or env say otherwise). */
	readonly tty?: boolean;
}

export interface RunResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	/** Everything written to stdout as raw bytes. */
	readonly stdoutBytes: Uint8Array;
	/** Files written through `--output-file`, by path. */
	readonly files: Readonly<Record<string, Uint8Array>>;
	readonly requests: readonly RecordedRequest[];
}

const decoder = new TextDecoder();

const isBinary = (headers: Readonly<Record<string, string>>) =>
	headers['content-type'] === 'application/octet-stream';

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> => {
	const joined = new Uint8Array(left.length + right.length);
	joined.set(left);
	joined.set(right, left.length);
	return joined;
};

/**
 * Runs the real `akua` program in-process against a fake public API. The
 * config file is real (`SecureConfigLive` over a temporary HOME the caller
 * owns); HTTP, stdin, and the terminal are test doubles.
 */
export const runAkua = Effect.fnUntraced(function* (
	argv: readonly string[],
	options: RunOptions = {}
) {
	const requests = yield* Ref.make<RecordedRequest[]>([]);
	const stdout = yield* Ref.make('');
	const stderr = yield* Ref.make('');
	const stdoutBytes = yield* Ref.make(new Uint8Array(0));
	const files = yield* Ref.make<Record<string, Uint8Array>>({});
	const api: FakeApi = options.api ?? (() => ({ status: 404, body: { message: 'no route' } }));

	const httpClient = HttpClient.make((request, url) =>
		Effect.gen(function* () {
			const recorded: RecordedRequest = {
				method: request.method,
				url,
				headers: request.headers,
				...(request.body._tag === 'Uint8Array' && isBinary(request.headers)
					? { body: undefined, bytes: request.body.body }
					: {
							body:
								request.body._tag === 'Uint8Array'
									? JSON.parse(decoder.decode(request.body.body))
									: undefined
						})
			};
			yield* Ref.update(requests, (all) => [...all, recorded]);
			const response = api(recorded);
			const text =
				response.text ?? (response.body === undefined ? '' : JSON.stringify(response.body));
			return HttpClientResponse.fromWeb(
				request,
				new Response(response.bytes ?? (text === '' ? null : text), {
					status: response.status ?? 200,
					headers: { 'content-type': response.contentType ?? 'application/json' }
				})
			);
		})
	);

	const services = Layer.mergeAll(
		Layer.succeed(HttpClient.HttpClient, httpClient),
		Layer.succeed(Console, {
			stdoutIsTTY: options.tty === true,
			stdinIsTTY: options.tty === true,
			writeStdout: (value) => Ref.update(stdout, (all) => all + value),
			writeStderr: (value) => Ref.update(stderr, (all) => all + value),
			writeStdoutBytes: (value) => Ref.update(stdoutBytes, (all) => concat(all, value))
		}),
		Layer.succeed(PublicInput, {
			read: (source) => {
				const text = options.inputs?.[source];
				return text === undefined ? Effect.fail(new PublicInputFailure({})) : Effect.succeed(text);
			},
			readBytes: (source) => {
				const text = options.inputs?.[source];
				return text === undefined
					? Effect.fail(new PublicInputFailure({}))
					: Effect.succeed(new TextEncoder().encode(text));
			}
		}),
		Layer.succeed(PublicOutput, {
			writeFile: (path, bytes) =>
				Stream.runCollect(bytes).pipe(
					Effect.map((chunks) => chunks.reduce(concat, new Uint8Array(0))),
					Effect.tap((all) => Ref.update(files, (written) => ({ ...written, [path]: all }))),
					Effect.map((all) => all.length)
				)
		}),
		Layer.succeed(Http, { postJson: () => Effect.die('device flow is not under test') }),
		Layer.succeed(Browser, { launch: () => Effect.die('browser is not under test') }),
		Layer.succeed(Process, { awaitSignal: Effect.never }),
		Layer.succeed(PackageCli, { execute: () => Effect.succeed(0) }),
		SecureConfigLive.pipe(Layer.provide(BunServices.layer))
	);

	const exitCode = yield* main(argv).pipe(
		Effect.provide(services),
		Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ ...options.env })))
	);
	return {
		exitCode,
		stdout: yield* Ref.get(stdout),
		stderr: yield* Ref.get(stderr),
		stdoutBytes: yield* Ref.get(stdoutBytes),
		files: yield* Ref.get(files),
		requests: yield* Ref.get(requests)
	} satisfies RunResult;
});

/** A fresh HOME for one test, removed when the test's scope closes. */
export const temporaryHome = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	return yield* fs.makeTempDirectoryScoped({ prefix: 'akua-cli-test-' });
}).pipe(Effect.provide(BunServices.layer));

export const readConfigFile = (home: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return JSON.parse(yield* fs.readFileString(`${home}/.config/akua/config.json`));
	}).pipe(Effect.provide(BunServices.layer));

export const writeConfigFile = (home: string, config: unknown) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.makeDirectory(`${home}/.config/akua`, { recursive: true });
		yield* fs.writeFileString(`${home}/.config/akua/config.json`, JSON.stringify(config), {
			mode: 0o600
		});
	}).pipe(Effect.provide(BunServices.layer));
