import { describe, expect, it } from '@effect/vitest';
import { BunServices } from '@effect/platform-bun';
import { Config, Effect, FileSystem, Layer, Option, Path } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { makeReleaseHostLive } from '../scripts/runtime/release-host-live';
import {
	admitNativeSmokeArchive,
	artifactName,
	makeReleaseProvenance,
	RELEASE_TARGETS,
	ReleaseHost
} from '../scripts/runtime/release-services';

const TEST_SOURCE_SHA = '0123456789abcdef0123456789abcdef01234567';

describe('release provenance contract', () => {
	it.effect('binds the cnap source and the bundled akuapkg version', () =>
		Effect.gen(function* () {
			const provenance = yield* makeReleaseProvenance({
				sourceSha: '0123456789abcdef0123456789abcdef01234567',
				packageVersion: '0.9.6'
			});

			expect(provenance).toEqual({
				source: {
					repository: 'akua-dev/cnap',
					sha: '0123456789abcdef0123456789abcdef01234567',
					subtree: 'oss/akua/packages/cli'
				},
				dependencies: [{ name: 'akuapkg', version: '0.9.6' }]
			});
		})
	);

	it.effect('rejects malformed source and dependency identities', () =>
		Effect.gen(function* () {
			const malformedSource = yield* Effect.exit(
				makeReleaseProvenance({ sourceSha: 'main', packageVersion: '0.9.6' })
			);
			const malformedVersion = yield* Effect.exit(
				makeReleaseProvenance({ sourceSha: '0'.repeat(40), packageVersion: 'latest' })
			);

			expect(malformedSource._tag).toBe('Failure');
			expect(malformedVersion._tag).toBe('Failure');
		})
	);
});

describe('native smoke archive admission', () => {
	it.effect('admits only the expected bytes on the actual native target', () =>
		Effect.gen(function* () {
			expect(
				yield* admitNativeSmokeArchive({
					targetId: 'linux-x64',
					hostTargetId: 'linux-x64',
					archiveSha256: 'a'.repeat(64),
					actualSha256: Effect.succeed('a'.repeat(64))
				})
			).toBeUndefined();
		})
	);
	it.effect('refuses altered bytes and malformed expected digests', () =>
		Effect.gen(function* () {
			for (const archiveSha256 of ['b'.repeat(64), 'not-a-digest']) {
				const result = yield* Effect.exit(
					admitNativeSmokeArchive({
						targetId: 'linux-x64',
						hostTargetId: 'linux-x64',
						archiveSha256,
						actualSha256: Effect.succeed('a'.repeat(64))
					})
				);
				expect(result._tag).toBe('Failure');
			}
		})
	);
	it.effect('refuses a foreign OS or architecture even with matching bytes', () =>
		Effect.gen(function* () {
			for (const hostTargetId of ['linux-arm64', 'darwin-x64']) {
				const result = yield* Effect.exit(
					admitNativeSmokeArchive({
						targetId: 'linux-x64',
						hostTargetId,
						archiveSha256: 'a'.repeat(64),
						actualSha256: Effect.succeed('a'.repeat(64))
					})
				);
				expect(result._tag).toBe('Failure');
			}
		})
	);
});

it.live('archives each target with the akua executable alone', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const host = yield* ReleaseHost;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const releaseRoot = path.join(process.cwd(), 'dist/release');
		yield* fs.makeDirectory(releaseRoot, { recursive: true });
		const root = yield* fs.makeTempDirectoryScoped({ directory: releaseRoot });
		const executable = path.join(root, 'executable');
		yield* fs.writeFileString(executable, 'compiled-cli-fixture');
		const zipper = yield* Config.option(Config.String('PLATFORM_CLI_TEST_ZIPPER'));
		const zipperPath = Option.isSome(zipper) ? path.resolve(zipper.value) : undefined;
		for (const target of RELEASE_TARGETS) {
			const outputDir = path.join(root, target.id);
			yield* host.packageExistingExecutables({
				version: '1.2.3',
				outputDir,
				binaries: { [target.id]: executable },
				packageVersion: '0.9.6',
				sourceSha: TEST_SOURCE_SHA,
				targetId: target.id,
				zipperPath
			});
			const extracted = path.join(root, `extracted-${target.id}`);
			yield* fs.makeDirectory(extracted);
			const archive = path.join(outputDir, artifactName('1.2.3', target));
			const command =
				target.archive === 'zip'
					? zipperPath
						? ChildProcess.make(zipperPath, ['x', archive], { cwd: extracted })
						: ChildProcess.make('unzip', ['-q', archive, '-d', extracted])
					: ChildProcess.make('tar', ['-xzf', archive, '-C', extracted]);
			expect(Number(yield* spawner.exitCode(command))).toBe(0);
			expect(yield* fs.readDirectory(extracted)).toEqual([target.executable]);
			const asset = JSON.parse(yield* fs.readFileString(path.join(outputDir, 'asset.json')));
			expect(asset.contents).toEqual([target.executable]);
		}
	}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, makeReleaseHostLive())))
);
