# Embedded engines

akuapkg ships its KCL runtime and its Helm and Kustomize engines inside the
executable. No command looks up `kcl`, `helm`, `kustomize` or `kubectl` on
`$PATH`, and there is no fallback to them.

## Inventory

| Engine | Version | Built from | Called from KCL as |
|---|---|---|---|
| KCL | [kcl-lang/kcl](https://github.com/kcl-lang/kcl), pinned with the patches in `third_party/kcl/patches/` | Rust, compiled to `wasm32-wasip1` as the render worker | the Package itself |
| Helm | v4.1.4, with a patch that removes client-go ([crates/helm-engine-wasm](../crates/helm-engine-wasm/)) | Go, compiled to `wasip1` | `charts.<name>.template(...)`, or `helm.template(...)` |
| Kustomize | `sigs.k8s.io/kustomize/api` v0.21.3 ([crates/kustomize-engine-wasm](../crates/kustomize-engine-wasm/)) | Go, compiled to `wasip1` | `kustomize.build(...)` |

Each akuapkg release pins exactly these versions, so a Package renders the
same way on every machine that runs that release. `akuapkg version` prints
the release.

## How an engine call works

1. `package.k` calls, for example, `webapp.template(...)` on a chart
   dependency.
2. The KCL worker passes the call to the host through its one plugin import.
3. The host packs the chart, which it already holds in memory, into an
   archive, serializes the values as JSON and calls the Helm engine.
4. The engine renders and returns the manifests; the host parses them and
   returns them to KCL as a list of resources.

The engines are loaded on first use, so a Package that never calls Helm
never pays for loading it. An engine instance is reused across calls while
they succeed and replaced after a failure. All Helm and Kustomize calls of
one render share one CPU budget. See
[security-model.md](security-model.md) for the limits.

## Which commands use which engine

| Command | Engines |
|---|---|
| `akuapkg render` | KCL, plus Helm or Kustomize when the Package calls them |
| `akuapkg check` | KCL (parse, imports, lockfile) |
| `akuapkg lint` | KCL parser |
| `akuapkg fmt` | KCL formatter |
| `akuapkg test` | KCL, plus every engine a golden render uses |
| `akuapkg export`, `akuapkg inspect` | KCL |
| `akuapkg repl` | KCL evaluator |

## Helm differences

Inside akuapkg, Helm renders like `helm template` with these differences:

- There is no cluster: `lookup` returns an empty result, and
  `.Capabilities` reports the engine's built-in defaults (Kubernetes
  v1.35.0 in akuapkg 0.13.0).
- Values arrive as JSON, so a string from KCL stays a string even when it
  looks like a YAML 1.1 boolean.
- `NOTES.txt` is dropped; it is prose, not a manifest.
- The chart's `values.schema.json` is not evaluated. akuapkg turns it into a
  KCL `Values` schema instead, checked when you write the values.
- Plugins, post-renderers and hooks are not run; hook resources are
  rendered like any other template.
- A chart's dependencies must be inside its archive (`charts/`); the engine
  never downloads them.

## Kustomize differences

- Bases and resources must be inside the Package. A remote base or remote
  resource (a URL or git reference) fails the render: the engine has no
  network and no `git`.
- Plugins, KRM functions and the `helmCharts` generator are not available.

## Related topics

- [Architecture](architecture.md)
- [Package format](package-format.md): calling charts and overlays from KCL
- [Security model](security-model.md)
