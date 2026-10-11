import { Effect, FileSystem, Option } from "effect"
import { osMessage } from "../errors"
import { Command, Flag } from "effect/cli"
import { ExitCode, fail } from "../contract"
import { signDsse, signKeyed, simpleSigningPayload } from "../cosign"
import { OciRegistry } from "../oci.effect"
import { packWorkspace } from "../package-tar"
import type { VerbContext } from "./context"
import { joinPath, readOptional } from "./files"
import { verb } from "./report"
import { emit, universal } from "./universal"
import { cosignPassphrase, dockerReference, provenanceStatement } from "./signing"
import { loadManifest, lockPath, manifestFailure, vendorTrees } from "./workspace"
import { parseLock } from "../lockfile"

/**
 * Pack the workspace, push it, and, when akua.toml names a cosign private
 * key, sign it (`.sig`) and attest its SLSA provenance (`.att`).
 */
export const publish = (context: VerbContext) =>
  Command.make(
    "publish",
    {
      ...universal,
      ociRef: Flag.String("ref").pipe(Flag.withDescription("Target repository (`oci://<registry>/<repo>`)")),
      tag: Flag.String("tag").pipe(Flag.optional, Flag.withDescription("Tag; defaults to [package].version")),
      noSign: Flag.Boolean("no-sign").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Skip cosign signing even when a private key is configured")
      ),
      noAttest: Flag.Boolean("no-attest").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Skip the SLSA attestation (it always pairs with signing)")
      ),
      workspace: Flag.String("workspace").pipe(Flag.withDefault("."), Flag.withDescription("Workspace root containing akua.toml"))
    },
    verb(
      "akuapkg.publish",
      Effect.fnUntraced(function*(flags, mode) {
        const fs = yield* FileSystem.FileSystem
        const manifest = yield* loadManifest(flags.workspace).pipe(
          Effect.catchTags({
            ManifestMissing: (missing) => Effect.fail(manifestFailure(missing)),
            ManifestInvalid: (invalid) => Effect.fail(manifestFailure(invalid))
          })
        )
        const tag = Option.getOrElse(flags.tag, () => manifest.package.version)
        const vendored = yield* vendorTrees(flags.workspace, context.fetchers)
        const tarball = yield* packWorkspace(flags.workspace, vendored).pipe(
          Effect.mapError((error) => fail("E_IO", osMessage(error), ExitCode.userError))
        )
        const publishFailed = (message: string) => fail("E_PUBLISH_FAILED", message, ExitCode.userError)
        const keyPath = flags.noSign ? undefined : manifest.signing?.cosign_private_key
        const key = keyPath === undefined
          ? Option.none<string>()
          : Option.some(
            yield* fs.readFileString(joinPath(flags.workspace, keyPath)).pipe(
              Effect.mapError((error) =>
                fail(
                  "E_PUBLISH_FAILED",
                  error.message,
                  ExitCode.userError,
                  joinPath(flags.workspace, keyPath),
                  "akua.toml [signing].cosign_private_key must resolve to a PEM-encoded PKCS#8 P-256 private key file."
                )
              )
            )
          )
        const passphrase = Option.isSome(key) ? yield* cosignPassphrase : Option.none<string>()
        const output = yield* Effect.gen(function*() {
          const registry = yield* OciRegistry
          const pushed = yield* registry.pushPackage({
            reference: flags.ociRef,
            tag,
            tarball,
            akuaVersion: context.version
          }).pipe(Effect.mapError((error) => publishFailed(error.message)))
          let signatureTag = Option.none<string>()
          let attestationTag = Option.none<string>()
          if (Option.isSome(key)) {
            const payload = simpleSigningPayload(dockerReference(flags.ociRef), pushed.manifestDigest)
            const signature = yield* signKeyed(key.value, payload, passphrase).pipe(
              Effect.mapError((error) => publishFailed(`cosign: ${error.message}`))
            )
            signatureTag = Option.some(
              yield* registry.pushSignature({
                reference: flags.ociRef,
                manifestDigest: pushed.manifestDigest,
                payload,
                signatureBase64: signature
              }).pipe(Effect.mapError((error) => publishFailed(error.message)))
            )
            if (!flags.noAttest) {
              const lockText = yield* readOptional(lockPath(flags.workspace))
              const lock = Option.isSome(lockText)
                ? Option.some(
                  yield* parseLock(lockText.value, lockPath(flags.workspace)).pipe(
                    Effect.mapError((error) =>
                      fail("E_LOCK_PARSE", `failed to parse ${lockPath(flags.workspace)}: ${error.message}`, ExitCode.userError)
                    )
                  )
                )
                : Option.none()
              const statement = provenanceStatement({
                reference: flags.ociRef,
                tag,
                manifestDigest: pushed.manifestDigest,
                lock,
                version: context.version
              })
              const envelope = yield* signDsse(key.value, "application/vnd.in-toto+json", statement, passphrase).pipe(
                Effect.mapError((error) => publishFailed(`cosign: ${error.message}`))
              )
              attestationTag = Option.some(
                yield* registry.pushAttestation({
                  reference: flags.ociRef,
                  manifestDigest: pushed.manifestDigest,
                  envelope
                }).pipe(Effect.mapError((error) => publishFailed(error.message)))
              )
            }
          }
          return {
            oci_ref: flags.ociRef,
            tag,
            manifest_digest: pushed.manifestDigest,
            layer_digest: pushed.layerDigest,
            layer_size: pushed.layerSize,
            ...Option.match(signatureTag, { onNone: () => ({}), onSome: (value) => ({ signature_tag: value }) }),
            ...Option.match(attestationTag, { onNone: () => ({}), onSome: (value) => ({ attestation_tag: value }) })
          }
        }).pipe(Effect.provide(context.fetchers))
        yield* emit(mode, output, () =>
          [
            `published: ${output.oci_ref}:${output.tag}`,
            `  manifest  ${output.manifest_digest}`,
            `  layer     ${output.layer_digest} (${output.layer_size} bytes)`,
            ...("signature_tag" in output ? [`  signed    ${output.signature_tag}`] : []),
            ...("attestation_tag" in output ? [`  attested  ${output.attestation_tag}`] : [])
          ].join("\n"))
      })
    )
  ).pipe(Command.withDescription("Pack, push, sign and attest the workspace's Package"))
