import { Effect, FileSystem, Option, Path, type PlatformError } from "effect"
import { CliName } from "../cli-name"
import { osMessage } from "../errors"
import { Argument, Command, Flag } from "effect/cli"
import type { FetchServices } from "../cli"
import { ExitCode, fail } from "../contract"
import { canonicalGitUrl, configuredCosignKey, detectKind, lockRecordFor, VENDOR_DIR } from "../dependencies.effect"
import { GitRemote, type GitRequest } from "../git.effect"
import { type HostAuthMap, lookupAuth, resolveAuth } from "../host-auth"
import { emptyLock, type Lock, mergeIntoLock } from "../lockfile"
import { type Dependency, dependencySpec } from "../manifest"
import { OciRegistry } from "../oci.effect"
import { loadSnapshot } from "../snapshot.effect"
import { UrlSource } from "../url-source.effect"
import { hashDirectory } from "../walk.effect"
import type { VerbContext } from "./context"
import { joinPath } from "./files"
import { reportable, verb } from "./report"
import { emit, universal } from "./universal"
import { loadLock, loadManifest, manifestFailure, saveLock } from "./workspace"

/**
 * The workspace vendor tree, `.akua/vendor/<name>/`, which resolution uses
 * before any other source: `add` copies a declared dependency in and pins
 * it, `check` compares it with the manifest and lock, `list` inventories it.
 */

const workspaceFlag = Flag.String("workspace").pipe(
  Flag.withDefault("."),
  Flag.withDescription("Workspace root containing akua.toml")
)

const vendorRoot = (workspace: string) => joinPath(workspace, VENDOR_DIR)

const loadWorkspaceManifest = (workspace: string) =>
  loadManifest(workspace).pipe(
    Effect.catchTags({
      ManifestMissing: (missing) => Effect.fail(manifestFailure(missing)),
      ManifestInvalid: (invalid) => Effect.fail(manifestFailure(invalid))
    })
  )

const ioFailure = (path: string) => (error: { readonly message: string }) =>
  fail("E_IO", osMessage(error), ExitCode.systemError, path)

interface Source {
  readonly kind: string
  readonly sourceRef: string
  /** The tree to vendor. */
  readonly root: string
  /** What `akua.lock` pins when it is not the tree digest (a git commit, an OCI blob). */
  readonly lockDigest: Option.Option<string>
  /** `cosign:key:...`: the configured key verified the pulled artifact. */
  readonly signature: Option.Option<string>
}

/** A user-authored dependency path: relative, existing, and inside the workspace. */
const workspaceDirectory = Effect.fnUntraced(function*(workspace: string, name: string, requested: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (path.isAbsolute(requested)) {
    return yield* fail(
      "E_PATH_ESCAPE",
      `dep \`${name}\`: absolute path \`${requested}\` is rejected - path deps must stay under the workspace root`,
      ExitCode.userError,
      requested,
      "use a relative path under the workspace, or vendor the dep via `oci = \"...\"` / `git = \"...\"`"
    )
  }
  const root = yield* fs.realPath(workspace).pipe(Effect.mapError(ioFailure(workspace)))
  const joined = joinPath(workspace, requested)
  const missing = (at: string) =>
    fail("E_IO", `source path \`${at}\` does not exist`, ExitCode.userError, at)
  const target = yield* fs.realPath(joined).pipe(
    Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.fail(missing(joined))),
    Effect.mapError((error) => (error._tag === "CliFailure" ? error : ioFailure(joined)(error)))
  )
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return yield* fail(
      "E_PATH_ESCAPE",
      `dep \`${name}\`: path \`${requested}\` resolves to \`${target}\`, which escapes the workspace root \`${root}\``,
      ExitCode.userError,
      target,
      "rewrite the path to stay under the workspace, or move the source into the workspace"
    )
  }
  const isDirectory = yield* fs.stat(target).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false)
  )
  if (!isDirectory) return yield* missing(target)
  return target
})

/** The `akua.lock` entry for `name`, when it came from `kind` (`oci://` or `git+`). */
const lockedEntry = (lock: Option.Option<Lock>, name: string, prefix: string) =>
  Option.flatMapNullishOr(lock, (l) => (l.package ?? []).find((p) => p.name === name && p.source.startsWith(prefix)))

