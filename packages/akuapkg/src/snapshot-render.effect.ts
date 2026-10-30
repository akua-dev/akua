import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect"
import { Gzip } from "./archive"
import { HelmEngine, KustomizeEngine } from "./engines.effect"
import { WasmLoadError } from "./errors"
import { GitFetchFailed, GitRemote } from "./git.effect"
import { HelmRepository, HelmRepositoryFailed } from "./helm-repository.effect"
import { Artifacts } from "./host"
import { JsWasmCompiler, JsWasmHost } from "./host-js.effect"
import { OciPullFailed, OciPushFailed, OciRegistry } from "./oci.effect"
import { KclPlugins } from "./plugins.effect"
import { manifestFilename, toYaml } from "./render.effect"
import { makeSnapshotFileSystem } from "./snapshot-filesystem.effect"
import type { Snapshot } from "./snapshot.effect"
import { UrlFetchFailed, UrlSource } from "./url-source.effect"
import { RenderWorker } from "./worker.effect"

export { makeSnapshotFileSystem } from "./snapshot-filesystem.effect"
export { treeDigest } from "./snapshot.effect"

const unavailable = "Rendering requires a complete vendored Package snapshot; dependency fetching is unavailable."
const pullFailed = () => Effect.fail(new OciPullFailed({ code: "E_DEP_RESOLVE", message: unavailable, offline: true }))
const pushFailed = () => Effect.fail(new OciPushFailed({ message: unavailable }))
const offlineSources = Layer.mergeAll(
  Layer.succeed(OciRegistry, OciRegistry.of({
    pull: pullFailed, pullPackage: pullFailed, pullAttestation: pullFailed,
    pushPackage: pushFailed, pushSignature: pushFailed, pushAttestation: pushFailed
  })),
  Layer.succeed(GitRemote, GitRemote.of({ fetch: () => Effect.fail(new GitFetchFailed({ message: unavailable, offline: true })) })),
  Layer.succeed(HelmRepository, HelmRepository.of({ fetch: () => Effect.fail(new HelmRepositoryFailed({ message: unavailable, offline: true })) })),
  Layer.succeed(UrlSource, UrlSource.of({ fetch: () => Effect.fail(new UrlFetchFailed({ message: unavailable, offline: true })) }))
)

export interface SnapshotRenderAssets {
  readonly stdlib: Snapshot
  readonly modules: ReadonlyMap<string, WebAssembly.Module>
  /** Synchronous because an engine can run inside KCL's synchronous plugin callback. */
  readonly gzip: (bytes: Uint8Array) => Uint8Array
}

/** Use only inside an execution environment that supplies process/isolate resource limits. */
export const snapshotRenderLayer = (files: Snapshot, assets: SnapshotRenderAssets) => Layer.unwrap(
  Effect.gen(function*() {
    const packageFs = yield* makeSnapshotFileSystem(files)
    const runtimeFiles = new Map(Array.from(assets.stdlib, ([name, bytes]) => [`/runtime/stdlib/${name}`, bytes]))
    runtimeFiles.set("/runtime/worker", new Uint8Array())
    runtimeFiles.set("/runtime/helm", new Uint8Array())
    runtimeFiles.set("/runtime/kustomize", new Uint8Array())
    const fs = Layer.succeed(FileSystem.FileSystem, FileSystem.FileSystem.of({
      ...packageFs,
      readFile: (name) => runtimeFiles.has(name)
        ? Effect.succeed((runtimeFiles.get(name) ?? new Uint8Array()).slice())
        : packageFs.readFile(name)
    }))
    const runtime = Layer.mergeAll(fs, Path.layer, offlineSources,
      Layer.succeed(Artifacts, Artifacts.of({
        worker: "/runtime/worker", helm: "/runtime/helm", kustomize: "/runtime/kustomize",
        stdlib: new Map(Array.from(assets.stdlib.keys(), (name) => [name, `/runtime/stdlib/${name}`]))
      })),
      Layer.succeed(Gzip, assets.gzip),
      Layer.succeed(JsWasmCompiler, (name) => {
        const module = assets.modules.get(name)
        return module === undefined
          ? Effect.fail(new WasmLoadError({ module: name, cause: new Error("Compiled module was not supplied") }))
          : Effect.succeed(module)
      })
    )
    return RenderWorker.layer.pipe(
      Layer.provide(KclPlugins.layer),
      Layer.provide(Layer.mergeAll(HelmEngine.layer, KustomizeEngine.layer)),
      Layer.provide(JsWasmHost),
      Layer.provideMerge(runtime),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ AKUA_REJECT_REPLACE: "1" })))
    )
  })
)

export const renderSnapshot = Effect.fn("renderSnapshot")(function*(request: {
  readonly files: Snapshot
  readonly filename: string
  readonly inputs: unknown
}) {
  const worker = yield* RenderWorker
  const resources = yield* Effect.scoped(worker.prepare({
    workspace: "/package", filename: request.filename, files: request.files,
    options: { offline: true }
  }).pipe(Effect.flatMap((tree) => worker.render({ tree, inputs: request.inputs, strict: false }))))
  return resources.map((resource, index): readonly [string, string] => [manifestFilename(index, resource), toYaml(resource)])
})
