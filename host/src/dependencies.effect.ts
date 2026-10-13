import { Config, Effect, FileSystem, Option, Path } from "effect"
import { CliName } from "./cli-name"
import { agentDetected } from "./agent"
import { DependencyUnresolved } from "./errors"
import { keyedSignatureRef } from "./cosign"
import { readGeneratedCrds } from "./crds.effect"
import { type Lock, type LockedPackage, parseLock, pinnedEntries } from "./lockfile"
import {
  crdSelector,
  dependencies,
  type Dependency,
  type DependencySpec,
  dependencySpec,
  type Manifest,
  parseManifest
} from "./manifest"
import { GitRemote } from "./git.effect"
import { HelmRepository } from "./helm-repository.effect"
import { OciRegistry } from "./oci.effect"
import { loadSnapshot, type Snapshot, treeDigest } from "./snapshot.effect"
import { UrlSource } from "./url-source.effect"

/**
 * What a resolved dependency is, from the files at its root: a Helm chart
 * (`Chart.yaml`), a KCL module (`kcl.mod`), or an Akua Package (`akua.toml`
 * and `package.k`). A dependency declared with `crds` is a CRD source,
 * whatever its files.
 */
export type DependencyKind = "helm" | "kcl" | "package" | "crds"

/** Where a CRD dependency's schemas come from. */
export interface CrdSource {
  /** The `crds` selector: a file or directory in the source, `.` for all of it. */
  readonly selector: string
  /** The schemas already generated under `.akua/crds/`, when they still match the manifest and lock. */
  readonly generated: Option.Option<Snapshot>
}

export interface ResolvedDependency {
  /** The key in `[dependencies]`. */
  readonly name: string
  readonly kind: DependencyKind
  /** The dependency's real directory on the host. */
  readonly root: string
  readonly files: Snapshot
  /** `sha256:<hex>` of the tree, or `git:<commit>`. */
  readonly digest: string
  readonly locked: LockRecord
  /** Set for a CRD dependency (`crds` in `akua.toml`). */
  readonly crds: Option.Option<CrdSource>
}

/** A dependency's files, before it is known how `akua.lock` records it. */
type DependencyTree = Omit<ResolvedDependency, "locked" | "crds">

/** How `akua.lock` records a dependency, besides its digest. */
export interface LockRecord {
  readonly kind: "path" | "oci" | "git" | "helm" | "url"
  /** `oci://...`, `git+<url>@<ref>`, `helm+<repo>#<chart>`, `url+<url>` or `path+file://<path>`. */
  readonly source: string
  readonly version: string
  /** The local fork a `replace` directive substituted. */
  readonly replaced: Option.Option<string>
  /** `cosign:key:...`: the configured key verified these bytes (OCI only). */
  readonly signature: Option.Option<string>
}

/**
 * A git URL as lockfiles record it: no credentials, no default port, no
 * trailing `/` or `.git`.
 */
export const canonicalGitUrl = (url: string) => {
  const separator = url.indexOf("://")
  if (separator === -1) return url
  const scheme = url.slice(0, separator)
  const rest = url.slice(separator + 3)
  const pathStart = rest.includes("/") ? rest.indexOf("/") : rest.length
  const withoutUser = rest.slice(rest.slice(0, pathStart).lastIndexOf("@") + 1)
  const authorityEnd = withoutUser.includes("/") ? withoutUser.indexOf("/") : withoutUser.length
  const authority = withoutUser.slice(0, authorityEnd)
  const port = authority.lastIndexOf(":")
  const host = port !== -1 && ((scheme === "https" && authority.slice(port + 1) === "443") ||
      (scheme === "http" && authority.slice(port + 1) === "80"))
    ? authority.slice(0, port)
    : authority
  const trimmed = `${scheme}://${host}${withoutUser.slice(authorityEnd)}`.replace(/\/+$/, "")
  return (trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed).replace(/\/+$/, "")
}

/** How `akua.lock` records a declared dependency vendored from its source. */
export const lockRecordFor = (dependency: Dependency) => lockRecord(dependencySpec(dependency), { gitFallback: "vendored" })