/** Where a declared dependency's tree comes from: the workspace, a registry pull or a git checkout. */
const resolveSource = Effect.fnUntraced(function*(
  workspace: string,
  name: string,
  dependency: Dependency,
  lock: Option.Option<Lock>,
  auth: HostAuthMap,
  /** `[signing].cosign_public_key`: an OCI pull must carry its signature, as for `lock`. */
  cosignPublicKey: Option.Option<string>
) {
  const path = yield* Path.Path
  const spec = dependencySpec(dependency)
  switch (spec._tag) {
    case "Path":
      return {
        kind: "path",
        sourceRef: spec.path,
        root: yield* workspaceDirectory(workspace, name, spec.path),
        lockDigest: Option.none(),
        signature: Option.none()
      } satisfies Source
    case "Oci": {
      const registry = yield* OciRegistry
      const locked = lockedEntry(lock, name, "oci://")
      const pulled = yield* registry.pull({
        reference: spec.oci,
        version: spec.version,
        pin: Option.map(locked, (entry) => entry.digest),
        offline: false,
        cosignPublicKey,
        lockedSignature: Option.flatMapNullishOr(locked, (entry) => entry.signature)
      }).pipe(
        Effect.mapError((error) =>
          fail(
            error.code,
            error.code === "E_DEP_RESOLVE" ? `fetching OCI dep \`${name}\`: ${error.message}` : error.message,
            ExitCode.userError
          )
        )
      )
      // The package inside the pulled tree, as resolution finds it.
      const { prefix } = detectKind(yield* loadSnapshot(pulled.directory).pipe(Effect.mapError(reportable)))
      return {
        kind: "oci",
        sourceRef: `${spec.oci}@${spec.version}`,
        root: prefix === "" ? pulled.directory : path.join(pulled.directory, prefix),
        // The blob stays the pin, so a re-vendor can fetch against it; the tree goes in `vendor_digest`.
        lockDigest: Option.some(pulled.digest),
        signature: pulled.signature
      } satisfies Source
    }
    case "Git": {
      const remote = yield* GitRemote
      const credential = lookupAuth(auth, spec.git)
      // A tag wins over a rev when both are set, as before.
      const ref: GitRequest["ref"] = Option.match(spec.tag, {
        onSome: (tag) => ({ _tag: "Tag", tag }),
        onNone: () => ({ _tag: "Rev", rev: Option.getOrElse(spec.rev, () => "") })
      })
      const fetched = yield* remote.fetch({
        url: spec.git,
        ref,
        pin: Option.map(lockedEntry(lock, name, "git+"), (entry) => entry.digest.replace(/^git:/, "")),
        offline: false,
        ...(Option.isSome(credential) ? { auth: credential.value } : {})
      }).pipe(
        Effect.mapError((error) =>
          fail("E_DEP_RESOLVE", `fetching git dep \`${name}\`: ${error.message}`, ExitCode.userError)
        )
      )
      const label = ref._tag === "Tag" ? ref.tag : ref.rev
      return {
        kind: "git",
        sourceRef: `${canonicalGitUrl(spec.git)}@${label}`,
        root: fetched.directory,
        lockDigest: Option.some(`git:${fetched.commit}`),
        signature: Option.none()
      } satisfies Source
    }
    case "Helm":
      return yield* fail(
        "E_DEP_RESOLVE",
        `dep \`${name}\`: helm source not yet supported by \`${yield* CliName} vendor\``,
        ExitCode.userError
      )
    case "Url": {
      const source = yield* UrlSource
      const fetched = yield* source.fetch({
        url: spec.url,
        pin: Option.map(lockedEntry(lock, name, "url+"), (entry) => entry.digest),
        offline: false
      }).pipe(
        Effect.mapError((error) => fail("E_DEP_RESOLVE", `fetching url dep \`${name}\`: ${error.message}`, ExitCode.userError))
      )
      return {
        kind: "url",
        sourceRef: spec.url,
        root: fetched.directory,
        lockDigest: Option.some(fetched.digest),
        // A single file has no signing layer, like a git checkout.
        signature: Option.none()
      } satisfies Source
    }
  }
})

