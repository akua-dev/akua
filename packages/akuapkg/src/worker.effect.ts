import { Cause, Context, Effect, FileSystem, Layer, Path, Predicate, Schema, type Scope } from "effect"
import YAML from "yaml"
import { type ResolvedDependency, type ResolveOptions, resolvePackage } from "./dependencies.effect"
import {
  type DependencyUnresolved,
  type GuestFailure,
  type ManifestInvalid,
  PluginError,
  ProgramShape,
  RenderError
} from "./errors"
import { Artifacts, type EngineBudget, type MountedTree, WasmHost } from "./host"
import { chartReference, chartsPackage, crdsPackage, kclModules, packageStubs } from "./kcl-modules"
import { GitRemote } from "./git.effect"
import { HelmRepository } from "./helm-repository.effect"
import { OciRegistry } from "./oci.effect"
import { UrlSource } from "./url-source.effect"
import { KclPlugins, type PluginScope } from "./plugins.effect"
import {
  ExportResponse,
  FormatResponse,
  type LintIssue,
  LintResponse,
  type OptionInfo,
  OptionsResponse,
  WorkerRequest,
  WorkerResponse
} from "./schemas"
import type { Snapshot } from "./snapshot.effect"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const STDLIB_KCL_MOD = "[package]\nname = \"akua\"\nedition = \"0.0.1\"\nversion = \"0.0.1\"\n"

/** Composition is shallow in practice (one to three levels); deeper is a runaway. */
export const MAX_RENDER_DEPTH = 16

/**
 * Nested renders (`pkg.render`) one render may start. Each gets a full
 * worker fuel budget, so this bounds the CPU a composition can spend.
 */
export const MAX_NESTED_RENDERS = 64

/** `__kcl_PanicInfo__` envelope: KCL raises it as a runtime error at the call site. */
const panicEnvelope = (message: string) => JSON.stringify({ __kcl_PanicInfo__: message })

/** The plugin failure behind a cause; anything untyped becomes a host failure. */
const pluginFailure = (cause: Cause.Cause<PluginError>): PluginError => {
  const error = Cause.squash(cause)
  return error instanceof PluginError ? error : new PluginError({ plugin: "host", message: Cause.pretty(cause) })
}

/** An Akua-Package dependency that cannot be rendered: it is on its own render stack, or too deep. */
export type Unrenderable = { readonly _tag: "Cycle" } | { readonly _tag: "TooDeep" }

/**
 * A Package ready to render: its files, its resolved dependencies, the
 * Akua-Package dependencies it can `pkg.render` (prepared the same way), and
 * the generated KCL packages already mounted for the worker.
 */
export interface PackageTree {
  readonly _tag: "PackageTree"
  readonly filename: string
  readonly source: string
  readonly files: Snapshot
  /** Helm dependencies by the `path` their generated module passes to `helm.template`. */
  readonly charts: ReadonlyMap<string, ResolvedDependency>
  /** Akua-Package dependencies by name. */
  readonly packages: ReadonlyMap<string, PackageTree | Unrenderable>
  readonly mounts: {
    readonly charts?: MountedTree
    readonly pkgs?: MountedTree
    readonly kclModules: ReadonlyArray<{ readonly ident: string; readonly tree: MountedTree }>
  }
}

/** A Package with no dependencies resolved: parses see only the `akua` stdlib. */
export const bareTree = (filename: string, files: Snapshot): PackageTree => ({
  _tag: "PackageTree",
  filename,
  source: decoder.decode(files.get(filename) ?? new Uint8Array()),
  files,
  charts: new Map(),
  packages: new Map(),
  mounts: { kclModules: [] }
})

/** What a YAML value is, in the previous release's words. */
const yamlKind = (value: unknown) =>
  value === null || value === undefined
    ? "null"
    : Array.isArray(value)
    ? "sequence"
    : typeof value === "object"
    ? "mapping"
    : typeof value === "boolean"
    ? "bool"
    : typeof value === "number"
    ? "number"
    : "string"

