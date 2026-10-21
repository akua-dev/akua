import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Effect, FileSystem, Layer, Path, Schema } from 'effect';

import { ReleaseHost, RELEASE_TARGETS } from '../packages/cli/scripts/runtime/release-services';
import { makeReleaseHostLive } from '../packages/cli/scripts/runtime/release-host-live';

class CliReleasePackageFailure extends Schema.TaggedError<CliReleasePackageFailure>()(
	'CliReleasePackageFailure',
	{ message: Schema.String }
) {}

const fail = (message: string) => new CliReleasePackageFailure({ message });

const UNSTAMPED = '-';
const UNSTAMPED_SOURCE_SHA = '0'.repeat(40);

const PackageManifest = Schema.Struct({ version: Schema.String });
const decodePackageManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest));

const readSourceSha = Effect.fn('cliReleasePackage.readSourceSha')(function* (status: string) {
	const lines = status.split(/\r?\n/u).filter((line) => line.startsWith('STABLE_SOURCE_SHA '));
	const line = lines[0];
	if (line === undefined || lines.length !== 1) {
		return yield* fail('Bazel status must name one checkout source SHA');
	}
	const sourceSha = line.slice('STABLE_SOURCE_SHA '.length);
	if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
		return yield* fail('Bazel checkout source SHA is invalid');
	}
	return sourceSha;
});

const parseBinaries = Effect.fn('cliReleasePackage.parseBinaries')(function* (
	entries: ReadonlyArray<string>,
	expected: ReadonlyArray<string>
) {
	const binaries: Record<string, string> = {};
	for (const entry of entries) {
		const separator = entry.indexOf('=');
		if (separator <= 0 || separator === entry.length - 1) {
			return yield* fail(`Invalid release binary coordinate: ${entry}`);
		}
		const target = entry.slice(0, separator);
		if (binaries[target] !== undefined) {
			return yield* fail(`Duplicate release binary target: ${target}`);
		}
		binaries[target] = entry.slice(separator + 1);
	}
	const actual = Object.keys(binaries).sort();
	if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
		return yield* fail(`Release coordinates must be exactly: ${expected.join(', ')}`);
	}
	return binaries;
});

const program = Effect.scoped(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const [mode, packageJsonPath, statusPath, outputDir, packageVersion, zipperPath, ...entries] =
			Bun.argv.slice(2);
		if (
			(mode !== 'target' && mode !== 'assemble') ||
			packageJsonPath === undefined ||
			statusPath === undefined ||
			outputDir === undefined ||
			packageVersion === undefined ||
			zipperPath === undefined
		) {
			return yield* fail(
				'Expected mode, package.json, stable status, output, akuapkg version, zipper, and coordinates'
			);
		}
		const packageManifest = yield* fs.readFileString(packageJsonPath).pipe(
			Effect.flatMap(decodePackageManifest),
			Effect.mapError(() => fail('Invalid CLI package.json'))
		);
		// One version for akua-dev/akua: the CLI releases on the version of the
		// package toolchain it embeds (Cargo.toml's workspace version).
		if (packageManifest.version !== packageVersion) {
			return yield* fail(
				`packages/cli/package.json version ${packageManifest.version} differs from the embedded akuapkg ${packageVersion}`
			);
		}
		// `-`: an unstamped build (no `--stamp`), whose provenance names no commit.
		const sourceSha =
			statusPath === UNSTAMPED
				? UNSTAMPED_SOURCE_SHA
				: yield* fs.readFileString(statusPath).pipe(
						Effect.flatMap(readSourceSha),
						Effect.mapError(() => fail('Invalid Bazel stable status'))
					);
		const targetIds = RELEASE_TARGETS.map((target) => target.id);
		const targetId = mode === 'target' ? entries[0]?.split('=', 1)[0] : undefined;
		const selectedTarget = RELEASE_TARGETS.find((target) => target.id === targetId);
		if (mode === 'target' && !selectedTarget) {
			return yield* fail(`Unknown release target: ${targetId}`);
		}
		const coordinates = yield* parseBinaries(
			entries,
			selectedTarget ? [selectedTarget.id] : targetIds
		);
		const stagingDir = path.join(process.cwd(), 'dist', 'release', `bazel-${sourceSha}`);
		const packageArchives = Effect.gen(function* () {
			const host = yield* ReleaseHost;
			if (mode === 'target' && selectedTarget) {
				yield* host.packageExistingExecutables({
					version: packageManifest.version,
					outputDir: stagingDir,
					binaries: coordinates,
					packageVersion,
					sourceSha,
					targetId: selectedTarget.id,
					zipperPath
				});
			} else {
				yield* host.assembleReleasePackages({
					version: packageManifest.version,
					outputDir: stagingDir,
					packageVersion,
					sourceSha,
					parts: coordinates,
					zipperPath
				});
			}
			yield* fs.remove(outputDir, { recursive: true, force: true });
			yield* fs.copy(stagingDir, outputDir);
		});
		yield* packageArchives.pipe(
			Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore))
		);
	})
).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, makeReleaseHostLive())));

BunRuntime.runMain(program);
