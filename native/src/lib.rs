//! A generic Wasmtime sandbox for JS, through N-API. It knows nothing about
//! the modules it runs: callers decide what to instantiate, which exports to
//! call and how to interpret the results.
//!
//! What it does own is every guarantee a guest could try to break: a memory
//! cap (a denied grow traps), fuel metering, read-only preopens, capped
//! in-memory stdio, no env and no sockets, and a wall clock fixed at the Unix
//! epoch. The monotonic clock is the host's: it paces the guest's runtime
//! (Go's scheduler and GC) and never reaches rendered output. Guest-caused
//! failures come back as tagged outcomes; a thrown JS error means a host bug.
//!
//! The addon has no compiler: it loads machine code precompiled at build time
//! (see `precompile/`). The only unsafe operation is that load,
//! `Module::deserialize`, which trusts the bytes the application embeds.

mod config;

use std::cell::RefCell;
use std::time::Duration;

use napi::bindgen_prelude::{Buffer, FnArgs, Function, FunctionRef};
use napi::{Env, Error, Result};
use napi_derive::napi;
use send_wrapper::SendWrapper;
use wasmtime::{Caller, Engine, Extern, FuncType, Linker, Module, ResourceLimiter, Store, Trap, Val, ValType};
use wasmtime_wasi::p1::{self, WasiP1Ctx};
use wasmtime_wasi::p2::pipe::{MemoryInputPipe, MemoryOutputPipe};
use rand::SeedableRng;
use rand::rngs::StdRng;
use wasmtime_wasi::{FsPerms, HostWallClock, I32Exit, WasiCtxBuilder, thread_rng};

fn host_error(context: &str, error: impl std::fmt::Display) -> Error {
  Error::from_reason(format!("{context}: {error}"))
}

/// How a guest call ended.
#[napi(discriminant = "_tag")]
pub enum Outcome {
  /// The export returned; i32/i64 results as numbers.
  Ok { values: Vec<f64> },
  /// The guest called WASI `proc_exit`.
  Exited { code: i32 },
  OutOfFuel,
  MemoryLimit,
  Trap { message: String },
}

/// Linear-memory cap that traps on a denied grow (instead of returning -1 to
/// the guest) and remembers that it did, so the outcome is `MemoryLimit`.
struct MemoryCap {
  max_bytes: usize,
  hit: bool,
}

impl ResourceLimiter for MemoryCap {
  fn memory_growing(&mut self, _current: usize, desired: usize, _maximum: Option<usize>) -> wasmtime::Result<bool> {
    if desired > self.max_bytes {
      self.hit = true;
      wasmtime::bail!("memory cap of {} bytes exceeded (requested {desired})", self.max_bytes);
    }
    Ok(true)
  }

  fn table_growing(&mut self, _current: usize, _desired: usize, _maximum: Option<usize>) -> wasmtime::Result<bool> {
    Ok(true)
  }
}

/// Wall time fixed at the Unix epoch.
struct FixedWallClock;
impl HostWallClock for FixedWallClock {
  fn resolution(&self) -> Duration {
    Duration::from_nanos(1)
  }
  fn now(&self) -> Duration {
    Duration::ZERO
  }
}

/// One Wasmtime engine for the process.
#[napi]
pub struct Sandbox {
  engine: Engine,
}

#[napi]
impl Sandbox {
  #[napi(constructor)]
  pub fn new() -> Result<Self> {
    let engine = Engine::new(&config::runtime_config()).map_err(|e| host_error("engine", e))?;
    Ok(Self { engine })
  }

  /// Load machine code produced by `precompile` for this target. Fails if it
  /// was built for another target, Wasmtime version or engine configuration.
  #[napi]
  pub fn load(&self, name: String, precompiled: Buffer) -> Result<CompiledModule> {
    // SAFETY: `precompiled` is output of `Engine::precompile_module` that the
    // application ships inside its own executable (trusted like the
    // executable itself); Wasmtime additionally checks the version, target
    // and configuration recorded in it before accepting it.
    let module = unsafe { Module::deserialize(&self.engine, &precompiled[..]) }.map_err(|e| host_error(&name, e))?;
    Ok(CompiledModule { engine: self.engine.clone(), module })
  }
}

