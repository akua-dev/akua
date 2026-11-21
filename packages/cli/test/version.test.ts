import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { describe, expect, it } from '@effect/vitest';

import { resolveBunBinary } from './bun-binary';

const readJson = Effect.fn('readVersionManifest')(function* <
	S extends Schema.Codec<unknown, unknown>
>(schema: S, path: string) {
	const fs = yield* FileSystem.FileSystem;
	return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
		yield* fs.readFileString(path)
	);
});

describe('one version for akua-dev/akua', () => {
	it.effect('keeps development workspace identities independent of the release version', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			// Workspace identities are not release identities. Bazel generates
			// distribution manifests and the executable entry from version.bzl.
			const cargoText = yield* fs.readFileString('../../Cargo.toml');
			const cargo = yield* Schema.decodeUnknownEffect(
				Schema.Struct({
					workspace: Schema.Struct({ package: Schema.Struct({ version: Schema.String }) })
				})
			)(yield* Effect.try(() => Bun.TOML.parse(cargoText)));
			const workspaceVersion = cargo.workspace.package.version;
			expect(workspaceVersion).toBe('0.0.0-dev');
			expect(workspaceVersion).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
			const host = yield* readJson(
				Schema.Struct({ version: Schema.String }),
				'../akuapkg/package.json'
			);
			const packageManifest = yield* readJson(
				Schema.Struct({
					version: Schema.String,
					dependencies: Schema.Struct({ '@akua-dev/sdk': Schema.String })
				}),
				'package.json'
			);
			expect(packageManifest.version).toBe(workspaceVersion);
			expect(host.version).toBe(workspaceVersion);
			expect(packageManifest.dependencies['@akua-dev/sdk']).toBe(workspaceVersion);
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const child = yield* spawner.spawn(
				ChildProcess.make(resolveBunBinary(), ['src/bin/akua.ts', '--version', '--json'], {
					stdin: 'ignore'
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
			expect(Number(exitCode)).toBe(0);
			expect(stderr).toBe('');
			const reported = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(
					Schema.Struct({
						status: Schema.Literal('ok'),
						command: Schema.Literal('akua --version'),
						data: Schema.Struct({ version: Schema.String })
					})
				)
			)(stdout);
			expect(reported.data.version).toBe(workspaceVersion);
		}).pipe(Effect.scoped, Effect.provide(BunServices.layer))
	);
});
