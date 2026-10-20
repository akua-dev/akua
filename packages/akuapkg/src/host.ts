import { Context, type Effect, type PlatformError, type Scope } from "effect"
import type { EngineError, GuestFailure, RenderError, WasmLoadError } from "./errors"
import type { Snapshot } from "./snapshot.effect"

/**
 * Go wasip1 reactor ABI shared by the engines (`engine-host-wasm::EngineSpec`):
 * `<prefix>_malloc`, `<prefix>_free`, `<prefix>_result_len`, and `entry`
 * `(input_ptr, input_len) -> result_ptr`.
 */
export interface ReactorSpec {
  readonly name: string
  readonly prefix: string
  readonly entry: string
}

/**
 * What the engine calls of one render have spent so far, shared with every
 * render nested in it: engine fuel is a budget per render, not per call.
 */
export interface EngineBudget {
  fuelSpent: number
}

/**
 * A compiled engine. `call` is synchronous end to end, instantiates on first
 * use, and charges `budget` for the work it does.
 */
export interface Reactor {
  readonly call: (input: Uint8Array, budget: EngineBudget) => Effect.Effect<Uint8Array, EngineError | GuestFailure>
}

/**
 * A tree made available to guests, read-only: a host directory (Wasmtime
 * preopens one) or the files themselves (the in-memory WASI).
 */
export type MountedTree =
  | { readonly _tag: "HostDirectory"; readonly path: string }
  | { readonly _tag: "InMemory"; readonly files: Snapshot }

export interface CommandRun {
  readonly stdin: Uint8Array
  readonly preopens: ReadonlyArray<{ readonly guestPath: string; readonly tree: MountedTree }>
  /** KCL's `env.kcl_plugin_invoke_json_wasm`: method + args JSON in, response JSON out. Must not throw. */
  readonly kclPlugin: (method: string, argsJson: string) => string
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

/**
 * A compiled WASI command module (the render worker). `run` never suspends,
 * so a plugin import can run another command (`pkg.render`) synchronously.
 */
export interface Command {
  readonly run: (io: CommandRun) => Effect.Effect<CommandResult, RenderError | GuestFailure>
}

/**
 * Where the wasm modules execute. Both implementations run the same
 * modules: the JS engine's `WebAssembly` (browser, portable) and Wasmtime
 * through the `crates/wasm-sandbox/` napi-rs addon (the CLI, with memory caps and fuel).
 */
export class WasmHost extends Context.Service<WasmHost, {
  readonly name: string
  /** Make `files` mountable for the lifetime of the scope. */
  mount(files: Snapshot): Effect.Effect<MountedTree, PlatformError.PlatformError, Scope.Scope>
  reactor(spec: ReactorSpec, wasm: Uint8Array): Effect.Effect<Reactor, WasmLoadError>
  command(name: string, wasm: Uint8Array): Effect.Effect<Command, WasmLoadError>
}>()("akuapkg/host/WasmHost") {}

/** Paths of the wasm modules and of the `akua` KCL stdlib files (by file name). */
export class Artifacts extends Context.Service<Artifacts, {
  readonly worker: string
  readonly helm: string
  readonly kustomize: string
  readonly stdlib: ReadonlyMap<string, string>
}>()("akuapkg/host/Artifacts") {}
