import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import YAML from "yaml"
import { gunzip, untar } from "./archive"
import { cacheRoot, readBounded, sha256, unpackInto } from "./downloads.effect"

/**
 * Charts from classic HTTPS Helm repositories (`repo = "https://..."`,
 * `chart`, `version`): `index.yaml`, version selection, then the `.tgz`,
 * pinned in `akua.lock` by the tarball's sha256 and unpacked into the
 * previous release's cache (`<cache>/helm/<hex>/<chart>/`).
 */

export class HelmRepositoryFailed extends Schema.TaggedError<HelmRepositoryFailed>()("HelmRepositoryFailed", {
  message: Schema.String,
  /** Refused because `--offline` forbids the network, not because a fetch failed. */
  offline: Schema.Boolean
}) {}

const MAX_INDEX_BYTES = 32 * 1024 * 1024
const MAX_TARBALL_BYTES = 1024 * 1024 * 1024

const RepositoryIndex = Schema.Struct({
  entries: Schema.optionalKey(Schema.Record(
    Schema.String,
    Schema.NullOr(Schema.Array(Schema.Struct({
      version: Schema.String,
      urls: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)))
    })))
  ))
})
type RepositoryIndex = typeof RepositoryIndex.Type

export interface ChartRequest {
  readonly repository: string
  readonly chart: string
  /** An exact version or a semver requirement (`>=0.60, <0.63`). */
  readonly version: string
  /** The `akua.lock` digest the tarball must have. */
  readonly pin: Option.Option<string>
  readonly offline: boolean
}

export interface FetchedChart {
  readonly directory: string
  /** The `.tgz` digest: what `akua.lock` pins. */
  readonly digest: string
  /** The exact version selected. */
  readonly version: string
}

/**
 * The highest published version satisfying `requirement`. A plain version
 * means exactly that version; a leading `v` (a git-tag habit Helm tolerates)
 * is ignored on both sides; entries that are not semver are skipped.
 */
export const selectVersion = (
  index: RepositoryIndex,
  chart: string,
  requirement: string
): { readonly version: string; readonly url: string } | string => {
  const entries = index.entries?.[chart] ?? undefined
  if (entries === undefined || entries === null) return `chart \`${chart}\` not found in repo index`
  const trimmed = requirement.trim()
  const plain = trimmed.replace(/^v/, "")
  // Rust semver requirements separate comparators with commas; npm ranges with spaces.
  const range = /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(plain) ? `=${plain}` : trimmed.replaceAll(",", " ")
  let best: { readonly version: string; readonly url: string | undefined } | undefined
  for (const entry of entries) {
    const version = entry.version.replace(/^v/, "")
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(version)) continue
    if (!Bun.semver.satisfies(version, range)) continue
    if (best === undefined || Bun.semver.order(version, best.version) > 0) {
      best = { version, url: entry.urls?.[0] }
    }
  }
  if (best === undefined) {
    const available = entries.map((entry) => entry.version).toSorted().join(", ")
    return `no version of \`${chart}\` satisfies \`${requirement}\`; available: ${available}`
  }
  if (best.url === undefined) return `chart \`${chart}\`@\`${best.version}\` has no download URL in the index`
  return { version: best.version, url: best.url }
}

/**
 * An index entry's tarball URL, absolute. An `http://` tarball from an index
 * served over `https://` is refused: a rewritten index could otherwise
 * downgrade the first, unpinned download to plaintext.
 */
export const tarballUrl = (
  repository: string,
  url: string,
  chart: string
): { readonly url: string } | { readonly error: string } => {
  if (url.startsWith("https://")) return { url }
  if (url.startsWith("http://")) {
    return repository.startsWith("https://")
      ? {
        error: `index for \`${chart}\` points its tarball at an http:// URL (\`${url}\`) but the repo was fetched ` +
          "over https:// - refusing the scheme downgrade"
      }
      : { url }
  }
  return { url: `${repository.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}` }
}

