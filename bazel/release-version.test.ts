import { BunServices } from '@effect/platform-bun';
import { Config, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from '@effect/vitest';

it.effect('generates every distribution manifest from the release build input', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const version = yield* Config.String('AKUA_EXPECTED_RELEASE_VERSION');
		const manifest = Schema.Struct({ version: Schema.Literal(version) });
		for (const file of [
			'packages/akuapkg/package.json',
			'packages/cli/package.json',
			'plugins/akuapkg/plugin.json'
		]) {
			yield* Schema.decodeUnknownEffect(Schema.fromJsonString(manifest))(
				yield* fs.readFileString(`bazel/release-manifests/${file}`)
			);
		}
		const dependencies: ReadonlyArray<readonly [string, string]> = [
			['package.json', '@akua-dev/cli'],
			['packages/cli/package.json', '@akua-dev/sdk']
		];
		for (const [file, dependency] of dependencies) {
			const result = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(
					Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) })
				)
			)(yield* fs.readFileString(`bazel/release-manifests/${file}`));
			expect(result.dependencies[dependency]).toBe(version);
		}
		const text = yield* fs.readFileString('bazel/release-manifests/Cargo.toml');
		const parsed = yield* Effect.try(() => Bun.TOML.parse(text));
		yield* Schema.decodeUnknownEffect(
			Schema.Struct({
				workspace: Schema.Struct({ package: manifest })
			})
		)(parsed);
	}).pipe(Effect.provide(BunServices.layer))
);
