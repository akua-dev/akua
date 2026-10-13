import { Effect, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { ExitCode, fail } from "../contract"
import { mergeIntoLock } from "../lockfile"
import type { VerbContext } from "./context"
import { verb } from "./report"
import { emit, universal } from "./universal"
import { loadManifestForLock, lockUpdates, priorLock, resolveForLock, saveLock } from "./workspace"

interface UpdatedEntry {
  readonly name: string
  readonly version: string
  readonly from_digest?: string
  readonly to_digest: string
  readonly source_kind: string
}

const text = (output: {
  readonly updated: ReadonlyArray<UpdatedEntry>
  readonly unchanged: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<string>
}) => {
  if (output.updated.length === 0 && output.unchanged.length === 0 && output.skipped.length === 0) {
    return "no dependencies declared"
  }
  return [
    ...(output.updated.length === 0 ? [] : [
      `updated ${output.updated.length} package(s):`,
      ...output.updated.map((u) =>
        `  [${u.source_kind}] ${u.name} ${u.version}  ${u.from_digest ?? "(new)"} → ${u.to_digest}`
      )
    ]),
    ...(output.unchanged.length === 0 ? [] : [`unchanged: ${output.unchanged.join(", ")}`]),
    ...(output.skipped.length === 0 ? [] : [`skipped (--dep filter): ${output.skipped.join(", ")}`])
  ].join("\n")
}

/**
 * Refresh `akua.lock` to whatever upstream serves now, accepting digest drift
 * that `lock` refuses. `--dep` writes only that entry; every dependency is
 * still resolved.
 */
export const update = (context: VerbContext) =>
  Command.make(
    "update",
    {
      ...universal,
      workspace: Flag.String("workspace").pipe(Flag.withDefault("."), Flag.withDescription("Workspace root")),
      dep: Flag.String("dep").pipe(Flag.optional, Flag.withDescription("Only update this dependency's entry"))
    },
    verb(
      "akuapkg.update",
      Effect.fnUntraced(function*(flags, mode) {
        const manifest = yield* loadManifestForLock(flags.workspace)
        if (Option.isSome(flags.dep) && manifest.dependencies?.[flags.dep.value] === undefined) {
          return yield* fail(
            "E_ADD_INVALID_DEP",
            `no dep named \`${flags.dep.value}\` declared in akua.toml`,
            ExitCode.userError
          )
        }
        const prior = yield* priorLock(flags.workspace)
        const resolved = (yield* resolveForLock(flags.workspace, "none", context.fetchers)).dependencies
        const selected = Option.match(flags.dep, {
          onNone: () => resolved,
          onSome: (name) => resolved.filter((dependency) => dependency.name === name)
        })
        const skipped = resolved.filter((dependency) => !selected.includes(dependency)).map((d) => d.name)
        const updated: Array<UpdatedEntry> = []
        const unchanged: Array<string> = []
        for (const dependency of selected) {
          const from = (prior.package ?? []).find((entry) => entry.name === dependency.name)?.digest
          if (from === dependency.digest) unchanged.push(dependency.name)
          else {
            updated.push({
              name: dependency.name,
              version: dependency.locked.version,
              ...(from === undefined ? {} : { from_digest: from }),
              to_digest: dependency.digest,
              source_kind: dependency.locked.kind
            })
          }
        }
        yield* saveLock(flags.workspace, mergeIntoLock(prior, lockUpdates(selected)))
        const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
        const output = {
          updated: updated.toSorted((a, b) => byName(a.name, b.name)),
          unchanged: unchanged.toSorted(byName),
          skipped: skipped.toSorted(byName)
        }
        yield* emit(mode, output, () => text(output))
      })
    )
  ).pipe(Command.withDescription("Refresh akua.lock to what upstream serves now"))