/** The `resources` of a Package program's YAML, checked as the previous release did. */
export const programResources = (yaml: string): Effect.Effect<ReadonlyArray<unknown>, RenderError | ProgramShape> =>
  Effect.try({
    try: (): unknown => YAML.parse(yaml),
    catch: (cause) => new RenderError({ message: `kcl output is not valid YAML: ${String(cause)}` })
  }).pipe(
    Effect.flatMap((program) => {
      if (yamlKind(program) !== "mapping") {
        return Effect.fail(new ProgramShape({ problem: "NotAMapping", got: yamlKind(program) }))
      }
      if (!Predicate.hasProperty(program, "resources")) {
        return Effect.fail(new ProgramShape({ problem: "NoResources", got: "" }))
      }
      const resources = program.resources
      return Array.isArray(resources)
        ? Effect.succeed(resources)
        : Effect.fail(new ProgramShape({ problem: "ResourcesNotASequence", got: yamlKind(resources) }))
    })
  )

export class RenderWorker extends Context.Service<RenderWorker, {
  /**
   * Resolve the Package's dependencies (the `akua.toml` in `workspace`), and
   * those of every Akua Package it depends on, and mount what the workers
   * need, for the lifetime of the scope.
   */
  prepare(pkg: {
    readonly workspace: string
    readonly filename: string
    readonly files: Snapshot
    readonly options: ResolveOptions
  }): Effect.Effect<PackageTree, ManifestInvalid | DependencyUnresolved | RenderError, Scope.Scope>
  render(request: {
    readonly tree: PackageTree
    readonly inputs: unknown
    /** Reject raw-string chart paths (`--strict`). */
    readonly strict: boolean
  }): Effect.Effect<ReadonlyArray<unknown>, RenderError | ProgramShape | GuestFailure | PluginError>
  /**
   * Run a prepared Package's program and return its top-level bindings as
   * the YAML KCL printed, whatever their shape (tests, the REPL).
   */
  evaluate(request: {
    readonly tree: PackageTree
    /** The name diagnostics carry. */
    readonly filename: string
    readonly inputs: unknown
  }): Effect.Effect<string, RenderError | GuestFailure | PluginError>
  /** Parse a prepared Package, its imports resolved against its dependencies; nothing runs. */
  lint(request: {
    readonly tree: PackageTree
    /** The name diagnostics carry (an absolute path, as before). */
    readonly filename: string
  }): Effect.Effect<ReadonlyArray<LintIssue>, RenderError | GuestFailure>
  /** KCL's canonical formatting of `source`. */
  format(source: string): Effect.Effect<string, RenderError | GuestFailure>
  /** The `Input` schema of a Package as JSON Schema 2020-12 or OpenAPI 3.1. */
  exportSchema(request: {
    readonly filename: string
    readonly tree: PackageTree
    readonly format: "json-schema" | "openapi"
  }): Effect.Effect<unknown, RenderError | GuestFailure>
  /** The `option(...)` calls a Package reads. */
  options(request: {
    readonly filename: string
    readonly source: string
  }): Effect.Effect<ReadonlyArray<OptionInfo>, RenderError | GuestFailure>
}>()("akuapkg/host/RenderWorker") {
  static readonly layer = Layer.effect(
    RenderWorker,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const host = yield* WasmHost
      const artifacts = yield* Artifacts
      const plugins = yield* KclPlugins
      const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path | OciRegistry | HelmRepository | GitRemote | UrlSource>()
      const worker = yield* host.command("akua-render-worker", yield* fs.readFile(artifacts.worker))
      const stdlibFiles: Snapshot = new Map(
        yield* Effect.forEach(
          artifacts.stdlib,
          ([name, file]) => Effect.map(fs.readFile(file), (data): [string, Uint8Array] => [name, data])
        )
      ).set("kcl.mod", encoder.encode(STDLIB_KCL_MOD))
      // Mounted once for the layer's lifetime: every render reads the same stdlib.
      const stdlib = yield* host.mount(stdlibFiles)
      const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(WorkerRequest))
      const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerResponse))

      /** `ancestors`: the real directories of the Packages on this one's render stack. */
      const prepareTree = (
        pkg: Parameters<RenderWorker["Service"]["prepare"]>[0],
        ancestors: ReadonlyArray<string>
      ): Effect.Effect<
        PackageTree,
        ManifestInvalid | DependencyUnresolved | RenderError,
        Scope.Scope | FileSystem.FileSystem | Path.Path | OciRegistry | HelmRepository | GitRemote | UrlSource
      > =>
        Effect.gen(function*() {
          const stack = [...ancestors, yield* fs.realPath(pkg.workspace)]
          const resolved = yield* resolvePackage(pkg.workspace, pkg.options)
          const charts = yield* chartsPackage(resolved.dependencies)
          const stubs = yield* packageStubs(resolved.dependencies)
          const modules = yield* kclModules(resolved.dependencies)
          const crds = yield* crdsPackage(resolved.dependencies)
          const packages = new Map<string, PackageTree | Unrenderable>()
          for (const dependency of resolved.dependencies.filter((dependency) => dependency.kind === "package")) {
            const root = yield* fs.realPath(dependency.root)
            packages.set(
              dependency.name,
              stack.includes(root)
                ? { _tag: "Cycle" }
                : stack.length >= MAX_RENDER_DEPTH
                ? { _tag: "TooDeep" }
                : yield* prepareTree(
                  { workspace: root, filename: "package.k", files: dependency.files, options: pkg.options },
                  stack
                )
            )
          }
          return {
            _tag: "PackageTree",
            filename: pkg.filename,
            source: decoder.decode(pkg.files.get(pkg.filename) ?? new Uint8Array()),
            files: pkg.files,
            charts: new Map(
              resolved.dependencies
                .filter((dependency) => dependency.kind === "helm")
                .map((dependency) => [chartReference(dependency.name), dependency])
            ),
            packages,
            mounts: {
              ...(charts === undefined ? {} : { charts: yield* host.mount(charts) }),
              ...(stubs === undefined ? {} : { pkgs: yield* host.mount(stubs) }),
              kclModules: yield* Effect.forEach(
                crds === undefined ? modules : [...modules, { ident: "crds", files: crds }],
                ({ files, ident }) => host.mount(files).pipe(Effect.map((tree) => ({ ident, tree })))
              )
            }
          } satisfies PackageTree
        }).pipe(
          Effect.catchTag("PlatformError", (error) => Effect.fail(new RenderError({ message: error.message })))
        )

      const prepare = Effect.fn("RenderWorker.prepare")(
        function*(pkg: Parameters<RenderWorker["Service"]["prepare"]>[0]) {
          return yield* prepareTree(pkg, [])
        },
        Effect.provideContext(platform)
      )

      /** The worker request fields naming a tree's dependency packages. */
      const dependencyFields = (tree: PackageTree) => ({
        ...(tree.mounts.charts === undefined ? {} : { charts_pkg_path: "/charts" }),
        ...(tree.mounts.pkgs === undefined ? {} : { pkgs_pkg_path: "/akua-pkgs" }),
        ...(tree.mounts.kclModules.length === 0 ? {} : {
          kcl_pkgs: Object.fromEntries(tree.mounts.kclModules.map(({ ident }) => [ident, `/kcl-pkgs/${ident}`]))
        })
      })

      /** The stdlib and a tree's dependency packages, where those fields say they are. */
      const preopens = (tree: PackageTree | undefined) => [
        { guestPath: "/akua-stdlib", tree: stdlib },
        ...(tree?.mounts.charts === undefined ? [] : [{ guestPath: "/charts", tree: tree.mounts.charts }]),
        ...(tree?.mounts.pkgs === undefined ? [] : [{ guestPath: "/akua-pkgs", tree: tree.mounts.pkgs }]),
        ...(tree?.mounts.kclModules ?? []).map(({ ident, tree }) => ({ guestPath: `/kcl-pkgs/${ident}`, tree }))
      ]

      /**
       * One worker request that runs no Package program, so no plugin call
       * can happen: the decoded response, or its `message` as a RenderError.
       */
      const exchange = <A extends { readonly status: "ok" | "fail"; readonly message?: string }>(
        request: object,
        response: Schema.Codec<A, string>,
        tree?: PackageTree
      ) =>
        Effect.gen(function*() {
          const result = yield* worker.run({
            stdin: encoder.encode(JSON.stringify(request)),
            preopens: preopens(tree),
            kclPlugin: () => panicEnvelope("plugins are only available while rendering")
          })
          if (result.exitCode !== 0) {
            return yield* new RenderError({
              message: `worker exited ${result.exitCode}: ${decoder.decode(result.stderr)}`
            })
          }
          const decoded = yield* Schema.decodeUnknownEffect(response)(decoder.decode(result.stdout)).pipe(
            Effect.mapError((error) => new RenderError({ message: error.message }))
          )
          if (decoded.status === "fail") return yield* new RenderError({ message: decoded.message ?? "failed" })
          return decoded
        })

      const lint = Effect.fn("RenderWorker.lint")(function*(
        { filename, tree }: Parameters<RenderWorker["Service"]["lint"]>[0]
      ) {
        const response = yield* exchange(
          { kind: "lint", package_filename: filename, source: tree.source, ...dependencyFields(tree) },
          Schema.fromJsonString(LintResponse),
          tree
        )
        return response.issues
      })

      const format = Effect.fn("RenderWorker.format")(function*(source: string) {
        return (yield* exchange({ kind: "format", source }, Schema.fromJsonString(FormatResponse))).formatted
      })

      const exportSchema = Effect.fn("RenderWorker.exportSchema")(function*(
        { filename, format, tree }: Parameters<RenderWorker["Service"]["exportSchema"]>[0]
      ) {
        return (yield* exchange(
          { kind: "export", package_filename: filename, source: tree.source, format, ...dependencyFields(tree) },
          Schema.fromJsonString(ExportResponse),
          tree
        )).schema
      })

      const options = Effect.fn("RenderWorker.options")(function*(
        { filename, source }: Parameters<RenderWorker["Service"]["options"]>[0]
      ) {
        return (yield* exchange(
          { kind: "options", package_filename: filename, source },
          Schema.fromJsonString(OptionsResponse)
        )).options
      })

      /** Shared by a render and every render nested in it. */
      interface Budget extends EngineBudget {
        nested: number
      }

      /**
       * `pkg.render` of dependency `name`, from inside the caller's plugin
       * import: a fresh worker instance, synchronous like the rest.
       */
      const renderDependency = (tree: PackageTree, strict: boolean, budget: Budget) =>
        Effect.fnUntraced(function*(name: string, inputs: unknown) {
          const plugin = `pkg.render(${name})`
          const child = tree.packages.get(name)
          if (child === undefined) {
            const known = Array.from(tree.packages.keys())
            return yield* new PluginError({
              plugin: "pkg.render",
              message: `package \`${name}\` is not in the current Package's dependencies (${
                known.length === 0
                  ? "none - declare it under `[dependencies]` in akua.toml"
                  : `known: ${known.join(", ")}`
              })`
            })
          }
          if (child._tag === "Cycle") {
            return yield* new PluginError({
              plugin,
              code: "E_RENDER_CYCLE",
              message: "cycle detected - already on the render stack"
            })
          }
          if (child._tag === "TooDeep") {
            return yield* new PluginError({
              plugin,
              code: "E_RENDER_BUDGET_DEPTH",
              message: `render depth limit (${MAX_RENDER_DEPTH}) exceeded - likely composition runaway`
            })
          }
          budget.nested += 1
          if (budget.nested > MAX_NESTED_RENDERS) {
            return yield* new PluginError({
              plugin,
              code: "E_RENDER_BUDGET_DEADLINE",
              message: `more than ${MAX_NESTED_RENDERS} nested renders - composition exceeds the render budget`
            })
          }
          return yield* renderTree(child, inputs, strict, budget).pipe(
            Effect.mapError((error) =>
              new PluginError({
                plugin,
                message: error._tag === "PluginError" ? `${error.plugin}: ${error.message}` : error.message,
                code: error._tag === "PluginError"
                  ? error.code
                  : error._tag === "GuestFailure"
                  ? error.budgetCode
                  : undefined
              })
            )
          )
        })

      const evaluateTree = (
        tree: PackageTree,
        filename: string,
        inputs: unknown,
        strict: boolean,
        budget: Budget
      ): Effect.Effect<string, RenderError | GuestFailure | PluginError> =>
        Effect.gen(function*() {
          const request = yield* encodeRequest({
            kind: "render",
            package_filename: filename,
            source: tree.source,
            inputs,
            ...dependencyFields(tree)
          })
          const scope: PluginScope = {
            files: tree.files,
            charts: tree.charts,
            strict,
            budget,
            renderPackage: renderDependency(tree, strict, budget)
          }
          // KCL turns a plugin failure into an opaque runtime panic; the first
          // one is kept typed here and reported instead of the panic text.
          let firstFailure: PluginError | undefined

          // The one synchronous boundary: KCL calls the plugin import and
          // blocks on its return value, so the plugin program (a nested
          // render included) runs to completion here. Failures become KCL
          // panic envelopes, never exceptions crossing back into the guest.
          const kclPlugin = (method: string, argsJson: string): string =>
            Effect.runSync(
              plugins.invoke({ method, argsJson, scope }).pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() => {
                    const failure = pluginFailure(cause)
                    firstFailure ??= failure
                    return panicEnvelope(`${failure.plugin}: ${failure.message}`)
                  })
                )
              )
            )

          const result = yield* worker.run({
            stdin: encoder.encode(request),
            preopens: preopens(tree),
            kclPlugin
          }).pipe(
            // A plugin failure reaches the guest as a KCL panic, which aborts
            // (traps) on wasm: report the plugin's own failure instead.
            Effect.catchTags({
              RenderError: (error) => Effect.fail(firstFailure ?? error),
              GuestFailure: (error) => Effect.fail(error.reason === "Trap" ? firstFailure ?? error : error)
            })
          )
          if (result.exitCode !== 0) {
            const stderr = decoder.decode(result.stderr)
            return yield* (firstFailure ?? new RenderError({ message: `worker exited ${result.exitCode}: ${stderr}` }))
          }

          const response = yield* decodeResponse(decoder.decode(result.stdout))
          if (response.status === "fail") {
            return yield* (firstFailure ?? new RenderError({ message: response.message ?? "render failed" }))
          }
          return response.yaml
        }).pipe(
          Effect.catchTag("SchemaError", (error) => Effect.fail(new RenderError({ message: error.message })))
        )

      const renderTree = (tree: PackageTree, inputs: unknown, strict: boolean, budget: Budget) =>
        evaluateTree(tree, tree.filename, inputs, strict, budget).pipe(Effect.flatMap(programResources))

      const render = Effect.fn("RenderWorker.render")(function*(
        { inputs, strict, tree }: Parameters<RenderWorker["Service"]["render"]>[0]
      ) {
        return yield* renderTree(tree, inputs, strict, { nested: 0, fuelSpent: 0 })
      })

      const evaluate = Effect.fn("RenderWorker.evaluate")(function*(
        { filename, inputs, tree }: Parameters<RenderWorker["Service"]["evaluate"]>[0]
      ) {
        return yield* evaluateTree(tree, filename, inputs, false, { nested: 0, fuelSpent: 0 })
      })

      return RenderWorker.of({ prepare, render, evaluate, lint, format, exportSchema, options })
    })
  )
}
