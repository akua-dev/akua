import { Effect, FileSystem, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ExitCode, fail } from "../contract"
import { osMessage } from "../errors"
import { isValidPackageName } from "../manifest"
import type { VerbContext } from "./context"
import { verb } from "./report"
import { emit, universal } from "./universal"

const PACKAGE_K = `# Minimal Package.k - edit me.
#
# See docs/package-format.md for the full authoring reference.

import akua.ctx

schema Input:
    """Public inputs for this Package."""

    appName: str
    """Application name. Used as resource-name prefix."""

    replicas: int = 2
    """Number of replicas."""

    check:
        replicas >= 1, "replicas must be at least 1"

input: Input = ctx.input()

resources = [{
    apiVersion: "v1"
    kind: "ConfigMap"
    metadata.name: input.appName
    data.replicas: str(input.replicas)
}]
`

const INPUTS_EXAMPLE = `appName: hello
replicas: 3
`

const akuaToml = (name: string) =>
  `[package]\nname    = "${name}"\nversion = "0.1.0"\nedition = "akua.dev/v1alpha1"\n\n[dependencies]\n`

/**
 * Coerce a directory name into a valid package name: ASCII lowercased, every
 * other character but `_` and `-` replaced by `_`, leading hyphens dropped.
 * Empty when nothing usable remains.
 */
export const sanitizePackageName = (raw: string) =>
  Array.from(raw, (char) => {
    const lower = /[A-Z]/.test(char) ? char.toLowerCase() : char
    return /[a-z0-9_-]/.test(lower) ? lower : "_"
  }).join("").replace(/^-+/, "")

/** `target/file` as the previous release spelled it: the target exactly as given. */
const within = (target: string, file: string) => (target.endsWith("/") ? `${target}${file}` : `${target}/${file}`)

const io = (path: string) => (error: { readonly message: string; readonly reason?: { readonly _tag: string } }) =>
  fail("E_IO", osMessage(error), ExitCode.systemError, path)

/** The current directory, resolved so `.` has a basename, and the package name it implies. */
const fromCwd = Effect.fnUntraced(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cwd = yield* fs.realPath(".").pipe(Effect.orElseSucceed(() => path.resolve(".")))
  return { target: cwd, name: sanitizePackageName(path.basename(cwd)) }
})

/**
 * Where `init` writes and the `[package].name` it records:
 * - no name, `.` or `./`: the current directory, named after its basename;
 * - a valid package name: `./<name>/`, named as given;
 * - anything else: used as a path, named after its sanitized basename.
 */
const initTarget = Effect.fnUntraced(function*(name: Option.Option<string>) {
  const path = yield* Path.Path
  if (Option.isNone(name) || name.value === "." || name.value === "./") return yield* fromCwd()
  if (isValidPackageName(name.value)) return { target: name.value, name: name.value }
  return { target: name.value, name: sanitizePackageName(path.basename(name.value)) }
})

/** Scaffold a new Package: `akua.toml`, `package.k` and `inputs.example.yaml`. */
export const init = (context: VerbContext) =>
  Command.make(
    "init",
    {
      ...universal,
      name: Argument.String("name").pipe(
        Argument.optional,
        Argument.withDescription(
          "Name for the new Package, and the directory created for it; absent, the current directory and its basename"
        )
      ),
      force: Flag.Boolean("force").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Overwrite existing scaffold files instead of aborting")
      )
    },
    verb(
      "akuapkg.init",
      Effect.fnUntraced(function*(flags, mode) {
        const fs = yield* FileSystem.FileSystem
        const { name, target } = yield* initTarget(flags.name)
        if (name === "") {
          return yield* fail(
            "E_INIT_EMPTY_NAME",
            "package name must be non-empty",
            ExitCode.userError,
            undefined,
            `pass \`${context.name} init <name>\` or run from a named directory`
          )
        }
        yield* fs.makeDirectory(target, { recursive: true }).pipe(Effect.mapError(io(target)))
        const files: ReadonlyArray<readonly [string, string]> = [
          ["akua.toml", akuaToml(name)],
          ["package.k", PACKAGE_K],
          ["inputs.example.yaml", INPUTS_EXAMPLE]
        ]
        if (!flags.force) {
          for (const [file] of files) {
            const existing = within(target, file)
            if (yield* fs.exists(existing).pipe(Effect.orElseSucceed(() => false))) {
              return yield* fail(
                "E_INIT_EXISTS",
                "target directory already contains scaffold files",
                ExitCode.userError,
                existing,
                "pass --force to overwrite, or pick a different directory"
              )
            }
          }
        }
        for (const [file, contents] of files) {
          const destination = within(target, file)
          yield* fs.writeFileString(destination, contents).pipe(Effect.mapError(io(destination)))
        }
        const resolved = yield* fs.realPath(target).pipe(Effect.orElseSucceed(() => target))
        const output = { name, path: resolved, files: files.map(([file]) => file) }
        yield* emit(
          mode,
          output,
          () => [`scaffolded ${name} at ${resolved}`, ...output.files.map((file) => `  + ${file}`)].join("\n")
        )
      })
    )
  ).pipe(Command.withDescription("Scaffold a new Package"))
