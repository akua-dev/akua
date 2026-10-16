#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Effect, type Layer, Stdio } from 'effect';

import { runAkua } from '../cli/main';
import { ExitStatus } from '../runtime/exit-codes';
import { CliLive, type CliPlatform, PackageCliLive } from '../runtime/services-live';
import type { CliServices, PackageCli } from '../runtime/services';

export const VERSION = '0.13.2'; // the Cargo workspace version (test/version.test.ts)

export function main(argv: readonly string[]): Effect.Effect<number, never, CliServices> {
	return runAkua(argv, VERSION);
}

/**
 * `akua` over the process arguments, with `akua pkg` served by `packageCli`.
 * A non-zero exit code is an `ExitStatus` failure, which `runMain` applies.
 */
export const akuaProgram = (packageCli: Layer.Layer<PackageCli, never, CliPlatform>) =>
	Effect.gen(function* () {
		const stdio = yield* Stdio.Stdio;
		const code = yield* main(yield* stdio.args);
		if (code !== 0) return yield* new ExitStatus({ code });
	}).pipe(Effect.provide(CliLive(VERSION, packageCli)), Effect.provide(BunServices.layer));

if (import.meta.main) BunRuntime.runMain(akuaProgram(PackageCliLive));
