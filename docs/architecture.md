# Architecture

akuapkg is one executable that turns a typed Package into Kubernetes
manifests. There is no service, control plane or cluster connection: every
command works on files and on the dependencies `akua.toml` names.

## The pipeline

```text
author                       akuapkg                           consume
------                       -------                           -------
package.k   (KCL)      -->   resolve deps (host)          -->  raw YAML in ./deploy
akua.toml   (deps)           render (sandbox):                 applied by Argo CD,
akua.lock   (digests)          KCL worker                      Flux, kubectl, ...
inputs.yaml                    + Helm engine
.akua/crds  (CRD types)        + Kustomize engine         -->  OCI artifact
                             publish (host)                    (cosign, SLSA v1)
```

1. **Resolve.** The host reads `akua.toml` and `akua.lock`, fetches or reuses
   each dependency (OCI registries, git, HTTPS Helm repositories, URLs, local
   paths), checks it against its pinned digest, and turns it into something
   KCL can import: a `charts.<name>` module for a Helm chart, a `pkgs.<name>`
   module for another Package, the KCL module itself for a KCL dependency
   such as `k8s`, and `crds.<name>.*` schemas for a CRD source.
2. **Render.** The KCL render worker evaluates `package.k` inside the
   sandbox. Calls to `helm.template`, `kustomize.build` and `pkg.render`
   leave the worker through one host import; the host runs the Helm or
   Kustomize engine (also in the sandbox) or a nested render, and returns the
   resources.
3. **Write.** The host writes each entry of `resources` as its own YAML file,
   `NNN-<kind>-<name>.yaml`, and prints a summary with a `sha256` over the
   output.

`akuapkg export` is a different operation: it reads the Package's `Input`
schema and emits JSON Schema or OpenAPI without rendering anything.

## Components

| Path | What it is |
|---|---|
| `packages/akuapkg/` | The Bun + Effect host (`@akua-dev/sdk`): the command tree, dependency resolution, the render pipeline and the sandbox adapter |
| `crates/wasm-sandbox/` | The Wasmtime addon (napi-rs, `@akua-dev/wasm-sandbox`) and its build-time precompiler. It owns the sandbox guarantees and knows nothing about KCL or Helm |
| `crates/akua-render-worker`, `crates/akua-core` | The KCL render worker, Rust compiled to `wasm32-wasip1`, and the `akua.*` KCL standard library it embeds |
| `crates/helm-engine-wasm`, `crates/kustomize-engine-wasm` | Helm v4.1.4 and Kustomize api v0.21.3, wrapped in small Go programs compiled to `wasip1` |
| `packages/cli/` | The `akua` CLI. Its `akua pkg` command runs this host in-process |

Bazel builds everything from source, precompiles each wasm module to machine
code for every release target, and embeds the modules and the addon in the
executable. See [building.md](building.md).

## One host, three ways to run it

- **`akuapkg`**, the standalone executable.
- **`akua pkg`**: the `akua` CLI embeds the same host, so both print the same
  output and error codes.
- **A child process** from a long-lived service: `@akua-dev/sdk/process`
  runs the `akuapkg` executable with a wall-clock deadline, so CPU, memory
  and any host-side bug stay in the child. See [sdk.md](sdk.md).

## Determinism

The same Package, inputs, `akua.lock` and akuapkg version produce
byte-identical output. Dependencies are pinned by digest, the sandbox's wall
clock is fixed at the Unix epoch, non-cryptographic randomness is seeded, and
output is serialized in a stable order. One deliberate exception: Helm's
random functions (`randAlphaNum` and the other `rand*` functions, `genCA`,
`genSignedCert`, `genPrivateKey`) draw real cryptographic randomness,
because a fixed seed would give every user of a chart the same private key.
Renders that use none of them stay byte-identical; a chart that does, such
as podinfo with its test hooks ([examples/14](../examples/14-helm-repo-dep/)),
differs on every render.

## What akuapkg is not

- **Not a reconciler.** Argo CD, Flux and `kubectl` apply what akuapkg
  renders.
- **Not a control plane.** It runs no controllers and installs nothing in a
  cluster.
- **Not a package catalog.** Packages, charts and CRDs come from the
  registries and repositories their authors publish to.

## Related topics

- [Security model](security-model.md): the sandbox and its limits
- [Embedded engines](embedded-engines.md): the KCL, Helm and Kustomize engines
- [Package format](package-format.md) and [lockfile format](lockfile-format.md)
- [CLI contract](cli-contract.md): output, errors and exit codes