/** Copy a tree: directories and regular files; symlinks are left out. */
const copyTree = Effect.fnUntraced(function*(from: string, to: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const copy = (source: string, target: string): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.gen(function*() {
      yield* fs.makeDirectory(target, { recursive: true })
      const realSource = yield* fs.realPath(source)
      for (const name of yield* fs.readDirectory(source)) {
        const entry = path.join(source, name)
        const real = yield* fs.realPath(entry).pipe(Effect.orElseSucceed(() => ""))
        if (real !== path.join(realSource, name)) continue
        const info = yield* fs.stat(entry)
        if (info.type === "Directory") yield* copy(entry, path.join(target, name))
        else if (info.type === "File") yield* fs.copyFile(entry, path.join(target, name))
      }
    })
  yield* copy(from, to).pipe(Effect.mapError(ioFailure(to)))
})

interface VendoredTree {
  readonly name: string
  readonly path: string
  readonly digest: string
  readonly size_bytes: number
  readonly orphan: boolean
}

/** The trees under `.akua/vendor`, by name; `expected` names are not orphans. */
const scanVendorTree = Effect.fnUntraced(function*(workspace: string, expected: ReadonlySet<string>) {
  const fs = yield* FileSystem.FileSystem
  const root = vendorRoot(workspace)
  const names = yield* fs.readDirectory(root).pipe(
    Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed([])),
    Effect.mapError(ioFailure(root))
  )
  const trees: Array<VendoredTree> = []
  for (const name of names) {
    const path = joinPath(root, name)
    const isDirectory = yield* fs.stat(path).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false)
    )
    if (!isDirectory) continue
    const { digest, size } = yield* hashDirectory(path).pipe(Effect.mapError(ioFailure(path)))
    trees.push({ name, path, digest, size_bytes: size, orphan: !expected.has(name) })
  }
  return trees.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
})

interface ExpectedTree {
  readonly name: string
  readonly source_kind: string
  readonly source_ref: string
  /** The digest the vendored tree must have. */
  readonly digest: string
}

const lockedKind = (source: string) =>
  source.startsWith("path+file://")
    ? "path"
    : source.startsWith("oci://")
    ? "oci"
    : source.startsWith("url+")
    ? "url"
    : source.startsWith("helm+")
    ? "helm"
    : "git"

/** Every dependency the manifest declares or the lock pins, with the tree digest it should vendor to. */
const expectedTrees = Effect.fnUntraced(function*(workspace: string) {
  const manifest = yield* loadWorkspaceManifest(workspace)
  const lock = yield* loadLock(workspace)
  const declared = manifest.dependencies ?? {}
  const names = new Set<string>(Object.keys(declared))
  const trees: Array<ExpectedTree> = []
  for (const [name, dependency] of Object.entries(declared)) {
    const locked = Option.flatMapNullishOr(lock, (l) => (l.package ?? []).find((p) => p.name === name))
    if (Option.isSome(locked)) {
      trees.push({
        name,
        source_kind: lockedKind(locked.value.source),
        source_ref: locked.value.source,
        digest: locked.value.vendor_digest ?? locked.value.digest
      })
      continue
    }
    const source = yield* resolveSource(workspace, name, dependency, lock, new Map(), Option.none())
    const { digest } = yield* hashDirectory(source.root).pipe(Effect.mapError(ioFailure(source.root)))
    trees.push({ name, source_kind: source.kind, source_ref: source.sourceRef, digest })
  }
  for (const entry of Option.match(lock, { onNone: () => [], onSome: (l) => l.package ?? [] })) {
    names.add(entry.name)
    if (declared[entry.name] !== undefined) continue
    trees.push({
      name: entry.name,
      source_kind: lockedKind(entry.source),
      source_ref: entry.source,
      digest: entry.vendor_digest ?? entry.digest
    })
  }
  return { names, trees: trees.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }
})

