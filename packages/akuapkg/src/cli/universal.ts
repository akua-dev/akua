import { Console, Effect, Option } from "effect"
import { Flag } from "effect/cli"
import { agentDetected } from "../agent"

/**
 * The flags every verb accepts (cli-contract §1), as the previous release
 * did. Most only shape logging and interactivity, which this build does not
 * have, so they are accepted and change nothing.
 */
export const universal = {
  json: Flag.Boolean("json").pipe(
    Flag.optional,
    Flag.withDescription("Emit structured JSON to stdout (§1.1); default for agents, `--no-json` forces text")
  ),
  plan: Flag.Boolean("plan").pipe(Flag.withDefault(false), Flag.withDescription("Compute the plan; do not write (§4)")),
  timeout: Flag.String("timeout").pipe(
    Flag.optional,
    Flag.withDescription("Wall-clock cap (§5); renders are bounded by fuel instead")
  ),
  idempotencyKey: Flag.String("idempotency-key").pipe(
    Flag.optional,
    Flag.withDescription("Retry-safe key for write operations (§3)")
  ),
  log: Flag.Literals("log", ["text", "json"]).pipe(Flag.optional, Flag.withDescription("Structured log format to stderr")),
  logLevel: Flag.Literals("log-level", ["debug", "info", "warn", "error"]).pipe(
    Flag.optional,
    Flag.withDescription("Log level")
  ),
  verbose: Flag.Boolean("verbose").pipe(
    Flag.withAlias("v"),
    Flag.withDefault(false),
    Flag.withDescription("More detail in logs (does not change stdout format)")
  ),
  noColor: Flag.Boolean("no-color").pipe(Flag.withDefault(false), Flag.withDescription("Disable color codes")),
  noProgress: Flag.Boolean("no-progress").pipe(Flag.withDefault(false), Flag.withDescription("Disable progress output")),
  noInteractive: Flag.Boolean("no-interactive").pipe(Flag.withDefault(false), Flag.withDescription("Never prompt")),
  noAgentMode: Flag.Boolean("no-agent-mode").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Ignore agent-context detection")
  )
}

export type OutputMode = "json" | "text"

/** `--json` / `--no-json` decide; otherwise JSON when an agent runs us (unless `--no-agent-mode`). */
export const outputMode = Effect.fnUntraced(function*(
  flags: { readonly json: Option.Option<boolean>; readonly noAgentMode: boolean }
) {
  if (Option.isSome(flags.json)) return flags.json.value ? "json" : "text"
  return !flags.noAgentMode && (yield* agentDetected) ? "json" : "text"
})

/** One line of compact JSON, or the human text. */
export const emit = (mode: OutputMode, value: unknown, text: () => string) =>
  Console.log(mode === "json" ? JSON.stringify(value) : text())