const lockRecord = (
  spec: DependencySpec,
  options: {
    /** The ref a git dependency with neither `tag` nor `rev` records. */
    readonly gitFallback: string
    readonly replaced?: string
    /** The version a Helm requirement selected. */
    readonly helmVersion?: string
  }
): LockRecord => {
  const replaced = Option.fromUndefinedOr(options.replaced)
  const signature = Option.none<string>()
  switch (spec._tag) {
    case "Path":
      return { kind: "path", source: `path+file://${spec.path}`, version: "local", replaced, signature }
    case "Oci":
      return { kind: "oci", source: spec.oci, version: spec.version, replaced, signature }
    case "Git": {
      const ref = Option.getOrElse(Option.orElse(spec.tag, () => spec.rev), () => options.gitFallback)
      return { kind: "git", source: `git+${canonicalGitUrl(spec.git)}@${ref}`, version: ref, replaced, signature }
    }
    case "Helm":
      return {
        kind: "helm",
        source: `helm+${spec.repo}#${spec.chart}`,
        version: options.helmVersion ?? spec.version,
        replaced,
        signature
      }
    case "Url":
      return { kind: "url", source: `url+${spec.url}`, version: "url", replaced, signature }
  }
}

/** Where a Package's manifest and dependencies were read from. */
export interface ResolvedPackage {
  readonly manifest: Option.Option<Manifest>
  readonly dependencies: ReadonlyArray<ResolvedDependency>
}

export interface ResolveOptions {
  /** The resolver may not touch the network. */
  readonly offline: boolean
  /**
   * Check OCI signatures against `[signing].cosign_public_key` (default), so
   * renders and lockfile writes (`add`, `lock`, `update`) only take signed
   * bytes and the lock records which key verified them.
   */
  readonly verifySignatures?: boolean
  /**
   * Which `akua.lock` digests a fetch must reproduce: every remote source
   * (default, renders), OCI blobs only (`add`, `lock`: as before), or none
   * (`update`, which records whatever upstream now serves).
   */
  readonly pins?: "all" | "oci" | "none"
  /**
   * Resolve CRD dependencies from their sources even when `.akua/crds/`
   * holds matching schemas: the verbs that rewrite that directory.
   */
  readonly regenerateCrds?: boolean
}

/** Pre-vendored dependencies live here, and are used before any other source. */
export const VENDOR_DIR = ".akua/vendor"

const MARKERS: ReadonlyArray<readonly [DependencyKind, ReadonlyArray<string>]> = [
  ["helm", ["Chart.yaml"]],
  ["kcl", ["kcl.mod"]],
  ["package", ["akua.toml", "package.k"]]
]

/**
 * The kind of a dependency tree, and the prefix its root is at: the tree
 * itself, or one directory down (archives that unpack to `<name>/...`).
 * Unrecognised trees are Helm charts, the historical default for path deps.
 */
export const detectKind = (files: Snapshot): { readonly kind: DependencyKind; readonly prefix: string } => {
  const directories = new Set(Array.from(files.keys(), (key) => key.split("/").slice(0, -1).join("/")))
  for (const [kind, markers] of MARKERS) {
    if (markers.every((marker) => files.has(marker))) return { kind, prefix: "" }
    for (const directory of Array.from(directories).toSorted()) {
      if (directory !== "" && !directory.includes("/") && markers.every((marker) => files.has(`${directory}/${marker}`))) {
        return { kind, prefix: directory }
      }
    }
  }
  return { kind: "helm", prefix: "" }
}

/**
 * Agent and production contexts must not honor `replace = { path = ... }`:
 * `AKUA_REJECT_REPLACE=1`, or a known agent environment unless
 * `AKUA_NO_AGENT_DETECT` is set.
 */
const replaceRejected = Effect.gen(function*() {
  const rejected = yield* Config.String("AKUA_REJECT_REPLACE").pipe(Config.option, Effect.orDie)
  return Option.contains(rejected, "1") || (yield* agentDetected)
})

/**
 * Resolve the dependencies of the Package in `workspace` (the directory
 * holding its `akua.toml`). No manifest means no dependencies. `akua.lock`
 * pins remote digests; a broken lockfile is `akua verify`'s to report.
 */
