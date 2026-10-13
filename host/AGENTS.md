# akuapkg host: agent guide

The Bun + Effect host (`@akua-dev/sdk`) runs the render pipeline: the KCL
render worker (`crates/akua-render-worker`, Rust to `wasm32-wasip1`) and the
Helm and Kustomize engines (`crates/{helm,kustomize}-engine-wasm/go-src`, Go to
`wasip1`). This file records the hosting decision and the rules that keep it
intact.

## The decision

Untrusted Packages run inside **Wasmtime**, reached through a small
**napi-rs addon** (`../native`, `@akua-dev/wasm-sandbox`). The JS engine's own
`WebAssembly` is used only where the environment already sandboxes the process
(the browser, `src/host-js.effect.ts`).

| Option | Verdict | Why |
|---|---|---|
| Bun's `WebAssembly` (JavaScriptCore) for the CLI | Rejected for untrusted input | No fuel and no hard memory cap; a JIT bug escapes straight to the user. |
| `bun:ffi` over Wasmtime's C API | Tried and deleted | Struct layouts and ownership maintained by hand; WASI callbacks run on threads without a JS realm. |
| Native Helm/Kustomize + OS sandboxing | Rejected | OS-specific mechanisms of different strength; nested sandboxing fails in containers; breaks "no shell-out". |
| napi-rs addon on the `wasmtime` crate | **Chosen** | Unsafe parts stay in safe Rust; TS types are generated; the `.node` file embeds in `bun build --compile`. |

**Modules are precompiled at build time, per target.** `native/precompile`
(Cranelift, every backend, build-time only) turns each `.wasm` into
zstd-compressed machine code for each target triple, with baseline CPU
features. The shipped addon has no compiler: it loads the machine code the
executable embeds. Engine settings live once in `native/src/config.rs`,
shared by both, because Wasmtime rejects machine code built with other
settings.

**One host, three ways to run it.** `akuapkg` is the standalone
executable; the `akua` CLI embeds the same host in-process for `akua pkg`
(`runAkuapkgWith`), so a release ships one Bun runtime. Long-lived services
that render untrusted Packages use `src/process.ts`: the executable in a child
process under an OS sandbox, with a wall-clock deadline that kills it.

## Rules

- **`native/` stays generic.** It must not know about KCL, akua, Helm, Kustomize or any module ABI. Module-specific behaviour (reactor ABI, `_start`, the KCL bridge) belongs in `src/host-native.effect.ts`. Before adding Rust, check whether it can be TS over the addon's primitives.
- **Rust changes only for a Wasmtime upgrade or a new sandbox guarantee.** Change engine settings only in `config.rs`; Bazel re-precompiles every target.
- **The addon owns the guarantees and keeps them unconditional:** a memory cap that traps and reports `MemoryLimit`, fuel per call, read-only preopens, capped in-memory stdio, no env, no sockets, a wall clock fixed at the Unix epoch, NaN canonicalization.
- **The monotonic clock and cryptographic randomness are the host's.** Go's scheduler and GC pace themselves by the monotonic clock; a stepping fake clock made large charts spin for minutes. Charts generate keys (`genCA`, `genSignedCert`); constant or seeded bytes either never terminate (prime search) or hand every user the same private key. Renders that draw no randomness stay byte-identical.
- **Guest failures are values, host bugs are exceptions.** The addon returns `Outcome` (`Ok`, `Exited`, `OutOfFuel`, `MemoryLimit`, `Trap`); the TS adapter maps them to `GuestFailure` / `EngineError` / `RenderError`. A plugin failure reaches the guest as a KCL panic (a trap on wasm): report the plugin's own error, not the trap.
- **`unsafe` is limited to `Module::deserialize`** of machine code the executable embeds. Never load machine code from a user-writable location.
- **Fuel is split:** a Package's own KCL gets `workerFuel` (fractions of a second), all engine calls of one render together `engineFuel` (about 25 seconds), nested renders included. Running out is `E_RENDER_BUDGET_DEADLINE`, exit 6.
- **Guest output is bounded before the host reads it:** an engine result over `maxOutputBytes` is `E_RENDER_BUDGET_MEMORY`. An engine instance whose call failed is discarded, never reused. Values go to engines as JSON, never YAML: the engines read YAML 1.1.
- **Output is byte-compatible with the previous release:** keys in the Package's order, Helm/Kustomize output with sorted keys and YAML 1.1 octal file modes (`src/yaml-compat.ts`), serde_yml's quoting (`toYaml`). `examples/15-yaml-output` is the golden.
- **Callbacks from Rust into JS only run on the calling thread.** Never route WASI stdio or anything Wasmtime may run on another thread through a JS callback.
- **Host-side TS outside the sandbox is an escape boundary too.** It reads files the guest named, so it resolves real paths and rejects anything outside the Package (`PathEscape`).
- **Instances are not re-entrant** (`RefCell`): calling into an `Instance` from its own import is an error by design.
- **TypeScript follows Effect conventions:** services with static layers, `Effect.fn`, `Schema` for guest-controlled data. The one `Effect.runSync` is the KCL plugin callback, which the guest calls synchronously.

## Building and verifying

Bazel builds everything from `bazel/BUILD.bazel` (see `../docs/building.md`):
the worker and engines, the addon per target (`sandbox_addon_<target>`), the
precompiled modules, and the `akuapkg_<target>` / `akua_<target>` release
executables. `bazel test //bazel:host_typecheck_test` type-checks this
package. In the Akua monorepo, `//tools/akuapkg:host_render_contract_test`
holds the goldens, determinism,
the CPU and memory budgets, plugin failures, octal modes, the Package path
boundary, and `src/process.ts`'s deadline.

`index.d.ts` in `native/` is generated by `bunx @napi-rs/cli build --dts`;
regenerate it when the addon's API changes.
