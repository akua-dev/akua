import { Config, Effect, FileSystem, Option, Schema } from "effect"
import { osMessage } from "../errors"
import { ExitCode, fail } from "../contract"
import type { Lock } from "../lockfile"

/**
 * Shared by `sign`, `push --sig` and `publish`: the cosign passphrase, the
 * offline signature sidecar, and the SLSA provenance statement.
 */

/** `$AKUA_COSIGN_PASSPHRASE`: never a flag, so it never reaches `ps` or shell history. */
export const cosignPassphrase = Config.option(Config.String("AKUA_COSIGN_PASSPHRASE")).pipe(
  Effect.map(Option.filter((value) => value !== "")),
  Effect.orElseSucceed(() => Option.none<string>())
)

/** `<tarball>.akuasig`: an offline signature waiting for `push --sig`. */
export const Sidecar = Schema.Struct({
  oci_ref: Schema.String,
  tag: Schema.String,
  /** The manifest digest the signature is bound to; `push` recomputes and compares it. */
  manifest_digest: Schema.String,
  /** The simple-signing payload, verbatim as signed. */
  simple_signing_payload: Schema.String,
  signature_b64: Schema.String,
  akua_version: Schema.String
})
export type Sidecar = typeof Sidecar.Type

export const readSidecar = Effect.fnUntraced(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path).pipe(
    Effect.mapError((error) => fail("E_IO", `i/o at \`${path}\`: ${osMessage(error)}`, ExitCode.userError))
  )
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Sidecar))(text).pipe(
    Effect.mapError((error) => fail("E_IO", `malformed sidecar at \`${path}\`: ${error.message}`, ExitCode.userError))
  )
})

/** The docker reference cosign signs: the OCI reference without its scheme. */
export const dockerReference = (reference: string) => reference.replace(/^oci:\/\//, "")

const splitDigest = (digest: string): readonly [string, string] => {
  const colon = digest.indexOf(":")
  return colon === -1 ? ["sha256", digest] : [digest.slice(0, colon), digest.slice(colon + 1)]
}

/**
 * The in-toto v1 statement with a SLSA v1 provenance predicate that
 * `publish` signs into the `.att` sidecar: the artifact, the invocation and
 * the lockfile's resolved dependencies.
 */
export const provenanceStatement = (request: {
  readonly reference: string
  readonly tag: string
  readonly manifestDigest: string
  readonly lock: Option.Option<Lock>
  readonly version: string
}) => {
  const [algorithm, hex] = splitDigest(request.manifestDigest)
  const dependencies = Option.match(request.lock, { onNone: () => [], onSome: (lock) => lock.package ?? [] }).map(
    (entry) => {
      const [kind, value] = splitDigest(entry.digest)
      return { name: entry.name, digest: { [kind]: value }, uri: entry.source }
    }
  )
  return new TextEncoder().encode(JSON.stringify({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: dockerReference(request.reference), digest: { [algorithm]: hex } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://akua.dev/slsa/publish/v1",
        externalParameters: { ociRef: request.reference, tag: request.tag },
        ...(dependencies.length === 0 ? {} : { resolvedDependencies: dependencies })
      },
      runDetails: { builder: { id: `https://cli.akua.dev/cli/v${request.version}` } }
    }
  }))
}
