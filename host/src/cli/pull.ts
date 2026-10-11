import { Effect } from "effect"
import { osMessage } from "../errors"
import { Command, Flag } from "effect/cli"
import { ExitCode, fail } from "../contract"
import { OciRegistry } from "../oci.effect"
import { unpackTarball } from "../package-tar"
import type { VerbContext } from "./context"
import { verb } from "./report"
import { emit, universal } from "./universal"

/** Fetch a published Package and unpack it: the inverse of `publish`. */
export const pull = (context: VerbContext) =>
  Command.make(
    "pull",
    {
      ...universal,
      ociRef: Flag.String("ref").pipe(Flag.withDescription("`oci://<registry>/<repo>` of the published Package")),
      tag: Flag.String("tag").pipe(Flag.withDescription("Tag to pull")),
      out: Flag.String("out").pipe(Flag.withDefault("./pulled"), Flag.withDescription("Directory to unpack into"))
    },
    verb(
      "akuapkg.pull",
      Effect.fnUntraced(function*(flags, mode) {
        const pulled = yield* OciRegistry.pipe(
          Effect.flatMap((registry) => registry.pullPackage({ reference: flags.ociRef, tag: flags.tag })),
          Effect.mapError((error) => fail("E_PULL_FAILED", error.message, ExitCode.userError)),
          Effect.provide(context.fetchers)
        )
        yield* unpackTarball(pulled.tarball, flags.out).pipe(
          Effect.mapError((error) => fail("E_IO", osMessage(error), ExitCode.userError))
        )
        const output = {
          oci_ref: flags.ociRef,
          tag: flags.tag,
          manifest_digest: pulled.manifestDigest,
          layer_digest: pulled.layerDigest,
          out: flags.out
        }
        yield* emit(mode, output, () =>
          [
            `pulled: ${output.oci_ref}:${output.tag} → ${output.out}`,
            `  manifest  ${output.manifest_digest}`,
            `  layer     ${output.layer_digest}`
          ].join("\n"))
      })
    )
  ).pipe(Command.withDescription("Pull a published Package from an OCI registry"))
