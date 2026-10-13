import { Effect, FileSystem, Option, Path, Predicate } from "effect"
import YAML from "yaml"
import type { RenderSummary } from "./contract"
import { HostError, InputsMissing, InputsParseError, osMessage, PackageMissing } from "./errors"
import { loadSnapshot } from "./snapshot.effect"
import { RenderWorker } from "./worker.effect"

export interface RenderRequest {
  /** Path to the Package file (`package.k`). */
  readonly packagePath: string
  /** Explicit inputs file (JSON or YAML); otherwise `inputs.yaml`, then `inputs.example.yaml`. */
  readonly inputsPath: Option.Option<string>
  readonly out: string
  readonly dryRun: boolean
  /** Reject raw-string chart paths (`--strict`). */
  readonly strict: boolean
  /** Resolve dependencies without the network (`--offline`). */
  readonly offline: boolean
}

export interface Rendered {
  readonly summary: RenderSummary
  /** The resources as the Package produced them, before YAML normalization (`--debug`). */
  readonly resources: ReadonlyArray<unknown>
  /** `[filename, yaml]` in render order. */
  readonly documents: ReadonlyArray<readonly [string, string]>
}

const stringField = (value: unknown, key: string): string | undefined =>
  Predicate.hasProperty(value, key) && Predicate.isString(value[key]) ? value[key] : undefined

/** `<NNN>-<kind>-<name>.yaml`; unknown kinds become `resource`, unnamed `unnamed`. */
export const manifestFilename = (index: number, resource: unknown) => {
  const kind = (stringField(resource, "kind") ?? "resource").toLowerCase()
  const metadata = Predicate.hasProperty(resource, "metadata") ? resource.metadata : undefined
  const name = (stringField(metadata, "name") ?? "unnamed").replace(/[^A-Za-z0-9_.-]/g, "-")
  return `${String(index).padStart(3, "0")}-${kind}-${name}.yaml`
}

/** Words some YAML parser reads as a bool or null. */
const AMBIGUOUS_WORDS = new Set(["y", "yes", "n", "no", "on", "off", "true", "false", "null", "nil", "~", "nan"])

/**
 * Strings the previous release's serializer (serde_yml) single-quoted so that
 * no YAML parser reads them as a number, bool or null. Multi-line strings are
 * block literals instead.
 */
const ambiguous = (value: string) => {
  const lower = value.toLowerCase()
  return !value.includes("\n") && (lower === "" || /^[0-9.+-]/.test(lower) || AMBIGUOUS_WORDS.has(lower))
}

/** YAML as the previous release wrote it: keys in the Package's order, block sequences flush with their key. */
export const toYaml = (resource: unknown) => {
  const document = new YAML.Document(resource)
  YAML.visit(document, {
    Scalar(_key, node) {
      if (typeof node.value === "string" && ambiguous(node.value)) node.type = "QUOTE_SINGLE"
    }
  })
  return document.toString({ singleQuote: true, lineWidth: 0, indentSeq: false })
}

/** sha256 over each `filename \n yaml`, in order, as `sha256:<hex>`. */
export const summaryHash = (documents: ReadonlyArray<readonly [string, string]>) => {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const [filename, yaml] of documents) hasher.update(`${filename}\n${yaml}`)
  return `sha256:${hasher.digest("hex")}`
}

export const renderPackage = Effect.fn("renderPackage")(
  function*(request: RenderRequest) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const worker = yield* RenderWorker

    const packageDir = path.dirname(path.resolve(request.packagePath))
    const filename = path.basename(request.packagePath)
    if (!(yield* fs.exists(request.packagePath))) return yield* new PackageMissing({ path: request.packagePath })
    const files = yield* loadSnapshot(packageDir)
    const source = files.get(filename)
    if (source === undefined) return yield* new PackageMissing({ path: request.packagePath })

    const discovered = ["inputs.yaml", "inputs.example.yaml"].find((name) => files.has(name))
    const inputsPath = Option.isSome(request.inputsPath)
      ? request.inputsPath.value
      : discovered === undefined
      ? undefined
      : path.join(packageDir, discovered)
    const inputsText = inputsPath === undefined ? "" : yield* fs.readFileString(inputsPath).pipe(
      Effect.mapError((error) => new InputsMissing({ path: inputsPath, message: osMessage(error) }))
    )
    const inputs = yield* Effect.try({
      try: (): unknown => YAML.parse(inputsText) ?? {},
      catch: (cause) => new InputsParseError({ path: inputsPath ?? "", message: String(cause) })
    })

    const resources = yield* Effect.scoped(
      worker.prepare({ workspace: packageDir, filename, files, options: { offline: request.offline } }).pipe(
        Effect.flatMap((tree) => worker.render({ tree, inputs, strict: request.strict }))
      )
    )
    const documents = resources.map((resource, index): readonly [string, string] => [
      manifestFilename(index, resource),
      toYaml(resource)
    ])
    if (!request.dryRun) {
      yield* fs.makeDirectory(request.out, { recursive: true })
      for (const [name, yaml] of documents) yield* fs.writeFileString(path.join(request.out, name), yaml)
    }
    return {
      summary: {
        format: "raw-manifests",
        target: request.out,
        manifests: documents.length,
        hash: summaryHash(documents),
        files: documents.map(([name]) => name)
      },
      resources,
      documents
    } satisfies Rendered
  },
  Effect.mapError(HostError.from)
)
