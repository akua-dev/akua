import { Bytes, Effect, FileSystem, Path } from "effect"
import { Digest } from "effect/crypto"
import { Hex } from "effect/encoding"
import { PathEscape } from "./errors"
import { comparePaths } from "./walk"

/**
 * Immutable in-memory copy of a directory tree, keyed by POSIX path
 * relative to its root. Rendering reads only snapshots: the KCL worker
 * and the Go engines never see the host filesystem, and a plugin path
 * can only ever name a file that is already in the snapshot.
 */
export type Snapshot = ReadonlyMap<string, Uint8Array>

/**
 * Read a Package directory into memory. This runs on the host, outside the
 * sandbox, so it is the escape boundary: every entry is resolved to its real
 * path, and a symlink pointing outside the Package fails the load instead of
 * copying a host file (credentials, kubeconfig) into the render.
 */
export const loadSnapshot = Effect.fn("loadSnapshot")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const realRoot = yield* fs.realPath(root)
  const entries = yield* fs.readDirectory(root, { recursive: true })
  const files = new Map<string, Uint8Array>()
  for (const rel of entries.toSorted()) {
    const real = yield* fs.realPath(path.join(root, rel))
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
      return yield* new PathEscape({ path: rel.split(path.sep).join("/") })
    }
    const info = yield* fs.stat(real)
    if (info.type === "File") files.set(rel.split(path.sep).join("/"), yield* fs.readFile(real))
  }
  return files satisfies Snapshot
})

/**
 * Normalize a Package-relative path. Mirrors `kcl_plugin::resolve_in_package`:
 * absolute paths and `..` escapes are rejected; "" names the root.
 */
export const resolveInSnapshot = (requested: string): string | undefined => {
  if (requested.startsWith("/")) return undefined
  const out: Array<string> = []
  for (const segment of requested.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment !== "..") out.push(segment)
    else if (out.pop() === undefined) return undefined
  }
  return out.join("/")
}

/** Files under `prefix`, re-keyed relative to it. */
export const subtree = (snapshot: Snapshot, prefix: string): Snapshot =>
  prefix === ""
    ? snapshot
    : new Map(
      Array.from(snapshot)
        .filter(([key]) => key.startsWith(`${prefix}/`))
        .map(([key, bytes]) => [key.slice(prefix.length + 1), bytes])
    )

const encoder = new TextEncoder()

/**
 * `sha256` over every file, sorted by path, as `<path>\0<bytes>\n`: the
 * previous release's tree digest, so `akua.lock` entries stay valid.
 */
export const treeDigest = Effect.fnUntraced(function*(files: Snapshot) {
  const crypto = yield* Digest.Digest
  const chunks: Uint8Array[] = []
  for (const name of Array.from(files.keys()).toSorted(comparePaths)) {
    chunks.push(encoder.encode(name), new Uint8Array([0]), files.get(name) ?? new Uint8Array(), new Uint8Array([10]))
  }
  return `sha256:${Hex.encode(yield* crypto.digest(Digest.sha256, Bytes.concat(chunks)))}`
})
