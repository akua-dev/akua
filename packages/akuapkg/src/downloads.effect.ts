import { Config, Effect, FileSystem, Option, Path, Stream } from "effect"
import type { HttpClientResponse } from "effect/http"

/**
 * Shared by the dependency fetchers: bounded downloads and the cache
 * directories the previous release used.
 */

/** `sha256:<hex>` of `bytes`. */
export const sha256 = (bytes: Uint8Array) => `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`

/**
 * `$XDG_CACHE_HOME/akua/<kind>`, else `$HOME/.cache/akua/<kind>`, else
 * `.akua/cache/<kind>` (sandboxes without either).
 */
export const cacheRoot = Effect.fnUntraced(function*(kind: "oci" | "helm" | "git" | "url") {
  const path = yield* Path.Path
  const env = (name: string) =>
    Config.String(name).pipe(Config.option, Effect.orDie, Effect.map(Option.filter((value) => value !== "")))
  const xdg = yield* env("XDG_CACHE_HOME")
  if (Option.isSome(xdg)) return path.join(xdg.value, "akua", kind)
  const home = yield* env("HOME")
  if (Option.isSome(home)) return path.join(home.value, ".cache", "akua", kind)
  return path.join(".akua", "cache", kind)
})

/**
 * The body of a 2xx response, read up to `limit` bytes: a declared or
 * streamed size past it fails, so a hostile server cannot fill memory.
 * `fail` builds the caller's error from a message; `status` words a non-2xx answer.
 */
export const readBounded = <E>(
  response: HttpClientResponse.HttpClientResponse,
  request: {
    readonly url: string
    readonly limit: number
    readonly fail: (message: string) => E
    readonly status: (status: number, body: string) => string
  }
): Effect.Effect<Uint8Array, E> =>
  Effect.gen(function*() {
    const { fail, limit, url } = request
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(fail(request.status(response.status, Array.from(text).slice(0, 300).join(""))))
    }
    const declared = Number(response.headers["content-length"] ?? Number.NaN)
    if (declared > limit) {
      return yield* Effect.fail(fail(`response from \`${url}\` exceeds the ${limit}-byte ceiling (declared ${declared} bytes)`))
    }
    let total = 0
    const chunks: Array<Uint8Array> = []
    yield* response.stream.pipe(
      Stream.mapError((error) => fail(`reading response body from \`${url}\`: ${error.message}`)),
      Stream.runForEach((chunk) => {
        total += chunk.length
        chunks.push(chunk)
        return total > limit ? Effect.fail(fail(`response from \`${url}\` exceeds the ${limit}-byte ceiling`)) : Effect.void
      })
    )
    return new Uint8Array(Bun.concatArrayBuffers(chunks))
  })

/**
 * Write `entries` under a staging directory next to `slot`, then move it
 * into place. A racing fetch that landed the same content first wins.
 */
export const unpackInto = Effect.fnUntraced(function*(
  slot: string,
  entries: ReadonlyArray<{ readonly path: string; readonly data: Uint8Array }>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parent = path.dirname(slot)
  yield* fs.makeDirectory(parent, { recursive: true })
  if (yield* fs.exists(slot)) return
  const staging = yield* fs.makeTempDirectory({ directory: parent, prefix: "akua-stage-" })
  for (const entry of entries) {
    const target = path.join(staging, ...entry.path.split("/"))
    yield* fs.makeDirectory(path.dirname(target), { recursive: true })
    yield* fs.writeFile(target, entry.data)
  }
  yield* fs.rename(staging, slot).pipe(
    Effect.catchTag("PlatformError", (error) =>
      fs.exists(slot).pipe(
        Effect.flatMap((exists) => exists ? fs.remove(staging, { recursive: true }) : Effect.fail(error))
      ))
  )
})
