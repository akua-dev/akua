/**
 * The promise filesystem API isomorphic-git drives, in memory: a fetched
 * repository never touches the host disk, and no host path is reachable
 * through it. Only what isomorphic-git calls is implemented.
 */

type Node =
  | { readonly kind: "file"; data: Uint8Array; mode: number }
  | { readonly kind: "dir"; readonly entries: Map<string, Node> }

class FsError extends Error {
  constructor(readonly code: "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY", path: string) {
    super(`${code}: ${path}`)
  }
}

const parts = (path: string) => String(path).split("/").filter((part) => part !== "" && part !== ".")

/**
 * Every method answers with a promise and never throws: isomorphic-git
 * recognizes a promise filesystem by calling `readFile()` with no
 * arguments and checking for a promise.
 */
const later = <A>(run: () => A): Promise<A> => Promise.resolve().then(run)

const stats = (node: Node, ino: number) => ({
  type: node.kind === "dir" ? "dir" : "file",
  mode: node.kind === "dir" ? 0o40755 : node.mode,
  size: node.kind === "dir" ? 0 : node.data.length,
  ino,
  mtimeMs: 0,
  ctimeMs: 0,
  uid: 1,
  gid: 1,
  dev: 1,
  isFile: () => node.kind === "file",
  isDirectory: () => node.kind === "dir",
  isSymbolicLink: () => false
})

export class MemoryFs {
  private readonly root: Node = { kind: "dir", entries: new Map() }

  private lookup(path: string): Node | undefined {
    let node: Node | undefined = this.root
    for (const part of parts(path)) {
      if (node === undefined || node.kind !== "dir") return undefined
      node = node.entries.get(part)
    }
    return node
  }

  private parent(path: string) {
    const all = parts(path)
    const name = all.at(-1)
    const parent = this.lookup(all.slice(0, -1).join("/"))
    if (name === undefined || parent === undefined) throw new FsError("ENOENT", path)
    if (parent.kind !== "dir") throw new FsError("ENOTDIR", path)
    return { name, entries: parent.entries }
  }

  readonly promises = {
    readFile: (path: string, options?: string | { readonly encoding?: string }) =>
      later((): Uint8Array | string => {
        const node = this.lookup(path)
        if (node === undefined) throw new FsError("ENOENT", path)
        if (node.kind === "dir") throw new FsError("EISDIR", path)
        const encoding = typeof options === "string" ? options : options?.encoding
        return encoding === undefined ? Buffer.from(node.data) : new TextDecoder().decode(node.data)
      }),
    writeFile: (path: string, data: Uint8Array | string, options?: { readonly mode?: number }) =>
      later(() => {
        const { entries, name } = this.parent(path)
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data)
        entries.set(name, { kind: "file", data: bytes, mode: options?.mode ?? 0o100644 })
      }),
    unlink: (path: string) =>
      later(() => {
        const node = this.lookup(path)
        if (node === undefined) throw new FsError("ENOENT", path)
        if (node.kind === "dir") throw new FsError("EISDIR", path)
        const { entries, name } = this.parent(path)
        entries.delete(name)
      }),
    readdir: (path: string) =>
      later(() => {
        const node = this.lookup(path)
        if (node === undefined) throw new FsError("ENOENT", path)
        if (node.kind !== "dir") throw new FsError("ENOTDIR", path)
        return Array.from(node.entries.keys())
      }),
    mkdir: (path: string) =>
      later(() => {
        if (this.lookup(path) !== undefined) throw new FsError("EEXIST", path)
        const { entries, name } = this.parent(path)
        entries.set(name, { kind: "dir", entries: new Map() })
      }),
    rmdir: (path: string) =>
      later(() => {
        const node = this.lookup(path)
        if (node === undefined) throw new FsError("ENOENT", path)
        if (node.kind !== "dir") throw new FsError("ENOTDIR", path)
        if (node.entries.size > 0) throw new FsError("ENOTEMPTY", path)
        const { entries, name } = this.parent(path)
        entries.delete(name)
      }),
    stat: (path: string) =>
      later(() => {
        const node = this.lookup(path)
        if (node === undefined) throw new FsError("ENOENT", path)
        return stats(node, parts(path).length)
      }),
    lstat: (path: string) => this.promises.stat(path),
    readlink: (path: string) => later((): string => { throw new FsError("ENOENT", path) }),
    symlink: (_target: string, path: string) => later((): void => { throw new FsError("ENOENT", path) }),
    chmod: () => later(() => undefined)
  }
}
