// FileSystem.stat always follows symlinks (delegates to Node's fs.stat; see
// node_modules/@effect/platform-node-shared/src/NodeFileSystem.ts), and this
// effect version exposes no lstat-equivalent (non-symlink-following stat) on
// the FileSystem service. assertSafeOutputDirectory's symlink-attack check
// below needs exactly that non-following behavior, so it stays on raw
// node:fs, bridged through Effect.try like any other live-adapter host
// boundary.
import { lstatSync } from 'node:fs';

import { BunServices } from '@effect/platform-bun';
import { Crypto, Effect, FileSystem, Layer, Path, Stream } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import {
	RELEASE_TARGETS,
	ReleaseHost,
	ReleaseFailure,
	archiveExtractCommand,
	artifactName,
	assertCompiledExecutable,
	admitNativeSmokeArchive,
	bytesEqual,
	bytesToHex,
	checksumLine,
	checksumsName,
	homebrewManifestName,
	releaseAssetNames,
	releaseFailure,
	releaseManifestName,
	releaseTag,
	releaseTargetIdForHost,
	makeReleaseProvenance,
	validateVersion
} from './release-services';
import type {
	AssembleReleasePackagesInput,
	PackageExistingExecutablesInput,
	PackageReleaseInput,
	ReleaseAsset,
	ReleaseManifest,
	ReleaseProvenance,
	ReleaseTarget
} from './release-services';

const RELEASE_REPOSITORY = 'akua-dev/akua';
const ARCHIVE_TIMESTAMP_SECONDS = 315532800;
const ARCHIVE_TIMESTAMP = new Date(ARCHIVE_TIMESTAMP_SECONDS * 1000);

function attempt<A>(operation: string, execute: () => A): Effect.Effect<A, ReleaseFailure> {
	return Effect.try({
		try: execute,
		catch: (cause) =>
			new ReleaseFailure({
				message: `Release host ${operation} failed`,
				cause
			})
	});
}

function toReleaseFailure(operation: string) {
	return (cause: PlatformError): ReleaseFailure =>
		new ReleaseFailure({ message: `Release host ${operation} failed`, cause });
}

function check(condition: boolean, message: string): Effect.Effect<void, ReleaseFailure> {
	return condition ? Effect.void : releaseFailure(message);
}

const planReleaseUploads = Effect.fn('planReleaseUploads')(function* (
	candidateDirInput: string,
	existingDirInput: string,
	version: string
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const candidateDir = path.resolve(candidateDirInput);
	const existingDir = path.resolve(existingDirInput);
	const expectedNames = yield* releaseAssetNames(version);
	const candidateNames = (yield* fs
		.readDirectory(candidateDir)
		.pipe(Effect.mapError(toReleaseFailure('read candidate directory')))).sort();
	yield* check(
		JSON.stringify(candidateNames) === JSON.stringify([...expectedNames].sort()),
		`Unexpected release files: ${candidateNames.join(', ')}`
	);
	const existingNames = yield* fs
		.readDirectory(existingDir)
		.pipe(Effect.mapError(toReleaseFailure('read existing directory')));
	const expectedNameSet = new Set(expectedNames);
	for (const name of existingNames) {
		yield* check(expectedNameSet.has(name), `Unexpected existing release asset: ${name}`);
		const candidate = yield* fs
			.readFile(path.join(candidateDir, name))
			.pipe(Effect.mapError(toReleaseFailure('read candidate asset')));
		const existing = yield* fs
			.readFile(path.join(existingDir, name))
			.pipe(Effect.mapError(toReleaseFailure('read existing asset')));
		yield* check(
			bytesEqual(candidate, existing),
			`Existing release asset does not match candidate: ${name}`
		);
	}
	const existingNameSet = new Set(existingNames);
	return expectedNames
		.filter((name) => !existingNameSet.has(name))
		.map((name) => path.join(candidateDir, name));
});

const assertSafeOutputDirectory = Effect.fn('assertSafeOutputDirectory')(function* (
	outputDirInput: string
) {
	const path = yield* Path.Path;
	const outputDir = path.resolve(outputDirInput);
	const workspace = path.resolve(process.cwd());
	const releaseOutputRoot = path.join(workspace, 'dist', 'release');
	const releaseRelativePath = path.relative(releaseOutputRoot, outputDir);
	yield* check(
		!(
			releaseRelativePath === '..' ||
			releaseRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
			path.isAbsolute(releaseRelativePath)
		),
		`Unsafe release output directory: ${outputDir}`
	);

	let currentPath = workspace;
	const segments = path.relative(workspace, outputDir).split(path.sep);
	for (const segment of segments) {
		currentPath = path.join(currentPath, segment);
		const stats = yield* lstatIfPresent(currentPath);
		if (stats !== undefined) {
			yield* check(
				!stats.isSymbolicLink(),
				`Unsafe release output directory contains a symlink: ${currentPath}`
			);
		}
	}
});

