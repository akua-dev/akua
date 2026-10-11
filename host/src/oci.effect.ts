import { Config, Context, Duration, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import * as TOML from "smol-toml"
import { gunzip, untar } from "./archive"
import { verifyKeyed } from "./cosign"
import { cacheRoot as defaultCacheRoot, readBounded, sha256, unpackInto } from "./downloads.effect"

/**
 * OCI-distributed dependencies (`oci = "oci://<registry>/<repository>"`):
 * Helm charts, Akua Packages and kpm KCL modules, pulled into a
 * content-addressed cache (`<cache>/sha256/<hex>/`, the previous release's
 * layout) and verified against the layer digest, the `akua.lock` pin and,
 * when `[signing].cosign_public_key` is set, a keyed cosign signature.
 */

export class OciPullFailed extends Schema.TaggedError<OciPullFailed>()("OciPullFailed", {
  /** E_DEP_RESOLVE, E_COSIGN_VERIFY or E_COSIGN_SIG_MISSING. */
  code: Schema.String,
  message: Schema.String,
  /** Refused because `--offline` forbids the network, not because a pull failed. */
  offline: Schema.Boolean,
  /** The registry served other bytes than `akua.lock` pins: a supply-chain signal, never ignored. */
  drift: Schema.optionalKey(Schema.Boolean)
}) {}

const HELM_LAYER = "application/vnd.cncf.helm.chart.content.v1.tar+gzip"
export const AKUA_LAYER = "application/vnd.akua.package.content.v1.tar+gzip"
export const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
const AKUA_CONFIG = "application/vnd.akua.package.config.v1+json"
const OCI_EMPTY_CONFIG = "application/vnd.oci.image.config.v1+json"
const DSSE_LAYER = "application/vnd.dsse.envelope.v1+json"

/** A registry refused or failed an upload. */
export class OciPushFailed extends Schema.TaggedError<OciPushFailed>()("OciPushFailed", {
  message: Schema.String
}) {}

const encoder = new TextEncoder()

/**
 * The bytes a Package publish uploads for `tarball`: the config blob
 * (`{"akuaVersion":...}`), and the manifest naming it and the layer. Pure,
 * so `sign` binds a signature to the manifest digest `push` will produce.
 */
export const publishDigests = (tarball: Uint8Array, akuaVersion: string) => {
  const config = encoder.encode(JSON.stringify({ akuaVersion }))
  const layerDigest = sha256(tarball)
  const manifest = encoder.encode(JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: { mediaType: AKUA_CONFIG, size: config.length, digest: sha256(config) },
    layers: [{ mediaType: AKUA_LAYER, size: tarball.length, digest: layerDigest }]
  }))
  return { config, manifest, manifestDigest: sha256(manifest), layerDigest, layerSize: tarball.length }
}

/** The cosign sidecar tag for an artifact: `sha256:<hex>` as `sha256-<hex>.<suffix>`. */
export const sidecarTag = (manifestDigest: string, suffix: "sig" | "att") =>
  `${manifestDigest.replace(/^sha256:/, "sha256-")}.${suffix}`
const KCL_LAYER = "application/vnd.oci.image.layer.v1.tar"
const KCL_ANNOTATIONS = ["org.kcllang.package.name", "org.kclpkg.package.name", "dev.akua.package.name"]
const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json"
]
const COSIGN_LAYER = "application/vnd.dev.cosign.simplesigning.v1+json"
const COSIGN_SIGNATURE = "dev.cosignproject.cosign/signature"

export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
export const MAX_BLOB_BYTES = 1024 * 1024 * 1024
const REQUEST_TIMEOUT = Duration.seconds(60)

const Manifest = Schema.Struct({
  layers: Schema.Array(Schema.Struct({
    mediaType: Schema.String,
    digest: Schema.String,
    size: Schema.optionalKey(Schema.Number),
    annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
  })),
  annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
})
type Manifest = typeof Manifest.Type
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))
const TokenResponse = Schema.Struct({
  token: Schema.optionalKey(Schema.String),
  access_token: Schema.optionalKey(Schema.String)
})
const decodeToken = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenResponse))

export type Credentials =
  | { readonly _tag: "Basic"; readonly username: string; readonly password: string }
  | { readonly _tag: "Bearer"; readonly token: string }

