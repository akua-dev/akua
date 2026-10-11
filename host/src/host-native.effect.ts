import { Effect, FileSystem, Layer, Path } from "effect"
import type { CompiledModule, Instance, Outcome } from "@akua-dev/wasm-sandbox"
import { EngineError, GuestFailure, RenderError, WasmLoadError } from "./errors"
import { type CommandRun, type MountedTree, type ReactorSpec, WasmHost } from "./host"
import { NativeSandbox } from "./native"
import type { Snapshot } from "./snapshot.effect"

export interface SandboxLimits {
  /** Linear-memory cap for the render worker's store. */
  readonly workerMemoryBytes: number
  /** Linear-memory cap for each engine store (helm, kustomize). */
  readonly engineMemoryBytes: number
  /** Fuel for one worker run: the Package's own KCL (roughly one unit per wasm instruction). */
  readonly workerFuel: number
  /** Fuel for each engine call (one Helm chart or Kustomize build). */
  readonly engineFuel: number
  /** Cap on stdout and stderr each. */
  readonly maxOutputBytes: number
}

/**
 * Defaults: the previous release's memory caps. Fuel is spent at roughly 4e10
 * units per second: a Package's own KCL gets a fraction of a second, one
 * engine call about 25 seconds (the previous release's 30-second engine
 * deadline; Cilium, the largest chart in use, renders in about one).
 */
export const DEFAULT_LIMITS: SandboxLimits = {
  workerMemoryBytes: 256 * 1024 * 1024,
  engineMemoryBytes: 2048 * 1024 * 1024,
  workerFuel: 10_000_000_000,
  engineFuel: 1_000_000_000_000,
  maxOutputBytes: 64 * 1024 * 1024
}

/**
 * KCL's plugin import in the render worker: three C-string params (method,
 * args JSON, kwargs JSON), response allocated through the worker's export.
 */
const KCL_PLUGIN_IMPORT = {
  module: "env",
  name: "kcl_plugin_invoke_json_wasm",
  params: 3,
  allocExport: "akua_bridge_alloc"
}

type Failed = Exclude<Outcome, { _tag: "Ok" } | { _tag: "Exited" }>

const guestFailure = (module: string, outcome: Failed) =>
  new GuestFailure({ module, reason: outcome._tag, detail: outcome._tag === "Trap" ? outcome.message : "" })

/** Results of a call that must return normally; anything else is a typed failure. */
const returned = Effect.fnUntraced(function*(module: string, outcome: Outcome) {
  switch (outcome._tag) {
    case "Ok":
      return outcome.values
    case "Exited":
      return yield* new EngineError({ engine: module, message: `exited ${outcome.code}` })
    default:
      return yield* guestFailure(module, outcome)
  }
})

/** The single i32 a call returns. */
const returnedI32 = Effect.fnUntraced(function*(module: string, outcome: Outcome) {
  const [value] = yield* returned(module, outcome)
  if (value === undefined) return yield* new EngineError({ engine: module, message: "call returned no value" })
  return value
})

/**
 * Wasmtime through the generic `native/` addon, running machine code
 * precompiled at build time (the artifacts are `.cwasm`, not `.wasm`). The addon owns the
 * guarantees (memory caps, fuel, read-only preopens, capped stdio, no env or
 * sockets, fixed clock, seeded randomness); everything module-specific lives
 * here: the Go reactor ABI, the worker's `_start` and the KCL bridge.
 */
