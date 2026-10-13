import { Effect, FileSystem, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ExitCode, fail } from "../contract"
import { osMessage } from "../errors"
import { formatLock, LOCK_VERSION } from "../lockfile"
import { isValidPackageName } from "../manifest"
import type { VerbContext } from "./context"
import { verb } from "./report"
import { emit, universal } from "./universal"

/**
 * The typed Kubernetes schemas every scaffold depends on: the KCL
 * ecosystem's `k8s` module, one tag per Kubernetes release.
 */
export const K8S_TYPES_OCI = "oci://ghcr.io/kcl-lang/k8s"

/**
 * The Kubernetes version a new Package is typed against: the oldest minor
 * still supported upstream, so what renders applies to every supported
 * cluster. `akua.lock` pins its digest from the start; `--k8s` picks another
 * version (then `akuapkg lock` pins it).
 */
export const DEFAULT_K8S_VERSION = "1.35"
const DEFAULT_K8S_DIGEST = "sha256:078b87bde17d1e1ec6670372e82de668bdbac36417878bb89fe3385d605759b7"

const PACKAGE_K = `# Minimal Package.k - edit me.
#
# Resources are typed by the \`k8s\` dependency in akua.toml (the schemas of
# one Kubernetes version): a misspelled field, a wrong type or an API the
# version does not serve fails the render instead of reaching a cluster.
# See docs/package-format.md and docs/typed-resources.md.
import akua.ctx
import k8s.api.core.v1 as corev1

schema Input:
    """Public inputs for this Package."""
    appName: str
    """Application name. Used as resource-name prefix."""

    replicas: int = 2
    """Number of replicas."""

    check:
        replicas >= 1, "replicas must be at least 1"

input: Input = ctx.input()

resources = [corev1.ConfigMap {
    metadata.name = input.appName
    data.replicas = str(input.replicas)
}]
`

const INPUTS_EXAMPLE = `appName: hello
replicas: 3
`

const akuaToml = (name: string, k8s: string, cli: string) =>
  `[package]\nname    = "${name}"\nversion = "0.1.0"\nedition = "akua.dev/v1alpha1"\n\n[dependencies]\n` +
  `# Typed Kubernetes schemas; switch versions with \`${cli} add k8s --k8s <version> --force\`.\n` +
  `k8s = { oci = "${K8S_TYPES_OCI}", version = "${k8s}" }\n`

const akuaLock = (cli: string) =>
  formatLock({
    version: LOCK_VERSION,
    package: [{ name: "k8s", version: DEFAULT_K8S_VERSION, source: K8S_TYPES_OCI, digest: DEFAULT_K8S_DIGEST }]
  }, cli)

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

/**
 * Scaffold a new Package: `akua.toml` with the typed Kubernetes schemas as
 * its one dependency, `akua.lock` pinning them (default version), a typed
 * `package.k` and `inputs.example.yaml`. No network.
 */
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
      ),
      k8s: Flag.String("k8s").pipe(
        Flag.withDefault(DEFAULT_K8S_VERSION),
        Flag.withDescription(
          `Kubernetes version the Package's resources are typed against: a \`${K8S_TYPES_OCI}\` tag ` +
            `(default \`${DEFAULT_K8S_VERSION}\`, pinned in akua.lock; run \`lock\` to pin another)`
        )
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
        // Only the default version's digest is known without the network.
        const lock: ReadonlyArray<readonly [string, string]> = flags.k8s === DEFAULT_K8S_VERSION
          ? [["akua.lock", akuaLock(context.name)]]
          : []
        const files: ReadonlyArray<readonly [string, string]> = [
          ["akua.toml", akuaToml(name, flags.k8s, context.name)],
          ...lock,
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
