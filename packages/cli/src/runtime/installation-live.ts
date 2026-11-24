import { Effect, FileSystem, Layer, Option, Path, PlatformError, Schema, Stream } from 'effect';
import { Digest, SecureRandom } from 'effect/crypto';
import { constant as discardError } from 'effect/Function';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import {
	archiveExtractCommand,
	assertCompiledExecutable,
	bytesToHex
} from '../../scripts/runtime/release-services';
import { Installation, InstallationFailure, type RunningExecutable, UpdateCheck } from './services';

const EXECUTABLE_MODE = 0o755;
const decodeUpdateCheck = Schema.decodeUnknownOption(Schema.fromJsonString(UpdateCheck));

const failure =
	(reason: InstallationFailure['reason'], message: string) =>
	(cause: unknown): InstallationFailure =>
		new InstallationFailure({
			reason:
				reason === 'write' &&
				PlatformError.isPlatformError(cause) &&
				cause.reason._tag === 'PermissionDenied'
					? 'permission'
					: reason,
			message,
			cause
		});

/**
 * `akua` as this host installed it. `host` is the running process's
 * executable, OS, and CPU (`process.execPath`, `process.platform`,
 * `process.arch`); tests pass a temporary executable instead.
 */
export const InstallationLive = (host: {
	readonly execPath: string;
	readonly platform: string;
	readonly arch: string;
}) =>
	Layer.effect(
		Installation,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const digest = yield* Digest.Digest;
			const random = yield* SecureRandom.SecureRandom;

			/** The archive's executable, extracted into `directory` and checked to be one for `target`. */
			const extract = Effect.fnUntraced(function* (
				directory: string,
				input: Parameters<Installation['Service']['replaceExecutable']>[0]
			) {
				const archivePath = path.join(directory, `release.${input.target.archive}`);
				const extracted = path.join(directory, 'release');
				yield* fs.writeFile(archivePath, input.archive);
				yield* fs.makeDirectory(extracted);
				const [command, ...args] = archiveExtractCommand(
					input.target.archive,
					archivePath,
					extracted,
					host.platform
				);
				const code =
					command === undefined
						? 1
						: yield* spawner
								.exitCode(
									ChildProcess.make(command, args, {
										stdin: 'ignore',
										stdout: 'ignore',
										stderr: 'ignore'
									})
								)
								.pipe(
									Effect.map(Number),
									Effect.mapError(failure('archive', `Could not run ${command}.`))
								);
				if (code !== 0) {
					return yield* new InstallationFailure({
						reason: 'archive',
						message: `Could not extract ${input.target.executable} from the release archive.`
					});
				}
				const executable = path.join(extracted, input.target.executable);
				yield* assertCompiledExecutable(input.target, yield* fs.readFile(executable)).pipe(
					Effect.mapError(
						(cause) => new InstallationFailure({ reason: 'archive', message: cause.message, cause })
					)
				);
				yield* fs.chmod(executable, EXECUTABLE_MODE);
				return executable;
			});

			const replaceExecutable: Installation['Service']['replaceExecutable'] = Effect.fn(
				'Installation.replaceExecutable'
			)(function* (input) {
				const actual = bytesToHex(
					yield* digest
						.digest(Digest.sha256, input.archive)
						.pipe(Effect.mapError(failure('checksum', 'Could not hash the release archive.')))
				);
				if (actual !== input.sha256) {
					return yield* new InstallationFailure({
						reason: 'checksum',
						message: `The release archive's SHA-256 is ${actual}, but the release publishes ${input.sha256}.`
					});
				}
				const directory = path.dirname(input.path);
				// Staged beside the executable so the final rename stays on one filesystem.
				const staging = yield* fs
					.makeTempDirectory({ directory, prefix: '.akua-update-' })
					.pipe(Effect.mapError(failure('write', `Cannot write to ${directory}.`)));
				yield* Effect.gen(function* () {
					const executable = yield* extract(staging, input).pipe(
						Effect.mapError((cause) =>
							cause._tag === 'InstallationFailure'
								? cause
								: failure('write', `Cannot write to ${directory}.`)(cause)
						)
					);
					if (host.platform !== 'win32') {
						yield* fs
							.rename(executable, input.path)
							.pipe(Effect.mapError(failure('write', `Cannot replace ${input.path}.`)));
						return;
					}
					// Windows cannot overwrite a running executable, but it can rename one.
					const previous = `${input.path}.old`;
					yield* fs.remove(previous, { force: true }).pipe(Effect.ignore);
					yield* fs
						.rename(input.path, previous)
						.pipe(Effect.mapError(failure('write', `Cannot replace ${input.path}.`)));
					yield* fs.rename(executable, input.path).pipe(
						Effect.tapError(() => fs.rename(previous, input.path).pipe(Effect.ignore)),
						Effect.mapError(failure('write', `Cannot replace ${input.path}.`))
					);
				}).pipe(Effect.ensuring(fs.remove(staging, { recursive: true }).pipe(Effect.ignore)));
			});

			const runPackageManager: Installation['Service']['run'] = (command, onOutput) =>
				Effect.scoped(
					Effect.gen(function* () {
						const [executable, ...args] = command;
						if (onOutput === undefined) {
							return yield* spawner.exitCode(
								ChildProcess.make(executable, args, {
									stdin: 'inherit',
									stdout: 'inherit',
									stderr: 'inherit',
									extendEnv: true
								})
							);
						}
						const handle = yield* spawner.spawn(
							ChildProcess.make(executable, args, { stdin: 'ignore', extendEnv: true })
						);
						yield* handle.all.pipe(Stream.decodeText(), Stream.runForEach(onOutput));
						return yield* handle.exitCode;
					})
				).pipe(
					Effect.map(Number),
					Effect.mapError(failure('run', `Could not run ${command.join(' ')}.`))
				);

			const saveUpdateCheck: Installation['Service']['saveUpdateCheck'] = Effect.fn(
				'Installation.saveUpdateCheck'
			)(function* (file, check) {
				const temporary = `${file}.${yield* random.uuidV4()}.tmp`;
				yield* Effect.gen(function* () {
					yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
					yield* fs.writeFileString(temporary, `${JSON.stringify(check)}\n`, { mode: 0o600 });
					yield* fs.rename(temporary, file);
				}).pipe(
					Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
					Effect.mapError(failure('write', `Cannot write ${file}.`))
				);
			});

			return Installation.of({
				executable: fs.realPath(host.execPath).pipe(
					Effect.map((resolved): RunningExecutable => ({
						path: resolved,
						platform: host.platform,
						arch: host.arch
					})),
					Effect.mapError(failure('locate', `Cannot resolve ${host.execPath}.`))
				),
				replaceExecutable,
				run: runPackageManager,
				readUpdateCheck: (file) =>
					fs.readFileString(file).pipe(
						Effect.map(decodeUpdateCheck),
						// A missing or damaged check only means the next run checks again.
						Effect.catch(discardError(Effect.succeed(Option.none())))
					),
				saveUpdateCheck
			});
		})
	);
