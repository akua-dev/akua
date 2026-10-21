import { Effect, FileSystem, Path } from "effect"
import { Command, Flag } from "effect/cli"
import { type CliFailure, ExitCode, fail, usageFailure } from "../contract"
import { cacheRoot } from "../downloads.effect"
import { osMessage } from "../errors"
import { comparePaths } from "../walk.effect"
import { verb } from "./report"
import { emit, universal } from "./universal"

/**
 * `cache` reports and reclaims what `add`, `lock` and `render` fetched:
 * OCI artifacts under `<oci>/sha256/<hex>`, git repositories and checkouts
 * under `<git>/{repos,checkouts}/<name>`, Helm charts under `<helm>/<hex>`,
 * single-file (`url`) dependencies under `<url>/<hex>`.
 */

interface CacheEntry {
  readonly kind: "oci-blob" | "git-repo" | "git-checkout" | "helm-chart" | "url-file"
  readonly id: string
  readonly path: string
  readonly size_bytes: number
}

const ioFailure = (path: string) => (error: { readonly message: string; readonly reason?: { readonly _tag: string } }) =>
  fail("E_IO", `i/o at \`${path}\`: ${osMessage(error)}`, ExitCode.systemError)

/** The bytes of every regular file under `directory`, symlinks not followed; a missing directory holds none. */
const directorySize = (directory: string): Effect.Effect<number, CliFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = yield* fs.readDirectory(directory).pipe(
      Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed([])),
      Effect.mapError(ioFailure(directory))
    )
    let total = 0
    for (const name of names) {
      const entry = path.join(directory, name)
      const isSymlink = yield* fs.readLink(entry).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
      if (isSymlink) continue
      const info = yield* fs.stat(entry).pipe(Effect.mapError(ioFailure(entry)))
      if (info.type === "Directory") total += yield* directorySize(entry)
      else if (info.type === "File") total += Number(info.size)
    }
    return total
  })

/** Each directory directly under `parent` as an entry; an unreadable `parent` holds none. */
const entriesUnder = Effect.fnUntraced(function*(
  parent: string,
  kind: CacheEntry["kind"],
  id: (name: string) => string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries: Array<CacheEntry> = []
  for (const name of yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed((): Array<string> => []))) {
    const entry = path.join(parent, name)
    const isDirectory = yield* fs.stat(entry).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false)
    )
    if (isDirectory) entries.push({ kind, id: id(name), path: entry, size_bytes: yield* directorySize(entry) })
  }
  return entries
})

const roots = Effect.gen(function*() {
  return {
    oci_root: yield* cacheRoot("oci"),
    git_root: yield* cacheRoot("git"),
    helm_root: yield* cacheRoot("helm"),
    url_root: yield* cacheRoot("url")
  }
})

const ociEntries = (root: string) =>
  Path.Path.pipe(Effect.flatMap((path) => entriesUnder(path.join(root, "sha256"), "oci-blob", (hex) => `sha256:${hex}`)))

const gitEntries = (root: string) =>
  Path.Path.pipe(Effect.flatMap((path) =>
    Effect.all([
      entriesUnder(path.join(root, "repos"), "git-repo", (name) => name),
      entriesUnder(path.join(root, "checkouts"), "git-checkout", (name) => `git:${name}`)
    ]).pipe(Effect.map((groups) => groups.flat()))
  ))

const helmEntries = (root: string) => entriesUnder(root, "helm-chart", (hex) => `helm:${hex}`)

const urlEntries = (root: string) => entriesUnder(root, "url-file", (hex) => `url:${hex}`)

/** `540 B`, `2.0 KiB`, `1.2 MiB`: one decimal, ties to even, as the previous release printed sizes. */
export const humanBytes = (bytes: number) => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  if (unit === 0) return `${bytes} B`
  const tenths = value * 10
  const rounded = tenths - Math.floor(tenths) === 0.5 && Math.floor(tenths) % 2 === 0
    ? Math.floor(tenths)
    : Math.round(tenths)
  return `${(rounded / 10).toFixed(1)} ${units[unit]}`
}