function lstatIfPresent(
	path: string
): Effect.Effect<ReturnType<typeof lstatSync> | undefined, ReleaseFailure> {
	return attempt('inspect output directory', () => lstatSync(path)).pipe(
		Effect.map((stats) => stats),
		Effect.catch((failure) =>
			isNotFoundError(failure.cause) ? Effect.succeed(undefined) : Effect.fail(failure)
		)
	);
}

const writeReleaseMetadata = Effect.fn('writeReleaseMetadata')(function* (
	outputDir: string,
	version: string,
	assets: ReleaseAsset[],
	provenance: ReleaseProvenance
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const manifestName = yield* releaseManifestName(version);
	const homebrewName = yield* homebrewManifestName(version);
	const manifest: ReleaseManifest = {
		schema_version: 1,
		executable: 'akua',
		version,
		checksums: checksumsName(version),
		homebrew_manifest: homebrewName,
		...provenance,
		assets
	};
	const homebrewManifest = yield* createHomebrewManifest(version, assets);
	const metadata: ReadonlyArray<readonly [string, string]> = [
		[
			checksumsName(version),
			assets.map((asset) => checksumLine(asset.file, asset.sha256)).join('')
		],
		[manifestName, stableJson(manifest)],
		[homebrewName, stableJson(homebrewManifest)]
	];
	for (const [name, contents] of metadata) {
		yield* fs
			.writeFileString(path.join(outputDir, name), contents)
			.pipe(Effect.mapError(toReleaseFailure('write release metadata')));
	}
});

