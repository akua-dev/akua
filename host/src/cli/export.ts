import { Effect, FileSystem, Option, Path } from "effect"
import { osMessage } from "../errors"
import { Command, Flag } from "effect/cli"
import { ExitCode, fail } from "../contract"
import { RenderWorker } from "../worker.effect"
import type { VerbContext } from "./context"
import { missingPackage, NOT_FOUND } from "./files"
import { reportable, verb } from "./report"
import { emit, universal } from "./universal"

/** The `Input` schema as JSON Schema 2020-12 or OpenAPI 3.1. */
export const exportSchema = (context: VerbContext) =>
  Command.make(
    "export",
    {
      ...universal,
      packagePath: Flag.String("package").pipe(Flag.withDefault("./package.k"), Flag.withDescription("Path to the `package.k` file")),
      format: Flag.Literals("format", ["json-schema", "openapi"]).pipe(
        Flag.withDefault("json-schema"),
        Flag.withDescription("JSON Schema 2020-12, or OpenAPI 3.1 with Input under `components.schemas`")
      ),
      out: Flag.String("out").pipe(Flag.optional, Flag.withDescription("Write the schema to this path instead of stdout"))
    },
    verb(
      "akuapkg.export",
      Effect.fnUntraced(function*(flags, mode) {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const source = yield* fs.readFileString(flags.packagePath).pipe(
          Effect.mapError((error) =>
            error.reason._tag === "NotFound"
              ? missingPackage(flags.packagePath, NOT_FOUND)
              : fail("E_IO", osMessage(error), ExitCode.systemError, flags.packagePath)
          )
        )
        const schema = yield* RenderWorker.pipe(
          Effect.flatMap((worker) => Effect.scoped(Effect.gen(function*() {
            const filename = path.basename(flags.packagePath)
            const tree = yield* worker.prepare({
              workspace: path.dirname(path.resolve(flags.packagePath)),
              filename,
              files: new Map([[filename, new TextEncoder().encode(source)]]),
              options: { offline: true }
            })
            return yield* worker.exportSchema({ filename, tree, format: flags.format })
          }))),
          Effect.catchTag("RenderError", (error) => Effect.fail(fail("E_RENDER_KCL", error.message, ExitCode.userError))),
          Effect.provide(context.services),
          Effect.mapError((error) => error._tag === "CliFailure" ? error : reportable(error))
        )
        const pretty = JSON.stringify(schema, null, 2)
        const envelope = { format: flags.format, schema }
        if (Option.isSome(flags.out)) {
          const out = flags.out.value
          const body = `${pretty}\n`
          yield* fs.writeFileString(out, body).pipe(
            Effect.mapError((error) => fail("E_IO", osMessage(error), ExitCode.systemError, out))
          )
          return yield* emit(mode, envelope, () => `wrote ${out} (${new TextEncoder().encode(body).length} bytes)`)
        }
        yield* emit(mode, envelope, () => pretty)
      })
    )
  ).pipe(Command.withDescription("Emit the Package's `Input` schema (JSON Schema / OpenAPI)"))
