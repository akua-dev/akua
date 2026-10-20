//! `precompile <target-triple> <level> <out.cwasm.zst> <module.wasm>`
//!
//! Compiles one module to zstd-compressed machine code for `target-triple`
//! (baseline CPU features, so it runs on any CPU of that target), with the
//! engine settings the runtime addon loads it with.

#[path = "../../src/config.rs"]
mod config;

fn main() -> wasmtime::Result<()> {
  let args: Vec<String> = std::env::args().skip(1).collect();
  let [target, level, output, input] = args.as_slice() else {
    wasmtime::bail!("usage: precompile <target-triple> <zstd-level> <out.cwasm.zst> <module.wasm>");
  };
  let mut config = config::runtime_config();
  config.cranelift_nan_canonicalization(true).target(target)?;
  let engine = wasmtime::Engine::new(&config)?;
  let code = engine.precompile_module(&std::fs::read(input)?)?;
  std::fs::write(output, zstd::encode_all(&code[..], level.parse()?)?)?;
  Ok(())
}