const packageExistingExecutables = Effect.fn('packageExistingExecutables')(function* (
	input: PackageExistingExecutablesInput
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	yield* validateVersion(input.version);
	const outputDir = path.resolve(input.outputDir);
	yield* assertSafeOutputDirectory(outputDir);
	const stagingRoot = path.join(outputDir, '.staging');
	yield* fs
		.remove(outputDir, { recursive: true, force: true })
		.pipe(Effect.mapError(toReleaseFailure('clear release output')));
	yield* fs
		.makeDirectory(stagingRoot, { recursive: true })
		.pipe(Effect.mapError(toReleaseFailure('create staging directory')));

	const provenance = yield* makeReleaseProvenance({
		sourceSha: input.sourceSha,
		packageVersion: input.packageVersion
	});
	const packageAssets = Effect.gen(function* () {
		const selectedTargets = input.targetId
			? RELEASE_TARGETS.filter((target) => target.id === input.targetId)
			: RELEASE_TARGETS;
		yield* check(selectedTargets.length > 0, `Unknown release target: ${input.targetId}`);
		const assets = yield* Effect.forEach(
			selectedTargets,
			(target) =>
				Effect.gen(function* () {
					const source = input.binaries[target.id];
					if (!source) {
						return yield* releaseFailure(`Missing compiled executable for ${target.id}`);
					}
					const stagingDir = path.join(stagingRoot, target.id);
					const stagedExecutable = path.join(stagingDir, target.executable);
					const archive = artifactName(input.version, target);
					const archivePath = path.join(outputDir, archive);
					yield* fs
						.makeDirectory(stagingDir, { recursive: true })
						.pipe(Effect.mapError(toReleaseFailure('create target staging directory')));
					const sourceBytes = yield* fs
						.readFile(source)
						.pipe(Effect.mapError(toReleaseFailure('read compiled executable')));
					yield* fs
						.writeFile(stagedExecutable, sourceBytes)
						.pipe(Effect.mapError(toReleaseFailure('stage compiled executable')));
					const stagedBytes = yield* fs
						.readFile(stagedExecutable)
						.pipe(Effect.mapError(toReleaseFailure('verify staged executable')));
					yield* check(
						bytesEqual(stagedBytes, sourceBytes),
						`Staged executable does not match source for ${target.id}`
					);
					yield* fs
						.chmod(stagedExecutable, target.os === 'windows' ? 0o644 : 0o755)
						.pipe(Effect.mapError(toReleaseFailure('set staged executable mode')));
					yield* fs
						.utimes(stagedExecutable, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP)
						.pipe(Effect.mapError(toReleaseFailure('set staged executable timestamp')));
					if (target.archive === 'tar.gz') {
						const metadataArguments =
							process.platform === 'linux'
								? ['--owner=0', '--group=0', `--mtime=@${ARCHIVE_TIMESTAMP_SECONDS}`]
								: [
										'--uid',
										'0',
										'--gid',
										'0',
										'--uname',
										'root',
										'--gname',
										'root',
										'--options',
										'gzip:!timestamp'
									];
						yield* runCommand(
							[
								'tar',
								'--format=ustar',
								...metadataArguments,
								'-czf',
								archivePath,
								'-C',
								stagingDir,
								target.executable
							],
							{ COPYFILE_DISABLE: '1' }
						);
					} else {
						if (input.zipperPath) {
							yield* runCommand([
								input.zipperPath,
								'cC',
								archivePath,
								...[target.executable].map((file) => `${file}=${path.join(stagingDir, file)}`)
							]);
						} else {
							yield* runCommand(
								['zip', '-X', '-q', archivePath, target.executable],
								{ COPYFILE_DISABLE: '1', TZ: 'UTC' },
								stagingDir
							);
						}
					}
					const bytes = yield* fs
						.readFile(archivePath)
						.pipe(Effect.mapError(toReleaseFailure('read packaged archive')));
					const digest = yield* sha256(bytes);
					const checksumFile = `${archive}.sha256`;
					yield* fs
						.writeFileString(path.join(outputDir, checksumFile), checksumLine(archive, digest))
						.pipe(Effect.mapError(toReleaseFailure('write archive checksum')));
					return {
						target: target.id,
						bun_target: target.bunTarget,
						os: target.os,
						arch: target.arch,
						archive: target.archive,
						executable: target.executable,
						contents: [target.executable],
						file: archive,
						checksum_file: checksumFile,
						sha256: digest,
						size: bytes.byteLength
					} satisfies ReleaseAsset;
				}),
			{ concurrency: selectedTargets.length }
		);
		if (input.targetId) {
			yield* fs
				.writeFileString(path.join(outputDir, 'asset.json'), stableJson(assets[0]))
				.pipe(Effect.mapError(toReleaseFailure('write target asset metadata')));
			return;
		}
		yield* writeReleaseMetadata(outputDir, input.version, assets, provenance);
	});
	yield* packageAssets.pipe(
		Effect.ensuring(
			fs
				.remove(stagingRoot, { recursive: true, force: true })
				.pipe(Effect.mapError(toReleaseFailure('remove staging directory')), Effect.ignore)
		)
	);
	if (!input.targetId) yield* verifyReleaseDirectory(outputDir, input.version, input.zipperPath);
});

const assembleReleasePackages = Effect.fn('assembleReleasePackages')(function* (
	input: AssembleReleasePackagesInput
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	yield* validateVersion(input.version);
	const outputDir = path.resolve(input.outputDir);
	yield* assertSafeOutputDirectory(outputDir);
	yield* fs
		.remove(outputDir, { recursive: true, force: true })
		.pipe(Effect.mapError(toReleaseFailure('clear assembled release output')));
	yield* fs
		.makeDirectory(outputDir, { recursive: true })
		.pipe(Effect.mapError(toReleaseFailure('create assembled release output')));
	const assets = yield* Effect.forEach(RELEASE_TARGETS, (target) =>
		Effect.gen(function* () {
			const part = input.parts[target.id];
			if (!part) return yield* releaseFailure(`Missing release part for ${target.id}`);
			const metadata = yield* fs
				.readFileString(path.join(part, 'asset.json'))
				.pipe(Effect.mapError(toReleaseFailure('read release part metadata')));
			const parsed = yield* attempt('parse release part metadata', () => JSON.parse(metadata));
			const asset = yield* parseReleaseAsset(parsed);
			yield* check(
				asset.target === target.id &&
					asset.file === artifactName(input.version, target) &&
					asset.checksum_file === `${asset.file}.sha256`,
				`Release part does not match ${target.id}`
			);
			for (const name of [asset.file, asset.checksum_file]) {
				yield* fs
					.copyFile(path.join(part, name), path.join(outputDir, name))
					.pipe(Effect.mapError(toReleaseFailure('copy release part')));
			}
			return asset;
		})
	);
	const provenance = yield* makeReleaseProvenance({
		sourceSha: input.sourceSha,
		packageVersion: input.packageVersion
	});
	yield* writeReleaseMetadata(outputDir, input.version, assets, provenance);
	yield* verifyReleaseDirectory(outputDir, input.version, input.zipperPath);
});

