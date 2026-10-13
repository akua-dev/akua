import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { EngineError } from "./errors"
import { Artifacts, type EngineBudget, type ReactorSpec, WasmHost } from "./host"
import { HelmEngineResponse, KustomizeEngineResponse } from "./schemas"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Compile an engine and expose one JSON request over its reactor ABI, charged
 * to the render's `budget`. The engine answers with `response` or reports
 * `error`; a budget failure keeps its contract code.
 */
const loadEngine = Effect.fnUntraced(function*<A extends { readonly error?: string }>(
  spec: ReactorSpec,
  path: string,
  response: Schema.Codec<A, string>
) {
  const fs = yield* FileSystem.FileSystem
  const host = yield* WasmHost
  const reactor = yield* host.reactor(spec, yield* fs.readFile(path))
  const decode = Schema.decodeUnknownEffect(response)
  return Effect.fn(`${spec.name}.request`)(
    function*(request: unknown, budget: EngineBudget) {
      const output = yield* reactor.call(encoder.encode(JSON.stringify(request)), budget)
      const decoded = yield* decode(decoder.decode(output))
      if (decoded.error) return yield* new EngineError({ engine: spec.name, message: decoded.error })
      return decoded
    },
    Effect.catchTags({
      GuestFailure: (failure) =>
        Effect.fail(new EngineError({ engine: spec.name, message: failure.summary, code: failure.budgetCode })),
      SchemaError: (error) => Effect.fail(new EngineError({ engine: spec.name, message: error.message }))
    })
  )
})

export class HelmEngine extends Context.Service<HelmEngine, {
  render(request: {
    readonly chartTarGz: Uint8Array
    readonly values: unknown
    readonly release: { readonly name: string; readonly namespace: string }
    readonly budget: EngineBudget
  }): Effect.Effect<Record<string, string>, EngineError>
}>()("akuapkg/host/HelmEngine") {
  static readonly layer = Layer.effect(
    HelmEngine,
    Effect.gen(function*() {
      const artifacts = yield* Artifacts
      const request = yield* loadEngine(
        { name: "helm-engine", prefix: "helm", entry: "helm_render" },
        artifacts.helm,
        Schema.fromJsonString(HelmEngineResponse)
      )
      return HelmEngine.of({
        render: ({ budget, chartTarGz, release, values }) =>
          request({
            chart_tar_gz_b64: chartTarGz.toBase64(),
            // As JSON: the engine reads values as YAML 1.1 (sigs.k8s.io/yaml),
            // where a plain `NO`, `on` or `0b101` is a bool or a number. JSON
            // is valid YAML with every string quoted, so strings stay strings.
            values_yaml: JSON.stringify(values),
            release: { ...release, revision: 1, service: "Helm" }
          }, budget).pipe(Effect.map((response) => response.manifests ?? {}))
      })
    })
  )
}

export class KustomizeEngine extends Context.Service<KustomizeEngine, {
  build(request: {
    readonly treeTarGz: Uint8Array
    readonly entrypoint: string
    readonly budget: EngineBudget
  }): Effect.Effect<string, EngineError>
}>()("akuapkg/host/KustomizeEngine") {
  static readonly layer = Layer.effect(
    KustomizeEngine,
    Effect.gen(function*() {
      const artifacts = yield* Artifacts
      const request = yield* loadEngine(
        { name: "kustomize-engine", prefix: "kustomize", entry: "kustomize_build" },
        artifacts.kustomize,
        Schema.fromJsonString(KustomizeEngineResponse)
      )
      return KustomizeEngine.of({
        build: ({ budget, entrypoint, treeTarGz }) =>
          request({ overlay_tar_gz_b64: treeTarGz.toBase64(), entrypoint }, budget).pipe(
            Effect.map((response) => response.yaml ?? "")
          )
      })
    })
  )
}