export class HelmRepository extends Context.Service<HelmRepository, {
  fetch(request: ChartRequest): Effect.Effect<FetchedChart, HelmRepositoryFailed>
}>()("akuapkg/host/HelmRepository") {
  static readonly layer = Layer.effect(
    HelmRepository,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const http = yield* HttpClient.HttpClient
      const root = yield* cacheRoot("helm")
      const failed = (message: string) => new HelmRepositoryFailed({ message, offline: false })

      const get = (url: string, limit: number) =>
        http.execute(HttpClientRequest.get(url)).pipe(
          Effect.mapError((cause) => failed(`fetching ${url}: ${cause.message}`)),
          Effect.flatMap((response) =>
            readBounded(response, {
              url,
              limit,
              fail: failed,
              status: (status) => `fetching ${url}: HTTP ${status}`
            })
          )
        )

      /** The unpacked chart for `digest`: `<slot>/<chart>/`, or a chart packed at the archive root. */
      const cached = Effect.fnUntraced(function*(digest: string, chart: string) {
        const slot = path.join(root, digest.replace(/^sha256:/, ""))
        for (const candidate of [path.join(slot, chart), slot]) {
          if (yield* fs.exists(path.join(candidate, "Chart.yaml")).pipe(Effect.orElseSucceed(() => false))) {
            return Option.some(candidate)
          }
        }
        return Option.none<string>()
      })

      const fetch = Effect.fn("HelmRepository.fetch")(function*(request: ChartRequest) {
        if (Option.isSome(request.pin)) {
          const hit = yield* cached(request.pin.value, request.chart)
          if (Option.isSome(hit)) {
            return { directory: hit.value, digest: request.pin.value, version: request.version } satisfies FetchedChart
          }
        }
        if (request.offline) {
          return yield* new HelmRepositoryFailed({
            offline: true,
            message: Option.isSome(request.pin)
              ? "offline mode and the helm cache doesn't have this dep - run `akua add` online first"
              : "offline mode needs a lockfile-pinned digest - run `akua add` first"
          })
        }
        const indexUrl = `${request.repository.replace(/\/+$/, "")}/index.yaml`
        const indexText = new TextDecoder().decode(yield* get(indexUrl, MAX_INDEX_BYTES))
        const index = yield* Effect.try({
          try: (): unknown => YAML.parse(indexText),
          catch: (cause) => failed(`parsing index.yaml: ${String(cause)}`)
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RepositoryIndex)),
          Effect.mapError((error) => error._tag === "HelmRepositoryFailed" ? error : failed(`parsing index.yaml: ${error.message}`))
        )
        const selected = selectVersion(index, request.chart, request.version)
        if (typeof selected === "string") return yield* failed(selected)
        const download = tarballUrl(request.repository, selected.url, request.chart)
        if ("error" in download) return yield* failed(download.error)
        const tarball = yield* get(download.url, MAX_TARBALL_BYTES)
        const digest = sha256(tarball)
        if (Option.isSome(request.pin) && request.pin.value !== digest) {
          return yield* failed(`digest mismatch for \`${request.chart}\`: expected ${request.pin.value}, got ${digest}`)
        }
        const entries = yield* gunzip(tarball).pipe(
          Effect.flatMap(untar),
          Effect.mapError((error) => failed(`extracting \`${request.chart}\`: ${error.message}`))
        )
        yield* unpackInto(path.join(root, digest.replace(/^sha256:/, "")), entries).pipe(
          Effect.mapError((error) => failed(`io error at ${root}: ${error.message}`))
        )
        const directory = yield* cached(digest, request.chart)
        if (Option.isNone(directory)) return yield* failed(`chart \`${request.chart}\` has no Chart.yaml in its tarball`)
        return { directory: directory.value, digest, version: selected.version } satisfies FetchedChart
      }, Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))

      return HelmRepository.of({ fetch })
    })
  )
}