export const resolvePackage = Effect.fn("resolvePackage")(function*(workspace: string, options: ResolveOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const manifestPath = path.join(workspace, "akua.toml")
  if (!(yield* fs.exists(manifestPath))) {
    return { manifest: Option.none(), dependencies: [] } satisfies ResolvedPackage
  }
  const manifest = yield* parseManifest(yield* fs.readFileString(manifestPath), manifestPath)
  const lockPath = path.join(workspace, "akua.lock")
  const lock = (yield* fs.exists(lockPath))
    ? yield* fs.readFileString(lockPath).pipe(Effect.flatMap((text) => parseLock(text, lockPath)), Effect.option)
    : Option.none<Lock>()
  const pinScope = options.pins ?? "all"
  const entries = Option.match(lock, { onNone: (): ReadonlyArray<LockedPackage> => [], onSome: (lock) => lock.package ?? [] })
  const pins = Option.match(lock, {
    onNone: (): ReadonlyArray<LockedPackage> => [],
    onSome: (lock) => pinScope === "none" ? [] : pinnedEntries(lock, pinScope === "oci")
  })
  const rejectReplace = yield* replaceRejected
  const cosignPublicKey = options.verifySignatures === false
    ? Option.none<string>()
    : yield* configuredCosignKey(workspace, manifest)
  const trustedSignature = yield* Effect.transposeOption(Option.map(cosignPublicKey, keyedSignatureRef)).pipe(
    Effect.mapError((error) =>
      new DependencyUnresolved({ dependency: "[signing]", code: "E_COSIGN_VERIFY", message: error.message })
    )
  )
  const resolved = yield* Effect.forEach(dependencies(manifest), ([name, dependency]) =>
    resolveDependency({
      workspace,
      name,
      dependency,
      pinned: lockEntryFor(pins, name, dependency),
      locked: lockEntryFor(entries, name, dependency),
      rejectReplace,
      cosignPublicKey,
      trustedSignature,
      options
    }))
  return { manifest: Option.some(manifest), dependencies: resolved } satisfies ResolvedPackage
})

interface DependencyRequest {
  readonly workspace: string
  readonly name: string
  readonly dependency: Dependency
  /** The `akua.lock` entry pinning this dependency's fetch. */
  readonly pinned: Option.Option<LockedPackage>
  /** Its `akua.lock` entry, pinned or not. */
  readonly locked: Option.Option<LockedPackage>
  readonly rejectReplace: boolean
  readonly cosignPublicKey: Option.Option<string>
  /** How `akua.lock` records a signature from `cosignPublicKey`. */
  readonly trustedSignature: Option.Option<string>
  readonly options: ResolveOptions
}

/**
 * The `akua.lock` entry of a dependency, if it is for the source and
 * version `akua.toml` declares now: after a version change the old entry
 * pins nothing and vouches for nothing. A Helm requirement is matched by
 * source alone (the lock records the version it selected).
 */
const lockEntryFor = (entries: ReadonlyArray<LockedPackage>, name: string, dependency: Dependency) => {
  const spec = dependencySpec(dependency)
  const declared = lockRecord(spec, { gitFallback: "vendored" })
  return Option.fromUndefinedOr(
    entries.find((entry) =>
      entry.name === name && entry.source === declared.source &&
      (spec._tag === "Helm" || entry.version === declared.version)
    )
  )
}

/**
 * A dependency as rendering uses it. A CRD dependency is its source tree,
 * unscoped for git, path and url sources (the `crds` selector is relative
 * to the repository or directory as declared), or its schemas from
 * `.akua/crds/` when they were generated from what `akua.toml` and
 * `akua.lock` still pin: then the source is not touched at all. With a
 * cosign key configured, schemas from an OCI source are used only when the
 * lock records that key verified the bytes they came from; git and url
 * sources have no signing layer, as git dependencies never had.
 */
