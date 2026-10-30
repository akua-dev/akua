import { ByteSize, Effect, FileSystem, Option, PlatformError } from "effect"
import { PathEscape } from "./errors"
import { resolveInSnapshot, type Snapshot } from "./snapshot.effect"

/** A read-only Package tree, with no ambient files or symlinks. */
export const makeSnapshotFileSystem = Effect.fn("makeSnapshotFileSystem")(function*(snapshot: Snapshot) {
  const files = new Map<string, Uint8Array>()
  const directories = new Set([""])
  for (const [name, bytes] of snapshot) {
    if (name === "" || name.includes("\\") || name.includes("\0") || resolveInSnapshot(name) !== name) {
      return yield* new PathEscape({ path: name })
    }
    files.set(name, bytes.slice())
    const parts = name.split("/")
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join("/"))
  }
  for (const name of files.keys()) if (directories.has(name)) return yield* new PathEscape({ path: name })
  const relative = (path: string) => {
    if (path !== "/package" && !path.startsWith("/package/")) return undefined
    return resolveInSnapshot(path.slice("/package".length).replace(/^\//u, ""))
  }
  const missing = (method: string, path: string) => PlatformError.systemError({
    _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: path
  })
  const denied = (path: string) => Effect.fail(PlatformError.systemError({
    _tag: "PermissionDenied", module: "FileSystem", method: "write", pathOrDescriptor: path,
    description: "Package snapshots are read-only"
  }))
  const exists = (path: string) => {
    const name = relative(path)
    return name !== undefined && (files.has(name) || directories.has(name))
  }
  const readFile = Effect.fnUntraced(function*(path: string) {
    const name = relative(path)
    const bytes = name === undefined ? undefined : files.get(name)
    if (bytes === undefined) return yield* missing("readFile", path)
    return bytes.slice()
  })
  const stat = Effect.fnUntraced(function*(path: string): Effect.fn.Return<FileSystem.File.Info, PlatformError.PlatformError> {
    const name = relative(path)
    if (name === undefined || !exists(path)) return yield* missing("stat", path)
    return {
      type: directories.has(name) ? "Directory" : "File",
      size: ByteSize.fromInputUnsafe(files.get(name)?.length ?? 0),
      mtime: Option.none(), atime: Option.none(), birthtime: Option.none(), dev: 0n,
      ino: Option.none(), mode: directories.has(name) ? 0o40555 : 0o100444,
      nlink: Option.none(), uid: Option.none(), gid: Option.none(), rdev: Option.none(),
      blksize: Option.none(), blocks: Option.none()
    }
  })
  return FileSystem.makeNoop({
    access: (path) => exists(path) ? Effect.void : Effect.fail(missing("access", path)),
    exists: (path) => Effect.succeed(exists(path)),
    realPath: (path) => exists(path)
      ? Effect.succeed(`/package${relative(path) === "" ? "" : `/${relative(path)}`}`)
      : Effect.fail(missing("realPath", path)),
    stat, lstat: stat, readFile,
    readFileString: (path, encoding) => encoding !== undefined && !/^utf-?8$/iu.test(encoding)
      ? Effect.fail(PlatformError.badArgument({ module: "FileSystem", method: "readFileString", description: "Package files use UTF-8" }))
      : readFile(path).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes))),
    readDirectory: (path, options) => Effect.suspend(() => {
      const name = relative(path)
      if (name === undefined || !directories.has(name)) return Effect.fail(missing("readDirectory", path))
      const prefix = name === "" ? "" : `${name}/`
      const entries = new Set<string>()
      for (const entry of [...directories, ...files.keys()]) {
        if (entry !== name && entry.startsWith(prefix)) {
          const child = entry.slice(prefix.length)
          if (options?.recursive || !child.includes("/")) entries.add(child)
        }
      }
      return Effect.succeed(Array.from(entries).sort())
    }),
    writeFile: denied, writeFileString: denied, makeDirectory: denied, remove: denied,
    rename: denied, copy: denied, copyFile: denied, link: denied, symlink: denied,
    chmod: denied, chown: denied, truncate: denied, utimes: denied
  })
})
