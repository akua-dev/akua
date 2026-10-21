import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { CliName } from "./cli-name"
import { HttpClient, HttpClientRequest } from "effect/http"
import { cacheRoot, readBounded, sha256, unpackInto } from "./downloads.effect"

/**
 * Single-file dependencies (`url = "https://..."`, CRD sources only): the
 * file fetched over HTTPS, pinned in `akua.lock` by its sha256, and kept in
 * `<cache>/url/<hex>/<file name>`.
 */

export class UrlFetchFailed extends Schema.TaggedError<UrlFetchFailed>()("UrlFetchFailed", {
  message: Schema.String,
  /** Refused because `--offline` forbids the network, not because a fetch failed. */
  offline: Schema.Boolean,
  /** The server sent other bytes than `akua.lock` pins. */
  drift: Schema.optionalKey(Schema.Boolean)
}) {}

export interface UrlRequest {
  readonly url: string
  /** The `akua.lock` digest the file must have. */
  readonly pin: Option.Option<string>
  readonly offline: boolean
}

export interface FetchedFile {
  /** A directory holding only the file. */
  readonly directory: string
  readonly digest: string
}

const MAX_FILE_BYTES = 64 * 1024 * 1024

/** The URL's last path segment as a safe file name. */
export const urlFileName = (url: string) => {
  const last = (url.split(/[?#]/, 1)[0] ?? "").split("/").at(-1) ?? ""
  const name = last.replace(/[^A-Za-z0-9._-]/g, "_")
  return name === "" || name === "." || name === ".." ? "download.yaml" : name
}

export class UrlSource extends Context.Service<UrlSource, {
  fetch(request: UrlRequest): Effect.Effect<FetchedFile, UrlFetchFailed>
}>()("akuapkg/host/UrlSource") {
  static readonly layer = Layer.effect(
    UrlSource,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const http = yield* HttpClient.HttpClient
      const root = yield* cacheRoot("url")
      const failed = (message: string) => new UrlFetchFailed({ message, offline: false })
      const slot = (digest: string) => path.join(root, digest.replace(/^sha256:/, ""))

      const fetch = Effect.fn("UrlSource.fetch")(function*(request: UrlRequest) {
        const name = urlFileName(request.url)
        if (Option.isSome(request.pin)) {
          const cached = slot(request.pin.value)
          if (yield* fs.exists(path.join(cached, name)).pipe(Effect.orElseSucceed(() => false))) {
            return { directory: cached, digest: request.pin.value } satisfies FetchedFile
          }
        }
        if (request.offline) {
          return yield* new UrlFetchFailed({
            offline: true,
            message: Option.isSome(request.pin)
              ? `offline mode and the url cache doesn't have this file - run \`${yield* CliName} add\` online first`
              : `offline mode needs a lockfile-pinned digest - run \`${yield* CliName} add\` first`
          })
        }
        if (!request.url.startsWith("https://")) return yield* failed(`\`${request.url}\`: only https:// URLs are supported`)
        const bytes = yield* http.execute(HttpClientRequest.get(request.url)).pipe(
          Effect.mapError((cause) => failed(`fetching ${request.url}: ${cause.message}`)),
          Effect.flatMap((response) =>
            readBounded(response, {
              url: request.url,
              limit: MAX_FILE_BYTES,
              fail: failed,
              status: (status) => `fetching ${request.url}: HTTP ${status}`
            })
          )
        )
        const digest = sha256(bytes)
        if (Option.isSome(request.pin) && request.pin.value !== digest) {
          return yield* new UrlFetchFailed({
            offline: false,
            drift: true,
            message: `\`${request.url}\` has digest ${digest}, but akua.lock pins ${request.pin.value}`
          })
        }
        yield* unpackInto(slot(digest), [{ path: name, data: bytes }]).pipe(
          Effect.mapError((error) => failed(`io error at ${root}: ${error.message}`))
        )
        return { directory: slot(digest), digest } satisfies FetchedFile
      }, Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))

      return UrlSource.of({ fetch })
    })
  )
}
