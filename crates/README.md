# crates

The parts of akuapkg that run inside its WebAssembly sandbox, and the
sandbox itself. You do not need them to use `akua` or `akuapkg`; the release
binaries embed all of them, precompiled for your machine.

| Crate                   | What it is                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `akua-render-worker`    | Evaluates a Package's KCL. Rust compiled to `wasm32-wasip1`.                                                    |
| `akua-core`             | The KCL engine bindings, `akua.toml`/`akua.lock` parsers and the `akua.*` KCL standard library the worker uses. |
| `helm-engine-wasm`      | Helm's template engine, Go compiled to `wasip1`, without Kubernetes client code.                                |
| `kustomize-engine-wasm` | Kustomize, Go compiled to `wasip1`.                                                                             |
| `wasm-sandbox`          | The Wasmtime addon the host runs every module in: memory caps, CPU fuel, a fixed clock, no network.             |

Build them with Bazel: [docs/building.md](../docs/building.md).
How they fit together: [docs/architecture.md](../docs/architecture.md).