const vendorAdd = (fetchers: FetchServices, cli: string) =>
  Command.make(
    "add",
    {
      ...universal,
      name: Argument.String("name").pipe(Argument.withDescription("Local alias declared in `[dependencies]`")),
      workspace: workspaceFlag,
      auth: Flag.String("auth").pipe(
        Flag.atLeast(0),
        Flag.withDescription("Credential for a private git remote: `<url-prefix>=<user>:<password>` (repeatable)")
      ),
      authFile: Flag.String("auth-file").pipe(
        Flag.optional,
        Flag.withDescription("TOML file with an `[auth]` table keyed by URL prefix; `--auth` overrides it")
      )
    },
    verb(
      "akuapkg.vendor.add",
      Effect.fnUntraced(function*(flags, mode) {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const auth = yield* resolveAuth(flags.auth, flags.authFile).pipe(
          Effect.mapError((error) => fail("E_AUTH_PARSE", error.message, ExitCode.userError))
        )
        const manifest = yield* loadWorkspaceManifest(flags.workspace)
        const dependency = manifest.dependencies?.[flags.name]
        if (dependency === undefined) {
          return yield* fail(
            "E_VENDOR_DEP_MISSING",
            `dep \`${flags.name}\` is not declared in akua.toml; declare \`path = ".akua/vendor/${flags.name}"\` first`,
            ExitCode.userError,
            undefined,
            `declare \`path = ".akua/vendor/${flags.name}"\` in \`akua.toml\` first`
          )
        }
        // Pins are best effort here; a broken lockfile fails the write below.
        const pins = yield* loadLock(flags.workspace).pipe(Effect.orElseSucceed(() => Option.none<Lock>()))
        const cosignPublicKey = yield* configuredCosignKey(flags.workspace, manifest).pipe(
          Effect.mapError((error) => fail(error.code, error.message, ExitCode.userError))
        )
        const source = yield* resolveSource(flags.workspace, flags.name, dependency, pins, auth, cosignPublicKey).pipe(
          Effect.provide(fetchers)
        )
        const target = joinPath(vendorRoot(flags.workspace), flags.name)
        const { digest, size } = yield* hashDirectory(source.root).pipe(Effect.mapError(ioFailure(source.root)))
        const existed = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))
        const matches = existed &&
          (yield* hashDirectory(target).pipe(Effect.mapError(ioFailure(target)))).digest === digest
        const wrote = !matches
        const replaced = !matches && existed
        if (!flags.plan) {
          if (wrote) {
            if (existed) yield* fs.remove(target, { recursive: true }).pipe(Effect.mapError(ioFailure(target)))
            yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.mapError(ioFailure(target)))
            yield* copyTree(source.root, target)
          }
          // Pin the vendored tree: a git commit keeps its own digest, with the tree's beside it.
          const locked = lockRecordFor(dependency)
          const lockDigest = Option.getOrElse(source.lockDigest, () => digest)
          const lock = yield* loadLock(flags.workspace)
          const merged = mergeIntoLock(Option.getOrElse(lock, () => emptyLock), [{
            name: flags.name,
            version: locked.version,
            source: locked.source,
            digest: lockDigest,
            replaced: Option.none(),
            signature: source.signature,
            // Vendoring does not regenerate CRD schemas: keep the recorded digest.
            crdsDigest: Option.flatMap(lock, (current) =>
              Option.fromUndefinedOr(
                current.package?.find((entry) => entry.name === flags.name && entry.version === locked.version)
                  ?.crds_digest
              ))
          }])
          yield* saveLock(flags.workspace, {
            ...merged,
            package: (merged.package ?? []).map((entry) =>
              lockDigest !== digest && entry.name === flags.name && entry.version === locked.version
                ? { ...entry, vendor_digest: digest }
                : entry
            )
          }, cli)
        }
        const output = {
          name: flags.name,
          source_kind: source.kind,
          source_ref: source.sourceRef,
          path: target,
          digest,
          size_bytes: size,
          wrote,
          replaced
        }
        yield* emit(mode, output, () =>
          [
            ...(flags.plan ? [`plan: vendor add ${output.name}`] : []),
            `vendor ${output.name}`,
            `  source  ${output.source_kind} ${output.source_ref}`,
            `  path    ${output.path}`,
            `  digest  ${output.digest}`,
            `  size    ${output.size_bytes} bytes`,
            `  wrote   ${output.wrote}`,
            `  replaced ${output.replaced}`
          ].join("\n"))
      })
    )
  ).pipe(Command.withDescription("Copy the declared dep into `.akua/vendor/<name>/`"))

interface CheckEntry {
  readonly name: string
  readonly path: string
  readonly source_kind?: string
  readonly source_ref?: string
  readonly expected_digest?: string
  readonly actual_digest?: string
  readonly orphan: boolean
  readonly missing_vendor: boolean
  readonly missing_source: boolean
}

