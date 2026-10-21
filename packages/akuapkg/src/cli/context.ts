import { Effect, Stdio, Stream } from "effect"
import type { FetchServices, RenderServices } from "../cli"

/** What every verb is built with. */
export interface VerbContext {
  /** How the CLI presents itself: `akuapkg`, or `akua pkg`. */
  readonly name: string
  readonly version: string
  /** The worker and its dependencies; only verbs that run KCL provide it, so the others never load the addon. */
  readonly services: RenderServices
  /** Dependency resolution alone, for verbs that edit the manifest or lockfile. */
  readonly fetchers: FetchServices
}

/** `text` on stdout exactly as given: no newline added. */
export const writeStdout = (text: string) =>
  Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio
    yield* Stream.make(text).pipe(Stream.run(stdio.stdout()), Effect.orDie)
  })