const packageRelease = Effect.fn('packageRelease')(function* (input: PackageReleaseInput) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	yield* validateVersion(input.version);
	const binaryBuildParent = path.join(process.cwd(), 'dist');
	yield* fs
		.makeDirectory(binaryBuildParent, { recursive: true })
		.pipe(Effect.mapError(toReleaseFailure('create binary build directory')));
	const binaryRoot = yield* fs
		.makeTempDirectory({
			directory: binaryBuildParent,
			prefix: '.tmp-akua-release-build-'
		})
		.pipe(Effect.mapError(toReleaseFailure('create binary build staging directory')));
	const buildBinaries = Effect.gen(function* () {
		const binaries: Record<string, string> = {};
		for (const target of RELEASE_TARGETS) {
			const binaryPath = path.join(binaryRoot, target.id, target.executable);
			yield* fs
				.makeDirectory(path.join(binaryRoot, target.id), { recursive: true })
				.pipe(Effect.mapError(toReleaseFailure('create target binary directory')));
			yield* runCommand([
				'bun',
				'build',
				input.entrypoint ?? 'src/bin/akua.ts',
				'--compile',
				`--target=${target.bunTarget}`,
				'--no-compile-autoload-dotenv',
				'--no-compile-autoload-bunfig',
				`--outfile=${binaryPath}`
			]);
			const bytes = yield* fs
				.readFile(binaryPath)
				.pipe(Effect.mapError(toReleaseFailure('read compiled executable')));
			yield* assertCompiledExecutable(target, bytes);
			binaries[target.id] = binaryPath;
		}
		yield* packageExistingExecutables({
			version: input.version,
			outputDir: input.outputDir,
			binaries,
			packageVersion: input.packageVersion,
			sourceSha: input.sourceSha
		});
	});
	yield* buildBinaries.pipe(
		Effect.ensuring(
			fs
				.remove(binaryRoot, { recursive: true, force: true })
				.pipe(
					Effect.mapError(toReleaseFailure('remove binary build staging directory')),
					Effect.ignore
				)
		)
	);
});

