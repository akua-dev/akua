import { Effect, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { ExitCode, fail } from "../contract"
import type { ResolvedDependency } from "../dependencies.effect"
import { lockBody, mergeIntoLock } from "../lockfile"
import type { VerbContext } from "./context"
import { joinPath, readOptional } from "./files"
import { verb } from "./report"
import { emit, universal } from "./universal"
import {
  checkGeneratedCrds,
  generateCrds,
  loadManifestForLock,
  lockUpdates,
  priorLock,
  resolveForLock,
  saveLock,
  syncGeneratedCrds
} from "./workspace"

/** The roots of the leading `import` lines (`import a.b` gives `a`), as the previous release scanned them. */
export const importRoots = (source: string) => {
  const roots: Array<string> = []
  if (!source.includes("import ")) return roots
  for (const line of source.split("\n")) {
    const trimmed = line.trimStart()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    if (!trimmed.startsWith("import ")) break
    const path = /^[^\s#]*/.exec(trimmed.slice("import ".length))?.[0] ?? ""
    const root = path.split(".")[0] ?? ""
    if (root !== "") roots.push(root)
  }
  return roots
}

/** A dependency `import`ed by name must be a KCL module or Akua Package, not a Helm chart. */
const importedChart = (source: string, resolved: ReadonlyArray<ResolvedDependency>) =>
  importRoots(source)
    .filter((alias) => alias !== "akua" && alias !== "kcl_plugin" && alias !== "charts")
    .find((alias) => resolved.find((dependency) => dependency.name === alias)?.kind === "helm")

export interface LockedSummary {
  readonly name: string
  readonly version: string
  readonly digest: string
  readonly source_kind: string
}

export const lockedSummaries = (resolved: ReadonlyArray<ResolvedDependency>): ReadonlyArray<LockedSummary> =>
  resolved
    .map((dependency) => ({
      name: dependency.name,
      version: dependency.locked.version,
      digest: dependency.digest,
      source_kind: dependency.locked.kind
    }))
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

const text = (output: { readonly wrote: boolean; readonly drift: boolean; readonly locked_packages: ReadonlyArray<LockedSummary> }) =>
  [
    ...(output.locked_packages.length === 0
      ? ["no dependencies to lock"]
      : [
        `locked ${output.locked_packages.length} package(s):`,
        ...output.locked_packages.map((p) => `  [${p.source_kind}] ${p.name} ${p.version}  ${p.digest}`)
      ]),
    ...(output.drift && !output.wrote
      ? ["DRIFT - akua.lock is out of date with akua.toml"]
      : output.wrote && output.drift
      ? ["updated akua.lock"]
      : output.wrote
      ? ["akua.lock up to date"]
      : [])
  ].join("\n")

/**
 * Regenerate `akua.lock` from `akua.toml`: every dependency resolved online,
 * merged into the existing lock (unchanged digests keep their signatures),
 * and the CRD schemas under `.akua/crds/` with it.
 * OCI digest drift against the lock fails; `update` is the verb that accepts
 * it. `--check` compares instead of writing.
 */
export const lock = (context: VerbContext) =>
  Command.make(
    "lock",
    {
      ...universal,
      workspace: Flag.String("workspace").pipe(Flag.withDefault("."), Flag.withDescription("Workspace root")),
      check: Flag.Boolean("check").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Exit 1 if akua.lock or .akua/crds/ would change; don't write")
      )
    },
    verb(
      "akuapkg.lock",
      Effect.fnUntraced(function*(flags, mode) {
        yield* loadManifestForLock(flags.workspace)
        const prior = yield* priorLock(flags.workspace)
        const resolved = (yield* resolveForLock(flags.workspace, "oci", context.fetchers)).dependencies
        const packageSource = yield* readOptional(joinPath(flags.workspace, "package.k")).pipe(
          Effect.orElseSucceed(() => Option.none<string>())
        )
        const mismatch = Option.flatMapNullishOr(packageSource, (source) => importedChart(source, resolved))
        if (Option.isSome(mismatch)) {
          const alias = mismatch.value
          return yield* fail(
            "E_DEP_KIND_MISMATCH",
            `dep \`${alias}\` is referenced by \`import ${alias}\` but resolves as a Helm chart - only KCL / Akua-package deps can be imported. Either remove the import or change the dep declaration.`,
            ExitCode.userError,
            undefined,
            "Remove the `import` for this alias, or replace the dep with a path/OCI reference to a KCL or Akua package (akua.toml + package.k, or kcl.mod)."
          )
        }
        const generation = yield* generateCrds(resolved)
        const next = mergeIntoLock(prior, lockUpdates(resolved, generation))
        const drift = lockBody(prior) !== lockBody(next)
        const locked_packages = lockedSummaries(resolved)
        if (flags.check) {
          const output = { wrote: false, drift, locked_packages }
          yield* emit(mode, output, () => text(output))
          if (drift) {
            return yield* fail(
              "E_LOCK_DRIFT",
              "lockfile drift detected - on-disk akua.lock doesn't match what `akuapkg lock` would write",
              ExitCode.userError
            )
          }
          return yield* checkGeneratedCrds(flags.workspace, generation)
        }
        yield* saveLock(flags.workspace, next, context.name)
        yield* syncGeneratedCrds(flags.workspace, generation)
        const output = { wrote: true, drift, locked_packages }
        yield* emit(mode, output, () => text(output))
      })
    )
  ).pipe(Command.withDescription("Regenerate akua.lock from akua.toml"))
