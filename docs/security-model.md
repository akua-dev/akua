# Security model

This page describes what akuapkg guarantees when it renders a Package you do
not trust, how each guarantee is enforced, and where the guarantees end. For
the reasoning behind the design, and the Helm and Kustomize advisories it
responds to, read [why.md](why.md) first.

## Threat model

**The adversary is the Package**: the author of `package.k` and of every
chart, kustomization, CRD source and KCL module it depends on. akuapkg is
meant to render such Packages on machines that hold something worth
protecting: a developer laptop with kubeconfigs, a CI runner with deploy
credentials, a service that renders Packages for many tenants.

A render must not let the Package:

1. read files outside the Package and the dependencies `akua.toml` declares;
2. write files anywhere except the output directory the caller chose;
3. make network requests;
4. start processes or load plugins;
5. read environment variables or credentials;
6. exhaust the host's memory or CPU;
7. change its output based on when or where it runs.

Out of scope, by design:

- **What the manifests say.** akuapkg renders what the Package declares,
  including privileged pods or cluster-admin bindings. Policy and admission
  control decide what may reach a cluster.
- **Side channels** such as timing.
- **The first fetch of a dependency.** See [Supply chain](#supply-chain).

## Architecture

```text
akuapkg (Bun + Effect host)
  - reads the Package into memory, resolves dependencies, writes the output
  - Wasmtime, through a small native addon
      - KCL render worker     wasm32-wasip1, read-only copy of the Package
          | one host import: kcl_plugin_invoke_json_wasm
          v
      - host plugin dispatch  helm.template, kustomize.build, pkg.render
          v
      - Helm engine           wasm32-wasip1, no filesystem
      - Kustomize engine      wasm32-wasip1, no filesystem
```

The host is TypeScript on Bun; Wasmtime runs inside it through a
[napi-rs](https://napi.rs) addon (`native/`). The KCL runtime is compiled to
`wasm32-wasip1` as the render worker; Helm v4.1.4 and Kustomize api v0.21.3
are compiled from Go to `wasip1`. All modules are compiled to machine code at
build time and embedded in the executable, so the shipped binary contains no
compiler and loads no code from disk.

When `package.k` calls a chart or a kustomization, the worker calls its one
host import. The host looks the call up in a closed plugin registry (a
Package cannot register plugins), builds the engine's input from files it
already holds in memory, calls the engine and hands the result back to the
worker.

## What the sandbox guarantees

| Threat | Enforcement |
|---|---|
| Reading host files | The engines get no preopened directory: charts and kustomizations arrive as in-memory archives. The worker gets one read-only preopen, a private temporary copy of the Package. Before that copy is made, every path is resolved to its real path and a symlink that leaves the Package fails the render (`E_PATH_ESCAPE`). Paths a Package passes to `helm.template` or `kustomize.build` resolve inside that copy; absolute paths and `..` escapes are rejected. |
| Writing host files | Preopens are read-only. Only the host writes, and only the output directory. |
| Network | WASI preview 1 has no sockets. The guests cannot open a connection or resolve a name. |
| Processes and plugins | WASI preview 1 has no process API. Helm plugins, post-renderers and getters, and Kustomize exec, Go and container plugins and the `helmCharts` generator are not reachable. |
| Environment and credentials | The guests get an empty environment. Credentials stay in the host, which uses them only to fetch dependencies. |
| Cluster access | The Helm engine is built without a Kubernetes client, so `lookup` has no cluster to query. |
| Memory | Each sandbox has a hard linear-memory cap: 256 MiB for the worker, 2 GiB for each engine. Growing past it stops the render with `E_RENDER_BUDGET_MEMORY`. |
| Large results | Standard output and standard error are captured in memory, capped at 64 MiB each. An engine result above 64 MiB is refused before the host copies it (`E_RENDER_BUDGET_MEMORY`). |
| CPU | Wasmtime fuel, roughly one unit per instruction. The Package's own KCL gets one budget per run (a fraction of a second); all Helm and Kustomize calls of one render share a second budget of about 25 seconds, nested `pkg.render` calls included. Running out stops the render with `E_RENDER_BUDGET_DEADLINE` and exit code 6. |
| Runaway composition | Nested `pkg.render` calls are capped at depth 16 (`E_RENDER_BUDGET_DEPTH`). |
| Time and randomness | The wall clock is fixed at the Unix epoch. Non-cryptographic randomness is a seeded generator. Cryptographic randomness is real, so a chart that generates keys (`genCA`, `genSignedCert`) does not hand every user the same private key. Helm's `rand*` functions use it too. |
| A failed engine | An engine instance is reused across calls only while its calls succeed. After a trap, exhausted fuel or a denied allocation, the instance is discarded and the next call gets a fresh one. |

The guest ABI is what makes these guarantees structural. The worker and the
engines are linked against WASI preview 1 (clocks, randomness, and file
descriptors for in-memory standard streams and the read-only preopen) and,
for the worker, the one KCL plugin import. There is nothing else to call.

### Values reach Helm as JSON

The Helm engine parses values as YAML 1.1, where `NO` is `false` and `0b101`
is `5`. The host serializes values as JSON, which is valid YAML with every
string quoted, so a KCL string reaches the chart as a string.

### Deterministic output

Given the same Package, inputs, `akua.lock` and akuapkg version, a render is
byte-identical unless a chart calls one of Helm's random functions
(`randAlphaNum`, `genCA` and the like): the clock is fixed, maps are written
in a stable order and dependencies are pinned by digest. KCL itself has no file, network or
environment functions.

## Outside the sandbox: dependency resolution

The host, not the sandbox, fetches dependencies. It is the escape boundary,
so it is strict:

- **Only declared sources.** `add`, `lock`, `update`, `vendor` and `pull`
  fetch exactly what `akua.toml` or the command line names. A chart's own
  `Chart.yaml` dependencies are never fetched by the engine.
- **Pinned by digest.** Every OCI, git, Helm-repository and URL dependency is
  pinned in `akua.lock`: the blob or file `sha256`, or the git commit. A
  render or pull whose bytes do not match fails before anything is
  unpacked.
- **Bounded downloads.** OCI manifests and Helm indexes are capped at 32 MiB,
  OCI blobs and Helm chart archives at 1 GiB, CRD URL files at 64 MiB, and
  any decompressed archive at 2 GiB.
- **Strict archives.** Absolute paths, `..` segments and non-UTF-8 names
  fail the archive; symlinks, hard links and devices are skipped.
- **HTTPS.** Registries and repositories are reached over HTTPS, except
  loopback registries. A Helm repository index served over `https://` that
  points a chart download at `http://` is refused.
- **Local paths stay local.** `path` dependencies and `replace` overrides
  must stay inside the workspace. `akuapkg publish` strips every `replace`
  before it packs, so consumers never inherit a publisher's local override.
  With `AKUA_REJECT_REPLACE=1`, or when an agent runs akuapkg, a render that
  touches a `replace` fails.
- **Offline renders.** With dependencies cached or vendored under
  `.akua/vendor/`, `akuapkg render --offline` makes no network request.

## Supply chain

- **Digests always.** `akua.lock` pins every remote dependency; `akuapkg lock
  --check` and `akuapkg verify` fail when `akua.toml`, `akua.lock` and the
  generated CRD schemas disagree.
- **Signatures when you configure a key.** With `[signing].cosign_public_key`
  in `akua.toml`, `add`, `lock`, `update` and `vendor add` refuse an OCI
  dependency without a valid cosign signature from that key, and `akua.lock`
  records the key that verified it. `strict_signing` then defaults to on:
  `akuapkg verify` fails any remote dependency whose lock entry does not
  name the key. Without a key, `verify` lists unsigned dependencies as
  warnings and exits 0; integrity rests on the digest pin.
- **Publishing.** With `[signing].cosign_private_key` configured,
  `akuapkg publish` signs the pushed artifact with cosign (ECDSA P-256) and
  attaches a SLSA v1 provenance attestation. Without a key it publishes
  unsigned.
- **Limits.** Only keyed cosign signatures are supported; keyless (Fulcio and
  Rekor) is not. Git, Helm-repository and URL sources have no signing layer,
  and Helm `.prov` files are not checked. The `kcl-lang/k8s` modules are not
  signed upstream.

## What akuapkg does not protect against

- **Rendered manifests.** They are as trustworthy as the Package. Use policy
  and admission control.
- **The first fetch.** A digest pin proves you get the same bytes again, not
  that the first bytes were good. Services that render untrusted Packages
  should restrict network egress, or render only from `akua.lock` and
  vendored dependencies with `--offline`.
- **Denial of service, entirely.** Budgets bound one render. A service should
  still bound wall-clock time and concurrency: `@akua-dev/sdk/process` runs
  the `akuapkg` executable in a child process with a deadline, which can be
  wrapped in an OS sandbox.
- **The browser host.** The JavaScript host (`host-js.effect.ts`) runs the
  same modules on the JavaScript engine's own WebAssembly. It has no memory
  caps or fuel and relies on the browser's process isolation.
- **Wasmtime and the host code.** They are the trusted computing base.
  Wasmtime has had sandbox escapes
  ([CVE-2026-34971](https://www.cve.org/CVERecord?id=CVE-2026-34971));
  akuapkg pins Wasmtime 49.0.2 and updates it deliberately.

## Why there is no shell-out

Every engine runs in the sandbox, or the feature does not ship. There is no
`--unsafe-host` flag and no fallback to a `helm` or `kustomize` binary on
`$PATH`:

1. **An opt-out is not a default.** A hosted service flips a convenience
   flag once and keeps it.
2. **A subprocess inherits the host.** `helm` would run with akuapkg's user,
   environment, working directory and network. OS-level sandboxing of a
   subprocess is platform-specific and fails inside many containers.
3. **The WebAssembly engines are good enough.** The largest chart in use,
   Cilium, renders in about one second.

## Related topics

- [Why akuapkg](why.md): the problems the sandbox and the types address
- [Typed resources](typed-resources.md): Kubernetes versions and CRDs
- [Lockfile format](lockfile-format.md): `akua.toml`, `akua.lock` and signing
- [Error codes](https://docs.akua.dev/akua/errors): the budget and path errors
- [SECURITY.md](../SECURITY.md): reporting a vulnerability
