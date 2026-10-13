import { describe, expect, it, test } from '@effect/vitest';
// Temp-directory fixtures for the release pipeline go through ./fs-test
// (Effect FileSystem + BunServices) so this suite stays off node:builtins.
import {
	chmodPath,
	copyFilePath,
	joinPath,
	mkdirp,
	mkdtempPath,
	parsePath,
	readFileString,
	removePath,
	statMode,
	symlinkPath,
	writeFileString
} from './fs-test';
import { BunServices } from '@effect/platform-bun';
import { Config, Console, Crypto, Effect, FileSystem, Layer, Option, Path, Stream } from 'effect';
import { Command } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import * as release from '../scripts/release';
import packageJson from '../package.json';
import { RELEASE_TARGETS, releaseCommand } from '../scripts/release';
import { bytesToHex, ReleaseFailure, ReleaseHost } from '../scripts/runtime/release-services';
import { makeReleaseHostLive } from '../scripts/runtime/release-host-live';
import { cliTestLayer } from './cli-test-layer';

const TEST_SOURCE_SHA = '0123456789abcdef0123456789abcdef01234567';

function runRelease<A, E>(program: Effect.Effect<A, E, ReleaseHost>): Promise<A> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const zipper = yield* Config.option(Config.String('PLATFORM_CLI_TEST_ZIPPER'));
			const zipperPath = Option.getOrUndefined(zipper);
			return yield* Effect.gen(function* () {
				const host = yield* ReleaseHost;
				return yield* Effect.provideService(program, ReleaseHost, {
					...host,
					packageExistingExecutables: (input) =>
						host.packageExistingExecutables({ ...input, zipperPath })
				});
			}).pipe(Effect.provide(makeReleaseHostLive(zipperPath)));
		})
	);
}

// Shared runner for the handful of independent-oracle/verification host
// calls below that do have a real Effect equivalent (crypto digest,
// subprocess spawn, file existence).
function runNode<A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> {
	return Effect.runPromise(Effect.provide(effect, BunServices.layer));
}

function sha256Oracle(bytes: Uint8Array): Promise<string> {
	return runNode(
		Effect.gen(function* () {
			const crypto = yield* Crypto.Crypto;
			const digest = yield* crypto.digest('SHA-256', bytes);
			return bytesToHex(digest);
		})
	);
}

function fileExists(path: string): Promise<boolean> {
	return runNode(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path)));
}

function extractTarSync(archivePath: string, extractDir: string): Promise<{ status: number }> {
	return runNode(
		Effect.scoped(
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				const handle = yield* spawner.spawn(
					ChildProcess.make('tar', ['-xzf', archivePath, '-C', extractDir])
				);
				const exitCode = yield* handle.exitCode;
				return { status: exitCode };
			})
		)
	);
}

async function makeReleaseTempDir(): Promise<string> {
	const releaseRoot = joinPath(process.cwd(), 'dist', 'release');
	await mkdirp(releaseRoot);
	return await mkdtempPath('.tmp-akua-release-', releaseRoot);
}

test('release packaging has a dedicated implementation module', async () => {
	expect(await fileExists('scripts/release.ts')).toBe(true);
});

