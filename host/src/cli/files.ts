import { Effect, FileSystem, Option, Path } from "effect"
import { osMessage } from "../errors"
import { ExitCode, fail } from "../contract"
import { bareTree, RenderWorker } from "../worker.effect"

const encoder = new TextEncoder()

/** `base.join(rel)` as the previous release printed paths: `./` and `./package.k` give `././package.k`. */
export const joinPath = (base: string, rel: string) =>
  rel.startsWith("/") ? rel : base.endsWith("/") ? `${base}${rel}` : `${base}/${rel}`

/** The file's text, or none when it does not exist; other failures are E_IO. */
export const readOptional = Effect.fnUntraced(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path).pipe(
    Effect.map(Option.some),
    Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed(Option.none<string>())),
    Effect.mapError((error) => fail("E_IO", osMessage(error), ExitCode.systemError, path))
  )
})

/** A Package file a verb needs, missing: E_PACKAGE_MISSING with `message`. */
export const missingPackage = (path: string, message = `${path} not found`) =>
  fail("E_PACKAGE_MISSING", message, ExitCode.userError, path)

/** What the previous release said for a file it could not open. */
export const NOT_FOUND = "No such file or directory (os error 2)"

/**
 * Lint `source` with its imports resolved as a render would resolve them,
 * against the `akua.toml` in `workspace`, offline (a lint never fetches).
 * Dependencies that cannot be resolved that way are left out, and their
 * imports report as unresolved.
 */
export const lintWithDependencies = Effect.fnUntraced(function*(
  request: { readonly workspace: string; readonly packagePath: string; readonly source: string }
) {
  const path = yield* Path.Path
  const worker = yield* RenderWorker
  const filename = path.basename(request.packagePath)
  const files = new Map([[filename, encoder.encode(request.source)]])
  return yield* Effect.scoped(
    Effect.gen(function*() {
      const tree = yield* worker.prepare({ workspace: request.workspace, filename, files, options: { offline: true } })
        .pipe(Effect.orElseSucceed(() => bareTree(filename, files)))
      // Diagnostics name the absolute path, as before.
      return yield* worker.lint({ tree, filename: path.resolve(request.packagePath) })
    })
  )
})