/** The init scaffold: one typed ConfigMap, against the Kubernetes types it pins. */
const smokeReleaseArtifact = Effect.fn('smokeReleaseArtifact')(function* (input: {
	version: string;
	outputDir: string;
	targetId: string;
	archiveSha256: string;
	ociCache?: string;
}) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	yield* validateVersion(input.version);
	const target = RELEASE_TARGETS.find((candidate) => candidate.id === input.targetId);
	if (!target) {
		return yield* releaseFailure(`Unknown release target: ${input.targetId}`);
	}
	const host = yield* attempt('read release host', () => ({
		platform: process.platform,
		arch: process.arch
	}));
	const hostTargetId = yield* releaseTargetIdForHost(host.platform, host.arch);
	const archivePath = path.resolve(input.outputDir, artifactName(input.version, target));
	yield* admitNativeSmokeArchive({
		targetId: target.id,
		hostTargetId,
		archiveSha256: input.archiveSha256,
		actualSha256: fs
			.readFile(archivePath)
			.pipe(Effect.mapError(toReleaseFailure('read smoke archive')), Effect.flatMap(sha256))
	});
	const installRoot = yield* fs
		.makeTempDirectory({ prefix: 'akua-release-smoke-' })
		.pipe(Effect.mapError(toReleaseFailure('create smoke directory')));
	const smoke = Effect.gen(function* () {
		yield* runCommand(
			archiveExtractCommand(target.archive, archivePath, installRoot, process.platform)
		);
		const executable = path.join(installRoot, target.executable);
		if (target.os !== 'windows') {
			yield* fs
				.chmod(executable, 0o755)
				.pipe(Effect.mapError(toReleaseFailure('set smoke executable mode')));
		}
		const versionOutput = yield* runCommand([executable, '--version', '--json']);
		const reportedVersion = yield* parseReportedVersion(versionOutput);
		yield* check(
			reportedVersion === input.version,
			`Installed ${target.id} executable reported an unexpected version: ${versionOutput.trim()}`
		);
		const helpOutput = yield* runCommand([executable, '--help'], {
			AKUA_OUTPUT: 'agent'
		});
		yield* check(
			helpOutput.trim() !== '',
			`Installed ${target.id} executable returned empty help output`
		);
		const commandsOutput = yield* runCommand([executable, 'commands', '--limit', '1'], {
			AKUA_OUTPUT: 'agent'
		});
		yield* check(
			commandsOutput.trim() !== '',
			`Installed ${target.id} executable returned empty command output`
		);
		const packageSmokeRoot = path.join(installRoot, 'package-smoke');
		yield* fs
			.makeDirectory(packageSmokeRoot, { recursive: true })
			.pipe(Effect.mapError(toReleaseFailure('create package smoke directory')));
		yield* runCommand([executable, 'pkg', 'version', '--json'], {}, packageSmokeRoot);
		yield* runCommand([executable, 'pkg', 'init', 'demo', '--json'], {}, packageSmokeRoot);
		const packageDirectory = path.join(packageSmokeRoot, 'demo');
		// With a seeded cache the scaffold's pinned dependencies never touch the network.
		const pinnedCache: Record<string, string> =
			input.ociCache === undefined ? {} : { XDG_CACHE_HOME: path.resolve(input.ociCache) };
		const offline = input.ociCache === undefined ? [] : ['--offline'];
		// Resolve the scaffold's pinned dependencies before its offline type check.
		yield* runCommand(
			[executable, 'pkg', 'lock', '--check', '--json'],
			pinnedCache,
			packageDirectory
		);
		yield* runCommand([executable, 'pkg', 'check', '--json'], pinnedCache, packageDirectory);
		yield* runCommand(
			[
				executable,
				'pkg',
				'render',
				'--inputs',
				'inputs.example.yaml',
				'--out',
				'deploy',
				'--json',
				...offline
			],
			pinnedCache,
			packageDirectory
		);
		const renderedFiles = yield* fs
			.readDirectory(path.join(packageDirectory, 'deploy'))
			.pipe(Effect.mapError(toReleaseFailure('read package smoke output')));
		yield* check(
			renderedFiles.length > 0,
			`Installed ${target.id} package renderer returned no manifests`
		);
		yield* runCommand([executable, 'pkg', 'inspect', '--json'], pinnedCache, packageDirectory);
	});
	yield* smoke.pipe(
		Effect.ensuring(
			fs
				.remove(installRoot, { recursive: true, force: true })
				.pipe(Effect.mapError(toReleaseFailure('remove smoke directory')), Effect.ignore)
		)
	);
});

function parseReportedVersion(output: string): Effect.Effect<unknown, ReleaseFailure> {
	return attempt('parse executable version response', () => JSON.parse(output)).pipe(
		Effect.map(versionFromPayload),
		Effect.catch(() => Effect.succeed(undefined))
	);
}

