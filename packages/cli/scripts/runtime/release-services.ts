import { Context, Effect, Schema } from 'effect';

export class ReleaseFailure extends Schema.TaggedError<ReleaseFailure>()('ReleaseFailure', {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect())
}) {}

export type ReleaseTargetId =
	| 'darwin-arm64'
	| 'darwin-x64'
	| 'linux-arm64'
	| 'linux-x64'
	| 'windows-x64';

export interface ReleaseTarget {
	id: ReleaseTargetId;
	bunTarget: string;
	os: 'darwin' | 'linux' | 'windows';
	arch: 'arm64' | 'x64';
	archive: 'tar.gz' | 'zip';
	executable: 'akua' | 'akua.exe';
	runner: string;
	homebrew?: {
		os: 'macos' | 'linux';
		arch: 'arm' | 'intel';
	};
}

export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
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
		// GitHub-hosted, matching every other leg in this matrix. The
		// self-hosted akua-x64-ci-v2 pool's shared egress IP gets
		// codeload.github.com 429-rate-limited under concurrent CI load
		// (observed 3x in a row on this exact job), and this leg only
		// needs a generic Linux x64 execution environment to smoke-test
		// an already-built artifact.
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
];

export interface ReleaseAsset {
	target: ReleaseTargetId;
	bun_target: string;
	os: ReleaseTarget['os'];
	arch: ReleaseTarget['arch'];
	archive: ReleaseTarget['archive'];
	executable: ReleaseTarget['executable'];
	contents: string[];
	file: string;
	checksum_file: string;
	sha256: string;
	size: number;
}

export interface ReleaseManifest {
	schema_version: 1;
	executable: 'akua';
	version: string;
	checksums: string;
	homebrew_manifest: string;
	source: ReleaseProvenance['source'];
	dependencies: ReleaseProvenance['dependencies'];
	assets: ReleaseAsset[];
}

export interface ReleaseProvenance {
	source: {
		repository: 'akua-dev/cnap';
		sha: string;
		subtree: 'oss/akua/packages/cli' | 'oss/akua/cli';
	};
	dependencies: [
		{
			name: 'akuapkg';
			version: string;
		}
	];
}

export interface PackageExistingExecutablesInput {
	version: string;
	outputDir: string;
	binaries: Record<string, string>;
	/** Version of the package toolchain the executables embed (`akua pkg`). */
	packageVersion: string;
	sourceSha: string;
	targetId?: ReleaseTargetId;
	zipperPath?: string;
}

export interface AssembleReleasePackagesInput {
	version: string;
	outputDir: string;
	packageVersion: string;
	sourceSha: string;
	parts: Record<string, string>;
	zipperPath?: string;
}

export interface PackageReleaseInput {
	version: string;
	outputDir: string;
	entrypoint?: string;
	packageVersion: string;
	sourceSha: string;
}

export const makeReleaseProvenance = Effect.fn('makeReleaseProvenance')(function* (input: {
	readonly sourceSha: string;
	readonly packageVersion: string;
}) {
	if (!/^[0-9a-f]{40}$/.test(input.sourceSha)) {
		return yield* releaseFailure(`Invalid cnap source SHA: ${input.sourceSha}`);
	}
	yield* validateVersion(input.packageVersion);
	return {
		source: {
			repository: 'akua-dev/cnap',
			sha: input.sourceSha,
			subtree: 'oss/akua/packages/cli'
		},
		dependencies: [{ name: 'akuapkg', version: input.packageVersion }]
	} satisfies ReleaseProvenance;
});

export function releaseMatrix(): {
	include: Array<{ target: ReleaseTargetId; runner: string }>;
} {
	return {
		include: RELEASE_TARGETS.map((target) => ({
			target: target.id,
			runner: target.runner
		}))
	};
}

export function artifactName(
	version: string,
	target: Pick<ReleaseTarget, 'id' | 'archive'>
): string {
	return `akua-v${version}-${target.id}.${target.archive}`;
}

/**
 * The public release tag of a version: akua-dev/akua releases the CLI and the
 * package toolchain it embeds together, on one version and one tag.
 */
export function releaseTag(version: string): string {
	return `v${version}`;
}

/**
 * The CLI's aggregate checksum file. The release also carries the package
 * toolchain's assets, so its name is prefixed like the other CLI metadata.
 */
export function checksumsName(version: string): string {
	return `akua-v${version}-checksums.txt`;
}

export function checksumLine(name: string, digest: string): string {
	return `${digest}  ${name}\n`;
}

export function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index += 1) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}

export function validateVersion(version: string): Effect.Effect<void, ReleaseFailure> {
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
		return releaseFailure(`Invalid release version: ${version}`);
	}
	return Effect.void;
}

export function releaseManifestName(version: string): Effect.Effect<string, ReleaseFailure> {
	return validateVersion(version).pipe(Effect.map(() => `akua-v${version}-manifest.json`));
}

export function homebrewManifestName(version: string): Effect.Effect<string, ReleaseFailure> {
	return validateVersion(version).pipe(Effect.map(() => `akua-v${version}-homebrew.json`));
}