const resolveDependency = Effect.fnUntraced(function*(request: DependencyRequest) {
  const selector = crdSelector(request.dependency)
  if (selector === undefined) return { ...(yield* resolveSourceTree(request, true)), crds: Option.none() }
  const spec = dependencySpec(request.dependency)
  if (spec._tag !== "Path" && request.dependency.replace === undefined && request.options.regenerateCrds !== true) {
    const generated = yield* readGeneratedCrds(request.workspace, request.name).pipe(
      Effect.mapError((error) =>
        new DependencyUnresolved({
          dependency: request.name,
          code: error._tag === "CrdsInvalid" ? "E_CRDS_INVALID" : "E_DEP_RESOLVE",
          message: `dependency \`${request.name}\`: ${error.message}`
        })
      )
    )
    if (Option.isSome(generated)) {
      const { directory, files, provenance } = generated.value
      const locked = lockRecord(spec, { gitFallback: "vendored" })
      // The directory is used only as akua.lock records it: from the pinned
      // source bytes, and with the file digest `lock` wrote (`crds_digest`),
      // so an edited or unlocked schema tree never renders.
      const stale = provenance.dependency !== request.name || provenance.source !== locked.source ||
        (spec._tag !== "Helm" && provenance.version !== locked.version) || provenance.crds !== selector ||
        !Option.exists(
          request.locked,
          (entry) => entry.digest === provenance.digest && entry.crds_digest === treeDigest(files)
        )
      if (stale) {
        return yield* new DependencyUnresolved({
          dependency: request.name,
          code: "E_CRDS_STALE",
          message: `dependency \`${request.name}\`: the schemas in ${directory} (generated from ` +
            `\`${provenance.source}\`, version \`${provenance.version}\`, crds = "${provenance.crds}", ` +
            `${provenance.digest}) are not what akua.toml and akua.lock pin, or differ from the \`crds_digest\` ` +
            `akua.lock records for them - run \`${yield* CliName} lock\` to regenerate them`
        })
      }
      const signature = Option.flatMapNullishOr(request.locked, (entry) => entry.signature)
      if (spec._tag === "Oci" && Option.isSome(request.trustedSignature)) {
        if (!Option.contains(signature, request.trustedSignature.value)) {
          return yield* new DependencyUnresolved({
            dependency: request.name,
            code: "E_COSIGN_SIG_MISSING",
            message: `dependency \`${request.name}\`: akua.lock does not record the source of ${directory} as ` +
              `verified by \`[signing].cosign_public_key\` - run \`${yield* CliName} lock\` online to verify and regenerate it`
          })
        }
      }
      return {
        name: request.name,
        kind: "crds",
        root: directory,
        files,
        digest: provenance.digest,
        locked: { ...locked, version: provenance.version, signature },
        crds: Option.some({ selector, generated: Option.some(files) })
      } satisfies ResolvedDependency
    }
  }
  const tree = yield* resolveSourceTree(request, spec._tag === "Oci" || spec._tag === "Helm")
  return {
    ...tree,
    kind: "crds",
    crds: Option.some({ selector, generated: Option.none() })
  } satisfies ResolvedDependency
})

/**
 * The dependency's files from its source. `scoped`: an archive that unpacks
 * into one directory holding a chart, module or Package is entered.
 */
