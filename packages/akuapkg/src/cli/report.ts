import { Console, Effect, type Option } from "effect"
import type { CliError } from "effect/cli"
import { CliFailure, type StructuredError, toCliFailure, usageFailure } from "../contract"
import { HostError } from "../errors"
import { type OutputMode, outputMode } from "./universal"

/**
 * KCL formats its diagnostics with ANSI colour codes whatever the output is.
 * Errors leave this CLI as JSON or plain text, never coloured, so the codes
 * are dropped (a pipe, a log file, `NO_COLOR` or an agent never sees them).
 */
const ansi = new RegExp(String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]`, "g")
const plain = (error: StructuredError): StructuredError => ({ ...error, message: error.message.replace(ansi, "") })

/** A structured error as people read it: `error[CODE]: message` and its details. */
const errorText = (error: StructuredError) =>
  [
    `error[${error.code}]: ${error.message}`,
    ...(error.path === undefined ? [] : [`  at ${error.path}`]),
    ...(error.suggestion === undefined ? [] : [`  suggestion: ${error.suggestion}`]),
    ...(error.docs === undefined ? [] : [`  docs: ${error.docs}`])
  ].join("\n")

/**
 * Print a structured error on stderr (one JSON line, or text) before failing
 * with its exit code. Other failures (`ExitWith`) carry only an exit code.
 */
export const reportedAs = (mode: OutputMode) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((failure) =>
      failure instanceof CliFailure
        ? Console.error(mode === "json" ? JSON.stringify(plain(failure.error)) : errorText(plain(failure.error)))
        : Effect.void
    )
  )

/** `reportedAs` JSON, for failures before a verb knows its mode. */
export const reported = reportedAs("json")

/**
 * A verb's handler: its output mode from the universal flags, then `body`,
 * with failures reported in that mode.
 */
export const verb = <F extends { readonly json: Option.Option<boolean>; readonly noAgentMode: boolean }, A, E, R>(
  name: string,
  body: (flags: F, mode: OutputMode) => Effect.Effect<A, E, R>
) =>
  Effect.fn(name)(function*(flags: F) {
    const mode = yield* outputMode(flags)
    return yield* body(flags, mode).pipe(reportedAs(mode))
  })

/** A host failure as the contract reports it. */
export const reportable = (error: Parameters<typeof HostError.from>[0]) => toCliFailure(HostError.from(error))

/**
 * Flag parse errors as the contract reports them: one structured error on
 * stderr, not prose. A help request (no parse errors) already printed its help.
 */
export const reportUsage = (error: CliError.CliError): Effect.Effect<void, CliFailure> =>
  error._tag === "ShowHelp" && error.errors.length === 0
    ? Effect.void
    : reported(
      Effect.fail(
        usageFailure(error._tag === "ShowHelp" ? error.errors.map((e) => e.message).join("; ") : error.message)
      )
    )
