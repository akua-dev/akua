import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { gunzip, gzip, tar, type TarFile, untar } from "./archive"
import { CRDS_DIR } from "./crds.effect"
import { sha256 } from "./downloads.effect"
import { osMessage } from "./errors"
import { formatManifest, parseManifest } from "./manifest"
import { collectFiles, comparePaths } from "./walk.effect"

/**
 * The published form of a Package: a gzipped tarball of the workspace, the
 * bytes `pack` writes and `publish` uploads as the OCI layer.
 *
 * - Included: everything the workspace walk keeps (akua.toml, akua.lock,
 *   `*.k`, `vendor/`, README, inputs.example.yaml, ...), then each vendored
 *   dependency under `.akua/vendor/<name>/` and the generated CRD schemas
 *   under `.akua/crds/`.
 * - Excluded: hidden files and directories, render outputs (`deploy/`,
 *   `rendered/`, `out/`, `dist/`), `target/`, `node_modules/`, and the
 *   consumer's own `inputs.yaml`.
 * - akua.toml loses every `replace` directive: a publisher's local override
 *   never reaches consumers.
 *
 * Reproducible: entries sorted, no timestamps or owners, modes 0644/0755, a
 * fixed gzip header. Re-packing unchanged sources gives the same digest.
 */

export class PackageTarError extends Schema.TaggedError<PackageTarError>()("PackageTarError", {
  message: Schema.String
}) {}

/** `sha256:<hex>` of a packed tarball: the OCI layer digest a registry would assign it. */
export const layerDigest = (tarGz: Uint8Array) => sha256(tarGz)

const io = (path: string) => (error: { readonly message: string; readonly reason?: { readonly _tag: string } }) =>
  new PackageTarError({ message: `i/o at \`${path}\`: ${osMessage(error)}` })

/** `0o755` for a file any execute bit is set on, else `0o644`. */
const modeOf = (mode: number) => ((mode & 0o111) !== 0 ? 0o755 : 0o644)

const readFile = Effect.fnUntraced(function*(file: string, path: string): Effect.fn.Return<
  TarFile,
  PackageTarError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem
  const data = yield* fs.readFile(file).pipe(Effect.mapError(io(file)))
  const info = yield* fs.stat(file).pipe(Effect.mapError(io(file)))
  return { path, data, mode: modeOf(info.mode) }
})

/** akua.toml with every dependency's `replace` dropped. */
const publishedManifest = Effect.fnUntraced(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(file).pipe(Effect.mapError(io(file)))
  const manifest = yield* parseManifest(text, file).pipe(
    Effect.mapError((error) =>
      new PackageTarError({
        message: `akua.toml at \`${file}\` could not be parsed/re-serialized for publish: ${error.message}`
      })
    )
  )
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([name, { replace: _replace, ...dependency }]) => [name, dependency])
  )
  return new TextEncoder().encode(formatManifest({ ...manifest, dependencies }))
})

/** Pack the workspace at `root`, embedding each vendored dependency tree. */
export const packWorkspace = Effect.fn("packWorkspace")(function*(
  root: string,
  vendored: ReadonlyArray<{ readonly name: string; readonly directory: string }>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const isDirectory = yield* fs.stat(root).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false)
  )
  if (!isDirectory) return yield* new PackageTarError({ message: `workspace root \`${root}\` is not a directory` })
  const manifestFile = path.join(root, "akua.toml")
  if (!(yield* fs.exists(manifestFile).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new PackageTarError({ message: `akua.toml missing under \`${root}\`` })
  }
  const workspaceFiles = yield* collectFiles(root, (name) => !name.startsWith(".") && name !== "inputs.yaml").pipe(
    Effect.mapError(io(root))
  )
  const files: Array<TarFile> = []
  for (const file of workspaceFiles) {
    files.push(
      file === "akua.toml"
        ? { path: file, data: yield* publishedManifest(manifestFile), mode: 0o644 }
        : yield* readFile(path.join(root, file), file)
    )
  }
  const vendorFiles: Array<TarFile> = []
  for (const { directory, name } of vendored) {
    for (const file of yield* collectFiles(directory, () => true).pipe(Effect.mapError(io(directory)))) {
      vendorFiles.push(yield* readFile(path.join(directory, file), `.akua/vendor/${name}/${file}`))
    }
  }
  const crds = path.join(root, CRDS_DIR)
  for (const file of yield* collectFiles(crds, () => true).pipe(Effect.mapError(io(crds)))) {
    vendorFiles.push(yield* readFile(path.join(crds, file), `${CRDS_DIR}/${file}`))
  }
  return gzip(tar([...files, ...vendorFiles.toSorted((a, b) => comparePaths(a.path, b.path))]))
})

/** What a packed Package holds, read in memory. */
export interface TarballInspection {
  readonly layer_digest: string
  readonly compressed_size_bytes: number
  readonly uncompressed_size_bytes: number
  readonly file_count: number
  readonly package_name: string | null
  readonly package_version: string | null
  readonly package_edition: string | null
  /** Names under `.akua/vendor/`, sorted. */
  readonly vendored_deps: ReadonlyArray<string>
  /** The root `package.k`, when there is one. */
  readonly packageSource: Option.Option<string>
}

/** Inspect a packed tarball without unpacking it; a missing or unreadable akua.toml leaves the package fields null. */
export const inspectTarball = Effect.fn("inspectTarball")(function*(tarGz: Uint8Array) {
  const entries = yield* gunzip(tarGz).pipe(
    Effect.flatMap(untar),
    Effect.mapError((error) => new PackageTarError({ message: `i/o at \`<tarball>\`: ${error.message}` }))
  )
  const decoder = new TextDecoder()
  const manifestText = entries.find((entry) => entry.path === "akua.toml")
  const parsed = manifestText === undefined
    ? Option.none()
    : yield* parseManifest(decoder.decode(manifestText.data), "akua.toml").pipe(Effect.option)
  const vendored = new Set(
    entries.flatMap((entry) => {
      const name = entry.path.startsWith(".akua/vendor/") ? entry.path.split("/")[2] : undefined
      return name === undefined || name === "" ? [] : [name]
    })
  )
  const packageFile = entries.find((entry) => entry.path === "package.k")
  return {
    layer_digest: layerDigest(tarGz),
    compressed_size_bytes: tarGz.length,
    uncompressed_size_bytes: entries.reduce((total, entry) => total + entry.data.length, 0),
    file_count: entries.length,
    package_name: Option.match(parsed, { onNone: () => null, onSome: (m) => m.package.name }),
    package_version: Option.match(parsed, { onNone: () => null, onSome: (m) => m.package.version }),
    package_edition: Option.match(parsed, { onNone: () => null, onSome: (m) => m.package.edition }),
    vendored_deps: Array.from(vendored).toSorted(),
    packageSource: packageFile === undefined ? Option.none() : Option.some(decoder.decode(packageFile.data))
  } satisfies TarballInspection
})

/** Unpack a packed Package into `target`, overwriting what is there; paths outside it are refused. */
export const unpackTarball = Effect.fn("unpackTarball")(function*(tarGz: Uint8Array, target: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* gunzip(tarGz).pipe(
    Effect.flatMap(untar),
    Effect.mapError((error) => new PackageTarError({ message: `i/o at \`${target}\`: ${error.message}` }))
  )
  yield* fs.makeDirectory(target, { recursive: true }).pipe(Effect.mapError(io(target)))
  for (const entry of entries) {
    const file = path.join(target, entry.path)
    yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.mapError(io(file)))
    yield* fs.writeFile(file, entry.data).pipe(Effect.mapError(io(file)))
  }
})