#[napi(object)]
pub struct Preopen {
  pub host_path: String,
  pub guest_path: String,
}

/// A host function whose parameters are NUL-terminated strings in guest
/// memory. Its string result is placed in guest memory through the guest's
/// `alloc_export(len) -> ptr` export, and that pointer is returned.
#[napi(object)]
pub struct StringImport {
  pub module: String,
  pub name: String,
  pub params: u32,
  pub alloc_export: String,
}

#[napi(object)]
pub struct InstanceOptions {
  /// WASI argv.
  pub args: Vec<String>,
  pub stdin: Option<Buffer>,
  /// Mounted read-only.
  pub preopens: Vec<Preopen>,
  /// Cap on each of stdout and stderr; writes past it fail in the guest.
  pub max_output_bytes: i64,
  /// Linear-memory cap; a `memory.grow` past it traps.
  pub memory_bytes: i64,
  /// Fuel for instantiation (which can run guest code) and the calls that
  /// follow until `setFuel` refills it.
  pub fuel: i64,
  pub string_imports: Vec<StringImport>,
}

type ImportHandler = Box<dyn Fn(String, Vec<String>) -> Result<String>>;

struct State {
  wasi: WasiP1Ctx,
  cap: MemoryCap,
  /// Answers string imports. Wasmtime calls core-wasm host functions on the
  /// calling thread, which is the JS thread that owns this reference;
  /// `SendWrapper` panics instead of touching it from any other thread.
  on_import: Option<SendWrapper<ImportHandler>>,
}

#[napi]
pub struct CompiledModule {
  engine: Engine,
  module: Module,
}

#[napi]
impl CompiledModule {
  /// Link WASI and the string imports and instantiate. Nothing runs yet:
  /// call `_start` / `_initialize` / other exports through the instance.
  #[napi(ts_args_type = "options: InstanceOptions, onImport?: (name: string, args: Array<string>) => string")]
  pub fn instantiate(
    &self,
    env: Env,
    options: InstanceOptions,
    on_import: Option<Function<FnArgs<(String, Vec<String>)>, String>>,
  ) -> Result<Instance> {
    let output_cap = options.max_output_bytes.max(0) as usize;
    let stdout = MemoryOutputPipe::new(output_cap);
    let stderr = MemoryOutputPipe::new(output_cap);
    let mut wasi = WasiCtxBuilder::new();
    wasi
      .args(&options.args)
      .stdin(MemoryInputPipe::new(options.stdin.map(|b| b.to_vec()).unwrap_or_default()))
      .stdout(stdout.clone())
      .stderr(stderr.clone())
      .wall_clock(FixedWallClock)
      // Cryptographic randomness stays real: a chart that generates keys
      // (Helm's genCA, genSignedCert) must not produce the same private key
      // for everyone who renders it. Renders that draw no keys stay
      // byte-identical. The non-cryptographic stream is a seeded PRNG.
      .secure_random(thread_rng())
      .insecure_random(StdRng::seed_from_u64(0xa5a5_a5a5_a5a5_a5a5))
      .insecure_random_seed(0);
    for preopen in &options.preopens {
      wasi
        .preopened_dir(&preopen.host_path, &preopen.guest_path, FsPerms::ReadOnly)
        .map_err(|e| host_error(&format!("preopen {}", preopen.guest_path), e))?;
    }

    let on_import = match on_import {
      Some(callback) => {
        let callback: FunctionRef<FnArgs<(String, Vec<String>)>, String> = callback.create_ref()?;
        let handler: ImportHandler =
          Box::new(move |name, args| callback.borrow_back(&env)?.call((name, args).into()));
        Some(SendWrapper::new(handler))
      }
      None => None,
    };
    let state = State {
      wasi: wasi.build_p1(),
      cap: MemoryCap { max_bytes: options.memory_bytes.max(0) as usize, hit: false },
      on_import,
    };
    let mut store = Store::new(&self.engine, state);
    store.limiter(|s| &mut s.cap);
    store.set_fuel(options.fuel.max(0) as u64).map_err(|e| host_error("fuel", e))?;

    let mut linker: Linker<State> = Linker::new(&self.engine);
    p1::add_to_linker_sync(&mut linker, |s| &mut s.wasi).map_err(|e| host_error("wasi", e))?;
    for import in options.string_imports {
      define_string_import(&mut linker, &self.engine, import)?;
    }
    let instance = linker.instantiate(&mut store, &self.module).map_err(|e| host_error("instantiate", e))?;
    Ok(Instance { inner: RefCell::new(Some(Inner { store, instance, stdout, stderr })) })
  }
}

