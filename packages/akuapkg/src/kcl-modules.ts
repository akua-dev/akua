import { Console, Effect, Option } from "effect"
import { crdSchemaTree } from "./crd-schemas"
import { CRDS_KCL_MOD } from "./crds.effect"
import type { ResolvedDependency } from "./dependencies.effect"
import { DependencyUnresolved, RenderError } from "./errors"
import { kclIdent } from "./manifest"
import { stubModule } from "./package-stubs"
import type { Snapshot } from "./snapshot.effect"
import { kclStringLiteral, valuesSchemaKcl } from "./values-schema"

/**
 * The KCL packages a render generates from its dependencies: `charts` (one
 * module per Helm dependency, `import charts.<name>`) and `pkgs` (one stub
 * per Akua-Package dependency, `import pkgs.<name>`) and `crds` (the
 * generated CRD schemas, `import crds.<name>.<group>.<version>`). KCL-module
 * dependencies are mounted as they are (`import <name>`). `charts` and
 * `pkgs` are generated per render, never written into the Package; `crds`
 * comes from `.akua/crds/` when that is current.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * The `path` a generated chart module hands `helm.template`. A stable name,
 * not a host path, so renders are identical on every machine; the plugin maps
 * it back to the dependency.
 */
export const chartReference = (dependency: string) => `/akua/deps/${dependency}`

const kclMod = (name: string) => `[package]\nname = "${name}"\nedition = "0.0.1"\nversion = "0.0.1"\n`

/**
 * Two dependency keys that sanitize to one identifier would make one module
 * overwrite the other.
 */
const identifiers = Effect.fnUntraced(function*(names: ReadonlyArray<string>, what: string) {
  const seen = new Map<string, string>()
  for (const name of names) {
    const ident = kclIdent(name)
    const prior = seen.get(ident)
    if (prior !== undefined && prior !== name) {
      return yield* new RenderError({
        message: `materializing ${what}: dep keys \`${prior}\` and \`${name}\` both sanitize to the KCL ` +
          `identifier \`${ident}\` - rename one so \`import\` aliases are unambiguous`
      })
    }
    seen.set(ident, name)
  }
})

/**
 * `charts/<ident>.k` for every Helm dependency: `path`, `sha256`, a
 * `TemplateOpts` schema and a `template` lambda with `chart = path` filled in.
 */
export const chartsPackage = Effect.fn("chartsPackage")(function*(dependencies: ReadonlyArray<ResolvedDependency>) {
  const charts = dependencies.filter((dependency) => dependency.kind === "helm")
  if (charts.length === 0) return undefined
  yield* identifiers(charts.map((chart) => chart.name), "charts pkg")
  const files = new Map<string, Uint8Array>([["kcl.mod", encoder.encode(kclMod("charts"))]])
  for (const chart of charts) {
    const values = yield* typedValues(chart)
    files.set(`${kclIdent(chart.name)}.k`, encoder.encode(chartModule(chart.name, chart.digest, values)))
  }
  return files satisfies Snapshot
})

/** `pkgs/<ident>.k` for every Akua-Package dependency: its schemas and a `render` lambda. */
export const packageStubs = Effect.fn("packageStubs")(function*(dependencies: ReadonlyArray<ResolvedDependency>) {
  const packages = dependencies.filter((dependency) => dependency.kind === "package")
  if (packages.length === 0) return undefined
  yield* identifiers(packages.map((dependency) => dependency.name), "akua-pkg stubs")
  const files = new Map<string, Uint8Array>([["kcl.mod", encoder.encode(kclMod("pkgs"))]])
  for (const dependency of packages) {
    const source = decoder.decode(dependency.files.get("package.k") ?? new Uint8Array())
    // The stub keeps the raw dependency name: `pkg.render` looks the package up by it.
    files.set(`${kclIdent(dependency.name)}.k`, encoder.encode(stubModule(dependency.name, source)))
  }
  return files satisfies Snapshot
})

/**
 * The schema tree of one CRD dependency, keyed relative to `crds/<ident>/`:
 * as `.akua/crds/` holds it, or generated from the source.
 */
