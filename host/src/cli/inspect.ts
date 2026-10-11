import { Effect, FileSystem, Option, Path, Predicate } from "effect"
import { osMessage } from "../errors"
import { Command, Flag } from "effect/cli"
import { ExitCode, fail, usageFailure } from "../contract"
import { OciRegistry } from "../oci.effect"
import { inspectTarball, type TarballInspection } from "../package-tar"
import type { OptionInfo } from "../schemas"
import { RenderWorker } from "../worker.effect"
import type { VerbContext } from "./context"
import { missingPackage, NOT_FOUND, readOptional } from "./files"
import { reportable, verb } from "./report"
import { emit, universal } from "./universal"

const text = (path: string, options: ReadonlyArray<OptionInfo>) =>
  [
    path,
    ...(options.length === 0 ? ["  (no options)"] : [
      "  options:",
      ...options.flatMap((option) => [
        `    - ${option.name}${option.type === undefined ? "" : `: ${option.type}`}` +
        `${option.default === undefined ? "" : ` = ${option.default}`}${option.required ? " [required]" : ""}`,
        ...(option.help === undefined ? [] : [`        ${option.help}`])
      ])
    ])
  ].join("\n")

/** The tarball fields of an inspection, as `inspect --tarball` prints them. */
export const tarballFields = ({ packageSource: _source, ...fields }: TarballInspection) => fields

/** The lines shared by tarball and OCI inspections, after their first line. */
export const tarballLines = (inspection: TarballInspection, manifestDigest?: string) => [
  inspection.package_name !== null && inspection.package_version !== null
    ? `  package   ${inspection.package_name} ${inspection.package_version}`
    : "  package   (no akua.toml in tarball)",
  ...(inspection.package_edition === null ? [] : [`  edition   ${inspection.package_edition}`]),
  ...(manifestDigest === undefined ? [] : [`  manifest  ${manifestDigest}`]),
  `  layer     ${inspection.layer_digest}`,
  `  size      ${inspection.compressed_size_bytes} compressed / ${inspection.uncompressed_size_bytes} uncompressed`,
  `  files     ${inspection.file_count}`,
  ...(inspection.vendored_deps.length === 0 ? [] : [`  vendored: ${inspection.vendored_deps.join(", ")}`])
]

/** A Package's input surface, or a packed tarball's metadata; nothing runs. */
export const inspect = (context: VerbContext) =>
  Command.make(
    "inspect",
    {
      ...universal,
      packagePath: Flag.String("package").pipe(Flag.withDefault("./package.k"), Flag.withDescription("Path to the Package.k")),
      tarball: Flag.String("tarball").pipe(Flag.optional, Flag.withDescription("A packed `.tar.gz` (from `pack` / `pull`)")),
      oci: Flag.String("oci").pipe(
        Flag.optional,
        Flag.withDescription("A published Package (`oci://<registry>/<repo>`, with --tag): its metadata and input schema")
      ),
      tag: Flag.String("tag").pipe(Flag.optional, Flag.withDescription("Tag of the --oci Package"))
    },
    verb(
      "akuapkg.inspect",
      Effect.fnUntraced(function*(flags, mode) {
        if (Option.isSome(flags.oci)) {
          if (Option.isNone(flags.tag)) return yield* usageFailure("--oci needs --tag")
          const reference = flags.oci.value
          const tag = flags.tag.value
          const pulled = yield* OciRegistry.pipe(
            Effect.flatMap((registry) => registry.pullPackage({ reference, tag })),
            Effect.mapError((error) => fail("E_PULL_FAILED", error.message, ExitCode.userError)),
            Effect.provide(context.fetchers)
          )
          const inspection = yield* inspectTarball(pulled.tarball).pipe(
            Effect.mapError((error) => fail("E_IO", osMessage(error), ExitCode.userError))
          )
          if (Option.isNone(inspection.packageSource)) {
            return yield* fail("E_INSPECT_FAIL", "package.k missing from tarball", ExitCode.userError)
          }
          const source = inspection.packageSource.value
          const schema = yield* RenderWorker.pipe(
            Effect.flatMap((worker) => worker.exportSchema({ filename: "package.k", source, format: "json-schema" })),
            Effect.catchTag("RenderError", (error) => Effect.fail(fail("E_INSPECT_FAIL", error.message, ExitCode.userError))),
            Effect.provide(context.services),
            Effect.mapError((error) => error._tag === "CliFailure" ? error : reportable(error))
          )
          if (!Predicate.isObject(schema) || Array.isArray(schema)) {
            return yield* fail("E_INSPECT_FAIL", "exported package input schema is not a JSON object", ExitCode.userError)
          }
          const { file_count, layer_digest, ...rest } = tarballFields(inspection)
          return yield* emit(
            mode,
            {
              kind: "oci_package",
              oci_ref: reference,
              tag,
              manifest_digest: pulled.manifestDigest,
              layer_digest,
              compressed_size_bytes: rest.compressed_size_bytes,
              uncompressed_size_bytes: rest.uncompressed_size_bytes,
              file_count,
              package_name: rest.package_name,
              package_version: rest.package_version,
              package_edition: rest.package_edition,
              vendored_deps: rest.vendored_deps,
              input_schema: schema
            },
            () => [`${reference}:${tag}`, ...tarballLines(inspection, pulled.manifestDigest)].join("\n")
          )
        }
        if (Option.isSome(flags.tarball)) {
          const fs = yield* FileSystem.FileSystem
          const file = flags.tarball.value
          const bytes = yield* fs.readFile(file).pipe(
            Effect.mapError((error) =>
              error.reason._tag === "NotFound"
                ? fail("E_PACKAGE_MISSING", NOT_FOUND, ExitCode.userError, file)
                : fail("E_IO", osMessage(error), ExitCode.systemError, file)
            )
          )
          const inspection = yield* inspectTarball(bytes).pipe(
            Effect.mapError((error) => fail("E_IO", osMessage(error), ExitCode.userError))
          )
          return yield* emit(
            mode,
            { kind: "tarball", path: file, ...tarballFields(inspection) },
            () => [file, ...tarballLines(inspection)].join("\n")
          )
        }
        const path = yield* Path.Path
        const source = yield* readOptional(flags.packagePath)
        if (Option.isNone(source)) return yield* missingPackage(flags.packagePath)
        const options = yield* RenderWorker.pipe(
          Effect.flatMap((worker) => worker.options({ filename: path.resolve(flags.packagePath), source: source.value })),
          Effect.catchTag("RenderError", (error) => Effect.fail(fail("E_INSPECT_FAIL", error.message, ExitCode.userError))),
          Effect.provide(context.services),
          Effect.mapError((error) => error._tag === "CliFailure" ? error : reportable(error))
        )
        yield* emit(mode, { kind: "package", path: flags.packagePath, options }, () => text(flags.packagePath, options))
      })
    )
  ).pipe(Command.withDescription("Report a Package's input surface or tarball metadata"))
