import { Effect, FileSystem, Path, type PlatformError } from "effect"

/**
 * The workspace walk `test` (and `pack`) share with the previous release:
 * hidden entries, render outputs and language-ecosystem siblings are never
 * entered, symlinks are skipped, and results are sorted so reports are
 * byte-identical across filesystems.
 */

const SKIPPED = new Set(["deploy", "rendered", "out", "target", "node_modules", "dist"])

/** Entry names a walk never enters or returns. */
export const skippedName = (name: string) => name.startsWith(".") || SKIPPED.has(name)

/** Relative POSIX paths ordered component by component, as Rust orders `Path`s. */
export const comparePaths = (a: string, b: string) => {
  const left = a.split("/")
  const right = b.split("/")
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const [mine, theirs] = [left[index] ?? "", right[index] ?? ""]
    if (mine !== theirs) return mine < theirs ? -1 : 1
  }
  return left.length - right.length
}

/**
 * Every regular file under `root` whose name `keep` accepts, as POSIX paths
 * relative to `root`, sorted. A missing root has no files. `skip` names
 * entries never entered or returned (the workspace walk's rule by default).
 */
export const collectFiles = Effect.fn("collectFiles")(function*(
  root: string,
  keep: (name: string) => boolean,
  skip: (name: string) => boolean = skippedName
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const found: Array<string> = []
  const walk = (relative: string): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.gen(function*() {
      const directory = relative === "" ? root : path.join(root, relative)
      const realDirectory = yield* fs.realPath(directory)
      for (const name of yield* fs.readDirectory(directory)) {
        if (skip(name)) continue
        // A symlink resolves somewhere other than where it is listed, or nowhere.
        const real = yield* fs.realPath(path.join(directory, name)).pipe(Effect.orElseSucceed(() => ""))
        if (real !== path.join(realDirectory, name)) continue
        const entry = relative === "" ? name : `${relative}/${name}`
        const info = yield* fs.stat(real)
        if (info.type === "Directory") yield* walk(entry)
        else if (info.type === "File" && keep(name)) found.push(entry)
      }
    })
  if (!(yield* fs.exists(root))) return []
  yield* walk("")
  return found.toSorted(comparePaths)
})

/**
 * `sha256` over every regular file under `root` (`<path>\0<bytes>\n`,
 * paths in Rust order, symlinks skipped) and the files' total size: the
 * previous release's `hash_dir`, which vendor trees and path dependencies
 * are pinned by.
 */
export const hashDirectory = Effect.fn("hashDirectory")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const hasher = new Bun.CryptoHasher("sha256")
  let size = 0
  for (const file of yield* collectFiles(root, () => true, () => false)) {
    const bytes = yield* fs.readFile(path.join(root, file))
    hasher.update(file)
    hasher.update(new Uint8Array([0]))
    hasher.update(bytes)
    hasher.update(new Uint8Array([10]))
    size += bytes.length
  }
  return { digest: `sha256:${hasher.digest("hex")}`, size }
})
