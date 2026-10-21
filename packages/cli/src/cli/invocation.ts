import { Context, Effect, Ref } from 'effect';

import { type CliFailure, runCli } from '../runtime/effect-runtime';
import type { OutputMode } from '../runtime/mode';
import type { RenderEnvelope } from '../runtime/render';
import type { Console } from '../runtime/services';

/**
 * One run of the `akua` binary: the output mode chosen before parsing
 * (flags, environment, and TTY) and the exit code the command settles on.
 */
export class Invocation extends Context.Service<
	Invocation,
	{
		readonly mode: OutputMode;
		readonly exitCode: Ref.Ref<number>;
	}
>()('platform/cli/Invocation') {}

/**
 * The single boundary every command handler ends in: renders the result or
 * the failure for the active output mode and records the exit code.
 */
export const respond = Effect.fnUntraced(function* <R>(
	program: Effect.Effect<RenderEnvelope<CliFailure>, CliFailure, R>
): Effect.fn.Return<void, never, R | Invocation | Console> {
	const invocation = yield* Invocation;
	const code = yield* runCli(program, { mode: invocation.mode });
	yield* Ref.set(invocation.exitCode, code);
});
