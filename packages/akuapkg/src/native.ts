import { Context, Effect, Layer } from "effect"
import type * as Addon from "@akua-dev/wasm-sandbox"
import { WasmLoadError } from "./errors"

/**
 * The `crates/wasm-sandbox/` Wasmtime addon (`wasm-sandbox.node`). Whoever builds the
 * executable or embeds the SDK loads the addon for its platform and provides
 * it here; the host never resolves a `.node` path itself.
 */
export class NativeSandbox extends Context.Service<NativeSandbox, Pick<typeof Addon, "Sandbox">>()(
  "akuapkg/host/NativeSandbox"
) {
  /** The addon `load` returns, loaded when the layer is built. */
  static readonly layer = (load: () => NativeSandbox["Service"]) =>
    Layer.effect(
      NativeSandbox,
      Effect.try({ try: load, catch: (cause) => new WasmLoadError({ module: "wasm-sandbox", cause }) })
    )
}