const verifyReleaseDirectory = Effect.fn('verifyReleaseDirectory')(function* (
	outputDirInput: string,
	version: string,
	zipperPath?: string
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	yield* validateVersion(version);
	const outputDir = path.resolve(outputDirInput);
	const manifestName = yield* releaseManifestName(version);
	const manifestContents = yield* fs
		.readFileString(path.join(outputDir, manifestName))
		.pipe(Effect.mapError(toReleaseFailure('read release manifest')));
	const manifestJson = yield* attempt('parse release manifest', () => JSON.parse(manifestContents));
	const manifest = yield* parseReleaseManifest(manifestJson);
	const homebrewName = yield* homebrewManifestName(version);
	yield* check(
		manifest.schema_version === 1 &&
			manifest.version === version &&
			manifest.executable === 'akua' &&
			manifest.checksums === checksumsName(version) &&
			manifest.homebrew_manifest === homebrewName &&
			manifest.assets.length === RELEASE_TARGETS.length,
		'Release manifest does not match the requested release contract'
	);
	const aggregateLines: string[] = [];
	for (const [index, target] of RELEASE_TARGETS.entries()) {
		const asset = manifest.assets[index];
		if (asset === undefined) return yield* releaseFailure('Release target asset is missing');
		const expectedFile = artifactName(version, target);
		yield* check(
			asset.target === target.id &&
				asset.bun_target === target.bunTarget &&
				asset.os === target.os &&
				asset.arch === target.arch &&
				asset.archive === target.archive &&
				asset.file === expectedFile &&
				asset.checksum_file === `${expectedFile}.sha256` &&
				asset.executable === target.executable &&
				JSON.stringify(asset.contents) === JSON.stringify([target.executable]),
			`Release manifest target mismatch for ${target.id}`
		);
		const bytes = yield* fs
			.readFile(path.join(outputDir, asset.file))
			.pipe(Effect.mapError(toReleaseFailure('read release archive')));
		const digest = yield* sha256(bytes);
		yield* check(digest === asset.sha256, `Release asset checksum mismatch: ${asset.file}`);
		const expectedLine = checksumLine(asset.file, digest);
		const adjacent = yield* fs
			.readFileString(path.join(outputDir, asset.checksum_file))
			.pipe(Effect.mapError(toReleaseFailure('read release checksum')));
		yield* check(
			adjacent === expectedLine,
			`Release checksum file mismatch: ${asset.checksum_file}`
		);
		const info = yield* fs
			.stat(path.join(outputDir, asset.file))
			.pipe(Effect.mapError(toReleaseFailure('read release archive metadata')));
		const size = Number(info.size);
		yield* check(size === asset.size, `Release asset size mismatch: ${asset.file}`);
		aggregateLines.push(expectedLine);
		yield* verifyArchive(outputDir, target, asset.file, asset.contents, zipperPath);
	}
	const aggregate = yield* fs
		.readFileString(path.join(outputDir, manifest.checksums))
		.pipe(Effect.mapError(toReleaseFailure('read aggregate checksums')));
	yield* check(aggregate === aggregateLines.join(''), 'Aggregate checksum file mismatch');
	const homebrewManifest = yield* fs
		.readFileString(path.join(outputDir, manifest.homebrew_manifest))
		.pipe(Effect.mapError(toReleaseFailure('read Homebrew manifest')));
	const expectedHomebrewManifest = stableJson(
		yield* createHomebrewManifest(version, manifest.assets)
	);
	yield* check(homebrewManifest === expectedHomebrewManifest, 'Homebrew manifest mismatch');
	const actualNames = (yield* fs
		.readDirectory(outputDir)
		.pipe(Effect.mapError(toReleaseFailure('read release directory')))).sort();
	const expectedNames = (yield* releaseAssetNames(version)).sort();
	yield* check(
		JSON.stringify(actualNames) === JSON.stringify(expectedNames),
		`Unexpected release files: ${actualNames.join(', ')}`
	);
});

const createHomebrewManifest = Effect.fn('createHomebrewManifest')(function* (
	version: string,
	assets: readonly ReleaseAsset[]
) {
	const platforms: Record<string, { artifact: string; url: string; sha256: string }> = {};
	for (const target of RELEASE_TARGETS) {
		if (!target.homebrew) continue;
		const asset = assets.find((candidate) => candidate.target === target.id);
		if (!asset) {
			return yield* releaseFailure(`Missing Homebrew release asset for ${target.id}`);
		}
		const key = `${target.homebrew.os}_${target.homebrew.arch}`;
		platforms[key] = {
			artifact: asset.file,
			url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${releaseTag(version)}/${asset.file}`,
			sha256: asset.sha256
		};
	}
	return {
		schema_version: 1,
		formula: 'akua',
		version,
		release: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${releaseTag(version)}`,
		platforms
	};
});

const verifyArchive = Effect.fn('verifyArchive')(function* (
	outputDir: string,
	target: ReleaseTarget,
	file: string,
	contents: readonly string[],
	zipperPath?: string
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const archivePath = path.join(outputDir, file);
	const listCommand =
		target.archive === 'zip'
			? zipperPath
				? [zipperPath, 'v', archivePath]
				: ['unzip', '-Z1', archivePath]
			: ['tar', '-tzf', archivePath];
	const listedFiles = (yield* runCommand(listCommand))
		.trim()
		.split('\n')
		.flatMap((entry) =>
			zipperPath && target.archive === 'zip'
				? entry.startsWith('f ')
					? [entry.slice(6)]
					: []
				: entry !== '' && !entry.endsWith('/')
					? [entry]
					: []
		)
		.sort();
	const expectedFiles = [...contents].sort();
	yield* check(
		JSON.stringify(listedFiles) === JSON.stringify(expectedFiles),
		`Release archive ${file} has unexpected files: ${listedFiles.join(', ')}`
	);
	if (target.os === 'windows') return;
	const extractDir = yield* fs
		.makeTempDirectory({ prefix: 'akua-release-verify-' })
		.pipe(Effect.mapError(toReleaseFailure('create archive verification directory')));
	const verifyMode = Effect.gen(function* () {
		yield* runCommand(['tar', '-xzf', archivePath, '-C', extractDir]);
		const info = yield* fs
			.stat(path.join(extractDir, target.executable))
			.pipe(Effect.mapError(toReleaseFailure('read extracted executable metadata')));
		const mode = info.mode & 0o777;
		yield* check(
			mode === 0o755,
			`Release executable mode mismatch for ${target.id}: ${mode.toString(8)}`
		);
	});
	yield* verifyMode.pipe(
		Effect.ensuring(
			fs
				.remove(extractDir, { recursive: true, force: true })
				.pipe(
					Effect.mapError(toReleaseFailure('remove archive verification directory')),
					Effect.ignore
				)
		)
	);
});

const runCommand = Effect.fn('runCommand')(function* (
	command: string[],
	extraEnv: Record<string, string> = {},
	cwd?: string
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const executable = command[0];
	if (executable === undefined) return yield* releaseFailure('Release command is empty');
	const [stdout, stderr, exitCode] = yield* Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* spawner.spawn(
				ChildProcess.make(executable, command.slice(1), {
					cwd,
					env: extraEnv,
					extendEnv: true
				})
			);
			return yield* Effect.all(
				[
					handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
					handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
					handle.exitCode
				],
				{ concurrency: 'unbounded' }
			);
		})
	).pipe(Effect.mapError(toReleaseFailure('run release command')));
	yield* check(
		exitCode === ChildProcessSpawner.ExitCode(0),
		`${JSON.stringify(command)} failed (${exitCode}):\nstdout:\n${stdout.trim()}\nstderr:\n${stderr.trim()}`
	);
	return stdout;
});

