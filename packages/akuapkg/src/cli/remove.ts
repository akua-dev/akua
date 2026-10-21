import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ExitCode, fail } from "../contract"
import type { VerbContext } from "./context"
import { verb } from "./report"
import { emit, universal } from "./universal"
import { loadLock, loadManifest, manifestFailure, removeGeneratedCrds, saveLock, saveManifest } from "./workspace"

/** Drop a dependency from `akua.toml`, its entries from `akua.lock` and its generated CRD schemas. */
export const remove = (context: VerbContext) =>
  Command.make(
    "remove",
    {
      ...universal,
      name: Argument.String("name").pipe(Argument.withDescription("Local alias of the dep to remove")),
      ignoreMissing: Flag.Boolean("ignore-missing").pipe(
        Flag.withDefault(false),
        Flag.withDescription("No-op when the dep is already absent")
      ),
      workspace: Flag.String("workspace").pipe(Flag.withDefault("."), Flag.withDescription("Workspace root"))
    },
    verb(
      "akuapkg.remove",
      Effect.fnUntraced(function*(flags, mode) {
        const manifest = yield* loadManifest(flags.workspace).pipe(
          Effect.catchTags({
            ManifestMissing: (missing) => Effect.fail(manifestFailure(missing)),
            ManifestInvalid: (invalid) => Effect.fail(manifestFailure(invalid))
          })
        )
        const removed = manifest.dependencies?.[flags.name] !== undefined
        if (!removed && !flags.ignoreMissing) {
          return yield* fail(
            "E_REMOVE_NOT_FOUND",
            `dep \`${flags.name}\` not present in akua.toml`,
            ExitCode.userError,
            undefined,
            "pass --ignore-missing to make this a no-op"
          )
        }
        if (removed) {
          const rest = Object.entries(manifest.dependencies ?? {}).filter(([name]) => name !== flags.name)
          yield* saveManifest(flags.workspace, { ...manifest, dependencies: Object.fromEntries(rest) })
          // Keep `verify` green: prune the lock entries too, when there is a lock.
          const lock = yield* loadLock(flags.workspace)
          if (Option.isSome(lock)) {
            const packages = lock.value.package ?? []
            const kept = packages.filter((entry) => entry.name !== flags.name)
            if (kept.length !== packages.length) yield* saveLock(flags.workspace, { ...lock.value, package: kept }, context.name)
          }
          yield* removeGeneratedCrds(flags.workspace, flags.name)
        }
        yield* emit(
          mode,
          { name: flags.name, removed },
          () => (removed ? `removed ${flags.name}` : `no-op (dep \`${flags.name}\` was already absent)`)
        )
      })
    )
  ).pipe(Command.withDescription("Remove a dependency from akua.toml"))