const authorization = (credentials: Credentials) =>
  credentials._tag === "Bearer"
    ? `Bearer ${credentials.token}`
    : `Basic ${new TextEncoder().encode(`${credentials.username}:${credentials.password}`).toBase64()}`

/** `oci://<registry>/<repository>`. */
export const parseReference = (reference: string) => {
  if (!reference.startsWith("oci://")) return undefined
  const rest = reference.slice("oci://".length)
  const slash = rest.indexOf("/")
  if (slash <= 0 || slash === rest.length - 1) return undefined
  return { registry: rest.slice(0, slash), repository: rest.slice(slash + 1) }
}

/** Loopback registries speak plain HTTP; everything else HTTPS. */
const scheme = (registry: string) => {
  const host = registry.startsWith("[")
    ? registry.slice(1, registry.indexOf("]"))
    : registry.split(":").length === 2
    ? registry.split(":")[0]
    : registry
  return host === "localhost" || host === "127.0.0.1" || host === "::1" ? "http" : "https"
}

/** Where a pulled artifact unpacks: content-addressed, shared by every tag that names it. */
const cacheSlot = (path: Path.Path, cacheRoot: string, digest: string) =>
  path.join(cacheRoot, "sha256", digest.replace(/^sha256:/, ""))

export interface PulledPackage {
  /** The `.tar.gz` `publish` uploaded. */
  readonly tarball: Uint8Array
  readonly manifestDigest: string
  readonly layerDigest: string
}

export interface PullRequest {
  /** `oci://<registry>/<repository>`. */
  readonly reference: string
  /** The tag (`version` in `akua.toml`). */
  readonly version: string
  /** The `akua.lock` digest the layer must have. */
  readonly pin: Option.Option<string>
  /** No network: the pinned digest must already be cached. */
  readonly offline: boolean
  readonly cosignPublicKey: Option.Option<string>
}

export interface Pulled {
  /** The unpacked artifact, a directory in the cache. */
  readonly directory: string
  /** The layer (blob) digest: what `akua.lock` pins. */
  readonly digest: string
}

