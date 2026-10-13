import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { VERSION } from '../src/bin/akua';

const readJson = <S extends Schema.Codec<unknown, unknown>>(schema: S, path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
			yield* fs.readFileString(path)
		);
	});

describe('one version for akua-dev/akua', () => {
	it.effect('releases the CLI on the Cargo workspace version, which every manifest carries', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			// akuapkg and the CLI share one version and one `v<version>` tag. The
			// Cargo workspace version is the source the Bazel release reads.
			const cargo = yield* fs.readFileString('../Cargo.toml');
			const workspaceVersion = /\[workspace\.package\][^[]*?\nversion = "([^"]+)"/u.exec(
				cargo
			)?.[1];
			expect(workspaceVersion).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
			const host = yield* readJson(
				Schema.Struct({ version: Schema.String }),
				'../host/package.json'
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
			expect(VERSION).toBe(workspaceVersion);
		}).pipe(Effect.provide(BunServices.layer))
	);
});