describe('release target contract', () => {
	it.effect('renders the release matrix as JSON through the matrix subcommand', () =>
		Effect.gen(function* () {
			const stdout: string[] = [];
			const testConsole = Object.assign(Object.create(console), {
				log: (value: string) => stdout.push(value)
			}) as Console.Console;

			yield* Command.runWith(releaseCommand, { version: 'test' })(['matrix']).pipe(
				Effect.provide(Layer.mergeAll(cliTestLayer, makeReleaseHostLive())),
				Effect.provideService(Console.Console, testConsole)
			);

			expect(JSON.parse(stdout.join('\n'))).toEqual({
				include: RELEASE_TARGETS.map((target) => ({
					target: target.id,
					runner: target.runner
				}))
			});
		})
	);

	it.effect('public release operations preserve the injected host failure', () =>
		Effect.gen(function* () {
			const program: Effect.Effect<void, Error, ReleaseHost> =
				release.assertSafeOutputDirectory('/virtual/output');
			const failure = yield* program.pipe(
				Effect.provideService(ReleaseHost, {
					sha256: () => Effect.die('unused'),
					hostTargetId: Effect.die('unused'),
					planUploads: () => Effect.die('unused'),
					assertSafeOutputDirectory: (output) =>
						Effect.fail(new ReleaseFailure({ message: `injected host: ${output}` })),
					packageExistingExecutables: () => Effect.die('unused'),
					assembleReleasePackages: () => Effect.die('unused'),
					packageRelease: () => Effect.die('unused'),
					smokeReleaseArtifact: () => Effect.die('unused'),
					verifyReleaseDirectory: () => Effect.die('unused')
				}),
				Effect.flip
			);
			expect(failure.message).toBe('injected host: /virtual/output');
		})
	);

	test('exposes local package, verify, and smoke tasks without publishing a package', async () => {
		const packageJson = JSON.parse(await readFileString('package.json'));

		expect(packageJson.scripts['release:package']).toContain('scripts/release.ts package');
		expect(packageJson.scripts['release:verify']).toContain('scripts/release.ts verify');
		expect(packageJson.scripts['release:smoke']).toContain('scripts/release.ts smoke');
		expect(JSON.stringify(packageJson.scripts)).not.toContain('publish');
	});

	test('defines the five tested Bun targets in stable order', async () => {
		expect(release.RELEASE_TARGETS).toEqual([
			{
				id: 'darwin-arm64',
				bunTarget: 'bun-darwin-arm64',
				os: 'darwin',
				arch: 'arm64',
				archive: 'tar.gz',
				executable: 'akua',
				runner: 'macos-15',
				homebrew: { os: 'macos', arch: 'arm' }
			},
			{
				id: 'darwin-x64',
				bunTarget: 'bun-darwin-x64',
				os: 'darwin',
				arch: 'x64',
				archive: 'tar.gz',
				executable: 'akua',
				runner: 'macos-15-intel',
				homebrew: { os: 'macos', arch: 'intel' }
			},
			{
				id: 'linux-arm64',
				bunTarget: 'bun-linux-arm64',
				os: 'linux',
				arch: 'arm64',
				archive: 'tar.gz',
				executable: 'akua',
				runner: 'ubuntu-24.04-arm',
				homebrew: { os: 'linux', arch: 'arm' }
			},
			{
				id: 'linux-x64',
				bunTarget: 'bun-linux-x64-baseline',
				os: 'linux',
				arch: 'x64',
				archive: 'tar.gz',
				executable: 'akua',
				runner: 'ubuntu-24.04',
				homebrew: { os: 'linux', arch: 'intel' }
			},
			{
				id: 'windows-x64',
				bunTarget: 'bun-windows-x64-baseline',
				os: 'windows',
				arch: 'x64',
				archive: 'zip',
				executable: 'akua.exe',
				runner: 'windows-2025'
			}
		]);
	});

	test('derives the GitHub Actions matrix from the release target contract', async () => {
		const releaseMatrix = release.releaseMatrix as () => {
			include: Array<{ target: string; runner: string }>;
		};

		expect(releaseMatrix()).toEqual({
			include: [
				{ target: 'darwin-arm64', runner: 'macos-15' },
				{ target: 'darwin-x64', runner: 'macos-15-intel' },
				{ target: 'linux-arm64', runner: 'ubuntu-24.04-arm' },
				{ target: 'linux-x64', runner: 'ubuntu-24.04' },
				{ target: 'windows-x64', runner: 'windows-2025' }
			]
		});
	});

	test('derives versioned archive and checksum names', async () => {
		const targets = release.RELEASE_TARGETS;
		const artifactName = release.artifactName as (
			version: string,
			target: { id: string; archive: string }
		) => string;

		expect(targets.map((target) => artifactName('1.2.3', target))).toEqual([
			'akua-v1.2.3-darwin-arm64.tar.gz',
			'akua-v1.2.3-darwin-x64.tar.gz',
			'akua-v1.2.3-linux-arm64.tar.gz',
			'akua-v1.2.3-linux-x64.tar.gz',
			'akua-v1.2.3-windows-x64.zip'
		]);
	});

	test('renders standard SHA-256 checksum lines', async () => {
		const sha256 = release.sha256;
		const checksumLine = release.checksumLine;
		const bytes = new TextEncoder().encode('akua\n');
		const digest = await sha256Oracle(bytes);

		expect(await runRelease(sha256(bytes))).toBe(digest);
		expect(checksumLine('akua-v1.2.3-linux-x64.tar.gz', digest)).toBe(
			`${digest}  akua-v1.2.3-linux-x64.tar.gz\n`
		);
	});

	test('rejects zero-filled compiled outputs before release packaging', async () => {
		const assertCompiledExecutable = release.assertCompiledExecutable as (
			target: { id: string; os: 'darwin' | 'linux' | 'windows' },
			bytes: Uint8Array
		) => Effect.Effect<void, Error>;

		expect(() =>
			Effect.runSync(assertCompiledExecutable({ id: 'linux-x64', os: 'linux' }, new Uint8Array(64)))
		).toThrow('invalid linux header');
		expect(() =>
			Effect.runSync(
				assertCompiledExecutable(
					{ id: 'linux-x64', os: 'linux' },
					new Uint8Array([0x7f, 0x45, 0x4c, 0x46])
				)
			)
		).not.toThrow();
	});

	test('plans uploads for only release assets missing from an identical existing subset', async () => {
		expect(typeof release.planReleaseUploads).toBe('function');
		if (typeof release.planReleaseUploads !== 'function') {
			return;
		}
		const planReleaseUploads = release.planReleaseUploads as (
			candidateDir: string,
			existingDir: string,
			version: string
		) => Effect.Effect<string[], Error>;
		const releaseAssetNames = release.releaseAssetNames as (
			version: string
		) => Effect.Effect<string[], Error>;
		const root = await makeReleaseTempDir();

		try {
			const candidateDir = joinPath(root, 'candidate');
			const existingDir = joinPath(root, 'existing');
			const assetNames = Effect.runSync(releaseAssetNames('1.2.3'));
			await mkdirp(candidateDir);
			await mkdirp(existingDir);
			for (const name of assetNames) {
				await writeFileString(joinPath(candidateDir, name), `candidate ${name}\n`);
			}
			await copyFilePath(
				joinPath(candidateDir, assetNames[0]),
				joinPath(existingDir, assetNames[0])
			);
			await copyFilePath(
				joinPath(candidateDir, assetNames[4]),
				joinPath(existingDir, assetNames[4])
			);

			expect(await runRelease(planReleaseUploads(candidateDir, existingDir, '1.2.3'))).toEqual(
				assetNames
					.filter((_, index) => index !== 0 && index !== 4)
					.map((name) => joinPath(candidateDir, name))
			);
		} finally {
			await removePath(root, { recursive: true, force: true });
		}
	});

	test('rejects an existing release asset that differs from the candidate', async () => {
		expect(typeof release.planReleaseUploads).toBe('function');
		if (typeof release.planReleaseUploads !== 'function') {
			return;
		}
		const planReleaseUploads = release.planReleaseUploads as (
			candidateDir: string,
			existingDir: string,
			version: string
		) => Effect.Effect<string[], Error>;
		const releaseAssetNames = release.releaseAssetNames as (
			version: string
		) => Effect.Effect<string[], Error>;
		const root = await makeReleaseTempDir();

		try {
			const candidateDir = joinPath(root, 'candidate');
			const existingDir = joinPath(root, 'existing');
			const assetNames = Effect.runSync(releaseAssetNames('1.2.3'));
			await mkdirp(candidateDir);
			await mkdirp(existingDir);
			for (const name of assetNames) {
				await writeFileString(joinPath(candidateDir, name), `candidate ${name}\n`);
			}
			await writeFileString(joinPath(existingDir, assetNames[0]), 'different bytes\n');

			await expect(
				runRelease(planReleaseUploads(candidateDir, existingDir, '1.2.3'))
			).rejects.toThrow(`Existing release asset does not match candidate: ${assetNames[0]}`);
		} finally {
			await removePath(root, { recursive: true, force: true });
		}
	});

	test('packages each akua executable alone with its provenance', async () => {
		const targets = release.RELEASE_TARGETS;
		const packageExistingExecutables = release.packageExistingExecutables as (input: {
			version: string;
			outputDir: string;
			binaries: Record<string, string>;
			packageVersion: string;
			sourceSha: string;
		}) => Effect.Effect<void, Error>;
		const verifyReleaseDirectory = release.verifyReleaseDirectory as (
			outputDir: string,
			version: string
		) => Effect.Effect<void, Error>;
		const root = await makeReleaseTempDir();

		try {
			const source = joinPath(root, 'akua-fixture');
			const outputDir = joinPath(root, 'release');
			await writeFileString(source, '#!/bin/sh\necho akua fixture\n');
			await chmodPath(source, 0o755);
			await runRelease(
				packageExistingExecutables({
					version: '1.2.3',
					outputDir,
					binaries: Object.fromEntries(targets.map((target) => [target.id, source])),
					packageVersion: '0.9.6',
					sourceSha: TEST_SOURCE_SHA
				})
			);

			expect(await runRelease(verifyReleaseDirectory(outputDir, '1.2.3'))).toBeUndefined();
			const manifest = JSON.parse(
				await readFileString(joinPath(outputDir, 'akua-v1.2.3-manifest.json'))
			);
			expect(manifest).toMatchObject({
				schema_version: 1,
				executable: 'akua',
				version: '1.2.3',
				checksums: 'akua-v1.2.3-checksums.txt',
				homebrew_manifest: 'akua-v1.2.3-homebrew.json',
				source: {
					repository: 'akua-dev/cnap',
					sha: TEST_SOURCE_SHA,
					subtree: 'oss/akua/cli'
				},
				dependencies: [{ name: 'akuapkg', version: '0.9.6' }]
			});
			expect(manifest.assets).toHaveLength(5);
			expect(manifest.assets.map((asset: { target: string }) => asset.target)).toEqual(
				targets.map((target) => target.id)
			);

			const homebrew = JSON.parse(
				await readFileString(joinPath(outputDir, 'akua-v1.2.3-homebrew.json'))
			);
			expect(homebrew).toMatchObject({
				schema_version: 1,
				formula: 'akua',
				version: '1.2.3',
				release: 'https://github.com/akua-dev/akua/releases/tag/v1.2.3'
			});
			expect(Object.keys(homebrew.platforms)).toEqual([
				'macos_arm',
				'macos_intel',
				'linux_arm',
				'linux_intel'
			]);
			expect(homebrew.platforms.linux_intel.url).toBe(
				'https://github.com/akua-dev/akua/releases/download/v1.2.3/akua-v1.2.3-linux-x64.tar.gz'
			);

			const extractDir = joinPath(root, 'extract');
			await mkdirp(extractDir);
			const extract = await extractTarSync(
				joinPath(outputDir, 'akua-v1.2.3-linux-x64.tar.gz'),
				extractDir
			);
			expect(extract.status).toBe(0);
			expect((await statMode(joinPath(extractDir, 'akua'))) & 0o777).toBe(0o755);
			expect(await readFileString(joinPath(extractDir, 'akua'))).toEqual(
				await readFileString(source)
			);
		} finally {
			await removePath(root, { recursive: true, force: true });
		}
	});

	test('packages byte-identical release assets across repeated builds', async () => {
		const targets = release.RELEASE_TARGETS;
		const releaseAssetNames = release.releaseAssetNames as (
			version: string
		) => Effect.Effect<string[], Error>;
		const packageExistingExecutables = release.packageExistingExecutables as (input: {
			version: string;
			outputDir: string;
			binaries: Record<string, string>;
			packageVersion: string;
			sourceSha: string;
		}) => Effect.Effect<void, Error>;
		const root = await makeReleaseTempDir();

		try {
			const source = joinPath(root, 'akua-fixture');
			const firstOutputDir = joinPath(root, 'first');
			const secondOutputDir = joinPath(root, 'second');
			const binaries = Object.fromEntries(targets.map((target) => [target.id, source]));
			await writeFileString(source, '#!/bin/sh\necho akua fixture\n');
			await chmodPath(source, 0o755);

			await runRelease(
				packageExistingExecutables({
					version: '1.2.3',
					outputDir: firstOutputDir,
					binaries,
					packageVersion: '0.9.6',
					sourceSha: TEST_SOURCE_SHA
				})
			);
			await Effect.runPromise(Effect.sleep('2100 millis'));
			await runRelease(
				packageExistingExecutables({
					version: '1.2.3',
					outputDir: secondOutputDir,
					binaries,
					packageVersion: '0.9.6',
					sourceSha: TEST_SOURCE_SHA
				})
			);

			for (const name of Effect.runSync(releaseAssetNames('1.2.3'))) {
				const [first, second] = await Promise.all([
					readFileString(joinPath(firstOutputDir, name)),
					readFileString(joinPath(secondOutputDir, name))
				]);
				if (second !== first) {
					throw new Error(`Repeated release packaging changed ${name}`);
				}
			}
		} finally {
			await removePath(root, { recursive: true, force: true });
		}
	});

	test('verification rejects an archive changed after checksumming', async () => {
		const targets = release.RELEASE_TARGETS;
		const packageExistingExecutables = release.packageExistingExecutables as (input: {
			version: string;
			outputDir: string;
			binaries: Record<string, string>;
			packageVersion: string;
			sourceSha: string;
		}) => Effect.Effect<void, Error>;
		const verifyReleaseDirectory = release.verifyReleaseDirectory as (
			outputDir: string,
			version: string
		) => Effect.Effect<void, Error>;
		const root = await makeReleaseTempDir();

		try {
			const source = joinPath(root, 'akua-fixture');
			const outputDir = joinPath(root, 'release');
			await writeFileString(source, '#!/bin/sh\necho akua fixture\n');
			await chmodPath(source, 0o755);
			await runRelease(
				packageExistingExecutables({
					version: '1.2.3',
					outputDir,
					binaries: Object.fromEntries(targets.map((target) => [target.id, source])),
					packageVersion: '0.9.6',
					sourceSha: TEST_SOURCE_SHA
				})
			);
			await writeFileString(joinPath(outputDir, 'akua-v1.2.3-linux-x64.tar.gz'), 'tampered');

			await expect(runRelease(verifyReleaseDirectory(outputDir, '1.2.3'))).rejects.toThrow(
				'checksum mismatch'
			);
		} finally {
			await removePath(root, { recursive: true, force: true });
		}
	});

	test('rejects release output directories that could erase the checkout or filesystem root', async () => {
		const assertSafeOutputDirectory = release.assertSafeOutputDirectory as (
			outputDir: string
		) => Effect.Effect<void, Error>;

		await expect(runRelease(assertSafeOutputDirectory(process.cwd()))).rejects.toThrow(
			'Unsafe release output directory'
		);
		await expect(
			runRelease(assertSafeOutputDirectory(parsePath(process.cwd()).root))
		).rejects.toThrow('Unsafe release output directory');
		await expect(
			runRelease(assertSafeOutputDirectory(joinPath(process.cwd(), 'src')))
		).rejects.toThrow('Unsafe release output directory');
		await expect(
			runRelease(assertSafeOutputDirectory(joinPath(process.cwd(), 'docs')))
		).rejects.toThrow('Unsafe release output directory');
		await expect(
			runRelease(assertSafeOutputDirectory(joinPath(process.cwd(), 'dist', 'js')))
		).rejects.toThrow('Unsafe release output directory');
		expect(
			await runRelease(assertSafeOutputDirectory(joinPath(process.cwd(), 'dist', 'release')))
		).toBeUndefined();
	});

	test('rejects release output paths beneath a symlinked ancestor', async () => {
		const assertSafeOutputDirectory = release.assertSafeOutputDirectory as (
			outputDir: string
		) => Effect.Effect<void, Error>;
		const root = await makeReleaseTempDir();
		const target = await mkdtempPath('.tmp-akua-release-target-');
		const linkedDirectory = joinPath(root, 'linked-output');

		try {
			await symlinkPath(target, linkedDirectory);
			await expect(
				runRelease(assertSafeOutputDirectory(joinPath(linkedDirectory, 'release')))
			).rejects.toThrow('symlink');
		} finally {
			await removePath(root, { recursive: true, force: true });
			await removePath(target, { recursive: true, force: true });
		}
	});

	test('verification rejects a Homebrew manifest that does not match verified assets', async () => {
		const targets = release.RELEASE_TARGETS;
		const packageExistingExecutables = release.packageExistingExecutables as (input: {
			version: string;
			outputDir: string;
			binaries: Record<string, string>;
			packageVersion: string;
			sourceSha: string;
		}) => Effect.Effect<void, Error>;
		const verifyReleaseDirectory = release.verifyReleaseDirectory as (
			outputDir: string,
			version: string
		) => Effect.Effect<void, Error>;
		const root = await makeReleaseTempDir();

		try {
			const source = joinPath(root, 'akua-fixture');
			const outputDir = joinPath(root, 'release');
			await writeFileString(source, '#!/bin/sh\necho akua fixture\n');
			await chmodPath(source, 0o755);
			await runRelease(
				packageExistingExecutables({
					version: '1.2.3',
					outputDir,
					binaries: Object.fromEntries(targets.map((target) => [target.id, source])),
					packageVersion: '0.9.6',
					sourceSha: TEST_SOURCE_SHA
				})
			);
			const manifestPath = joinPath(outputDir, 'akua-v1.2.3-homebrew.json');
			const homebrew = JSON.parse(await readFileString(manifestPath));
			homebrew.platforms.linux_intel.sha256 = '0'.repeat(64);
			await writeFileString(manifestPath, `${JSON.stringify(homebrew, null, 2)}\n`);

			await expect(runRelease(verifyReleaseDirectory(outputDir, '1.2.3'))).rejects.toThrow(
				'Homebrew manifest mismatch'
			);
		} finally {
			await removePath(root, { recursive: true, force: true });
		}
	});

	test('maps supported native hosts to release target IDs', async () => {
		const releaseTargetIdForHost = release.releaseTargetIdForHost as (
			platform: string,
			arch: string
		) => Effect.Effect<string, Error>;

		expect(Effect.runSync(releaseTargetIdForHost('darwin', 'arm64'))).toBe('darwin-arm64');
		expect(Effect.runSync(releaseTargetIdForHost('darwin', 'x64'))).toBe('darwin-x64');
		expect(Effect.runSync(releaseTargetIdForHost('linux', 'arm64'))).toBe('linux-arm64');
		expect(Effect.runSync(releaseTargetIdForHost('linux', 'x64'))).toBe('linux-x64');
		expect(Effect.runSync(releaseTargetIdForHost('win32', 'x64'))).toBe('windows-x64');
		expect(() => Effect.runSync(releaseTargetIdForHost('win32', 'arm64'))).toThrow(
			'Unsupported release host'
		);
	});

	test('extracts Windows zip archives with native PowerShell', async () => {
		const archiveExtractCommand = release.archiveExtractCommand as (
			archive: 'tar.gz' | 'zip',
			archivePath: string,
			installRoot: string,
			platform: NodeJS.Platform
		) => string[];

		expect(
			archiveExtractCommand('zip', "D:\\a\\Robin's build\\akua.zip", 'C:\\install dir', 'win32')
		).toEqual([
			'powershell.exe',
			'-NoLogo',
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			"Expand-Archive -LiteralPath 'D:\\a\\Robin''s build\\akua.zip' -DestinationPath 'C:\\install dir'"
		]);
	});

	it.effect('forwards the expected digest through the package smoke task', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const root = yield* fs.makeTempDirectoryScoped();
			const source = yield* path.fromFileUrl(new URL('..', import.meta.url));
			yield* fs.writeFileString(path.join(root, 'package.json'), JSON.stringify(packageJson));
			yield* fs.symlink(path.join(source, 'scripts'), path.join(root, 'scripts'));
			const output = path.join(root, 'dist', 'release');
			yield* fs.makeDirectory(output, { recursive: true });
			const host = yield* release.hostTargetId();
			const target = RELEASE_TARGETS.find((candidate) => candidate.id === host);
			if (target === undefined) return yield* Effect.die('Missing native release target');
			yield* fs.writeFileString(
				path.join(output, release.artifactName(packageJson.version, target)),
				'not an archive: the task must reject this digest before extraction'
			);
			const child = yield* spawner.spawn(
				ChildProcess.make('bun', ['run', 'release:smoke'], {
					cwd: root,
					detached: false,
					extendEnv: true,
					env: { CLI_RELEASE_ARCHIVE_SHA256: '0'.repeat(64) }
				})
			);
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					child.stdout.pipe(Stream.decodeText(), Stream.mkString),
					child.stderr.pipe(Stream.decodeText(), Stream.mkString),
					child.exitCode
				],
				{ concurrency: 'unbounded' }
			);
			expect(exitCode).not.toBe(0);
			expect(stdout + stderr).toContain('Release smoke archive checksum mismatch');
		}).pipe(Effect.scoped, Effect.provide(makeReleaseHostLive()), Effect.provide(BunServices.layer))
	);

	it.effect('rejects the wrong archive digest before extraction or execution', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const root = yield* fs.makeTempDirectoryScoped();
			const targetId = yield* release.hostTargetId();
			const target = RELEASE_TARGETS.find((candidate) => candidate.id === targetId);
			expect(target).toBeDefined();
			if (target === undefined) return yield* Effect.die('Missing native release target');
			const archivePath = joinPath(root, release.artifactName('1.2.3', target));
			yield* fs.writeFileString(archivePath, 'not an archive: must never be extracted');
			const failure = yield* release
				.smokeReleaseArtifact({
					version: '1.2.3',
					outputDir: root,
					targetId,
					archiveSha256: '0'.repeat(64)
				})
				.pipe(Effect.flip);
			expect(failure.message).toBe('Release smoke archive checksum mismatch');
		}).pipe(Effect.scoped, Effect.provide(makeReleaseHostLive()), Effect.provide(BunServices.layer))
	);

	it.effect('rejects a foreign native target before reading its archive', () =>
		Effect.gen(function* () {
			const host = yield* release.hostTargetId();
			const foreign = host === 'windows-x64' ? 'linux-x64' : 'windows-x64';
			const failure = yield* release
				.smokeReleaseArtifact({
					version: '1.2.3',
					outputDir: '/does-not-exist',
					targetId: foreign,
					archiveSha256: '0'.repeat(64)
				})
				.pipe(Effect.flip);
			expect(failure.message).toBe(
				`Release smoke target ${foreign} does not match native host ${host}`
			);
		}).pipe(Effect.provide(makeReleaseHostLive()))
	);

	test('extracts and executes all install-smoke commands for the native artifact', async () => {
		const targets = release.RELEASE_TARGETS;
		const hostTargetId = release.hostTargetId as () => Effect.Effect<string, Error, ReleaseHost>;
		const packageExistingExecutables = release.packageExistingExecutables as (input: {
			version: string;
			outputDir: string;
			binaries: Record<string, string>;
			packageVersion: string;
			sourceSha: string;
		}) => Effect.Effect<void, Error>;
		const smokeReleaseArtifact = release.smokeReleaseArtifact as (input: {
			version: string;
			outputDir: string;
			targetId: string;
			archiveSha256: string;
		}) => Effect.Effect<void, Error>;
		const root = await makeReleaseTempDir();

		try {
			const source = joinPath(root, 'akua-fixture');
			const outputDir = joinPath(root, 'release');
			const smokeLog = joinPath(root, 'smoke.log');
			await writeFileString(
				source,
				`#!/bin/sh\nprintf '%s\\n' "$*" >> '${smokeLog}'\ncase "$1" in\n  --version) echo '{"status":"ok","data":{"version":"1.2.3"}}' ;;\n  --help) echo 'Usage: akua' ;;\n  commands) echo 'commands[1]' ;;\n  pkg)\n    case "$2" in\n      version) echo '{"version":"0.8.26"}' ;;\n      init) mkdir -p \"$3\"; echo fixture > \"$3/inputs.example.yaml\"; echo '{}' ;;\n      check|inspect) test -f inputs.example.yaml || exit 2; echo '{}' ;;\n      render) test -f inputs.example.yaml || exit 2; mkdir -p deploy; echo manifest > deploy/manifest.yaml; echo '{}' ;;\n      *) exit 2 ;;\n    esac\n    ;;\n  *) exit 2 ;;\nesac\n`
			);
			await chmodPath(source, 0o755);
			await runRelease(
				packageExistingExecutables({
					version: '1.2.3',
					outputDir,
					binaries: Object.fromEntries(targets.map((target) => [target.id, source])),
					packageVersion: '0.9.6',
					sourceSha: TEST_SOURCE_SHA
				})
			);

			const targetId = await runRelease(hostTargetId());
			expect(
				await runRelease(
					smokeReleaseArtifact({
						version: '1.2.3',
						outputDir,
						targetId,
						archiveSha256: await runRelease(
							Effect.gen(function* () {
								const fs = yield* FileSystem.FileSystem;
								const target = RELEASE_TARGETS.find((candidate) => candidate.id === targetId);
								if (target === undefined) return yield* Effect.die('Missing native release target');
								return yield* release.sha256(
									yield* fs.readFile(joinPath(outputDir, release.artifactName('1.2.3', target)))
								);
							}).pipe(Effect.provide(BunServices.layer))
						)
					})
				)
			).toBeUndefined();
			expect((await readFileString(smokeLog)).trim().split('\n')).toEqual([
				'--version --json',
				'--help',
				'commands --limit 1',
				'pkg version --json',
				'pkg init demo --json',
				'pkg check --json',
				'pkg render --inputs inputs.example.yaml --out deploy --json',
				'pkg inspect --json'
			]);
		} finally {
			await removePath(root, { recursive: true, force: true });
		}
	});

	test('rejects an install-smoke executable whose longer version contains the expected version', async () => {
		const targets = release.RELEASE_TARGETS;
		const hostTargetId = release.hostTargetId as () => Effect.Effect<string, Error, ReleaseHost>;
		const packageExistingExecutables = release.packageExistingExecutables as (input: {
			version: string;
			outputDir: string;
			binaries: Record<string, string>;
			packageVersion: string;
			sourceSha: string;
		}) => Effect.Effect<void, Error>;
		const smokeReleaseArtifact = release.smokeReleaseArtifact as (input: {
			version: string;
			outputDir: string;
			targetId: string;
			archiveSha256: string;
		}) => Effect.Effect<void, Error>;
		const root = await makeReleaseTempDir();

		try {
			const source = joinPath(root, 'akua-fixture');
			const outputDir = joinPath(root, 'release');
			await writeFileString(
				source,
				'#!/bin/sh\ncase "$1" in\n  --version) echo \'{"status":"ok","data":{"version":"11.2.3"}}\' ;;\n  --help) echo \'Usage: akua\' ;;\n  commands) echo \'commands[1]\' ;;\n  *) exit 2 ;;\nesac\n'
			);
			await chmodPath(source, 0o755);
			await runRelease(
				packageExistingExecutables({
					version: '1.2.3',
					outputDir,
					binaries: Object.fromEntries(targets.map((target) => [target.id, source])),
					packageVersion: '0.9.6',
					sourceSha: TEST_SOURCE_SHA
				})
			);

			const targetId = await runRelease(hostTargetId());
			await expect(
				runRelease(
					smokeReleaseArtifact({
						version: '1.2.3',
						outputDir,
						targetId,
						archiveSha256: await runRelease(
							Effect.gen(function* () {
								const fs = yield* FileSystem.FileSystem;
								const target = RELEASE_TARGETS.find((candidate) => candidate.id === targetId);
								if (target === undefined) return yield* Effect.die('Missing native release target');
								return yield* release.sha256(
									yield* fs.readFile(joinPath(outputDir, release.artifactName('1.2.3', target)))
								);
							}).pipe(Effect.provide(BunServices.layer))
						)
					})
				)
			).rejects.toThrow('unexpected version');
		} finally {
			await removePath(root, { recursive: true, force: true });
		}
	});
});
