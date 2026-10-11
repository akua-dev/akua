import { Effect, FileSystem, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { renderSummaryJson, usageFailure } from "../contract"
import { renderPackage } from "../render.effect"
import type { VerbContext } from "./context"
import { writeStdout } from "./context"
import { reportable, verb } from "./report"
import { emit, universal } from "./universal"

export const render = (context: VerbContext) =>
  Command.make(
    "render",
    {
      ...universal,
      packagePath: Flag.String("package").pipe(Flag.withDefault("./package.k"), Flag.withDescription("Path to the Package.k")),
      inputs: Flag.String("inputs").pipe(
        Flag.optional,
        Flag.withDescription("Inputs file (JSON or YAML); defaults to inputs.yaml, then inputs.example.yaml")
      ),
      out: Flag.String("out").pipe(Flag.withDefault("./deploy"), Flag.withDescription("Output directory")),
      summaryOut: Flag.String("summary-out").pipe(
        Flag.optional,
        Flag.withDescription("Also write the RenderSummary JSON to this file")
      ),
      dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("Render without writing files")),
      stdout: Flag.Boolean("stdout").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Write the manifests as one YAML stream to stdout instead of --out")
      ),
      strict: Flag.Boolean("strict").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Reject raw-string chart paths; every chart must be an akua.toml dependency")
      ),
      offline: Flag.Boolean("offline").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Resolve dependencies from the vendor tree and cache only")
      ),
      maxDepth: Flag.Int("max-depth").pipe(
        Flag.optional,
        Flag.withDescription("Accepted; pkg.render composition is capped at depth 16")
      ),
      debug: Flag.Boolean("debug").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Under --json, also emit the resources before YAML normalization (`evalResult`)")
      )
    },
    verb(
      "akuapkg.render",
      Effect.fnUntraced(function*(flags, mode) {
        if (Option.isSome(flags.summaryOut) && (flags.dryRun || flags.stdout)) {
          return yield* usageFailure("--summary-out conflicts with --dry-run and --stdout")
        }
        const fs = yield* FileSystem.FileSystem
        // Provided here, not around the command: only a render loads the addon.
        const rendered = yield* renderPackage({
          packagePath: flags.packagePath,
          inputsPath: flags.inputs,
          out: flags.out,
          dryRun: flags.dryRun || flags.stdout,
          strict: flags.strict,
          offline: flags.offline
        }).pipe(Effect.provide(context.services), Effect.mapError(reportable))
        if (flags.stdout) {
          return yield* writeStdout(rendered.documents.map(([, yaml]) => yaml).join("---\n"))
        }
        const { summary } = rendered
        if (Option.isSome(flags.summaryOut)) {
          yield* fs.writeFileString(flags.summaryOut.value, `${JSON.stringify(renderSummaryJson(summary))}\n`).pipe(
            Effect.mapError(reportable)
          )
        }
        yield* emit(
          mode,
          flags.debug ? { summary: renderSummaryJson(summary), evalResult: rendered.resources } : renderSummaryJson(summary),
          () =>
            `${flags.dryRun ? "would render" : "rendered"}: ${summary.manifests} manifest(s) → ${summary.target} ` +
            `(${summary.hash})`
        )
      })
    )
  ).pipe(Command.withDescription("Execute a `package.k` against inputs and write manifests"))
