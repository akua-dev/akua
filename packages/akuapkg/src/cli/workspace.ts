import { Console, Effect, FileSystem, Option, Path, Schema } from "effect"
import { osMessage } from "../errors"
import { ExitCode, fail } from "../contract"
import type { FetchServices } from "../cli"
import {
  CRDS_DIR,
  type GeneratedCrds,
  generatedCrdsDigest,
  PROVENANCE_FILE,
  staleGeneratedCrds,
  writeGeneratedCrds
} from "../crds.effect"
import { type ResolvedDependency, resolvePackage } from "../dependencies.effect"
import { crdTree } from "../kcl-modules"
import type { ManifestInvalid } from "../errors"
import { emptyLock, formatLock, type Lock, type LockUpdate, parseLock } from "../lockfile"
import { formatManifest, kclIdent, type Manifest, parseManifest } from "../manifest"
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

/** Put back `akua.toml` exactly as it was read, when a verb that edited it fails. */
export const restoreManifest = (workspace: string, text: string) => write(manifestPath(workspace), text)

export const saveLock = (workspace: string, lock: Lock, cli: string) =>
  write(lockPath(workspace), formatLock(lock, cli))

/**
 * What resolution pinned, as `akua.lock` entries, with the digest of each CRD
 * dependency's generated schemas from `generation`.
 */
export const lockUpdates = (
  resolved: ReadonlyArray<ResolvedDependency>,
  generation: CrdGeneration
): ReadonlyArray<LockUpdate> =>
  resolved.map((dependency) => ({
    name: dependency.name,
    version: dependency.locked.version,
    source: dependency.locked.source,
    digest: dependency.digest,
    replaced: dependency.locked.replaced,
    signature: dependency.locked.signature,
    crdsDigest: Option.fromUndefinedOr(generation.digests.get(dependency.name))
  }))

/**
 * Resolve every dependency online for a lockfile write, as `lock` and
 * `update` report it. OCI signatures are checked against
 * `[signing].cosign_public_key`, so the lock records the key that verified them.
 */
export const resolveForLock = (workspace: string, pins: "oci" | "none", fetchers: FetchServices) =>
  resolvePackage(workspace, { offline: false, pins, regenerateCrds: true }).pipe(
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
        // CRD dependencies ship as their generated schemas, under `.akua/crds/`.
        .filter(({ kind, locked }) =>
          kind !== "crds" && (locked.kind === "oci" || locked.kind === "git") && Option.isNone(locked.replaced)
        )
        .map(({ name, root }) => ({ name, directory: root }))
    ),
    Effect.catch((error) =>
      Console.error(`warning: dep resolution failed, packed artifact will not render offline: ${error.message}`).pipe(
        Effect.as([])
      )
    ),
    Effect.provide(fetchers)
  )

/** One CRD dependency's generated schemas, as verbs report them. */
export interface GeneratedSummary {
  readonly name: string
  /** `.akua/crds/<ident>`, relative to the workspace. */
  readonly path: string
  readonly modules: ReadonlyArray<{ readonly module: string; readonly kinds: ReadonlyArray<string> }>
}

/** The schemas generated for the CRD dependencies of one resolution, and their lock digests. */
export interface CrdGeneration {
  readonly trees: ReadonlyArray<GeneratedCrds>
  readonly summaries: ReadonlyArray<GeneratedSummary>
  readonly digests: ReadonlyMap<string, string>
}

/**
 * Generate the schemas of the CRD dependencies resolved from their sources
 * (`regenerateCrds`), before `akua.lock` records their digests.
 */
export const generateCrds = Effect.fnUntraced(function*(resolved: ReadonlyArray<ResolvedDependency>) {
  const { summaries, trees } = yield* generatedTrees(resolved)
  return {
    trees,
    summaries,
    digests: new Map(trees.map((tree) => [tree.dependency, generatedCrdsDigest(tree)]))
  } satisfies CrdGeneration
})

/** Rewrite `.akua/crds/` from `generation`: one directory per CRD dependency. */
export const syncGeneratedCrds = Effect.fnUntraced(function*(
  workspace: string,
  generation: CrdGeneration,
  /** The generation covers every dependency: generated directories of others are removed. */
  prune = true
) {
  yield* writeGeneratedCrds(workspace, generation.trees, prune).pipe(
    Effect.mapError((error) => fail("E_IO", error.message, ExitCode.systemError, joinPath(workspace, CRDS_DIR)))
  )
  return generation.summaries
})

/**
 * `lock --check` for `.akua/crds/`: E_CRDS_STALE when a CRD dependency's
 * directory is missing or differs from what `lock` would write.
 */
export const checkGeneratedCrds = Effect.fnUntraced(function*(workspace: string, generation: CrdGeneration) {
  const stale = yield* staleGeneratedCrds(workspace, generation.trees).pipe(
    Effect.mapError((error) => fail("E_IO", error.message, ExitCode.systemError, joinPath(workspace, CRDS_DIR)))
  )
  if (stale.length > 0) {
    return yield* fail(
      "E_CRDS_STALE",
      `${CRDS_DIR} is missing or out of date for ${stale.map((name) => `\`${name}\``).join(", ")} - ` +
        "`akuapkg lock` would regenerate it",
      ExitCode.userError,
      undefined,
      "run `akuapkg lock` and commit .akua/crds/"
    )
  }
})

/** The generated schema trees of the CRD dependencies in `resolved`, and how verbs report them. */
const generatedTrees = Effect.fnUntraced(function*(resolved: ReadonlyArray<ResolvedDependency>) {
  const trees: Array<GeneratedCrds> = []
  const summaries: Array<GeneratedSummary> = []
  for (const dependency of resolved) {
    if (Option.isNone(dependency.crds)) continue
    const tree = yield* crdTree(dependency).pipe(
      Effect.mapError((error) => fail(error.code, error.message, ExitCode.userError))
    )
    trees.push({
      dependency: dependency.name,
      files: tree.files,
      provenance: {
        dependency: dependency.name,
        source: dependency.locked.source,
        version: dependency.locked.version,
        crds: dependency.crds.value.selector,
        digest: dependency.digest
      }
    })
    summaries.push({ name: dependency.name, path: `${CRDS_DIR}/${kclIdent(dependency.name)}`, modules: tree.modules })
  }
  return { summaries, trees }
})

/** Drop the generated schemas of dependency `name`, if there are any. */
export const removeGeneratedCrds = Effect.fnUntraced(function*(workspace: string, name: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(workspace, CRDS_DIR)
  const directory = path.join(root, kclIdent(name))
  yield* Effect.gen(function*() {
    const generated = yield* fs.stat(path.join(directory, PROVENANCE_FILE)).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false)
    )
    if (!generated) return
    yield* fs.remove(directory, { recursive: true })
    if ((yield* fs.readDirectory(root)).every((entry) => entry === "kcl.mod")) yield* fs.remove(root, { recursive: true })
  }).pipe(Effect.mapError((error) => fail("E_IO", osMessage(error), ExitCode.systemError, directory)))
})
