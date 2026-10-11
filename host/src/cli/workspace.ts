import { Console, Effect, FileSystem, Option, Schema } from "effect"
import { osMessage } from "../errors"
import { ExitCode, fail } from "../contract"
import type { FetchServices } from "../cli"
import { type ResolvedDependency, resolvePackage } from "../dependencies.effect"
import type { ManifestInvalid } from "../errors"
import { emptyLock, formatLock, type Lock, type LockUpdate, parseLock } from "../lockfile"
import { formatManifest, type Manifest, parseManifest } from "../manifest"
import { joinPath, readOptional } from "./files"
import { reportable } from "./report"

/**
 * `akua.toml` and `akua.lock` in a workspace, read and written as the
 * previous release did. Load failures keep their shape so each verb reports
 * them its own way (structured with a path, or folded into one message).
 */

/** No `akua.toml` at `path`. */
export class ManifestMissing extends Schema.TaggedError<ManifestMissing>()("ManifestMissing", {
  path: Schema.String
}) {}

export type ManifestLoadFailure = ManifestMissing | ManifestInvalid

/** As `ManifestLoadError::to_structured`: the file's path, and the validation code. */
export const manifestFailure = (failure: ManifestLoadFailure, missingSuggestion?: string) =>
  failure._tag === "ManifestMissing"
    ? fail("E_MANIFEST_MISSING", "akua.toml not found", ExitCode.userError, failure.path, missingSuggestion)
    : fail(failure.code, failure.message, ExitCode.userError, failure.path)

/** As `ManifestLoadError`'s message, for verbs that report it under one code. */
export const manifestFailureMessage = (failure: ManifestLoadFailure) =>
  failure._tag === "ManifestMissing" ? `akua.toml not found at ${failure.path}` : `failed to parse ${failure.path}: ${failure.message}`

export const manifestPath = (workspace: string) => joinPath(workspace, "akua.toml")
export const lockPath = (workspace: string) => joinPath(workspace, "akua.lock")

/** The workspace manifest; an unreadable file is E_IO. */
export const loadManifest = Effect.fnUntraced(function*(workspace: string) {
  const path = manifestPath(workspace)
  const text = yield* readOptional(path)
  if (Option.isNone(text)) return yield* new ManifestMissing({ path })
  return yield* parseManifest(text.value, path)
})

/** The workspace lockfile, none when it has not been written yet; an invalid one is E_LOCK_PARSE. */
export const loadLock = Effect.fnUntraced(function*(workspace: string) {
  const path = lockPath(workspace)
  const text = yield* readOptional(path)
  if (Option.isNone(text)) return Option.none<Lock>()
  return Option.some(
    yield* parseLock(text.value, path).pipe(
      Effect.mapError((error) => fail("E_LOCK_PARSE", error.message, ExitCode.userError, path))
    )
  )
})

const write = (path: string, text: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(path, text).pipe(
      Effect.mapError((error) => fail("E_IO", osMessage(error), ExitCode.systemError, path))
    )
  })

export const saveManifest = (workspace: string, manifest: Manifest) =>
  write(manifestPath(workspace), formatManifest(manifest))

export const saveLock = (workspace: string, lock: Lock) => write(lockPath(workspace), formatLock(lock))

/** What resolution pinned, as `akua.lock` entries. */
export const lockUpdates = (resolved: ReadonlyArray<ResolvedDependency>): ReadonlyArray<LockUpdate> =>
  resolved.map((dependency) => ({
    name: dependency.name,
    version: dependency.locked.version,
    source: dependency.locked.source,
    digest: dependency.digest,
    replaced: dependency.locked.replaced
  }))

/**
 * Resolve every dependency online for a lockfile write, without signature
 * checks (renders and `verify` check them), as `lock` and `update` report it.
 */
export const resolveForLock = (workspace: string, pins: "oci" | "none", fetchers: FetchServices) =>
  resolvePackage(workspace, { offline: false, verifySignatures: false, pins }).pipe(
    Effect.catchTag("DependencyUnresolved", (error) => Effect.fail(fail(error.code, error.message, ExitCode.userError))),
    Effect.provide(fetchers),
    Effect.mapError((error) => (error._tag === "CliFailure" ? error : reportable(error)))
  )

/** `ManifestLoadError` folded into E_MANIFEST_PARSE, as `lock` and `update` report it. */
export const loadManifestForLock = (workspace: string) =>
  loadManifest(workspace).pipe(
    Effect.catchTags({
      ManifestMissing: (missing) => Effect.fail(fail("E_MANIFEST_PARSE", manifestFailureMessage(missing), ExitCode.userError)),
      ManifestInvalid: (invalid) => Effect.fail(fail("E_MANIFEST_PARSE", manifestFailureMessage(invalid), ExitCode.userError))
    })
  )

/** The lockfile if it loads; a missing or broken one counts as empty. */
export const priorLock = (workspace: string) =>
  loadLock(workspace).pipe(
    Effect.map(Option.getOrElse(() => emptyLock)),
    Effect.orElseSucceed(() => emptyLock)
  )

/**
 * The OCI and git dependencies a published Package carries under
 * `.akua/vendor/` so it renders offline once pulled. Path dependencies are
 * already in the workspace. A resolution failure is a loud warning, not an
 * error: the artifact still packs, but needs the network to render.
 */
export const vendorTrees = (workspace: string, fetchers: FetchServices) =>
  resolvePackage(workspace, { offline: false, verifySignatures: false, pins: "oci" }).pipe(
    Effect.map(({ dependencies }) =>
      dependencies
        .filter(({ locked }) => (locked.kind === "oci" || locked.kind === "git") && Option.isNone(locked.replaced))
        .map(({ name, root }) => ({ name, directory: root }))
    ),
    Effect.catch((error) =>
      Console.error(`warning: dep resolution failed, packed artifact will not render offline: ${error.message}`).pipe(
        Effect.as([])
      )
    ),
    Effect.provide(fetchers)
  )
