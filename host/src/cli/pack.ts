import { Effect, FileSystem, Path } from "effect"
import { osMessage } from "../errors"
import { Command, Flag } from "effect/cli"
import { ExitCode, fail } from "../contract"
import { layerDigest, packWorkspace } from "../package-tar"
import type { VerbContext } from "./context"
import { joinPath } from "./files"
import { verb } from "./report"
import { emit, universal } from "./universal"
import { loadManifestForLock, vendorTrees } from "./workspace"

/** The tarball `publish` uploads, written to a file (air-gapped transfer, offline signing, archives). */
export const pack = (context: VerbContext) =>
  Command.make(
    "pack",
    {
      ...universal,
      workspace: Flag.String("workspace").pipe(Flag.withDefault("."), Flag.withDescription("Workspace root containing akua.toml")),
      out: Flag.String("out").pipe(
        Flag.optional,
        Flag.withDescription("Output tarball; defaults to ./dist/<name>-<version>.tar.gz under the workspace")
      ),
      noVendor: Flag.Boolean("no-vendor").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Don't embed OCI/git deps under .akua/vendor/ (the result needs the network to render)")
      )
    },
    verb(
      "akuapkg.pack",
      Effect.fnUntraced(function*(flags, mode) {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const manifest = yield* loadManifestForLock(flags.workspace)
        const vendored = flags.noVendor ? [] : yield* vendorTrees(flags.workspace, context.fetchers)
        const tarGz = yield* packWorkspace(flags.workspace, vendored).pipe(
          Effect.mapError((error) => fail("E_IO", osMessage(error), ExitCode.userError))
        )
        const out = flags.out._tag === "Some"
          ? flags.out.value
          : joinPath(joinPath(flags.workspace, "dist"), `${manifest.package.name}-${manifest.package.version}.tar.gz`)
        const written = (error: { readonly message: string }) => fail("E_IO", osMessage(error), ExitCode.systemError)
        if (path.dirname(out) !== "") yield* fs.makeDirectory(path.dirname(out), { recursive: true }).pipe(Effect.mapError(written))
        yield* fs.writeFile(out, tarGz).pipe(Effect.mapError(written))
        const output = {
          path: out,
          size_bytes: tarGz.length,
          layer_digest: layerDigest(tarGz),
          vendored_deps: vendored.map(({ name }) => name)
        }
        yield* emit(mode, output, () =>
          [
            `packed: ${output.path}`,
            `  layer  ${output.layer_digest}`,
            `  size   ${output.size_bytes} bytes`,
            ...(output.vendored_deps.length === 0 ? [] : [`  vendored: ${output.vendored_deps.join(", ")}`])
          ].join("\n"))
      })
    )
  ).pipe(Command.withDescription("Pack the workspace into a local .tar.gz"))