export class OciRegistry extends Context.Service<OciRegistry, {
  pull(request: PullRequest): Effect.Effect<Pulled, OciPullFailed>
  /** A published Akua Package's tarball (the `pull` and `inspect --oci` verbs). */
  pullPackage(request: { readonly reference: string; readonly tag: string }): Effect.Effect<PulledPackage, OciPullFailed>
  /**
   * The DSSE attestation (`.att`) of the artifact `tag` names: its manifest
   * digest, its layer digests, and the envelope when there is one.
   */
  pullAttestation(request: { readonly reference: string; readonly tag: string }): Effect.Effect<
    {
      readonly manifestDigest: string
      readonly layerDigests: ReadonlyArray<string>
      readonly envelope: Option.Option<Uint8Array>
    },
    OciPullFailed
  >
  /** Upload a packed Package under `tag`: layer, config, then manifest. */
  pushPackage(request: {
    readonly reference: string
    readonly tag: string
    readonly tarball: Uint8Array
    readonly akuaVersion: string
  }): Effect.Effect<{ readonly manifestDigest: string; readonly layerDigest: string; readonly layerSize: number }, OciPushFailed>
  /** Attach a keyed cosign signature (the `.sig` sidecar); its tag. */
  pushSignature(request: {
    readonly reference: string
    readonly manifestDigest: string
    readonly payload: Uint8Array
    readonly signatureBase64: string
  }): Effect.Effect<string, OciPushFailed>
  /** Attach a DSSE attestation (the `.att` sidecar); its tag. */
  pushAttestation(request: {
    readonly reference: string
    readonly manifestDigest: string
    readonly envelope: Uint8Array
  }): Effect.Effect<string, OciPushFailed>
}>()("akuapkg/host/OciRegistry") {
  static readonly layer = Layer.effect(
    OciRegistry,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const http = yield* HttpClient.HttpClient
      const env = (name: string) =>
        Config.String(name).pipe(Config.option, Effect.orDie, Effect.map(Option.filter((value) => value !== "")))
      const xdgConfig = yield* env("XDG_CONFIG_HOME")
      const dockerConfig = yield* env("DOCKER_CONFIG")
      const home = yield* env("HOME")
      const cacheRoot = yield* defaultCacheRoot("oci")
      const failed = (message: string, code = "E_DEP_RESOLVE") => new OciPullFailed({ code, message, offline: false })

      /** `auth.toml` (akua) first, then `~/.docker/config.json`; read once, on first use. */
      const credentials = yield* Effect.cached(Effect.gen(function*() {
        const store = new Map<string, Credentials>()
        const akuaAuth = Option.orElse(
          Option.map(xdgConfig, (xdg) => path.join(xdg, "akua", "auth.toml")),
          () => Option.map(home, (h) => path.join(h, ".config", "akua", "auth.toml"))
        )
        const docker = Option.orElse(
          Option.map(dockerConfig, (dir) => path.join(dir, "config.json")),
          () => Option.map(home, (h) => path.join(h, ".docker", "config.json"))
        )
        const read = (file: string) =>
          fs.readFileString(file).pipe(
            Effect.map(Option.some),
            Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed(Option.none<string>())),
            Effect.mapError((error) => failed(`auth config parse error: i/o reading auth config at ${file}: ${error.message}`))
          )
        const parseError = (file: string, cause: unknown) =>
          failed(`auth config parse error: malformed auth config at ${file}: ${cause instanceof Error ? cause.message : String(cause)}`)
        if (Option.isSome(akuaAuth)) {
          const text = yield* read(akuaAuth.value)
          if (Option.isSome(text)) {
            const parsed = yield* Effect.try({
              try: (): unknown => TOML.parse(text.value),
              catch: (cause) => parseError(akuaAuth.value, cause)
            })
            const registries = yield* Schema.decodeUnknownEffect(AkuaAuthFile)(parsed).pipe(
              Effect.mapError((error) => parseError(akuaAuth.value, error))
            )
            for (const [registry, entry] of Object.entries(registries.registries ?? {})) {
              store.set(
                registry,
                entry.token !== undefined
                  ? { _tag: "Bearer", token: entry.token }
                  : { _tag: "Basic", username: entry.username ?? "", password: entry.password ?? "" }
              )
            }
          }
        }
        if (Option.isSome(docker)) {
          const text = yield* read(docker.value)
          if (Option.isSome(text)) {
            const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DockerConfig))(text.value).pipe(
              Effect.mapError((error) => parseError(docker.value, error))
            )
            for (const [registry, entry] of Object.entries(config.auths ?? {})) {
              if (store.has(registry)) continue
              const basic = yield* dockerCredentials(entry)
              if (basic !== undefined) store.set(registry, basic)
            }
          }
        }
        const found: ReadonlyMap<string, Credentials> = store
        return found
      }))

      /** A GET with the registry's auth: anonymous or configured, then the bearer-token exchange on a 401. */
      const get = Effect.fnUntraced(function*(request: {
        readonly url: string
        readonly registry: string
        readonly accept: ReadonlyArray<string>
        readonly limit: number
        readonly token: { value: string | undefined }
      }) {
        const configured = (yield* credentials).get(request.registry)
        const send = (bearer: string | undefined) => {
          const base = HttpClientRequest.get(request.url).pipe(
            request.accept.length === 0 ? (r) => r : HttpClientRequest.setHeader("Accept", request.accept.join(", "))
          )
          const authed = bearer !== undefined
            ? HttpClientRequest.bearerToken(base, bearer)
            : configured?._tag === "Bearer"
            ? HttpClientRequest.bearerToken(base, configured.token)
            : base
          return http.execute(authed).pipe(
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.mapError((cause) => failed(`http error on \`${request.url}\`: ${cause.message}`))
          )
        }
        let response = yield* send(request.token.value)
        if (response.status === 401) {
          const challenge = bearerChallenge(response.headers["www-authenticate"])
          if (challenge === undefined) {
            return yield* failed(
              `registry \`${request.registry}\` rejected auth. Configure credentials in \`~/.config/akua/auth.toml\` ` +
                "or `docker login` for `~/.docker/config.json`."
            )
          }
          request.token.value = yield* exchangeToken(challenge, configured, request.registry)
          response = yield* send(request.token.value)
          if (response.status === 401) {
            return yield* failed(
              `registry \`${request.registry}\` rejected auth. Configure credentials in \`~/.config/akua/auth.toml\` ` +
                "or `docker login` for `~/.docker/config.json`."
            )
          }
        }
        return yield* body(response, request.url, request.limit)
      })

      const exchangeToken = Effect.fnUntraced(function*(
        challenge: { readonly realm: string; readonly service?: string; readonly scope?: string },
        configured: Credentials | undefined,
        registry: string
      ) {
        const params: Array<readonly [string, string]> = []
        if (challenge.service !== undefined) params.push(["service", challenge.service])
        if (challenge.scope !== undefined) params.push(["scope", challenge.scope])
        const request = HttpClientRequest.get(challenge.realm).pipe(
          HttpClientRequest.setUrlParams(params),
          configured === undefined ? (r) => r : HttpClientRequest.setHeader("Authorization", authorization(configured))
        )
        const response = yield* http.execute(request).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError((cause) => failed(`http error on \`${challenge.realm}\`: ${cause.message}`))
        )
        const text = new TextDecoder().decode(yield* body(response, challenge.realm, MAX_MANIFEST_BYTES))
        const token = yield* decodeToken(text).pipe(
          Effect.mapError((error) => failed(`http error on \`${challenge.realm}\`: ${error.message}`))
        )
        const value = token.token || token.access_token || ""
        if (value === "") {
          return yield* failed(
            `registry \`${challenge.service ?? challenge.realm ?? registry}\` rejected auth. Configure credentials in ` +
              "`~/.config/akua/auth.toml` or `docker login` for `~/.docker/config.json`."
          )
        }
        return value
      })

      /** The response body, failing on a non-2xx status or past `limit` bytes. */
      const body = (response: HttpClientResponse.HttpClientResponse, url: string, limit: number) =>
        readBounded(response, {
          url,
          limit,
          fail: (message) => failed(message),
          status: (status, text) => `registry returned ${status} for \`${url}\`: ${text}`
        })

      /** The cached artifact for `digest`, if it was unpacked before. */
      const cached = Effect.fnUntraced(function*(digest: string) {
        const slot = cacheSlot(path, cacheRoot, digest)
        return (yield* fs.exists(slot).pipe(Effect.orElseSucceed(() => false)))
          ? Option.some({ directory: slot, digest } satisfies Pulled)
          : Option.none<Pulled>()
      })

      const pull = Effect.fn("OciRegistry.pull")(function*(request: PullRequest) {
        const parsed = parseReference(request.reference)
        if (parsed === undefined) {
          return yield* failed(`invalid OCI reference \`${request.reference}\`: expected \`oci://<registry>/<repo>\``)
        }
        if (Option.isSome(request.pin)) {
          const hit = yield* cached(request.pin.value)
          if (Option.isSome(hit)) return hit.value
        }
        if (request.offline) {
          return yield* new OciPullFailed({
            code: "E_DEP_RESOLVE",
            offline: true,
            message: Option.isSome(request.pin)
              ? "offline mode and the OCI cache doesn't have this dep - run `akua add` online first"
              : "offline mode needs a lockfile-pinned digest - run `akua add` first"
          })
        }
        const base = `${scheme(parsed.registry)}://${parsed.registry}/v2/${parsed.repository}`
        const token: { value: string | undefined } = { value: undefined }
        const manifestBytes = yield* get({
          url: `${base}/manifests/${request.version}`,
          registry: parsed.registry,
          accept: MANIFEST_TYPES,
          limit: MAX_MANIFEST_BYTES,
          token
        })
        const manifest = yield* decodeManifest(new TextDecoder().decode(manifestBytes)).pipe(
          Effect.mapError((error) => failed(`malformed manifest JSON: ${error.message}`))
        )
        const manifestDigest = sha256(manifestBytes)
        if (Option.isSome(request.cosignPublicKey)) {
          yield* verifySignature({
            base,
            registry: parsed.registry,
            reference: `oci://${parsed.registry}/${parsed.repository}`,
            manifestDigest,
            publicKeyPem: request.cosignPublicKey.value,
            token
          })
        }
        const layer = packageLayer(manifest)
        if (layer === undefined) {
          return yield* failed(
            `manifest for \`${request.reference}:${request.version}\` has no recognised package layer - expected helm ` +
              `\`${HELM_LAYER}\`, akua \`${AKUA_LAYER}\`, or KCL \`${KCL_LAYER}\` with \`org.kcllang.package.*\` / ` +
              "`org.kclpkg.package.*` / `dev.akua.package.*` annotations"
          )
        }
        if ((layer.size ?? 0) > MAX_BLOB_BYTES) {
          return yield* failed(
            `response body for \`${base}/blobs/${layer.digest}\` exceeds the ${MAX_BLOB_BYTES}-byte ceiling ` +
              `(registry declared ${layer.size} bytes)`
          )
        }
        const blob = yield* get({
          url: `${base}/blobs/${layer.digest}`,
          registry: parsed.registry,
          accept: [],
          limit: MAX_BLOB_BYTES,
          token
        })
        const digest = sha256(blob)
        if (digest !== layer.digest) {
          return yield* failed(`pulled blob digest \`${digest}\` doesn't match layer-declared \`${layer.digest}\``)
        }
        if (Option.isSome(request.pin) && digest !== request.pin.value) {
          return yield* new OciPullFailed({
            code: "E_DEP_RESOLVE",
            offline: false,
            drift: true,
            message: `pulled blob digest \`${digest}\` doesn't match lockfile-pinned \`${request.pin.value}\` for ` +
              `\`${request.reference}:${request.version}\``
          })
        }
        const tar = layer.mediaType === KCL_LAYER ? blob : yield* gunzip(blob)
        const entries = yield* untar(tar)
        const slot = cacheSlot(path, cacheRoot, digest)
        yield* unpack(slot, entries)
        return { directory: slot, digest } satisfies Pulled
      }, Effect.catchTag("ArchiveInvalid", (error) => Effect.fail(failed(`extracting chart tarball: ${error.message}`))))

      const unpack = (slot: string, entries: ReadonlyArray<{ path: string; data: Uint8Array }>) =>
        unpackInto(slot, entries).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((error) => failed(`i/o at the OCI cache: ${error.message}`))
        )

      const verifySignature = Effect.fnUntraced(function*(request: {
        readonly base: string
        readonly registry: string
        readonly reference: string
        readonly manifestDigest: string
        readonly publicKeyPem: string
        readonly token: { value: string | undefined }
      }) {
        const tag = `sha256-${request.manifestDigest.replace(/^sha256:/, "")}.sig`
        const missing = (detail: string) =>
          failed(
            `cosign signature for \`${request.reference}@${request.manifestDigest}\` is missing or malformed at ` +
              `\`${tag}\`: ${detail}`,
            "E_COSIGN_SIG_MISSING"
          )
        const signatureManifest = yield* get({
          url: `${request.base}/manifests/${tag}`,
          registry: request.registry,
          accept: MANIFEST_TYPES,
          limit: MAX_MANIFEST_BYTES,
          token: request.token
        }).pipe(
          Effect.flatMap((bytes) => decodeManifest(new TextDecoder().decode(bytes))),
          Effect.mapError((error) => missing(error.message))
        )
        const layer = signatureManifest.layers.find((candidate) => candidate.mediaType === COSIGN_LAYER)
        if (layer === undefined) return yield* missing(`no layer with media type ${COSIGN_LAYER}`)
        const signature = layer.annotations?.[COSIGN_SIGNATURE]
        if (signature === undefined) return yield* missing(`layer missing \`${COSIGN_SIGNATURE}\` annotation`)
        const payload = yield* get({
          url: `${request.base}/blobs/${layer.digest}`,
          registry: request.registry,
          accept: [],
          limit: MAX_MANIFEST_BYTES,
          token: request.token
        }).pipe(Effect.mapError((error) => missing(`payload blob: ${error.message}`)))
        yield* verifyKeyed({
          publicKeyPem: request.publicKeyPem,
          payload,
          signatureBase64: signature,
          manifestDigest: request.manifestDigest
        }).pipe(
          Effect.mapError((error) =>
            failed(
              `cosign verify failed for \`${request.reference}@${request.manifestDigest}\`: ${error.message}`,
              "E_COSIGN_VERIFY"
            )
          )
        )
      })

      const pullPackage = Effect.fn("OciRegistry.pullPackage")(function*(request: {
        readonly reference: string
        readonly tag: string
      }) {
        const parsed = parseReference(request.reference)
        if (parsed === undefined) {
          return yield* failed(`invalid OCI reference \`${request.reference}\`: expected \`oci://<registry>/<repo>\``)
        }
        const base = `${scheme(parsed.registry)}://${parsed.registry}/v2/${parsed.repository}`
        const token: { value: string | undefined } = { value: undefined }
        const manifestBytes = yield* get({
          url: `${base}/manifests/${request.tag}`,
          registry: parsed.registry,
          accept: [OCI_MANIFEST],
          limit: MAX_MANIFEST_BYTES,
          token
        })
        const manifest = yield* decodeManifest(new TextDecoder().decode(manifestBytes)).pipe(
          Effect.mapError((error) => failed(`manifest parse: ${error.message}`))
        )
        const layer = manifest.layers.find((entry) => entry.mediaType === AKUA_LAYER)
        if (layer === undefined) {
          return yield* failed(
            `manifest at \`${request.reference}:${request.tag}\` has no akua package layer (media type ${AKUA_LAYER})`
          )
        }
        const tarball = yield* get({
          url: `${base}/blobs/${layer.digest}`,
          registry: parsed.registry,
          accept: [],
          limit: MAX_BLOB_BYTES,
          token
        })
        const actual = sha256(tarball)
        if (actual !== layer.digest) {
          return yield* failed(`pulled blob digest \`${actual}\` doesn't match manifest-declared \`${layer.digest}\``)
        }
        return { tarball, manifestDigest: sha256(manifestBytes), layerDigest: layer.digest } satisfies PulledPackage
      })

      const pullAttestation = Effect.fn("OciRegistry.pullAttestation")(function*(request: {
        readonly reference: string
        readonly tag: string
      }) {
        const parsed = parseReference(request.reference)
        if (parsed === undefined) {
          return yield* failed(`invalid OCI reference \`${request.reference}\`: expected \`oci://<registry>/<repo>\``)
        }
        const base = `${scheme(parsed.registry)}://${parsed.registry}/v2/${parsed.repository}`
        const token: { value: string | undefined } = { value: undefined }
        const manifestBytes = yield* get({
          url: `${base}/manifests/${request.tag}`,
          registry: parsed.registry,
          accept: MANIFEST_TYPES,
          limit: MAX_MANIFEST_BYTES,
          token
        })
        const manifest = yield* decodeManifest(new TextDecoder().decode(manifestBytes)).pipe(
          Effect.mapError((error) => failed(`manifest parse: ${error.message}`))
        )
        const manifestDigest = sha256(manifestBytes)
        const layerDigests = manifest.layers.map((layer) => layer.digest)
        const attestation = yield* get({
          url: `${base}/manifests/${sidecarTag(manifestDigest, "att")}`,
          registry: parsed.registry,
          accept: [OCI_MANIFEST],
          limit: MAX_MANIFEST_BYTES,
          token
        }).pipe(
          Effect.map(Option.some),
          Effect.catchIf((error) => / returned 404 /.test(error.message), () => Effect.succeedNone)
        )
        if (Option.isNone(attestation)) return { manifestDigest, layerDigests, envelope: Option.none() }
        const sidecar = yield* decodeManifest(new TextDecoder().decode(attestation.value)).pipe(
          Effect.mapError((error) => failed(`manifest parse: ${error.message}`))
        )
        const layer = sidecar.layers.find((entry) => entry.mediaType === DSSE_LAYER)
        if (layer === undefined) {
          return yield* failed(
            `manifest at \`${request.reference}:${sidecarTag(manifestDigest, "att")}\` has no akua package layer (media type ${AKUA_LAYER})`
          )
        }
        const envelope = yield* get({
          url: `${base}/blobs/${layer.digest}`,
          registry: parsed.registry,
          accept: [],
          limit: MAX_MANIFEST_BYTES,
          token
        })
        return { manifestDigest, layerDigests, envelope: Option.some(envelope) }
      })

      const pushFailed = (message: string) => new OciPushFailed({ message })
      const authRejected = (registry: string) =>
        pushFailed(
          `registry \`${registry}\` rejected auth. Configure credentials in \`~/.config/akua/auth.toml\` ` +
            "or `docker login` for `~/.docker/config.json`."
        )

      /** A POST or PUT with the registry's auth, retried once with a bearer token after a 401 challenge. */
      const send = Effect.fnUntraced(function*(request: {
        readonly method: "POST" | "PUT"
        readonly url: string
        readonly registry: string
        readonly body: Uint8Array
        readonly contentType?: string
        readonly token: { value: string | undefined }
      }) {
        const configured = (yield* credentials.pipe(Effect.mapError((error) => pushFailed(error.message)))).get(
          request.registry
        )
        const attempt = (bearer: string | undefined) => {
          const base = (request.method === "POST" ? HttpClientRequest.post : HttpClientRequest.put)(request.url).pipe(
            HttpClientRequest.bodyUint8Array(request.body, request.contentType ?? "application/octet-stream")
          )
          const authed = bearer !== undefined
            ? HttpClientRequest.bearerToken(base, bearer)
            : configured?._tag === "Bearer"
            ? HttpClientRequest.bearerToken(base, configured.token)
            : base
          return http.execute(authed).pipe(
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.mapError((cause) => pushFailed(`http error on \`${request.url}\`: ${cause.message}`))
          )
        }
        let response = yield* attempt(request.token.value)
        if (response.status !== 401) return response
        const challenge = bearerChallenge(response.headers["www-authenticate"])
        if (challenge === undefined) return yield* authRejected(request.registry)
        request.token.value = yield* exchangeToken(challenge, configured, request.registry).pipe(
          Effect.mapError((error) => pushFailed(error.message))
        )
        response = yield* attempt(request.token.value)
        if (response.status === 401) return yield* authRejected(request.registry)
        return response
      })

      const failedUpload = (response: HttpClientResponse.HttpClientResponse) =>
        response.text.pipe(
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((body) => Effect.fail(pushFailed(`registry returned ${response.status} on blob upload: ${body}`)))
        )

      /** A monolithic blob upload: `POST .../blobs/uploads/`, then `PUT <location>?digest=`. */
      const uploadBlob = Effect.fnUntraced(function*(
        target: { readonly registry: string; readonly repository: string },
        bytes: Uint8Array,
        token: { value: string | undefined }
      ) {
        const origin = `${scheme(target.registry)}://${target.registry}`
        const started = yield* send({
          method: "POST",
          url: `${origin}/v2/${target.repository}/blobs/uploads/`,
          registry: target.registry,
          body: new Uint8Array(),
          token
        })
        const location = started.headers["location"]
        if (location === undefined) return yield* pushFailed("registry didn't return a Location header on blob upload start")
        const url = /^https?:\/\//.test(location) ? location : `${origin}${location}`
        const put = yield* send({
          method: "PUT",
          url: `${url}${url.includes("?") ? "&" : "?"}digest=${sha256(bytes)}`,
          registry: target.registry,
          body: bytes,
          token
        })
        if (put.status !== 201 && put.status !== 202) return yield* failedUpload(put)
      })

      const putManifest = Effect.fnUntraced(function*(
        target: { readonly registry: string; readonly repository: string },
        tag: string,
        manifest: Uint8Array,
        token: { value: string | undefined }
      ) {
        const response = yield* send({
          method: "PUT",
          url: `${scheme(target.registry)}://${target.registry}/v2/${target.repository}/manifests/${tag}`,
          registry: target.registry,
          body: manifest,
          contentType: OCI_MANIFEST,
          token
        })
        if (response.status < 200 || response.status >= 300) return yield* failedUpload(response)
      })

      const target = (reference: string) => {
        const parsed = parseReference(reference)
        return parsed === undefined
          ? Effect.fail(pushFailed(`invalid OCI reference \`${reference}\`: expected \`oci://<registry>/<repo>\``))
          : Effect.succeed(parsed)
      }

      const pushPackage = Effect.fn("OciRegistry.pushPackage")(function*(request: {
        readonly reference: string
        readonly tag: string
        readonly tarball: Uint8Array
        readonly akuaVersion: string
      }) {
        const parsed = yield* target(request.reference)
        const token: { value: string | undefined } = { value: undefined }
        const digests = publishDigests(request.tarball, request.akuaVersion)
        yield* uploadBlob(parsed, request.tarball, token)
        yield* uploadBlob(parsed, digests.config, token)
        yield* putManifest(parsed, request.tag, digests.manifest, token)
        return { manifestDigest: digests.manifestDigest, layerDigest: digests.layerDigest, layerSize: digests.layerSize }
      })

      /** A cosign sidecar: `payload` as its one layer, under an empty `{}` config. */
      const pushSidecar = Effect.fnUntraced(function*(
        reference: string,
        tag: string,
        payload: Uint8Array,
        layer: Record<string, unknown>
      ) {
        const parsed = yield* target(reference)
        const token: { value: string | undefined } = { value: undefined }
        const config = encoder.encode("{}")
        yield* uploadBlob(parsed, payload, token)
        yield* uploadBlob(parsed, config, token)
        const manifest = encoder.encode(JSON.stringify({
          schemaVersion: 2,
          mediaType: OCI_MANIFEST,
          config: { mediaType: OCI_EMPTY_CONFIG, size: config.length, digest: sha256(config) },
          layers: [{ ...layer, size: payload.length, digest: sha256(payload) }]
        }))
        yield* putManifest(parsed, tag, manifest, token)
        return tag
      })

      const pushSignature = Effect.fn("OciRegistry.pushSignature")(function*(request: {
        readonly reference: string
        readonly manifestDigest: string
        readonly payload: Uint8Array
        readonly signatureBase64: string
      }) {
        return yield* pushSidecar(request.reference, sidecarTag(request.manifestDigest, "sig"), request.payload, {
          mediaType: COSIGN_LAYER,
          size: 0,
          digest: "",
          annotations: { [COSIGN_SIGNATURE]: request.signatureBase64 }
        })
      })

      const pushAttestation = Effect.fn("OciRegistry.pushAttestation")(function*(request: {
        readonly reference: string
        readonly manifestDigest: string
        readonly envelope: Uint8Array
      }) {
        return yield* pushSidecar(request.reference, sidecarTag(request.manifestDigest, "att"), request.envelope, {
          mediaType: DSSE_LAYER,
          size: 0,
          digest: ""
        })
      })

      return OciRegistry.of({ pull, pullPackage, pullAttestation, pushPackage, pushSignature, pushAttestation })
    })
  )
}

