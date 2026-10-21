import { Schema } from 'effect';
import { defineConfig } from 'vitest/config';

/**
 * Vitest replaces `bun test` as this package's test runner. Effect is this
 * CLI's control-flow model end to end (see AGENTS.md), so tests need
 * `@effect/vitest`'s `it.effect`/`TestClock` primitives, which only run
 * under vitest, not `bun:test`. Tests still execute inside the Bun process
 * (`bun run test` -> `vitest run`), so `Bun.spawn` and other Bun globals used
 * by process-boundary tests remain available.
 */
const TestInclude = Schema.Array(Schema.String);

export default defineConfig({
	test: {
		include: Schema.decodeUnknownSync(TestInclude)(['test/**/*.test.ts']),
		environment: 'node',
		testTimeout: 30_000
	}
});
