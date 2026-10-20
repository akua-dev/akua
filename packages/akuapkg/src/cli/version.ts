import { Effect } from "effect"
import { Command } from "effect/cli"
import type { VerbContext } from "./context"
import { emit, outputMode, universal } from "./universal"

export const versionVerb = (context: VerbContext) =>
  Command.make(
    "version",
    universal,
    Effect.fn("akuapkg.version")(function*(flags) {
      yield* emit(yield* outputMode(flags), { version: context.version }, () => `akua ${context.version}`)
    })
  ).pipe(Command.withDescription("Print the package toolchain version"))
