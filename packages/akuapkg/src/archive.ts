import { Effect, Schema, Stream } from "effect"

/**
 * Untrusted archives (registry blobs, Helm-repository charts) unpacked into
 * memory. Strict rather than forgiving: an absolute path, a `..` segment
 * or a path that is not UTF-8 fails the archive; links and devices are
 * skipped; the decompressed size is capped, because the verified digest
 * covers only the compressed bytes.
 */

export class ArchiveInvalid extends Schema.TaggedError<ArchiveInvalid>()("ArchiveInvalid", {
  message: Schema.String
}) {}

/** Ceiling on a decompressed archive: generous for any chart or package, and bounded. */
export const MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024

const decoder = new TextDecoder("utf-8", { fatal: true })

/** gzip-decompress `bytes`, failing past `limit` decompressed bytes. */
export const gunzip = (bytes: Uint8Array, limit = MAX_DECOMPRESSED_BYTES) =>
  Stream.fromReadableStream({
    // A copy, so the Blob holds an ArrayBuffer-backed view whatever backs `bytes`.
    evaluate: () => new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip")),
    onError: (cause) => new ArchiveInvalid({ message: `decompressing: ${String(cause)}` })
  }).pipe(
    Stream.mapAccum(() => 0, (total, chunk: Uint8Array) => [total + chunk.length, [{ total, chunk }]]),
    Stream.mapEffect(({ chunk, total }) =>
      total + chunk.length > limit
        ? Effect.fail(
          new ArchiveInvalid({
            message: `decompressed size exceeds the ${limit}-byte ceiling (possible decompression bomb)`
          })
        )
        : Effect.succeed(chunk)
    ),
    Stream.runCollect,
    Effect.map((chunks) => new Uint8Array(Bun.concatArrayBuffers(Array.from(chunks))))
  )

export interface ArchiveEntry {
  /** POSIX path relative to the archive root. */
  readonly path: string
  readonly data: Uint8Array
}

const field = (block: Uint8Array, offset: number, length: number) => {
  const bytes = block.subarray(offset, offset + length)
  const end = bytes.indexOf(0)
  return bytes.subarray(0, end < 0 ? bytes.length : end)
}

const octal = (block: Uint8Array, offset: number, length: number) =>
  Number.parseInt(new TextDecoder().decode(field(block, offset, length)).trim() || "0", 8)

/** PAX records: `<length> <key>=<value>\n`. */
const paxRecords = (data: Uint8Array) => {
  const records = new Map<string, string>()
  const text = new TextDecoder().decode(data)
  let index = 0
  while (index < text.length) {
    const space = text.indexOf(" ", index)
    const length = Number.parseInt(text.slice(index, space), 10)
    if (space < 0 || !Number.isFinite(length) || length <= 0) break
    const record = text.slice(space + 1, index + length - 1)
    const equals = record.indexOf("=")
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1))
    index += length
  }
  return records
}

/** `path` made relative and checked: no absolute paths, no `..`, no empty names. */
const entryPath = (raw: string) => {
  const parts = raw.replaceAll("\\", "/").split("/").filter((part) => part !== "" && part !== ".")
  if (raw.startsWith("/") || parts.includes("..") || parts.length === 0) return undefined
  return parts.join("/")
}

