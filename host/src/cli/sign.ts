import { Effect, FileSystem, Option } from "effect"
import { osMessage } from "../errors"
import { Command, Flag } from "effect/cli"
import { ExitCode, fail } from "../contract"
import { signKeyed, simpleSigningPayload } from "../cosign"
import { publishDigests } from "../oci.effect"
import type { VerbContext } from "./context"
import { joinPath } from "./files"
import { verb } from "./report"
import { emit, universal } from "./universal"
import { cosignPassphrase, dockerReference, type Sidecar } from "./signing"
import { loadManifestForLock } from "./workspace"

/**
 * Sign a packed tarball for a later `push --sig`, without a registry: the
 * signature binds the manifest digest `push` will produce for these bytes
 * (so sign and push must run the same akuapkg version).
 */
export const sign = (context: VerbContext) =>
  Command.make(
    "sign",
    {
      ...universal,
      tarball: Flag.String("tarball").pipe(Flag.withDescription("Pre-packed tarball to sign")),
      ociRef: Flag.String("ref").pipe(Flag.withDescription("Repository it will be pushed to (`oci://<registry>/<repo>`)")),
      tag: Flag.String("tag").pipe(Flag.withDescription("Tag it will be pushed under")),
      key: Flag.String("key").pipe(
        Flag.optional,
        Flag.withDescription("PEM PKCS#8 P-256 private key; defaults to akua.toml [signing].cosign_private_key")
      ),
      workspace: Flag.String("workspace").pipe(Flag.withDefault("."), Flag.withDescription("Workspace root containing akua.toml")),
      out: Flag.String("out").pipe(Flag.optional, Flag.withDescription("Sidecar path; defaults to <tarball>.akuasig"))
    },
    verb(
      "akuapkg.sign",
      Effect.fnUntraced(function*(flags, mode) {
        const fs = yield* FileSystem.FileSystem
        const read = (what: string, path: string) =>
          fs.readFile(path).pipe(
            Effect.mapError((error) => fail("E_IO", `reading ${what} \`${path}\`: ${osMessage(error)}`, ExitCode.userError))
          )
        const tarball = yield* read("tarball", flags.tarball)
        if (tarball.length === 0) {
          return yield* fail("E_IO", `tarball \`${flags.tarball}\` is empty - nothing to sign`, ExitCode.userError)
        }
        const { manifestDigest } = publishDigests(tarball, context.version)
        const keyPath = Option.isSome(flags.key)
          ? flags.key.value
          : yield* loadManifestForLock(flags.workspace).pipe(
            Effect.flatMap((manifest) =>
              manifest.signing?.cosign_private_key === undefined
                ? Effect.fail(
                  fail(
                    "E_MANIFEST_PARSE",
                    "no signing key - pass `--key <path>` or set `[signing].cosign_private_key` in akua.toml",
                    ExitCode.userError
                  )
                )
                : Effect.succeed(joinPath(flags.workspace, manifest.signing.cosign_private_key))
            )
          )
        const key = new TextDecoder().decode(yield* read("signing key", keyPath))
        const payload = simpleSigningPayload(dockerReference(flags.ociRef), manifestDigest)
        const signature = yield* signKeyed(key, payload, yield* cosignPassphrase).pipe(
          Effect.mapError((error) => fail("E_COSIGN_VERIFY", error.message, ExitCode.userError))
        )
        const sidecar: Sidecar = {
          oci_ref: flags.ociRef,
          tag: flags.tag,
          manifest_digest: manifestDigest,
          simple_signing_payload: new TextDecoder().decode(payload),
          signature_b64: signature,
          akua_version: context.version
        }
        const sidecarPath = Option.getOrElse(flags.out, () => `${flags.tarball}.akuasig`)
        yield* fs.writeFileString(sidecarPath, JSON.stringify(sidecar, null, 2)).pipe(
          Effect.mapError((error) => fail("E_IO", `i/o at \`${sidecarPath}\`: ${osMessage(error)}`, ExitCode.userError))
        )
        const output = {
          tarball: flags.tarball,
          sidecar: sidecarPath,
          oci_ref: flags.ociRef,
          tag: flags.tag,
          manifest_digest: manifestDigest
        }
        yield* emit(mode, output, () =>
          [
            `signed: ${output.tarball}`,
            `  ref       ${output.oci_ref}:${output.tag}`,
            `  manifest  ${output.manifest_digest}`,
            `  sidecar   ${output.sidecar}`
          ].join("\n"))
      })
    )
  ).pipe(Command.withDescription("Produce a cosign signature sidecar for a packed tarball"))