/** Helm wins ties, then Akua Packages, then annotated kpm KCL modules. */
const packageLayer = (manifest: Manifest) =>
  manifest.layers.find((layer) => layer.mediaType === HELM_LAYER) ??
    manifest.layers.find((layer) => layer.mediaType === AKUA_LAYER) ??
    (KCL_ANNOTATIONS.some((key) => manifest.annotations?.[key] !== undefined)
      ? manifest.layers.find((layer) => layer.mediaType === KCL_LAYER)
      : undefined)

/** `WWW-Authenticate: Bearer realm="...",service="...",scope="..."`. */
const bearerChallenge = (header: string | undefined) => {
  if (header === undefined || !header.startsWith("Bearer ")) return undefined
  // `key=value` or `key="quoted, value"`: a push scope (`repository:x:pull,push`) holds a comma.
  const fields = new Map<string, string>()
  for (const match of header.slice("Bearer ".length).matchAll(/\s*([^=,\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,]*))\s*(?:,|$)/g)) {
    const [, key = "", quoted, bare] = match
    fields.set(key, quoted === undefined ? (bare ?? "").trim() : quoted.replace(/\\(.)/g, "$1"))
  }
  const realm = fields.get("realm") ?? ""
  if (realm === "") return undefined
  const service = fields.get("service")
  const scope = fields.get("scope")
  return {
    realm,
    ...(service === undefined ? {} : { service }),
    ...(scope === undefined ? {} : { scope })
  }
}