fn define_string_import(linker: &mut Linker<State>, engine: &Engine, import: StringImport) -> Result<()> {
  let ty = FuncType::new(engine, (0..import.params).map(|_| ValType::I32), [ValType::I32]);
  let StringImport { module, name, alloc_export, .. } = import;
  let label = name.clone();
  linker
    .func_new(&module, &name, ty, move |mut caller: Caller<'_, State>, params, results| {
      let memory = match caller.get_export("memory") {
        Some(Extern::Memory(memory)) => memory,
        _ => wasmtime::bail!("{label}: guest has no memory export"),
      };
      let args = params
        .iter()
        .map(|param| read_c_str(memory.data(&caller), param.unwrap_i32()))
        .collect();
      let handler = caller
        .data()
        .on_import
        .as_ref()
        .ok_or_else(|| wasmtime::format_err!("{label}: no onImport handler"))?;
      let response = handler(label.clone(), args).map_err(|e| wasmtime::format_err!("{label}: {e}"))?;

      let alloc = caller
        .get_export(&alloc_export)
        .and_then(Extern::into_func)
        .ok_or_else(|| wasmtime::format_err!("{label}: guest has no {alloc_export} export"))?
        .typed::<u32, i32>(&caller)?;
      let dest = alloc.call(&mut caller, u32::try_from(response.len() + 1)?)?;
      let start = usize::try_from(dest)?;
      let slot = memory
        .data_mut(&mut caller)
        .get_mut(start..start + response.len() + 1)
        .ok_or_else(|| wasmtime::format_err!("{label}: {alloc_export} returned an out-of-bounds pointer"))?;
      slot[..response.len()].copy_from_slice(response.as_bytes());
      slot[response.len()] = 0;
      results[0] = Val::I32(dest);
      Ok(())
    })
    .map_err(|e| host_error(&name, e))?;
  Ok(())
}

/// A NUL-terminated string at `ptr`; empty for null or unterminated input.
fn read_c_str(memory: &[u8], ptr: i32) -> String {
  usize::try_from(ptr)
    .ok()
    .filter(|p| *p > 0)
    .and_then(|start| memory.get(start..))
    .and_then(|tail| tail.iter().position(|b| *b == 0).map(|end| &tail[..end]))
    .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
    .unwrap_or_default()
}

struct Inner {
  store: Store<State>,
  instance: wasmtime::Instance,
  stdout: MemoryOutputPipe,
  stderr: MemoryOutputPipe,
}

/// An instantiated module with its own store. Calls are not re-entrant: a
/// call into this instance from inside one of its own imports is an error.
#[napi]
pub struct Instance {
  inner: RefCell<Option<Inner>>,
}

impl Instance {
  fn with<T>(&self, f: impl FnOnce(&mut Inner) -> Result<T>) -> Result<T> {
    let mut inner = self.inner.try_borrow_mut().map_err(|_| host_error("instance", "re-entrant call"))?;
    f(inner.as_mut().ok_or_else(|| host_error("instance", "disposed"))?)
  }
}

