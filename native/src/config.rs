//! Engine settings shared by the runtime addon and the build-time
//! precompiler. Wasmtime only loads a precompiled module into an engine whose
//! settings match the ones it was compiled with, so both sides use this.

pub fn runtime_config() -> wasmtime::Config {
  let mut config = wasmtime::Config::new();
  config
    .wasm_exceptions(true)
    .consume_fuel(true)
    .relaxed_simd_deterministic(true);
  config
}