/** The regular files of a ustar/PAX/GNU tar archive. */
export const untar = Effect.fnUntraced(function*(bytes: Uint8Array) {
  const entries: Array<ArchiveEntry> = []
  let offset = 0
  let longName: string | undefined
  let pax: Map<string, string> | undefined
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + 512
    if (!Number.isFinite(size) || size < 0 || dataStart + size > bytes.length) {
      return yield* new ArchiveInvalid({ message: "truncated tar archive" })
    }
    const data = bytes.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512
    if (type === "x") {
      pax = paxRecords(data)
      continue
    }
    if (type === "g") continue
    if (type === "L") {
      longName = new TextDecoder().decode(field(data, 0, data.length))
      continue
    }
    const ustar = new TextDecoder().decode(header.subarray(257, 262)) === "ustar"
    const prefix = ustar ? field(header, 345, 155) : new Uint8Array()
    const name = field(header, 0, 100)
    const raw = yield* Effect.try({
      try: () =>
        pax?.get("path") ?? longName ??
          (prefix.length > 0 ? `${decoder.decode(prefix)}/${decoder.decode(name)}` : decoder.decode(name)),
      catch: () => new ArchiveInvalid({ message: "tar entry name is not UTF-8" })
    })
    longName = undefined
    pax = undefined
    // Regular files only: links could point anywhere, devices are never content.
    if (type !== "0" && type !== "\0" && type !== "7") continue
    const path = entryPath(raw)
    if (path === undefined) return yield* new ArchiveInvalid({ message: `tar entry \`${raw}\` escapes the archive` })
    entries.push({ path, data: data.slice() })
  }
  return entries
})

/** A file to archive: its POSIX path, contents and permission bits. */
export interface TarFile {
  readonly path: string
  readonly data: Uint8Array
  /** `0o644` or `0o755`. */
  readonly mode: number
}

const encoder = new TextEncoder()

/** One 512-byte ustar header: owner, group and mtime are zero, so archives are reproducible. */
const tarHeader = (name: Uint8Array, size: number, mode: number, type: "0" | "x") => {
  const block = new Uint8Array(512)
  const put = (bytes: Uint8Array, offset: number, length: number) => block.set(bytes.subarray(0, length), offset)
  const octal = (value: number, offset: number, length: number) =>
    put(encoder.encode(`${value.toString(8).padStart(length - 1, "0")}\0`), offset, length)
  put(name, 0, 100)
  octal(mode, 100, 8)
  octal(0, 108, 8)
  octal(0, 116, 8)
  octal(size, 124, 12)
  octal(0, 136, 12)
  put(encoder.encode("        "), 148, 8)
  put(encoder.encode(type), 156, 1)
  put(encoder.encode("ustar\0"), 257, 6)
  put(encoder.encode("00"), 263, 2)
  const checksum = block.reduce((sum, byte) => sum + byte, 0)
  put(encoder.encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148, 8)
  return block
}

const padded = (data: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512)
  out.set(data)
  return out
}

/** A PAX `path` record, `<length> path=<name>\n`, where the length counts itself. */
const paxPath = (name: string) => {
  const body = encoder.encode(` path=${name}\n`).length
  let length = body + 1
  while (String(length).length + body !== length) length = String(length).length + body
  return encoder.encode(`${length} path=${name}\n`)
}

/**
 * A ustar archive of `files`, in the given order. Names over 100 bytes carry
 * a PAX `path` record; there are no directory entries.
 */
export const tar = (files: ReadonlyArray<TarFile>) => {
  const blocks: Array<Uint8Array> = []
  for (const file of files) {
    const name = encoder.encode(file.path)
    if (name.length > 100) {
      const record = paxPath(file.path)
      blocks.push(tarHeader(encoder.encode(`PaxHeader/${file.path}`), record.length, 0o644, "x"), padded(record))
    }
    blocks.push(tarHeader(name, file.data.length, file.mode, "0"), padded(file.data))
  }
  blocks.push(new Uint8Array(1024))
  return new Uint8Array(Bun.concatArrayBuffers(blocks))
}

/**
 * gzip with a fixed header (no name, mtime 0, OS "unknown", as flate2
 * writes it), so the same bytes always compress to the same archive.
 */
export const gzip = (data: Uint8Array) => {
  const deflated = Bun.deflateSync(new Uint8Array(data), { level: 6 })
  const out = new Uint8Array(10 + deflated.length + 8)
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff])
  out.set(deflated, 10)
  const trailer = new DataView(out.buffer, 10 + deflated.length)
  trailer.setUint32(0, Bun.hash.crc32(data), true)
  trailer.setUint32(4, data.length >>> 0, true)
  return out
}