export const NativeWasmHost = (limits: SandboxLimits = DEFAULT_LIMITS) =>
  Layer.effect(
    WasmHost,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const native = yield* NativeSandbox
      const sandbox = yield* Effect.try({
        try: () => new native.Sandbox(),
        catch: (cause) => new WasmLoadError({ module: "wasm-sandbox", cause })
      })

      /**
       * Decompress (zstd) and load machine code precompiled for this target
       * (see native/precompile). Synchronous, so engines can load lazily from
       * inside the KCL bridge.
       */
      const load = Effect.fn("NativeWasmHost.load")(function*(name: string, compressed: Uint8Array) {
        return yield* Effect.try({
          try: () => sandbox.load(name, Bun.zstdDecompressSync(compressed)),
          catch: (cause) => new WasmLoadError({ module: name, cause })
        })
      })

      /** Private temp dir holding a snapshot, preopened read-only by the addon. */
      const mount = Effect.fn("NativeWasmHost.mount")(function*(files: Snapshot) {
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "akuapkg-preopen-" })
        for (const [rel, data] of files) {
          const target = path.join(dir, ...rel.split("/"))
          yield* fs.makeDirectory(path.dirname(target), { recursive: true })
          yield* fs.writeFile(target, data)
        }
        return { _tag: "HostDirectory", path: dir } satisfies MountedTree
      })

      /** Instantiate a Go wasip1 reactor and run its package inits once. */
      const startReactor = Effect.fn("NativeWasmHost.startReactor")(function*(spec: ReactorSpec, module: CompiledModule) {
        const instance = yield* Effect.try({
          try: () =>
            module.instantiate({
              args: [spec.name],
              preopens: [],
              maxOutputBytes: limits.maxOutputBytes,
              memoryBytes: limits.engineMemoryBytes,
              fuel: limits.engineFuel,
              stringImports: []
            }),
          catch: (cause) => new EngineError({ engine: spec.name, message: `instantiate: ${String(cause)}` })
        })
        yield* returned(spec.name, instance.call("_initialize", []))
        return instance
      })

      /**
       * One JSON request over the reactor ABI: `<prefix>_malloc` the input,
       * call the entry point, `<prefix>_result_len` the result, read it back
       * and free both buffers. Each request gets a full fuel budget.
       */
      const request = Effect.fn("NativeWasmHost.request")(function*(
        spec: ReactorSpec,
        instance: Instance,
        input: Uint8Array
      ) {
        instance.setFuel(limits.engineFuel)
        const inPtr = yield* returnedI32(spec.name, instance.call(`${spec.prefix}_malloc`, [input.length]))
        instance.write(inPtr, Buffer.from(input))
        const outPtr = yield* returnedI32(spec.name, instance.call(spec.entry, [inPtr, input.length]))
        const outLen = yield* returnedI32(spec.name, instance.call(`${spec.prefix}_result_len`, [outPtr]))
        const output = instance.read(outPtr, outLen)
        yield* returned(spec.name, instance.call(`${spec.prefix}_free`, [inPtr]))
        yield* returned(spec.name, instance.call(`${spec.prefix}_free`, [outPtr]))
        return output
      })

      return WasmHost.of({
        name: "wasmtime",
        mount,

        reactor: Effect.fn("NativeWasmHost.reactor")(function*(spec: ReactorSpec, compressed: Uint8Array) {
          // Loaded and instantiated on first use, synchronously (inside the KCL
          // bridge): Packages that never call this engine never pay for it.
          const session = yield* Effect.cached(
            load(spec.name, compressed).pipe(
              Effect.mapError((error) => new EngineError({ engine: spec.name, message: `loading engine: ${String(error.cause)}` })),
              Effect.flatMap((module) => startReactor(spec, module))
            )
          )
          return {
            call: Effect.fn("NativeWasmHost.call")(function*(input: Uint8Array) {
              return yield* request(spec, yield* session, input)
            })
          }
        }),

        command: Effect.fn("NativeWasmHost.command")(function*(name: string, compressed: Uint8Array) {
          const module = yield* load(name, compressed)
          const run = Effect.fn("NativeWasmHost.run")(
            function*({ kclPlugin, preopens, stdin }: CommandRun) {
              const mounts: Array<{ hostPath: string; guestPath: string }> = []
              for (const { guestPath, tree } of preopens) {
                if (tree._tag !== "HostDirectory") {
                  return yield* new RenderError({ message: `${name}: ${guestPath} is not mounted on the host` })
                }
                mounts.push({ hostPath: tree.path, guestPath })
              }
              const instance = yield* Effect.try({
                try: () =>
                  module.instantiate(
                    {
                      args: [name],
                      stdin: Buffer.from(stdin),
                      preopens: mounts,
                      maxOutputBytes: limits.maxOutputBytes,
                      memoryBytes: limits.workerMemoryBytes,
                      fuel: limits.workerFuel,
                      stringImports: [KCL_PLUGIN_IMPORT]
                    },
                    (_import, [method = "", argsJson = ""]) => kclPlugin(method, argsJson || "[]")
                  ),
                catch: (cause) => new RenderError({ message: `${name}: instantiate: ${String(cause)}` })
              })
              const outcome = instance.call("_start", [])
              switch (outcome._tag) {
                case "Ok":
                case "Exited":
                  return {
                    exitCode: outcome._tag === "Exited" ? outcome.code : 0,
                    stdout: instance.stdout(),
                    stderr: instance.stderr()
                  }
                default:
                  return yield* guestFailure(name, outcome)
              }
            }
          )
          return { run }
        })
      })
    })
  )
