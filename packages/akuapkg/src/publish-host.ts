import { Context, Effect, Redacted } from "effect"
import type { CliFailure } from "./contract"

/**
 * Optional embedding boundary. The standalone toolchain knows packing, signing and OCI;
 * the embedding CLI owns hosted authentication, Workspace selection and publication.
 */
export class PublishHost extends Context.Service<
  PublishHost,
  {
    prepare(args: { readonly name: string; readonly version: string; readonly archiveSize: number }): Effect.Effect<
      {
        readonly reference: string
        /** The OCI tag the version is pushed under; a SemVer `+` is not valid in a tag. */
        readonly tag: string
        readonly password: Redacted.Redacted<string>
        readonly complete: Effect.Effect<void, CliFailure>
      },
      CliFailure
    >
  }
>()("akuapkg/PublishHost") {}