const resolveSourceTree = Effect.fnUntraced(function*(request: DependencyRequest, scoped: boolean) {
  const { dependency, name, workspace } = request
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spec = dependencySpec(dependency)
  const pin = Option.map(request.pinned, (entry) => entry.digest)
  if (dependency.replace !== undefined) {
    if (request.rejectReplace) {
      return yield* new DependencyUnresolved({
        dependency: name,
        code: "E_DEP_RESOLVE",
        message: `dependency \`${name}\`: \`replace\` directive rejected - AKUA_REJECT_REPLACE=1 (or agent context) ` +
          "requires unmodified dep resolution"
      })
    }
    return {
      ...(yield* fromWorkspacePath(workspace, name, dependency.replace.path, scoped)),
      locked: lockRecord(spec, { gitFallback: "HEAD", replaced: dependency.replace.path })
    }
  }
  // Vendored first, for every source but Helm repositories: installs and
  // pulled Packages arrive with their dependencies under `.akua/vendor`.
  const vendored = path.join(workspace, VENDOR_DIR, name)
  if (spec._tag !== "Helm" && (yield* isDirectory(fs, vendored))) {
    const dependencyTree = yield* fromDirectory(name, vendored, scoped)
    const locked = lockRecord(spec, { gitFallback: "vendored" })
    const entry = Option.getOrUndefined(request.locked)
    // A tree `vendor add` pinned (`vendor_digest`) keeps the source digest it came from.
    const sourceDigest = entry?.vendor_digest === dependencyTree.digest ? entry.digest : undefined
    const digest = sourceDigest ??
      (spec._tag === "Git" ? `git:${dependencyTree.digest.slice("sha256:".length)}` : dependencyTree.digest)
    if (spec._tag === "Oci" && Option.isSome(request.trustedSignature)) {
      // As for the OCI cache: a vendored copy is trusted only when akua.lock
      // records that the configured key verified exactly these bytes.
      if (entry?.signature !== request.trustedSignature.value || entry.digest !== digest) {
        return yield* new DependencyUnresolved({
          dependency: name,
          code: "E_COSIGN_SIG_MISSING",
          message: `dependency \`${name}\`: akua.lock does not record the vendored tree \`${dependencyTree.digest}\` ` +
            `as verified by \`[signing].cosign_public_key\` - run \`${yield* CliName} vendor add\` to re-vendor it from the registry`
        })
      }
      return { ...dependencyTree, digest, locked: { ...locked, signature: request.trustedSignature } }
    }
    return { ...dependencyTree, digest, locked }
  }
  const locked = lockRecord(spec, { gitFallback: "vendored" })
  switch (spec._tag) {
    case "Path":
      return { ...(yield* fromWorkspacePath(workspace, name, spec.path, scoped)), locked }
    case "Oci": {
      const registry = yield* OciRegistry
      const pulled = yield* registry.pull({
        reference: spec.oci,
        version: spec.version,
        pin,
        offline: request.options.offline,
        cosignPublicKey: request.cosignPublicKey,
        lockedSignature: Option.flatMapNullishOr(request.pinned, (entry) => entry.signature),
        anyArchive: crdSelector(dependency) !== undefined
      }).pipe(
        Effect.mapError((error) =>
          new DependencyUnresolved({
            dependency: name,
            code: error.code,
            ...(error.drift === true ? { drift: true } : {}),
            message: error.offline
              ? `chart \`${name}\`: oci:// source not resolvable in the current mode - ${error.message}`
              : `chart \`${name}\`: OCI fetch failed: ${error.message}`
          })
        )
      )
      // The lockfile pins the blob, not the unpacked tree.
      return {
        ...(yield* fromDirectory(name, pulled.directory, scoped)),
        digest: pulled.digest,
        locked: { ...locked, signature: pulled.signature }
      }
    }
    case "Helm": {
      const repository = yield* HelmRepository
      const fetched = yield* repository.fetch({
        repository: spec.repo,
        chart: spec.chart,
        version: spec.version,
        pin,
        offline: request.options.offline
      }).pipe(
        Effect.mapError((error) =>
          new DependencyUnresolved({
            dependency: name,
            code: "E_DEP_RESOLVE",
            message: error.offline
              ? `chart \`${name}\`: helm source not resolvable in the current mode - ${error.message}`
              : `chart \`${name}\`: helm-repo fetch failed: ${error.message}`
          })
        )
      )
      return {
        ...(yield* fromDirectory(name, fetched.directory, scoped)),
        digest: fetched.digest,
        locked: lockRecord(spec, { gitFallback: "vendored", helmVersion: fetched.version })
      }
    }
    case "Git": {
      const remote = yield* GitRemote
      const fetched = yield* remote.fetch({
        url: spec.git,
        // A tag wins over a rev when both are set, as before.
        ref: Option.match(spec.tag, {
          onSome: (tag) => ({ _tag: "Tag", tag }),
          onNone: () => ({ _tag: "Rev", rev: Option.getOrElse(spec.rev, () => "") })
        }),
        pin: Option.map(Option.filter(pin, (digest) => digest.startsWith("git:")), (git) => git.slice("git:".length)),
        offline: request.options.offline
      }).pipe(
        Effect.mapError((error) =>
          new DependencyUnresolved({
            dependency: name,
            code: "E_DEP_RESOLVE",
            message: error.offline
              ? `chart \`${name}\`: git source not resolvable in the current mode - ${error.message}`
              : `chart \`${name}\`: git fetch failed: ${error.message}`
          })
        )
      )
      return { ...(yield* fromDirectory(name, fetched.directory, scoped)), digest: `git:${fetched.commit}`, locked }
    }
    case "Url": {
      const source = yield* UrlSource
      const fetched = yield* source.fetch({ url: spec.url, pin, offline: request.options.offline }).pipe(
        Effect.mapError((error) =>
          new DependencyUnresolved({
            dependency: name,
            code: "E_DEP_RESOLVE",
            ...(error.drift === true ? { drift: true } : {}),
            message: error.offline
              ? `dependency \`${name}\`: url source not resolvable in the current mode - ${error.message}`
              : `dependency \`${name}\`: url fetch failed: ${error.message}`
          })
        )
      )
      return { ...(yield* fromDirectory(name, fetched.directory, scoped)), digest: fetched.digest, locked }
    }
  }
})

