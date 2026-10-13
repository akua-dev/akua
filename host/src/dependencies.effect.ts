import { Config, Effect, FileSystem, Option, Path } from "effect"
import { agentDetected } from "./agent"
import { DependencyUnresolved } from "./errors"
import { parseLock, pinnedDigests } from "./lockfile"
import { dependencies, type Dependency, type DependencySpec, dependencySpec, type Manifest, parseManifest } from "./manifest"
import { GitRemote } from "./git.effect"
import { HelmRepository } from "./helm-repository.effect"
import { OciRegistry } from "./oci.effect"
import { loadSnapshot, type Snapshot } from "./snapshot.effect"
import { comparePaths } from "./walk.effect"

/**
 * What a resolved dependency is, from the files at its root: a Helm chart
 * (`Chart.yaml`), a KCL module (`kcl.mod`), or an Akua Package (`akua.toml`
 * and `package.k`).
 */
export type DependencyKind = "helm" | "kcl" | "package"

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
}

/** A dependency's files, before it is known how `akua.lock` records it. */
type DependencyTree = Omit<ResolvedDependency, "locked">

/** How `akua.lock` records a dependency, besides its digest. */
export interface LockRecord {
  readonly kind: "path" | "oci" | "git" | "helm"
  /** `oci://...`, `git+<url>@<ref>`, `helm+<repo>#<chart>` or `path+file://<path>`. */
  readonly source: string
  readonly version: string
  /** The local fork a `replace` directive substituted. */
  readonly replaced: Option.Option<string>
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
  switch (spec._tag) {
    case "Path":
      return { kind: "path", source: `path+file://${spec.path}`, version: "local", replaced }
    case "Oci":
      return { kind: "oci", source: spec.oci, version: spec.version, replaced }
    case "Git": {
      const ref = Option.getOrElse(Option.orElse(spec.tag, () => spec.rev), () => options.gitFallback)
      return { kind: "git", source: `git+${canonicalGitUrl(spec.git)}@${ref}`, version: ref, replaced }
    }
    case "Helm":
      return {
        kind: "helm",
        source: `helm+${spec.repo}#${spec.chart}`,
        version: options.helmVersion ?? spec.version,
        replaced
      }
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
   * Check OCI signatures against `[signing].cosign_public_key` (default).
   * Manifest edits (`add`, `lock`, `update`) pin digests without it, as
   * before; renders and `verify` check them.
   */
  readonly verifySignatures?: boolean
  /**
   * Which `akua.lock` digests a fetch must reproduce: every remote source
   * (default, renders), OCI blobs only (`add`, `lock`: as before), or none
   * (`update`, which records whatever upstream now serves).
   */
  readonly pins?: "all" | "oci" | "none"
}

/** Pre-vendored dependencies live here, and are used before any other source. */
export const VENDOR_DIR = ".akua/vendor"

const encoder = new TextEncoder()

/**
 * `sha256` over every file, sorted by path, as `<path>\0<bytes>\n`: the
 * previous release's tree digest, so `akua.lock` entries stay valid.
 */
export const treeDigest = (files: Snapshot) => {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const name of Array.from(files.keys()).toSorted(comparePaths)) {
    hasher.update(encoder.encode(name))
    hasher.update(new Uint8Array([0]))
    hasher.update(files.get(name) ?? new Uint8Array())
    hasher.update(new Uint8Array([10]))
  }
  return `sha256:${hasher.digest("hex")}`
}

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
  const pinScope = options.pins ?? "all"
  const pins = pinScope !== "none" && (yield* fs.exists(lockPath))
    ? yield* fs.readFileString(lockPath).pipe(
      Effect.flatMap((text) => parseLock(text, lockPath)),
      Effect.map((lock) => pinnedDigests(lock, pinScope === "oci")),
      Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map())
    )
    : new Map<string, string>()
  const rejectReplace = yield* replaceRejected
  const cosignPublicKey = options.verifySignatures === false ? Option.none<string>() : yield* cosignKey(workspace, manifest)
  const resolved = yield* Effect.forEach(dependencies(manifest), ([name, dependency]) =>
    resolveDependency({
      workspace,
      name,
      dependency,
      pin: Option.fromUndefinedOr(pins.get(name)),
      rejectReplace,
      cosignPublicKey,
      options
    }))
  return { manifest: Option.some(manifest), dependencies: resolved } satisfies ResolvedPackage
})

const resolveDependency = Effect.fnUntraced(function*(request: {
  readonly workspace: string
  readonly name: string
  readonly dependency: Dependency
  readonly pin: Option.Option<string>
  readonly rejectReplace: boolean
  readonly cosignPublicKey: Option.Option<string>
  readonly options: ResolveOptions
}) {
  const { dependency, name, workspace } = request
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spec = dependencySpec(dependency)
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
      ...(yield* fromWorkspacePath(workspace, name, dependency.replace.path)),
      locked: lockRecord(spec, { gitFallback: "HEAD", replaced: dependency.replace.path })
    } satisfies ResolvedDependency
  }
  // Vendored first, for every source but Helm repositories: installs and
  // pulled Packages arrive with their dependencies under `.akua/vendor`.
  const vendored = path.join(workspace, VENDOR_DIR, name)
  if (spec._tag !== "Helm" && (yield* isDirectory(fs, vendored))) {
    const dependencyTree = yield* fromDirectory(name, vendored)
    const locked = lockRecord(spec, { gitFallback: "vendored" })
    return spec._tag === "Git"
      ? { ...dependencyTree, digest: `git:${dependencyTree.digest.slice("sha256:".length)}`, locked }
      : { ...dependencyTree, locked }
  }
  const locked = lockRecord(spec, { gitFallback: "vendored" })
  switch (spec._tag) {
    case "Path":
      return { ...(yield* fromWorkspacePath(workspace, name, spec.path)), locked }
    case "Oci": {
      const registry = yield* OciRegistry
      const pulled = yield* registry.pull({
        reference: spec.oci,
        version: spec.version,
        pin: request.pin,
        offline: request.options.offline,
        cosignPublicKey: request.cosignPublicKey
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
      return { ...(yield* fromDirectory(name, pulled.directory)), digest: pulled.digest, locked }
    }
    case "Helm": {
      const repository = yield* HelmRepository
      const fetched = yield* repository.fetch({
        repository: spec.repo,
        chart: spec.chart,
        version: spec.version,
        pin: request.pin,
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
        ...(yield* fromDirectory(name, fetched.directory)),
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
        pin: Option.map(Option.filter(request.pin, (pin) => pin.startsWith("git:")), (pin) => pin.slice("git:".length)),
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
      return { ...(yield* fromDirectory(name, fetched.directory)), digest: `git:${fetched.commit}`, locked }
    }
  }
})

/** `[signing].cosign_public_key`, relative to the workspace: every OCI pull must carry its signature. */
const cosignKey = Effect.fnUntraced(function*(workspace: string, manifest: Manifest) {
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
const fromWorkspacePath = Effect.fnUntraced(function*(workspace: string, name: string, requested: string) {
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
  return yield* fromDirectory(name, target)
})

/** Read a dependency tree into memory and classify it. */
const fromDirectory = Effect.fnUntraced(function*(name: string, directory: string) {
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
  const { kind, prefix } = detectKind(files)
  const scoped = prefix === "" ? files : new Map(
    Array.from(files)
      .filter(([key]) => key.startsWith(`${prefix}/`))
      .map(([key, bytes]) => [key.slice(prefix.length + 1), bytes])
  )
  return {
    name,
    kind,
    root: prefix === "" ? directory : path.join(directory, prefix),
    files: scoped,
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
