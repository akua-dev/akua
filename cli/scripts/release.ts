import { Console, Effect, Option, Runtime } from 'effect';
import { Command, Flag } from 'effect/cli';

import {
	RELEASE_TARGETS,
	ReleaseHost,
	archiveExtractCommand,
	artifactName,
	assertCompiledExecutable,
	checksumLine,
	homebrewManifestName,
	releaseTargetIdForHost,
	releaseAssetNames,
	releaseManifestName,
	releaseMatrix,
	validateVersion
} from './runtime/release-services';
import { makeReleaseHostLive } from './runtime/release-host-live';
import { ScriptCliLive } from './runtime/cli-live';
import type {
	PackageExistingExecutablesInput,
	PackageReleaseInput,
	ReleaseAsset,
	ReleaseManifest,
	ReleaseTarget,
	ReleaseTargetId
} from './runtime/release-services';

export {
	RELEASE_TARGETS,
	archiveExtractCommand,
	artifactName,
	assertCompiledExecutable,
	checksumLine,
	homebrewManifestName,
	releaseAssetNames,
	releaseManifestName,
	releaseMatrix,
	releaseTargetIdForHost,
	validateVersion
};
export type { ReleaseAsset, ReleaseManifest, ReleaseTarget, ReleaseTargetId };

export function planReleaseUploads(
	candidateDir: string,
	existingDir: string,
	version: string
): Effect.Effect<string[], Error, ReleaseHost> {
	return Effect.gen(function* () {
		return yield* (yield* ReleaseHost).planUploads(candidateDir, existingDir, version);
	});
}

export function assertSafeOutputDirectory(
	outputDir: string
): Effect.Effect<void, Error, ReleaseHost> {
	return Effect.gen(function* () {
		return yield* (yield* ReleaseHost).assertSafeOutputDirectory(outputDir);
	});
}

export function packageExistingExecutables(
	input: PackageExistingExecutablesInput
): Effect.Effect<void, Error, ReleaseHost> {
	return Effect.gen(function* () {
		return yield* (yield* ReleaseHost).packageExistingExecutables(input);
	});
}

export function packageRelease(
	input: PackageReleaseInput
): Effect.Effect<void, Error, ReleaseHost> {
	return Effect.gen(function* () {
		return yield* (yield* ReleaseHost).packageRelease(input);
	});
}

export function smokeReleaseArtifact(input: {
	version: string;
	outputDir: string;
	targetId: string;
	archiveSha256: string;
}): Effect.Effect<void, Error, ReleaseHost> {
	return Effect.gen(function* () {
		return yield* (yield* ReleaseHost).smokeReleaseArtifact(input);
	});
}

export function verifyReleaseDirectory(
	outputDir: string,
	version: string
): Effect.Effect<void, Error, ReleaseHost> {
	return Effect.gen(function* () {
		return yield* (yield* ReleaseHost).verifyReleaseDirectory(outputDir, version);
	});
}

export function sha256(bytes: Uint8Array): Effect.Effect<string, Error, ReleaseHost> {
	return Effect.gen(function* () {
		return yield* (yield* ReleaseHost).sha256(bytes);
	});
}

export function hostTargetId(): Effect.Effect<ReleaseTargetId, Error, ReleaseHost> {
	return Effect.gen(function* () {
		return yield* (yield* ReleaseHost).hostTargetId;
	});
}

const versionFlag = Flag.String('version').pipe(Flag.withDescription('Release version'));
const outputFlag = Flag.String('output').pipe(Flag.withDescription('Release output directory'));
const sourceShaFlag = Flag.String('source-sha').pipe(
	Flag.withDescription('Canonical cnap source commit SHA')
);
const akuapkgVersionFlag = Flag.String('akuapkg-version').pipe(
	Flag.withDescription('Version of the package toolchain behind `akua pkg`')
);

const matrixCommand = Command.make('matrix', {}, () =>
	Console.log(JSON.stringify(releaseMatrix()))
).pipe(Command.withDescription('Print the release target matrix as JSON'));

const packageCommand = Command.make(
	'package',
	{
		version: versionFlag,
		outputDir: outputFlag,
		sourceSha: sourceShaFlag,
		akuapkgVersion: akuapkgVersionFlag
	},
	({ version, outputDir, sourceSha, akuapkgVersion }) =>
		packageRelease({ version, outputDir, sourceSha, packageVersion: akuapkgVersion })
).pipe(Command.withDescription('Package all release artifacts'));

const verifyCommand = Command.make(
	'verify',
	{ version: versionFlag, outputDir: outputFlag },
	({ version, outputDir }) => verifyReleaseDirectory(outputDir, version)
).pipe(Command.withDescription('Verify release artifacts'));

const smokeCommand = Command.make(
	'smoke',
	{
		version: versionFlag,
		outputDir: outputFlag,
		archiveSha256: Flag.String('archive-sha256').pipe(
			Flag.withDescription('Expected archive SHA-256 from the admitted manifest')
		),
		targetId: Flag.String('target').pipe(
			Flag.optional,
			Flag.withDescription('Release target to smoke; defaults to the host target')
		)
	},
	({ version, outputDir, targetId, archiveSha256 }) => {
		const target = Option.getOrUndefined(targetId);
		return target === undefined
			? hostTargetId().pipe(
					Effect.flatMap((hostTarget) =>
						smokeReleaseArtifact({
							version,
							outputDir,
							targetId: hostTarget,
							archiveSha256
						})
					)
				)
			: smokeReleaseArtifact({ version, outputDir, targetId: target, archiveSha256 });
	}
).pipe(Command.withDescription('Install and smoke a release artifact'));

const uploadPlanCommand = Command.make(
	'upload-plan',
	{
		version: versionFlag,
		outputDir: outputFlag,
		existingDir: Flag.String('existing').pipe(
			Flag.withDescription('Directory containing already-published assets')
		)
	},
	({ version, outputDir, existingDir }) =>
		planReleaseUploads(outputDir, existingDir, version).pipe(
			Effect.tap((plan) => Console.log(JSON.stringify(plan)))
		)
).pipe(Command.withDescription('Print missing immutable release assets as JSON'));

export const releaseCommand = Command.make('release').pipe(
	Command.withDescription('Package and verify CLI release artifacts'),
	Command.withSubcommands([
		matrixCommand,
		packageCommand,
		verifyCommand,
		smokeCommand,
		uploadPlanCommand
	])
);

if (import.meta.main) {
	Runtime.makeRunMain(({ fiber, teardown }) => {
		fiber.addObserver((exit) =>
			teardown(exit, (code) => {
				process.exitCode = code;
			})
		);
	})(
		Command.run(releaseCommand, { version: '0.9.0' }).pipe(
			Effect.provide(makeReleaseHostLive()),
			Effect.provide(ScriptCliLive)
		)
	);
}