const rootLines = (
  body: { readonly oci_root: string; readonly git_root: string; readonly helm_root: string; readonly url_root: string }
) => [`oci: ${body.oci_root}`, `git: ${body.git_root}`, `helm: ${body.helm_root}`, `url: ${body.url_root}`]

const cacheList = () =>
  Command.make(
    "list",
    universal,
    verb(
      "akuapkg.cache.list",
      Effect.fnUntraced(function*(_flags, mode) {
        const where = yield* roots
        const entries = [
          ...(yield* ociEntries(where.oci_root)),
          ...(yield* gitEntries(where.git_root)),
          ...(yield* helmEntries(where.helm_root)),
          ...(yield* urlEntries(where.url_root))
        ].toSorted((a, b) => comparePaths(a.path, b.path))
        const total = entries.reduce((sum, entry) => sum + entry.size_bytes, 0)
        yield* emit(
          mode,
          { action: "list", ...where, entries, total_bytes: total },
          () =>
            (entries.length === 0
              ? ["no cache entries", ...rootLines(where)]
              : [
                `${entries.length} entries, ${humanBytes(total)} total`,
                ...entries.map((entry) =>
                  `  [${entry.kind}] ${entry.id}  ${humanBytes(entry.size_bytes)}  ${entry.path}`
                )
              ]).join("\n")
        )
      })
    )
  ).pipe(
    Command.withDescription("Enumerate every OCI blob, git repo/checkout, Helm chart and url file with its size")
  )

const cacheClear = () =>
  Command.make(
    "clear",
    {
      ...universal,
      oci: Flag.Boolean("oci").pipe(Flag.withDefault(false), Flag.withDescription("Only wipe the OCI blob cache")),
      git: Flag.Boolean("git").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Only wipe the git repo and checkout cache")
      ),
      helm: Flag.Boolean("helm").pipe(Flag.withDefault(false), Flag.withDescription("Only wipe the Helm chart cache")),
      url: Flag.Boolean("url").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Only wipe the cache of single-file (url) dependencies")
      )
    },
    verb(
      "akuapkg.cache.clear",
      Effect.fnUntraced(function*(flags, mode) {
        const fs = yield* FileSystem.FileSystem
        const kinds: ReadonlyArray<"oci" | "git" | "helm" | "url"> = ["oci", "git", "helm", "url"]
        const chosen = kinds.filter((kind) => flags[kind])
        const first = chosen.at(0)
        const second = chosen.at(1)
        if (first !== undefined && second !== undefined) {
          return yield* usageFailure(`the argument '--${first}' cannot be used with '--${second}'`)
        }
        const scope = first ?? "all"
        const where = yield* roots
        const scoped = [
          { kind: "oci", root: where.oci_root, entries: ociEntries },
          { kind: "git", root: where.git_root, entries: gitEntries },
          { kind: "helm", root: where.helm_root, entries: helmEntries },
          { kind: "url", root: where.url_root, entries: urlEntries }
        ].filter(({ kind }) => scope === "all" || scope === kind)
        let removed = 0
        let freed = 0
        for (const { entries, root } of scoped) {
          const found = yield* entries(root)
          if (!(yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false)))) continue
          removed += found.length
          freed += found.reduce((sum, entry) => sum + entry.size_bytes, 0)
          yield* fs.remove(root, { recursive: true }).pipe(Effect.mapError(ioFailure(root)))
        }
        yield* emit(
          mode,
          { action: "clear", scope, ...where, removed, freed_bytes: freed },
          () => `cleared ${scope} cache: ${removed} entries, ${humanBytes(freed)} freed`
        )
      })
    )
  ).pipe(Command.withDescription("Wipe the caches; all of them by default, or one with --oci, --git, --helm or --url"))

const cachePath = () =>
  Command.make(
    "path",
    universal,
    verb(
      "akuapkg.cache.path",
      Effect.fnUntraced(function*(_flags, mode) {
        const where = yield* roots
        yield* emit(mode, { action: "path", ...where }, () => rootLines(where).join("\n"))
      })
    )
  ).pipe(Command.withDescription("Print the resolved cache roots"))

export const cache = () =>
  Command.make("cache").pipe(
    Command.withDescription("Manage the on-disk OCI, git, Helm and url caches"),
    Command.withSubcommands([cacheList(), cacheClear(), cachePath()])
  )
