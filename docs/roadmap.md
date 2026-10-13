# Roadmap

What akuapkg does today, what is open, and what it will not do. Release
notes for each version are in the [changelog](../CHANGELOG.md).

## Shipped

As of v0.13.0:

- **Typed packages.** KCL Packages with a typed `Input` schema, exported as
  JSON Schema or OpenAPI with `@ui` hints.
- **Typed by default.** `akuapkg init` pins the Kubernetes 1.35 schemas;
  `--k8s` and `add k8s --k8s` switch versions. CRDs from URLs, git, OCI,
  Helm charts and local directories become typed schemas under
  `.akua/crds/` ([typed-resources.md](typed-resources.md)).
- **Embedded engines.** Helm v4 and Kustomize compiled to WebAssembly, called
  through typed dependency aliases, with chart values typed from
  `values.schema.json`.
- **The sandbox.** Every render in Wasmtime with memory caps, shared CPU
  budgets, a 64 MiB engine result cap, a fixed clock and no filesystem,
  network, environment or process access
  ([security-model.md](security-model.md)).
- **Dependencies.** OCI, git, HTTPS Helm repositories, URLs and local paths,
  pinned by digest in `akua.lock`; `lock --check` and `verify` for CI;
  vendoring and `--offline` renders.
- **Supply chain.** Keyed cosign verification of OCI dependencies (opt-in
  through `[signing].cosign_public_key`, with strict signing on by default
  when a key is set); cosign signing and SLSA v1 attestation on `publish`;
  offline `pack`, `sign`, `verify --tarball` and `push --sig` for air-gapped
  transfers.
- **Author loop.** `check`, `lint`, `fmt`, `test` with golden snapshots,
  `diff`, `inspect`, `repl`.
- **One release.** `akuapkg` and the `akua` CLI (which embeds it as
  `akua pkg`) ship together from this repository, built with Bazel.

## Open

Not scheduled; listed so you know they are missing:

- Keyless cosign verification (Fulcio and Rekor), and checking Helm `.prov`
  files.
- Verifying attestations of transitive dependencies.
- Offline attestation (`.att` sidecars) alongside offline signing.
- A typed `.Capabilities` for Helm charts that follows the Package's
  pinned Kubernetes version.
- A file-watching development loop.
- Policy evaluation of rendered output. Until then, use your cluster's
  admission control.

## Non-goals

- **Shell-out in the render path.** If an engine cannot run in the sandbox,
  the feature does not ship. There is no `--unsafe-host` flag.
- **Cluster-side controllers.** akuapkg renders; Argo CD, Flux and `kubectl`
  apply.
- **Rendering inside the cluster.** Render in CI and commit what runs.
- **A central package catalog.** Maintainers publish to their own
  registries.
- **Deploy targets other than Kubernetes.**
