import { Context, Effect, Layer, Schema } from "effect"
import YAML from "yaml"
import { gzip, tar } from "./archive"
import { HelmEngine, KustomizeEngine } from "./engines.effect"
import { PluginError } from "./errors"
import { HelmTemplateArgs, KustomizeBuildArgs, PkgRenderArgs } from "./schemas"
import type { ResolvedDependency } from "./dependencies.effect"
import { resolveInSnapshot, type Snapshot, subtree } from "./snapshot.effect"
import { comparePaths } from "./walk.effect"
import { parseEngineManifests, sortKeys } from "./yaml-compat"

/**
 * Deterministic tar.gz of a snapshot under `prefix/`: sorted entries,
 * fixed mtime/owner, so identical inputs give identical engine requests.
 */
const tarGz = (files: Snapshot, prefix: string): Uint8Array =>
  gzip(tar(
    Array.from(files)
      .toSorted(([a], [b]) => comparePaths(a, b))
      .map(([name, data]) => ({ path: `${prefix}/${name}`, data, mode: 0o644 }))
  ))

const lastSegment = (path: string, fallback: string) => path.split("/").filter(Boolean).at(-1) ?? fallback

/** What a plugin call can reach: the calling Package and its typed dependencies. */
export interface PluginScope {
  readonly files: Snapshot
  /** Helm dependencies by the `path` their generated `charts.<name>` module passes. */
  readonly charts: ReadonlyMap<string, ResolvedDependency>
  /** Reject raw-string chart paths; charts must be typed `akua.toml` deps. */
  readonly strict: boolean
  /** `pkg.render`: render the Akua-Package dependency `name` with `inputs`. */
  readonly renderPackage: (name: string, inputs: unknown) => Effect.Effect<ReadonlyArray<unknown>, PluginError>
}

/**
 * The host side of KCL's plugin bridge. Same registry shape as
 * `akua_core::kcl_plugin`: KCL sends `kcl_plugin.<name>`, args are a JSON
 * array whose first element is the stdlib options schema instance.
 */
export class KclPlugins extends Context.Service<KclPlugins, {
  invoke(request: {
    readonly method: string
    readonly argsJson: string
    readonly scope: PluginScope
  }): Effect.Effect<string, PluginError>
}>()("akuapkg/host/KclPlugins") {
  static readonly layer = Layer.effect(
    KclPlugins,
    Effect.gen(function*() {
      const helm = yield* HelmEngine
      const kustomize = yield* KustomizeEngine
      const decodeHelmArgs = Schema.decodeUnknownEffect(Schema.fromJsonString(HelmTemplateArgs))
      const decodeKustomizeArgs = Schema.decodeUnknownEffect(Schema.fromJsonString(KustomizeBuildArgs))
      const decodePkgRenderArgs = Schema.decodeUnknownEffect(Schema.fromJsonString(PkgRenderArgs))

      /** Composition goes through typed dependency aliases only, never filesystem paths. */
      const pkgRender = Effect.fn("KclPlugins.pkgRender")(function*(argsJson: string, scope: PluginScope) {
        const [opts] = yield* decodePkgRenderArgs(argsJson)
        if (opts.package === undefined) {
          return yield* new PluginError({
            plugin: "pkg.render",
            message: "set `package = \"<dep-alias>\"` - declare the sub-package under `[dependencies]` in " +
              "akua.toml and compose it by alias (filesystem paths are not allowed in composition)"
          })
        }
        // Keys reach the caller sorted, as the previous release's JSON bridge delivered them.
        return (yield* scope.renderPackage(opts.package, opts.inputs ?? {})).map(sortKeys)
      })

      const parseManifests = Effect.fn("KclPlugins.parseManifests")(function*(plugin: string, yaml: string) {
        return yield* Effect.try({
          try: () => parseEngineManifests(yaml),
          catch: (cause) => new PluginError({ plugin, message: `parsing output as YAML: ${String(cause)}` })
        })
      })

      const packageDir = Effect.fn("KclPlugins.packageDir")(function*(plugin: string, pkg: Snapshot, path: string) {
        const prefix = resolveInSnapshot(path)
        const files = prefix === undefined ? new Map() : subtree(pkg, prefix)
        if (prefix === undefined || files.size === 0) {
          return yield* new PluginError({ plugin, message: `path \`${path}\` is not a directory inside the Package` })
        }
        return { prefix, files }
      })

      /** A typed `charts.<name>` dependency, or a directory inside the Package. */
      const chartFiles = Effect.fnUntraced(function*(chart: string, scope: PluginScope) {
        const dependency = scope.charts.get(chart)
        if (dependency !== undefined) return { name: dependency.name, files: dependency.files }
        if (scope.strict) {
          return yield* new PluginError({
            plugin: "helm.template",
            code: "E_STRICT_UNTYPED_CHART",
            message: `raw chart path \`${chart}\` under --strict; declare the chart in akua.toml and use charts.<name>`
          })
        }
        const directory = yield* packageDir("helm.template", scope.files, chart)
        return { name: lastSegment(directory.prefix, "chart"), files: directory.files }
      })

      const helmTemplate = Effect.fn("KclPlugins.helmTemplate")(function*(argsJson: string, scope: PluginScope) {
        const [opts] = yield* decodeHelmArgs(argsJson)
        const chart = yield* chartFiles(opts.chart, scope)
        const manifests = yield* helm.render({
          chartTarGz: tarGz(chart.files, chart.name),
          valuesYaml: YAML.stringify(opts.values ?? {}),
          release: { name: opts.release ?? "release", namespace: opts.namespace ?? "default" }
        })
        const resources: Array<unknown> = []
        // Sorted like the Rust host's BTreeMap; NOTES.txt is prose, not a manifest.
        for (const path of Object.keys(manifests).toSorted()) {
          if (lastSegment(path, "") === "NOTES.txt") continue
          resources.push(...(yield* parseManifests("helm.template", manifests[path] ?? "")))
        }
        return resources
      })

      const kustomizeBuild = Effect.fn("KclPlugins.kustomizeBuild")(function*(argsJson: string, scope: PluginScope) {
        const [opts] = yield* decodeKustomizeArgs(argsJson)
        const overlay = yield* packageDir("kustomize.build", scope.files, opts.path)
        // Tar the overlay's parent so sibling bases (`../base`) resolve.
        const parent = overlay.prefix.split("/").slice(0, -1).join("/")
        const yaml = yield* kustomize.build({
          treeTarGz: tarGz(subtree(scope.files, parent), "pkg"),
          entrypoint: `pkg/${lastSegment(overlay.prefix, "overlay")}`
        })
        return yield* parseManifests("kustomize.build", yaml)
      })

      const invoke = Effect.fn("KclPlugins.invoke")(
        function*({ argsJson, method, scope }: Parameters<KclPlugins["Service"]["invoke"]>[0]) {
          const name = method.replace(/^kcl_plugin\./, "")
          switch (name) {
            case "helm.template":
              return JSON.stringify(yield* helmTemplate(argsJson, scope))
            case "kustomize.build":
              return JSON.stringify(yield* kustomizeBuild(argsJson, scope))
            case "pkg.render":
              return JSON.stringify(yield* pkgRender(argsJson, scope))
            default:
              return yield* new PluginError({ plugin: name, message: `no plugin registered under \`${name}\`` })
          }
        },
        Effect.catchTags({
          SchemaError: (error) => Effect.fail(new PluginError({ plugin: "args", message: error.message })),
          EngineError: (error) =>
            Effect.fail(new PluginError({ plugin: error.engine, message: error.message, code: error.code }))
        })
      )

      return KclPlugins.of({ invoke })
    })
  )
}
