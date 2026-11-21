#!/usr/bin/env bun
import { BunCrypto, BunRuntime, BunServices } from '@effect/platform-bun';
import { Effect, Layer, Stdio } from 'effect';

import { runAkua } from '../cli/main';
import { ExitStatus } from '../runtime/exit-codes';
import { CliLive, type CliPlatform, PackageCliLive } from '../runtime/services-live';
import type { CliServices, PackageCli } from '../runtime/services';

export const VERSION = '0.0.0-dev';

export function main(
	argv: readonly string[],
	version = VERSION
): Effect.Effect<number, never, CliServices> {
	return runAkua(argv, version);
}

/**
 * `akua` over the process arguments, with `akua pkg` served by `packageCli`.
 * A non-zero exit code is an `ExitStatus` failure, which `runMain` applies.
 */
export const akuaProgram = (
	packageCli: Layer.Layer<PackageCli, never, CliPlatform>,
	version = VERSION
) =>
	Effect.gen(function* () {
		const stdio = yield* Stdio.Stdio;
		const code = yield* main(yield* stdio.args, version);
		if (code !== 0) return yield* new ExitStatus({ code });
	}).pipe(
		Effect.provide(CliLive(version, packageCli)),
		Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer))
	);

if (import.meta.main) BunRuntime.runMain(akuaProgram(PackageCliLive));
