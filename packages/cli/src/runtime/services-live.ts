import { type HostAssets, runAkuapkgWith } from '@akua-dev/sdk/cli';
import { BunServices } from '@effect/platform-bun';
import {
	Crypto,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	PlatformError,
	Predicate,
	Schema,
	Stdio,
	Stream
} from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { AkuaHttpClientLive } from './http-client-live';
import {
	Browser,
	BrowserFailure,
	type CliServices,
	Console,
	Http,
	HttpFailure,
	Process,
	PackageCli,
	PackageCliFailure,
	PublicInput,
	PublicInputFailure,
	PublicOutput,
	PublicOutputFailure,
	SecureConfig,
	SecureConfigFailure,
	StoredWorkspace
} from './services';

const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;
const MAX_DEVICE_RESPONSE_SIZE = 16_384;

/** The config file is not a JSON object. */
class ConfigParseFailure extends Schema.TaggedError<ConfigParseFailure>()('ConfigParseFailure', {
	message: Schema.String
}) {}

/** The device-login HTTP service over the shared CLI HTTP client. */
const DeviceHttpLive = Layer.effect(
	Http,
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const postJson = Effect.fn('Http.postJson')(
			function* (request: {
				readonly url: string;
				readonly body: Readonly<Record<string, string>>;
			}) {
				const response = yield* HttpClientRequest.post(request.url).pipe(
					HttpClientRequest.bodyJson(request.body),
					Effect.flatMap(client.execute)
				);
				const text = yield* response.text;
				if (text.length > MAX_DEVICE_RESPONSE_SIZE) {
					return yield* new HttpFailure({ cause: new Error('Device response is too large.') });
				}
				const body = yield* Effect.try({
					try: (): unknown => (text === '' ? {} : JSON.parse(text)),
					catch: (cause) => new HttpFailure({ cause })
				});
				return { status: response.status, body };
			},
			Effect.mapError((cause) =>
				cause._tag === 'HttpFailure' ? cause : new HttpFailure({ cause })
			)
		);
		return Http.of({ postJson });
	})
);

export function HttpLive(cliVersion: string): Layer.Layer<Http> {
	return DeviceHttpLive.pipe(Layer.provide(AkuaHttpClientLive(cliVersion)));
}

/** The platform's URL opener. */
const browserCommand = (url: string): readonly [string, ...string[]] =>
	process.platform === 'darwin'
		? ['open', url]
		: process.platform === 'win32'
			? ['cmd', '/c', 'start', '', url]
			: ['xdg-open', url];

export const BrowserLive = Layer.effect(
	Browser,
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const launch = Effect.fn('Browser.launch')(
			function* (url: string) {
				const [command, ...args] = browserCommand(url);
				const exitCode = yield* spawner.exitCode(
					ChildProcess.make(command, args, { stdout: 'ignore', stderr: 'ignore' })
				);
				if (exitCode !== 0) {
					return yield* new BrowserFailure({ cause: new Error('Browser launch failed.') });
				}
			},
			Effect.catchTag('PlatformError', (cause) => Effect.fail(new BrowserFailure({ cause })))
		);
		return Browser.of({ launch });
	})
);

export const ProcessLive = Layer.succeed(Process, {
	awaitSignal: Effect.callback((resume) => {
		const cancel = () => resume(Effect.void);
		process.once('SIGINT', cancel);
		process.once('SIGTERM', cancel);
		return Effect.sync(() => {
			process.removeListener('SIGINT', cancel);
			process.removeListener('SIGTERM', cancel);
		});
	})
});

export const ConsoleLive = Layer.effect(
	Console,
	Effect.gen(function* () {
		const stdio = yield* Stdio.Stdio;
		const write = (sink: ReturnType<Stdio.Stdio['stdout']>) => (value: string) =>
			Stream.make(value).pipe(Stream.run(sink), Effect.orDie);
		return Console.of({
			stdoutIsTTY: yield* stdio.stdoutIsTerminal,
			stdinIsTTY: yield* stdio.stdinIsTerminal,
			writeStdout: write(stdio.stdout()),
			writeStdoutBytes: (value) =>
				Stream.make(value).pipe(Stream.run(stdio.stdout()), Effect.orDie),
			writeStderr: write(stdio.stderr())
		});
	})
);

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === 'NotFound';

