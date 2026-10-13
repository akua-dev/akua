import { Effect, FileSystem, Stdio, Stream } from "effect"
import { Command } from "effect/cli"
import { HostError } from "../errors"
import { bareTree, RenderWorker } from "../worker.effect"
import type { VerbContext } from "./context"
import { writeStdout } from "./context"
import { NOT_FOUND } from "./files"
import { reportable, verb } from "./report"
import { universal } from "./universal"

const encoder = new TextEncoder()

/** KCL rejects file names ending in `>`, so every evaluation is `repl.k`. */
const FILENAME = "repl.k"

const HELP = "meta commands: .load <path> | .reset | .show | .help | .exit"

/** What one line of input does: print `text`, print nothing, or end the session. */
type Step =
  | { readonly _tag: "Print"; readonly text: string }
  | { readonly _tag: "Nothing" }
  | { readonly _tag: "Quit" }

const print = (text: string): Step => ({ _tag: "Print", text })

/**
 * Interactive KCL: every submitted line is appended to a buffer that is
 * re-evaluated whole, and the top-level bindings are printed as YAML. A line
 * that fails to evaluate is reported and dropped from the buffer.
 */
export const repl = (context: VerbContext) =>
  Command.make(
    "repl",
    universal,
    verb(
      "akuapkg.repl",
      Effect.fnUntraced(function*(_flags, mode) {
        const fs = yield* FileSystem.FileSystem
        const stdio = yield* Stdio.Stdio
        let buffer = ""

        const session = Effect.gen(function*() {
          const worker = yield* RenderWorker

          /** Evaluate the buffer with `addition`; keep it only if it evaluates. */
          const extend = (addition: string) => {
            const trial = `${buffer}${addition}\n`
            return worker.evaluate({
              tree: bareTree(FILENAME, new Map([[FILENAME, encoder.encode(trial)]])),
              filename: FILENAME,
              inputs: {}
            }).pipe(
              Effect.map((yaml) => {
                buffer = trial
                return print(yaml)
              }),
              Effect.catch((error) => Effect.succeed(print(`error: ${error.message}`)))
            )
          }

          const meta = (command: string): Effect.Effect<Step> => {
            const space = command.search(/\s/)
            const name = space === -1 ? command : command.slice(0, space)
            const argument = space === -1 ? "" : command.slice(space + 1).trim()
            switch (name) {
              case "exit":
              case "quit":
                return Effect.succeed({ _tag: "Quit" })
              case "reset":
                buffer = ""
                return Effect.succeed(print("(buffer cleared)"))
              case "show":
                return Effect.succeed(print(buffer === "" ? "(empty buffer)" : buffer))
              case "help":
                return Effect.succeed(print(HELP))
              case "load":
                return argument === ""
                  ? Effect.succeed(print("usage: .load <path>"))
                  : fs.readFileString(argument).pipe(
                    Effect.matchEffect({
                      onFailure: (error) =>
                        Effect.succeed(print(`error: ${error.reason._tag === "NotFound" ? NOT_FOUND : error.message}`)),
                      onSuccess: extend
                    })
                  )
              default:
                return Effect.succeed(print(`unknown meta command \`.${name}\``))
            }
          }

          const handle = (line: string): Effect.Effect<Step> => {
            const trimmed = line.trim()
            if (trimmed === "") return Effect.succeed({ _tag: "Nothing" })
            return trimmed.startsWith(".") ? meta(trimmed.slice(1)) : extend(line)
          }

          yield* writeStdout(
            mode === "json"
              ? "{\"note\":\"akuapkg repl is interactive; JSON output is not supported - falling back to text\"}\n"
              : "akuapkg repl - KCL interactive (type `.exit` or Ctrl-D to quit, `.help` for commands)\n"
          )
          yield* writeStdout("> ")
          let quit = false
          yield* stdio.stdin.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.mapEffect(handle),
            Stream.takeUntil((step) => step._tag === "Quit"),
            Stream.runForEach((step) => {
              if (step._tag === "Quit") {
                quit = true
                return Effect.void
              }
              const text = step._tag === "Print" ? (step.text.endsWith("\n") ? step.text : `${step.text}\n`) : ""
              return writeStdout(`${text}> `)
            })
          )
          // End of input: finish the prompt line, so piped scripts end cleanly.
          if (!quit) yield* writeStdout("\n")
        })

        yield* session.pipe(
          Effect.provide(context.services),
          Effect.mapError((error) => reportable(HostError.from(error)))
        )
      })
    )
  ).pipe(Command.withDescription("Interactive KCL shell (`.help` lists meta commands)"))
