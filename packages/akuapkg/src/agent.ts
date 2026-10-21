import { Config, Effect, Option } from "effect"

/**
 * Whether an agent runs this process: `AGENT`, `CLAUDECODE`, `GEMINI_CLI`,
 * `CURSOR_CLI` or `AKUA_AGENT` is set, unless `AKUA_NO_AGENT_DETECT` is.
 * Agents get JSON output by default and cannot apply `replace` overrides.
 */
export const agentDetected = Effect.gen(function*() {
  const env = (name: string) =>
    Config.String(name).pipe(Config.option, Effect.orDie, Effect.map(Option.filter((value) => value !== "")))
  if (Option.isSome(yield* env("AKUA_NO_AGENT_DETECT"))) return false
  const agents = yield* Effect.forEach(["AGENT", "CLAUDECODE", "GEMINI_CLI", "CURSOR_CLI", "AKUA_AGENT"], env)
  return agents.some(Option.isSome)
})
