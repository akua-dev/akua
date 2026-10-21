import { Effect, FileSystem } from "effect"
import { osMessage } from "../errors"
import { Command, Flag } from "effect/cli"
import { ExitCode, ExitWith, fail } from "../contract"
import { RenderWorker } from "../worker.effect"
import { type VerbContext, writeStdout } from "./context"
import { missingPackage, NOT_FOUND } from "./files"
import { reportable, verb } from "./report"
import { emit, universal } from "./universal"

export const fmt = (context: VerbContext) =>
  Command.make(
    "fmt",
    {
      ...universal,
      packagePath: Flag.String("package").pipe(Flag.withDefault("./package.k"), Flag.withDescription("Path to the `package.k` file")),
      check: Flag.Boolean("check").pipe(Flag.withDefault(false), Flag.withDescription("Exit 1 if the file would change; don't write")),
      stdout: Flag.Boolean("stdout").pipe(Flag.withDefault(false), Flag.withDescription("Print formatted source to stdout; don't write"))
    },
    verb(
      "akuapkg.fmt",
      Effect.fnUntraced(function*(flags, mode) {
        const fs = yield* FileSystem.FileSystem
        const original = yield* fs.readFileString(flags.packagePath).pipe(
          Effect.mapError((error) =>
            error.reason._tag === "NotFound"
              ? missingPackage(flags.packagePath, NOT_FOUND)
              : fail("E_IO", osMessage(error), ExitCode.systemError, flags.packagePath)
          )
        )
        const formatted = yield* RenderWorker.pipe(
          Effect.flatMap((worker) => worker.format(original)),
          Effect.catchTag("RenderError", (error) => Effect.fail(fail("E_FMT_KCL", error.message, ExitCode.userError))),
          Effect.provide(context.services),
          Effect.mapError((error) => error._tag === "CliFailure" ? error : reportable(error))
        )
        if (flags.stdout) return yield* writeStdout(formatted)
        const changed = formatted !== original
        if (changed && !flags.check) {
          yield* fs.writeFileString(flags.packagePath, formatted).pipe(Effect.mapError(reportable))
        }
        const verb = flags.check ? (changed ? "would reformat" : "ok") : changed ? "formatted" : "unchanged"
        yield* emit(mode, { files: [{ path: flags.packagePath, changed }] }, () => `${verb}: ${flags.packagePath}`)
        if (flags.check && changed) return yield* new ExitWith({ exitCode: ExitCode.userError })
      })
    )
  ).pipe(Command.withDescription("Format a `package.k` via KCL's canonical formatter"))