const checkText = (output: {
  readonly drift: boolean
  readonly entries: ReadonlyArray<CheckEntry>
  readonly orphaned: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
}) =>
  [
    ...output.entries.flatMap((entry) => {
      const marker = entry.orphan
        ? "(orphan)"
        : entry.missing_vendor
        ? "(missing vendor)"
        : entry.missing_source
        ? "(missing source)"
        : entry.expected_digest !== entry.actual_digest
        ? "(drift)"
        : "(ok)"
      return [
        `  ${entry.name} ${marker}`,
        ...(entry.source_kind === undefined
          ? []
          : [`    source  ${entry.source_kind}${entry.source_ref === undefined ? "" : ` ${entry.source_ref}`}`]),
        ...(entry.expected_digest === undefined ? [] : [`    expected ${entry.expected_digest}`]),
        ...(entry.actual_digest === undefined ? [] : [`    actual   ${entry.actual_digest}`])
      ]
    }),
    ...(output.orphaned.length === 0 ? [] : [`  orphaned: ${output.orphaned.join(", ")}`]),
    ...(output.missing.length === 0 ? [] : [`  missing: ${output.missing.join(", ")}`]),
    output.drift ? "drift" : "ok"
  ].join("\n")

const vendorCheck = (fetchers: FetchServices) =>
  Command.make(
    "check",
    { ...universal, workspace: workspaceFlag },
    verb(
      "akuapkg.vendor.check",
      Effect.fnUntraced(function*(flags, mode) {
        const expected = yield* expectedTrees(flags.workspace).pipe(Effect.provide(fetchers))
        const onDisk = yield* scanVendorTree(flags.workspace, expected.names)
        const byName = new Map(onDisk.map((tree) => [tree.name, tree]))
        const entries: Array<CheckEntry> = []
        const missing: Array<string> = []
        let drift = false
        for (const tree of expected.trees) {
          const actual = byName.get(tree.name)
          if (actual === undefined) {
            drift = true
            missing.push(tree.name)
          } else if (actual.digest !== tree.digest) drift = true
          entries.push({
            name: tree.name,
            path: joinPath(vendorRoot(flags.workspace), tree.name),
            source_kind: tree.source_kind,
            source_ref: tree.source_ref,
            expected_digest: tree.digest,
            ...(actual === undefined ? {} : { actual_digest: actual.digest }),
            orphan: false,
            missing_vendor: actual === undefined,
            missing_source: false
          })
        }
        const orphaned = onDisk.filter((tree) => !expected.names.has(tree.name))
        for (const tree of orphaned) {
          drift = true
          entries.push({
            name: tree.name,
            path: tree.path,
            actual_digest: tree.digest,
            orphan: true,
            missing_vendor: false,
            missing_source: false
          })
        }
        const byEntryName = (a: { readonly name: string }, b: { readonly name: string }) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        const output = {
          drift,
          entries: entries.toSorted(byEntryName),
          orphaned: orphaned.map((tree) => tree.name).toSorted(),
          missing: missing.toSorted()
        }
        yield* emit(mode, output, () => checkText(output))
        if (drift) return yield* fail("E_VENDOR_DRIFT", "vendor tree drift detected", ExitCode.userError)
      })
    )
  ).pipe(Command.withDescription("Compare the vendor tree against manifest + lock"))

const vendorList = (fetchers: FetchServices) =>
  Command.make(
    "list",
    { ...universal, workspace: workspaceFlag },
    verb(
      "akuapkg.vendor.list",
      Effect.fnUntraced(function*(flags, mode) {
        const expected = yield* expectedTrees(flags.workspace).pipe(Effect.provide(fetchers))
        const entries = yield* scanVendorTree(flags.workspace, expected.names)
        yield* emit(mode, { entries }, () =>
          entries.length === 0
            ? "no vendored trees"
            : entries.map((entry) =>
              `  ${entry.name}${entry.orphan ? " (orphan)" : ""}  ${entry.digest}  ${entry.size_bytes} bytes  ${entry.path}`
            ).join("\n"))
      })
    )
  ).pipe(Command.withDescription("List on-disk vendor trees, including orphans"))

export const vendor = (context: VerbContext) =>
  Command.make("vendor").pipe(
    Command.withDescription("Materialize and inspect the vendor tree at `.akua/vendor/`"),
    Command.withSubcommands([vendorAdd(context.fetchers, context.name), vendorCheck(context.fetchers), vendorList(context.fetchers)])
  )