const AkuaAuthFile = Schema.Struct({
  registries: Schema.optionalKey(Schema.Record(
    Schema.String,
    Schema.Struct({
      username: Schema.optionalKey(Schema.String),
      password: Schema.optionalKey(Schema.String),
      token: Schema.optionalKey(Schema.String)
    })
  ))
})

const DockerAuth = Schema.Struct({
  auth: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Schema.String)
})
const DockerConfig = Schema.Struct({ auths: Schema.optionalKey(Schema.Record(Schema.String, DockerAuth)) })

/**
 * `auth` is base64 `user:password`; `username`/`password` may also be set
 * verbatim. Credential helpers would mean running a binary, so they are not
 * consulted: export the credentials into `auth.toml` instead.
 */
const dockerCredentials = Effect.fnUntraced(function*(entry: typeof DockerAuth.Type) {
  if (entry.auth !== undefined) {
    const encoded = entry.auth.trim()
    const decoded = yield* Effect.option(Effect.try(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.fromBase64(encoded))
    ))
    if (Option.isSome(decoded)) {
      const colon = decoded.value.indexOf(":")
      if (colon >= 0) {
        const basic: Credentials = {
          _tag: "Basic",
          username: decoded.value.slice(0, colon),
          password: decoded.value.slice(colon + 1)
        }
        return basic
      }
    }
  }
  const credentials: Credentials | undefined = entry.username !== undefined && entry.password !== undefined
    ? { _tag: "Basic", username: entry.username, password: entry.password }
    : undefined
  return credentials
})