const sha256 = Effect.fn('sha256')(function* (bytes: Uint8Array) {
	const crypto = yield* Crypto.Crypto;
	const digest = yield* crypto
		.digest('SHA-256', bytes)
		.pipe(Effect.mapError(toReleaseFailure('calculate SHA-256')));
	return bytesToHex(digest);
});

function stableJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function versionFromPayload(value: unknown): unknown {
	return isRecord(value) && isRecord(value.data) ? value.data.version : undefined;
}

function parseReleaseManifest(value: unknown): Effect.Effect<ReleaseManifest, ReleaseFailure> {
	if (!isRecord(value) || !Array.isArray(value.assets)) {
		return releaseFailure('Release manifest is invalid');
	}
	const rawAssets = value.assets;
	const version = value.version;
	const homebrewManifest = value.homebrew_manifest;
	if (
		value.schema_version !== 1 ||
		value.executable !== 'akua' ||
		typeof version !== 'string' ||
		value.checksums !== checksumsName(version) ||
		typeof homebrewManifest !== 'string'
	) {
		return releaseFailure('Release manifest is invalid');
	}
	return Effect.gen(function* () {
		const provenance = yield* parseReleaseProvenance(value);
		const assets = yield* Effect.all(rawAssets.map(parseReleaseAsset));
		return {
			schema_version: 1,
			executable: 'akua',
			version,
			checksums: checksumsName(version),
			homebrew_manifest: homebrewManifest,
			...provenance,
			assets
		};
	});
}

function parseReleaseProvenance(
	value: Record<string, unknown>
): Effect.Effect<ReleaseProvenance, ReleaseFailure> {
	const source = value.source;
	const subtree = isRecord(source) ? source.subtree : undefined;
	const dependencies = value.dependencies;
	const toolchain =
		Array.isArray(dependencies) && dependencies.length === 1 ? dependencies[0] : undefined;
	if (
		!isRecord(source) ||
		source.repository !== 'akua-dev/cnap' ||
		(subtree !== 'oss/akua/packages/cli' && subtree !== 'oss/akua/cli') ||
		!isRecord(toolchain) ||
		toolchain.name !== 'akuapkg' ||
		typeof source.sha !== 'string' ||
		typeof toolchain.version !== 'string'
	) {
		return releaseFailure('Release manifest provenance is invalid');
	}
	// Immutable releases retain the source location that existed when they were built.
	return makeReleaseProvenance({ sourceSha: source.sha, packageVersion: toolchain.version }).pipe(
		Effect.map((provenance) => ({ ...provenance, source: { ...provenance.source, subtree } }))
	);
}

