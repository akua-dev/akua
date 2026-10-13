# helm-engine-wasm

The Helm template engine akuapkg embeds: a small Go program (`go-src/`)
around `helm.sh/helm/v4/pkg/engine.Render`, compiled to `wasip1` and run by
akuapkg's host inside Wasmtime. No `helm` binary is involved.

Bazel builds it as `//bazel:helm_engine_wasm`: it downloads Helm v4.1.4
(checksum-pinned in `bazel/source_dependencies.bzl`), applies
[`fork/helm-v4.1.4.patch`](fork/README.md), vendors the Go modules pinned by
`go-src/go.sum` and compiles `helm-engine.wasm`. The build then precompiles it
to machine code for every release target and embeds it in the `akuapkg`
and `akua` executables.

## ABI

The module is a Go `wasip1` reactor. The host calls `_initialize` once, then
for each render:

| Export | Purpose |
|---|---|
| `helm_malloc(size) -> ptr` | allocate the input buffer |
| `helm_render(ptr, len) -> ptr` | render; returns a NUL-terminated JSON result |
| `helm_result_len(ptr) -> len` | length of that result |
| `helm_free(ptr)` | free a buffer |

Input:

```json
{
  "chart_tar_gz_b64": "<base64 of the chart archive>",
  "values_yaml": "<values, serialized as JSON>",
  "release": { "name": "demo", "namespace": "default", "revision": 1, "service": "Helm" }
}
```

The host always sends values as JSON (valid YAML with every string quoted),
because the engine parses them as YAML 1.1. Output:

```json
{ "manifests": { "mychart/templates/cm.yaml": "<rendered yaml>" }, "error": "" }
```

The engine processes subchart conditions, tags and import-values like
`helm install`, then renders. It does no I/O: the chart arrives as an
in-memory archive, and it runs without preopened directories, environment,
network or a Kubernetes client. See
[docs/security-model.md](../../docs/security-model.md).
