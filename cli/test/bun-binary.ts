import { Schema } from 'effect';

/**
 * Resolves the bun executable used by tests that spawn a subprocess running
 * Bun (either the `akua` CLI or an ad-hoc Bun-executed tool). `bun run`/`npm
 * run` set `npm_execpath` to the fully resolved bun binary, which avoids
 * resolving `bun` through PATH on every spawned process and stays correct
 * now that tests run inside a vitest worker (a real Node process, not Bun)
 * rather than `bun test`.
 */
const BunBinaryPath = Schema.String;

export function resolveBunBinary(): string {
	return Schema.decodeUnknownSync(BunBinaryPath)(process.env.npm_execpath ?? 'bun');
}