#[napi]
impl Instance {
  /// Release the store and its WASI handles immediately. Safe to call again;
  /// disposal from inside this instance's own import is a re-entrant error.
  #[napi]
  pub fn dispose(&self) -> Result<()> {
    let mut inner = self.inner.try_borrow_mut().map_err(|_| host_error("instance", "re-entrant call"))?;
    inner.take();
    Ok(())
  }

  /// Call an export with i32/i64 arguments.
  #[napi]
  pub fn call(&self, name: String, args: Vec<f64>) -> Result<Outcome> {
    self.with(|inner| {
      let func = inner
        .instance
        .get_func(&mut inner.store, &name)
        .ok_or_else(|| host_error(&name, "no such exported function"))?;
      let ty = func.ty(&inner.store);
      if args.len() != ty.params().len() {
        return Err(host_error(&name, format!("expected {} arguments", ty.params().len())));
      }
      let params = ty
        .params()
        .zip(&args)
        .map(|(ty, arg)| match ty {
          ValType::I32 => Ok(Val::I32(*arg as i32)),
          ValType::I64 => Ok(Val::I64(*arg as i64)),
          other => Err(host_error(&name, format!("unsupported parameter type {other}"))),
        })
        .collect::<Result<Vec<_>>>()?;
      let mut results = vec![Val::I32(0); ty.results().len()];
      Ok(match func.call(&mut inner.store, &params, &mut results) {
        Ok(()) => Outcome::Ok {
          values: results
            .iter()
            .map(|v| match v {
              Val::I32(n) => *n as f64,
              Val::I64(n) => *n as f64,
              _ => f64::NAN,
            })
            .collect(),
        },
        Err(error) => {
          if let Some(I32Exit(code)) = error.downcast_ref::<I32Exit>() {
            Outcome::Exited { code: *code }
          } else if inner.store.data().cap.hit {
            Outcome::MemoryLimit
          } else if let Some(Trap::OutOfFuel) = error.downcast_ref::<Trap>() {
            Outcome::OutOfFuel
          } else {
            Outcome::Trap { message: format!("{error:?}") }
          }
        }
      })
    })
  }

  /// Fuel available to the following calls (roughly one unit per wasm instruction).
  #[napi]
  pub fn set_fuel(&self, fuel: i64) -> Result<()> {
    self.with(|inner| inner.store.set_fuel(fuel.max(0) as u64).map_err(|e| host_error("fuel", e)))
  }

  /// Fuel left after the calls so far: what a caller spending one budget across calls charges.
  #[napi]
  pub fn fuel(&self) -> Result<i64> {
    self.with(|inner| {
      let fuel = inner.store.get_fuel().map_err(|e| host_error("fuel", e))?;
      Ok(i64::try_from(fuel).unwrap_or(i64::MAX))
    })
  }

  /// Copy `len` bytes out of the guest's exported memory.
  #[napi]
  pub fn read(&self, ptr: u32, len: u32) -> Result<Buffer> {
    self.with(|inner| {
      let memory = inner
        .instance
        .get_memory(&mut inner.store, "memory")
        .ok_or_else(|| host_error("read", "no memory export"))?;
      let mut out = vec![0; len as usize];
      memory.read(&inner.store, ptr as usize, &mut out).map_err(|e| host_error("read", e))?;
      Ok(out.into())
    })
  }

  /// Copy `data` into the guest's exported memory at `ptr`.
  #[napi]
  pub fn write(&self, ptr: u32, data: Buffer) -> Result<()> {
    self.with(|inner| {
      let memory = inner
        .instance
        .get_memory(&mut inner.store, "memory")
        .ok_or_else(|| host_error("write", "no memory export"))?;
      memory.write(&mut inner.store, ptr as usize, &data).map_err(|e| host_error("write", e))
    })
  }

  #[napi]
  pub fn stdout(&self) -> Result<Buffer> {
    self.with(|inner| Ok(inner.stdout.contents().to_vec().into()))
  }

  #[napi]
  pub fn stderr(&self) -> Result<Buffer> {
    self.with(|inner| Ok(inner.stderr.contents().to_vec().into()))
  }
}
