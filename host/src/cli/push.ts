import { Effect, FileSystem, Option } from "effect"
import { osMessage } from "../errors"
import { Command, Flag } from "effect/cli"
import { ExitCode, fail } from "../contract"
import { OciRegistry, publishDigests } from "../oci.effect"
import type { VerbContext } from "./context"
import { verb } from "./report"
import { emit, universal } from "./universal"
import { readSidecar } from "./signing"

/** Upload a pre-packed tarball (`pack`), with its `sign` sidecar when given: the air-gap half of `publish`. */
export const push = (context: VerbContext) =>
  Command.make(
    "push",
    {
      ...universal,
      tarball: Flag.String("tarball").pipe(Flag.withDescription("Pre-packed tarball to upload")),
      ociRef: Flag.String("ref").pipe(Flag.withDescription("Target repository (`oci://<registry>/<repo>`)")),
      tag: Flag.String("tag").pipe(Flag.withDescription("Tag to push under")),
      sig: Flag.String("sig").pipe(
        Flag.optional,
        Flag.withDescription("`.akuasig` sidecar from `sign`; uploaded as the cosign signature when it matches")
      )
    },
    verb(
      "akuapkg.push",
      Effect.fnUntraced(function*(flags, mode) {
        const fs = yield* FileSystem.FileSystem
        const tarball = yield* fs.readFile(flags.tarball).pipe(
          Effect.mapError((error) => fail("E_IO", osMessage(error), ExitCode.userError))
        )
        if (tarball.length === 0) return yield* fail("E_IO", `tarball \`${flags.tarball}\` is empty`, ExitCode.userError)
        const sidecar = Option.isSome(flags.sig) ? Option.some(yield* readSidecar(flags.sig.value)) : Option.none()
        if (Option.isSome(sidecar)) {
          const s = sidecar.value
          if (s.oci_ref !== flags.ociRef || s.tag !== flags.tag) {
            return yield* fail(
              "E_COSIGN_VERIFY",
              `sidecar ref/tag (\`${s.oci_ref}:${s.tag}\`) doesn't match push target (\`${flags.ociRef}:${flags.tag}\`)`,
              ExitCode.userError
            )
          }
          const expected = publishDigests(tarball, context.version).manifestDigest
          if (s.manifest_digest !== expected) {
            return yield* fail(
              "E_COSIGN_VERIFY",
              `sidecar manifest digest \`${s.manifest_digest}\` doesn't match pushed manifest \`${expected}\` - ` +
                "signature was produced for a different artifact; skipping .sig upload",
              ExitCode.userError
            )
          }
        }
        const published = (error: { readonly message: string }) =>
          fail("E_PUBLISH_FAILED", error.message, ExitCode.systemError)
        const { pushed, signatureTag } = yield* Effect.gen(function*() {
          const registry = yield* OciRegistry
          const pushed = yield* registry.pushPackage({
            reference: flags.ociRef,
            tag: flags.tag,
            tarball,
            akuaVersion: context.version
          })
          const signatureTag = Option.isSome(sidecar)
            ? Option.some(
              yield* registry.pushSignature({
                reference: flags.ociRef,
                manifestDigest: pushed.manifestDigest,
                payload: new TextEncoder().encode(sidecar.value.simple_signing_payload),
                signatureBase64: sidecar.value.signature_b64
              })
            )
            : Option.none<string>()
          return { pushed, signatureTag }
        }).pipe(Effect.mapError(published), Effect.provide(context.fetchers))
        const output = {
          oci_ref: flags.ociRef,
          tag: flags.tag,
          manifest_digest: pushed.manifestDigest,
          layer_digest: pushed.layerDigest,
          layer_size: pushed.layerSize,
          tarball: flags.tarball,
          ...Option.match(signatureTag, { onNone: () => ({}), onSome: (tag) => ({ signature_tag: tag }) })
        }
        yield* emit(mode, output, () =>
          [
            `pushed: ${output.oci_ref}:${output.tag}`,
            `  tarball   ${output.tarball}`,
            `  manifest  ${output.manifest_digest}`,
            `  layer     ${output.layer_digest} (${output.layer_size} bytes)`,
            ...Option.match(signatureTag, { onNone: () => [], onSome: (tag) => [`  signed    ${tag}`] })
          ].join("\n"))
      })
    )
  ).pipe(Command.withDescription("Upload a pre-packed tarball to an OCI registry"))