export function releaseAssetNames(version: string): Effect.Effect<string[], ReleaseFailure> {
	return Effect.gen(function* () {
		const archives = RELEASE_TARGETS.map((target) => artifactName(version, target));
		return [
			...archives,
			...archives.map((archive) => `${archive}.sha256`),
			checksumsName(version),
			yield* releaseManifestName(version),
			yield* homebrewManifestName(version)
		];
	});
}

export function assertCompiledExecutable(
	target: Pick<ReleaseTarget, 'id' | 'os'>,
	bytes: Uint8Array
): Effect.Effect<void, ReleaseFailure> {
	const expectedMagic =
		target.os === 'darwin'
			? [0xcf, 0xfa, 0xed, 0xfe]
			: target.os === 'linux'
				? [0x7f, 0x45, 0x4c, 0x46]
				: [0x4d, 0x5a];
	if (
		bytes.length < expectedMagic.length ||
		expectedMagic.some((byte, index) => bytes[index] !== byte)
	) {
		return releaseFailure(
			`Compiled executable has an invalid ${target.os} header for ${target.id}`
		);
	}
	return Effect.void;
}

export function releaseTargetIdForHost(
	platform: string,
	arch: string
): Effect.Effect<ReleaseTargetId, ReleaseFailure> {
	const normalizedPlatform = platform === 'win32' ? 'windows' : platform;
	const id = `${normalizedPlatform}-${arch}`;
	const target = RELEASE_TARGETS.find((candidate) => candidate.id === id);
	if (!target) {
		return releaseFailure(`Unsupported release host: ${platform}-${arch}`);
	}
	return Effect.succeed(target.id);
}

export function archiveExtractCommand(
	archive: ReleaseTarget['archive'],
	archivePath: string,
	installRoot: string,
	platform: string
): string[] {
	if (archive === 'zip') {
		if (platform === 'win32') {
			const archiveLiteral = `'${archivePath.replaceAll("'", "''")}'`;
			const installRootLiteral = `'${installRoot.replaceAll("'", "''")}'`;
			return [
				'powershell.exe',
				'-NoLogo',
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				`Expand-Archive -LiteralPath ${archiveLiteral} -DestinationPath ${installRootLiteral}`
			];
		}
		return ['unzip', '-q', archivePath, '-d', installRoot];
	}
	return ['tar', '-xf', archivePath, '-C', installRoot];
}

export class ReleaseHost extends Context.Service<
	ReleaseHost,
	{
		readonly sha256: (bytes: Uint8Array) => Effect.Effect<string, ReleaseFailure>;
		readonly hostTargetId: Effect.Effect<ReleaseTargetId, ReleaseFailure>;
		readonly planUploads: (
			candidateDir: string,
			existingDir: string,
			version: string
		) => Effect.Effect<string[], ReleaseFailure>;
		readonly assertSafeOutputDirectory: (outputDir: string) => Effect.Effect<void, ReleaseFailure>;
		readonly packageExistingExecutables: (
			input: PackageExistingExecutablesInput
		) => Effect.Effect<void, ReleaseFailure>;
		readonly assembleReleasePackages: (
			input: AssembleReleasePackagesInput
		) => Effect.Effect<void, ReleaseFailure>;
		readonly packageRelease: (input: PackageReleaseInput) => Effect.Effect<void, ReleaseFailure>;
		readonly smokeReleaseArtifact: (input: {
			version: string;
			outputDir: string;
			targetId: string;
			archiveSha256: string;
			/**
			 * An `XDG_CACHE_HOME` holding the OCI dependencies the scaffold
			 * pins (kcl-lang/k8s): the package smoke then renders `--offline`
			 * from it. Absent, the render may fetch them.
			 */
			ociCache?: string;
		}) => Effect.Effect<void, ReleaseFailure>;
		readonly verifyReleaseDirectory: (
			outputDir: string,
			version: string
		) => Effect.Effect<void, ReleaseFailure>;
	}
>()('platform/scripts/ReleaseHost') {}

export function releaseFailure(
	message: string,
	cause?: unknown
): Effect.Effect<never, ReleaseFailure> {
	return Effect.fail(new ReleaseFailure({ message, cause }));
}

const ArchiveSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const admitNativeSmokeArchive = Effect.fn('admitNativeSmokeArchive')(function* <R>(input: {
	readonly targetId: string;
	readonly hostTargetId: string;
	readonly archiveSha256: string;
	readonly actualSha256: Effect.Effect<string, ReleaseFailure, R>;
}) {
	if (input.targetId !== input.hostTargetId) {
		return yield* releaseFailure(
			`Release smoke target ${input.targetId} does not match native host ${input.hostTargetId}`
		);
	}
	const expected = yield* Schema.decodeUnknownEffect(ArchiveSha256)(input.archiveSha256).pipe(
		Effect.mapError(() => new ReleaseFailure({ message: 'Invalid release smoke archive SHA-256' }))
	);
	if ((yield* input.actualSha256) !== expected) {
		return yield* releaseFailure('Release smoke archive checksum mismatch');
	}
});