export const crdTree = Effect.fn("crdTree")(function*(dependency: ResolvedDependency) {
  if (Option.isNone(dependency.crds)) return { files: new Map<string, Uint8Array>(), modules: [] }
  const { generated, selector } = dependency.crds.value
  if (Option.isSome(generated)) return { files: generated.value, modules: [] }
  return yield* crdSchemaTree(dependency.name, dependency.files, selector).pipe(
    Effect.mapError((error) =>
      new DependencyUnresolved({
        dependency: dependency.name,
        code: "E_CRDS_INVALID",
        message: `dependency \`${dependency.name}\`: ${error.message}`
      })
    )
  )
})

/** The `crds` package: one directory per CRD dependency. */
export const crdsPackage = Effect.fn("crdsPackage")(function*(dependencies: ReadonlyArray<ResolvedDependency>) {
  const crds = dependencies.filter((dependency) => dependency.kind === "crds")
  if (crds.length === 0) return undefined
  yield* identifiers(crds.map((dependency) => dependency.name), "crds pkg")
  const shadowed = dependencies.find((dependency) => dependency.kind === "kcl" && kclIdent(dependency.name) === "crds")
  if (shadowed !== undefined) {
    return yield* new RenderError({
      message: `dependency \`${shadowed.name}\` imports as \`crds\`, which the CRD dependencies use - rename it`
    })
  }
  const files = new Map<string, Uint8Array>([["kcl.mod", encoder.encode(CRDS_KCL_MOD)]])
  for (const dependency of crds) {
    for (const [name, data] of (yield* crdTree(dependency)).files) files.set(`${kclIdent(dependency.name)}/${name}`, data)
  }
  return files satisfies Snapshot
})

/** KCL-module dependencies by the identifier they import as. */
export const kclModules = Effect.fn("kclModules")(function*(dependencies: ReadonlyArray<ResolvedDependency>) {
  const modules = dependencies.filter((dependency) => dependency.kind === "kcl")
  yield* identifiers(modules.map((dependency) => dependency.name), "kcl-package deps")
  return modules.map((dependency) => ({ ident: kclIdent(dependency.name), files: dependency.files }))
})

/**
 * The chart's `values.schema.json` as KCL, if it has a usable one. A
 * malformed schema is reported and skipped: the render proceeds untyped.
 */
const typedValues = Effect.fnUntraced(function*(chart: ResolvedDependency) {
  const schema = chart.files.get("values.schema.json")
  if (schema === undefined) return undefined
  return yield* valuesSchemaKcl(decoder.decode(schema)).pipe(
    Effect.catchTag("ValuesSchemaInvalid", (error) =>
      Console.error(`akua: skipping malformed values.schema.json at ${chart.root}/values.schema.json: ${error.message}`)
        .pipe(Effect.as(undefined)))
  )
})

/** The previous release's generated chart module, byte for byte except `path`. */
const chartModule = (name: string, digest: string, values: string | undefined) => {
  const typed = values !== undefined && values !== ""
  return `# Auto-generated per-render from akua.toml dep \`${name}\`.\n` +
    "# slice C: exposes `path`, `sha256`, `Values`, and a\n" +
    "# pre-filled `template` callable. Regenerated every render.\n" +
    "\n" +
    "import akua.helm as _helm\n" +
    "\n" +
    `path: str = ${kclStringLiteral(chartReference(name))}\n` +
    `sha256: str = "${digest}"\n` +
    "\n" +
    (typed ? `# Typed Values schema, generated from values.schema.json.\n${values}\n` : "") +
    "schema TemplateOpts:\n" +
    (typed ? "    values: Values\n" : "    values: {str:} = {}\n") +
    "    release: str = \"release\"\n" +
    "    namespace: str = \"default\"\n" +
    "\n" +
    (typed ? "template = lambda opts: TemplateOpts -> [{str:}] {\n" : "template = lambda opts: TemplateOpts = TemplateOpts {} -> [{str:}] {\n") +
    (typed ? "    _flat = {**opts.values}\n" : "") +
    "    _helm.template(_helm.Template {\n" +
    "        chart = path\n" +
    (typed ? "        values = _flat\n" : "        values = opts.values\n") +
    "        release = opts.release\n" +
    "        namespace = opts.namespace\n" +
    "    })\n" +
    "}\n"
}