export const SecureConfigLive = Layer.effect(
	SecureConfig,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;

		/** The config file as a JSON object; a missing file is an empty one. */
		const readConfig = Effect.fnUntraced(function* (configPath: string) {
			const raw = yield* fs
				.readFileString(configPath)
				.pipe(Effect.catchIf(isNotFound, () => Effect.succeed('{}')));
			const value = yield* Effect.try({
				try: (): unknown => JSON.parse(raw),
				catch: (cause) =>
					new ConfigParseFailure({
						message: cause instanceof Error ? cause.message : String(cause)
					})
			});
			if (!Predicate.isObject(value)) {
				return yield* new ConfigParseFailure({ message: 'Akua config must be a JSON object.' });
			}
			return value;
		});

		/** Atomic replace: a user-only temporary file renamed over the config. */
		const writeConfig = Effect.fnUntraced(function* (
			configPath: string,
			config: Record<string, unknown>
		) {
			const directory = path.dirname(configPath);
			const temporary = path.join(directory, `.config.json.${yield* crypto.randomUUIDv4}.tmp`);
			yield* Effect.gen(function* () {
				yield* fs.makeDirectory(directory, { recursive: true, mode: CONFIG_DIR_MODE });
				yield* fs.chmod(directory, CONFIG_DIR_MODE);
				yield* fs.writeFileString(temporary, `${JSON.stringify(config, null, 2)}\n`, {
					mode: CONFIG_FILE_MODE,
					flag: 'wx'
				});
				yield* fs.chmod(temporary, CONFIG_FILE_MODE);
				yield* fs.rename(temporary, configPath);
				yield* fs.chmod(configPath, CONFIG_FILE_MODE);
			}).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
		});

		const failure =
			(operation: SecureConfigFailure['operation'], configPath: string) => (cause: unknown) =>
				new SecureConfigFailure({ operation, path: configPath, cause });

		return SecureConfig.of({
			readToken: (configPath) =>
				readConfig(configPath).pipe(
					Effect.map((config) =>
						Predicate.isString(config.token) && config.token !== '' ? config.token : undefined
					),
					Effect.mapError(failure('read', configPath))
				),
			saveToken: (configPath, token) =>
				readConfig(configPath).pipe(
					Effect.flatMap((config) => writeConfig(configPath, { ...config, token })),
					Effect.mapError(failure('write', configPath))
				),
			removeToken: (configPath) =>
				readConfig(configPath).pipe(
					Effect.matchEffect({
						// An unreadable file is removed; one without a token is left alone.
						onFailure: (cause) =>
							cause._tag === 'PlatformError' && isNotFound(cause)
								? Effect.succeed(false)
								: fs.remove(configPath, { force: true }).pipe(Effect.as(true)),
						onSuccess: (config) => {
							if (!Object.hasOwn(config, 'token')) return Effect.succeed(false);
							const { token, ...remaining } = config;
							return writeConfig(configPath, remaining).pipe(
								Effect.as(Predicate.isString(token) && token !== '')
							);
						}
					}),
					Effect.mapError(failure('remove', configPath))
				),
			readWorkspace: (configPath) =>
				readConfig(configPath).pipe(
					Effect.map((config) =>
						Option.getOrUndefined(Schema.decodeUnknownOption(StoredWorkspace)(config.workspace))
					),
					Effect.mapError(failure('read', configPath))
				),
			saveWorkspace: (configPath, workspace) =>
				readConfig(configPath).pipe(
					Effect.flatMap((config) => writeConfig(configPath, { ...config, workspace })),
					Effect.mapError(failure('write', configPath))
				),
			removeWorkspace: (configPath) =>
				readConfig(configPath).pipe(
					Effect.flatMap((config) => {
						if (!Object.hasOwn(config, 'workspace')) return Effect.succeed(false);
						const { workspace: _workspace, ...remaining } = config;
						return writeConfig(configPath, remaining).pipe(Effect.as(true));
					}),
					Effect.mapError(failure('remove', configPath))
				)
		});
	})
);

export const PublicInputLive = Layer.effect(
	PublicInput,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const stdio = yield* Stdio.Stdio;
		return PublicInput.of({
			read: (source) =>
				(source === '-'
					? stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)
					: fs.readFileString(source)
				).pipe(Effect.mapError(() => new PublicInputFailure({}))),
			readBytes: (source) =>
				(source === '-' ? Stream.mkUint8Array(stdio.stdin) : fs.readFile(source)).pipe(
					Effect.mapError(() => new PublicInputFailure({}))
				)
		});
	})
);

export const PublicOutputLive = Layer.effect(
	PublicOutput,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return PublicOutput.of({
			writeFile: (path, bytes) =>
				Effect.gen(function* () {
					let written = 0;
					yield* bytes.pipe(
						Stream.tap((chunk) => Effect.sync(() => void (written += chunk.length))),
						Stream.run(fs.sink(path)),
						Effect.mapError((error) =>
							Predicate.isTagged(error, 'PlatformError') ? new PublicOutputFailure({}) : error
						)
					);
					return written;
				})
		});
	})
);

/**
 * `akua pkg` as release builds run it: the package toolchain in this process,
 * over the Wasmtime addon and precompiled engines the executable embeds.
 */
export const EmbeddedPackageCli = (assets: HostAssets, version: string) =>
	Layer.succeed(PackageCli, {
		execute: (args) =>
			runAkuapkgWith(args, { name: 'akua pkg', version, assets }).pipe(
				Effect.provide(BunServices.layer),
				Effect.mapError((cause) => new PackageCliFailure({ cause }))
			)
	});

/**
 * `akua pkg` from a source checkout, which has no embedded engines: the
 * `akuapkg` executable from PATH, with the terminal and exit code passed
 * through and presenting itself as `akua pkg`.
 */
export const PackageCliLive = Layer.effect(
	PackageCli,
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		return PackageCli.of({
			execute: (args) =>
				spawner
					.exitCode(
						ChildProcess.make('akuapkg', args, {
							stdin: 'inherit',
							stdout: 'inherit',
							stderr: 'inherit',
							extendEnv: true,
							env: { AKUAPKG_PROGRAM_NAME: 'akua pkg' }
						})
					)
					.pipe(
						Effect.map(Number),
						Effect.mapError((cause) => new PackageCliFailure({ cause }))
					)
		});
	})
);

export type CliPlatform =
	| ChildProcessSpawner.ChildProcessSpawner
	| Crypto.Crypto
	| FileSystem.FileSystem
	| Path.Path
	| Stdio.Stdio;

export function CliLive(
	cliVersion: string,
	packageCli: Layer.Layer<PackageCli, never, CliPlatform> = PackageCliLive
): Layer.Layer<CliServices, never, CliPlatform> {
	return Layer.mergeAll(
		DeviceHttpLive,
		BrowserLive,
		ProcessLive,
		ConsoleLive,
		SecureConfigLive,
		PublicInputLive,
		PublicOutputLive,
		packageCli
	).pipe(Layer.provideMerge(AkuaHttpClientLive(cliVersion)));
}