function parseReleaseAsset(value: unknown): Effect.Effect<ReleaseAsset, ReleaseFailure> {
	if (!isRecord(value)) return releaseFailure('Release manifest asset is invalid');
	const stringFields = [
		'target',
		'bun_target',
		'os',
		'arch',
		'archive',
		'executable',
		'file',
		'checksum_file',
		'sha256'
	];
	const contents = value.contents;
	if (
		stringFields.some((field) => typeof value[field] !== 'string') ||
		typeof value.size !== 'number' ||
		!isStringArray(contents)
	) {
		return releaseFailure('Release manifest asset is invalid');
	}
	return Effect.gen(function* () {
		const target = yield* parseReleaseTargetId(value.target);
		const os = yield* parseReleaseOs(value.os);
		const arch = yield* parseReleaseArch(value.arch);
		const archive = yield* parseReleaseArchive(value.archive);
		const executable = yield* parseReleaseExecutable(value.executable);
		return {
			target,
			bun_target: yield* requiredString(value.bun_target),
			os,
			arch,
			archive,
			executable,
			contents,
			file: yield* requiredString(value.file),
			checksum_file: yield* requiredString(value.checksum_file),
			sha256: yield* requiredString(value.sha256),
			size: yield* requiredNumber(value.size)
		};
	});
}

function parseReleaseTargetId(
	value: unknown
): Effect.Effect<ReleaseAsset['target'], ReleaseFailure> {
	return value === 'darwin-arm64' ||
		value === 'darwin-x64' ||
		value === 'linux-arm64' ||
		value === 'linux-x64' ||
		value === 'windows-x64'
		? Effect.succeed(value)
		: releaseFailure('Release manifest asset is invalid');
}

function parseReleaseOs(value: unknown): Effect.Effect<ReleaseTarget['os'], ReleaseFailure> {
	return value === 'darwin' || value === 'linux' || value === 'windows'
		? Effect.succeed(value)
		: releaseFailure('Release manifest asset is invalid');
}

function parseReleaseArch(value: unknown): Effect.Effect<ReleaseTarget['arch'], ReleaseFailure> {
	return value === 'arm64' || value === 'x64'
		? Effect.succeed(value)
		: releaseFailure('Release manifest asset is invalid');
}

function parseReleaseArchive(
	value: unknown
): Effect.Effect<ReleaseTarget['archive'], ReleaseFailure> {
	return value === 'tar.gz' || value === 'zip'
		? Effect.succeed(value)
		: releaseFailure('Release manifest asset is invalid');
}

function parseReleaseExecutable(
	value: unknown
): Effect.Effect<ReleaseTarget['executable'], ReleaseFailure> {
	return value === 'akua' || value === 'akua.exe'
		? Effect.succeed(value)
		: releaseFailure('Release manifest asset is invalid');
}

function requiredString(value: unknown): Effect.Effect<string, ReleaseFailure> {
	return typeof value === 'string'
		? Effect.succeed(value)
		: releaseFailure('Release manifest asset is invalid');
}

function requiredNumber(value: unknown): Effect.Effect<number, ReleaseFailure> {
	return typeof value === 'number'
		? Effect.succeed(value)
		: releaseFailure('Release manifest asset is invalid');
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const makeReleaseHostLive = (zipperPath?: string) =>
	Layer.succeed(ReleaseHost, {
		sha256: (bytes) => sha256(bytes).pipe(Effect.provide(BunServices.layer)),
		hostTargetId: attempt('read release host', () => ({
			platform: process.platform,
			arch: process.arch
		})).pipe(Effect.flatMap(({ platform, arch }) => releaseTargetIdForHost(platform, arch))),
		planUploads: (candidateDir, existingDir, version) =>
			planReleaseUploads(candidateDir, existingDir, version).pipe(
				Effect.provide(BunServices.layer)
			),
		assertSafeOutputDirectory: (outputDir) =>
			assertSafeOutputDirectory(outputDir).pipe(Effect.provide(BunServices.layer)),
		packageExistingExecutables: (input) =>
			packageExistingExecutables(input).pipe(Effect.provide(BunServices.layer)),
		assembleReleasePackages: (input) =>
			assembleReleasePackages(input).pipe(Effect.provide(BunServices.layer)),
		packageRelease: (input) => packageRelease(input).pipe(Effect.provide(BunServices.layer)),
		smokeReleaseArtifact: (input) =>
			smokeReleaseArtifact(input).pipe(Effect.provide(BunServices.layer)),
		verifyReleaseDirectory: (outputDir, version) =>
			verifyReleaseDirectory(outputDir, version, zipperPath).pipe(Effect.provide(BunServices.layer))
	});