/** `[signing].cosign_public_key`, relative to the workspace: every OCI pull must carry its signature. */
export const configuredCosignKey = Effect.fnUntraced(function*(workspace: string, manifest: Manifest) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const configured = manifest.signing?.cosign_public_key
  if (configured === undefined) return Option.none<string>()
  const file = path.join(workspace, configured)
  return Option.some(
    yield* fs.readFileString(file).pipe(
      Effect.mapError((error) =>
        new DependencyUnresolved({
          dependency: "[signing]",
          code: "E_COSIGN_VERIFY",
          message: `reading cosign public key at ${file}: ${error.message}`
        })
      )
    )
  )
})

const isDirectory = (fs: FileSystem.FileSystem, target: string) =>
  fs.stat(target).pipe(Effect.map((info) => info.type === "Directory"), Effect.orElseSucceed(() => false))

/**
 * A user-authored `path` or `replace.path`: relative, and inside the
 * workspace after resolving symlinks.
 */
const fromWorkspacePath = Effect.fnUntraced(function*(
  workspace: string,
  name: string,
  requested: string,
  scoped = true
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const unresolved = (message: string, code = "E_DEP_RESOLVE") =>
    new DependencyUnresolved({ dependency: name, code, message: `dependency \`${name}\`: ${message}` })
  if (path.isAbsolute(requested)) {
    return yield* unresolved(
      `absolute path \`${requested}\` is rejected - path / replace deps must stay under the workspace root`,
      "E_PATH_ESCAPE"
    )
  }
  const root = yield* fs.realPath(workspace)
  const joined = path.join(workspace, requested)
  const target = yield* fs.realPath(joined).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.fail(unresolved(`path-dep target \`${joined}\` does not exist`))
    )
  )
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return yield* unresolved(
      `path \`${requested}\` resolves to \`${target}\`, which escapes the workspace root \`${root}\``,
      "E_PATH_ESCAPE"
    )
  }
  if (!(yield* isDirectory(fs, target))) return yield* unresolved(`path-dep target \`${target}\` is not a directory`)
  return yield* fromDirectory(name, target, scoped)
})

/** Read a dependency tree into memory and classify it; `scoped` enters an archive's package directory. */
const fromDirectory = Effect.fnUntraced(function*(name: string, directory: string, scoped = true) {
  const path = yield* Path.Path
  const files = yield* loadSnapshot(directory).pipe(
    Effect.catchTag("PathEscape", (escape) =>
      Effect.fail(
        new DependencyUnresolved({
          dependency: name,
          code: "E_PATH_ESCAPE",
          message: `dependency \`${name}\`: \`${escape.path}\` resolves outside the dependency`
        })
      ))
  )
  const detected = detectKind(files)
  const { kind } = detected
  const prefix = scoped ? detected.prefix : ""
  const inside = prefix === "" ? files : new Map(
    Array.from(files)
      .filter(([key]) => key.startsWith(`${prefix}/`))
      .map(([key, bytes]) => [key.slice(prefix.length + 1), bytes])
  )
  return {
    name,
    kind,
    root: prefix === "" ? directory : path.join(directory, prefix),
    files: inside,
    digest: treeDigest(files)
  } satisfies DependencyTree
})


/**
 * The tree a path dependency resolves to, as resolution finds it (the
 * vendored copy first, then the declared path), without touching any other
 * dependency: `verify` compares its digest with the lock.
 */
export const pathDependencyTree = Effect.fn("pathDependencyTree")(function*(
  workspace: string,
  name: string,
  requested: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const vendored = path.join(workspace, VENDOR_DIR, name)
  return (yield* isDirectory(fs, vendored))
    ? yield* fromDirectory(name, vendored)
    : yield* fromWorkspacePath(workspace, name, requested)
})
