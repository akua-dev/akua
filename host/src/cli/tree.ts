import { Effect, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { ExitCode, fail } from "../contract"
import { type Lock, parseLock } from "../lockfile"
import { crdSelector, dependencies, type Dependency, parseManifest } from "../manifest"
import { NOT_FOUND, readOptional } from "./files"
import { verb } from "./report"
import { emit, universal } from "./universal"
import { lockPath, manifestPath } from "./workspace"

interface DependencyRow {
  readonly name: string
  readonly source: string
  readonly source_ref: string
  readonly version?: string
  /** A CRD dependency's `crds` selector. */
  readonly crds?: string
  readonly locked?: { readonly digest: string; readonly signature?: string; readonly replaced_by?: string }
}

const sourceOf = (dependency: Dependency): readonly [string, string] =>
  dependency.oci !== undefined
    ? ["oci", dependency.oci]
    : dependency.git !== undefined
    ? ["git", dependency.git]
    : dependency.path !== undefined
    ? ["path", dependency.path]
    : dependency.repo !== undefined
    ? ["helm", dependency.repo]
    : dependency.url !== undefined
    ? ["url", dependency.url]
    : ["unknown", ""]

const row = (name: string, dependency: Dependency, lock: Option.Option<Lock>): DependencyRow => {
  const [source, sourceRef] = sourceOf(dependency)
  const entry = Option.flatMapNullishOr(lock, (l) => (l.package ?? []).find((p) => p.name === name))
  return {
    name,
    source,
    source_ref: sourceRef,
    ...(dependency.version === undefined ? {} : { version: dependency.version }),
    ...Option.match(Option.fromUndefinedOr(crdSelector(dependency)), { onNone: () => ({}), onSome: (crds) => ({ crds }) }),
    ...Option.match(entry, {
      onNone: () => ({}),
      onSome: (p) => ({
        locked: {
          digest: p.digest,
          ...(p.signature === undefined ? {} : { signature: p.signature }),
          ...(p.replaced === undefined ? {} : { replaced_by: p.replaced.path })
        }
      })
    })
  }
}

/** `sha256:abc123...` as `abc12345`. */
const shortDigest = (digest: string) => (digest.startsWith("sha256:") ? digest.slice(7) : digest).slice(0, 8)

const text = (
  pkg: { readonly name: string; readonly version: string; readonly edition: string },
  rows: ReadonlyArray<DependencyRow>
) =>
  [
    `${pkg.name}@${pkg.version} (${rows.length} deps, edition=${pkg.edition})`,
    ...(rows.length === 0 ? ["  (no dependencies)"] : rows.map((dep) => {
      const locked = dep.locked === undefined
        ? ""
        : ` [locked ${shortDigest(dep.locked.digest)} (${dep.locked.signature === undefined ? "unsigned" : "signed"})]`
      const replaced = dep.locked?.replaced_by === undefined ? "" : ` [replace -> ${dep.locked.replaced_by}]`
      const crds = dep.crds === undefined ? "" : ` [crds ${dep.crds}]`
      return `  - ${dep.name}${dep.version === undefined ? "" : `@${dep.version}`} (${dep.source} ${dep.source_ref})${crds}${locked}${replaced}`
    }))
  ].join("\n")

/** The manifest's declared dependencies and their `akua.lock` entries. */
export const tree = () =>
  Command.make(
    "tree",
    {
      ...universal,
      workspace: Flag.String("workspace").pipe(Flag.withDefault("."), Flag.withDescription("Workspace root"))
    },
    verb(
      "akuapkg.tree",
      Effect.fnUntraced(function*(flags, mode) {
        const path = manifestPath(flags.workspace)
        const source = yield* readOptional(path)
        // Read directly, as before: a missing manifest is an I/O failure here.
        if (Option.isNone(source)) return yield* fail("E_IO", NOT_FOUND, ExitCode.systemError, path)
        const manifest = yield* parseManifest(source.value, path).pipe(
          Effect.mapError((error) => fail("E_MANIFEST_PARSE", error.message, ExitCode.userError))
        )
        const lockFile = lockPath(flags.workspace)
        const lockSource = yield* readOptional(lockFile)
        const lock = Option.isNone(lockSource)
          ? Option.none<Lock>()
          : Option.some(
            yield* parseLock(lockSource.value, lockFile).pipe(
              Effect.mapError((error) => fail("E_LOCK_PARSE", error.message, ExitCode.userError))
            )
          )
        const rows = dependencies(manifest).map(([name, dependency]) => row(name, dependency, lock))
        const pkg = {
          name: manifest.package.name,
          version: manifest.package.version,
          edition: manifest.package.edition
        }
        yield* emit(mode, { package: pkg, dependencies: rows }, () => text(pkg, rows))
      })
    )
  ).pipe(Command.withDescription("Print the workspace's declared deps and lockfile entries"))
