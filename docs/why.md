# Why akuapkg

Helm and Kustomize made Kubernetes packaging possible, and akuapkg still runs
both. It exists because of two problems they leave to the person who renders
a package:

1. **There are no types.** A Helm chart is a text template over an untyped
   values tree, and a Kustomize overlay patches YAML against a schema from
   Kubernetes 1.21. A typo, a wrong type or a field the target cluster does
   not serve is found when the API server rejects the manifest, or never.
2. **Rendering is running someone else's program.** A chart or a
   kustomization can read files, make network requests and, through plugins
   and generators, start processes, all with the authority of the machine
   that renders it: your laptop, a CI runner, a GitOps repo server.

akuapkg answers the first with typed packages and the second with a sandbox.
This page lays out the evidence for both problems, what akuapkg does about
them, and what it does not protect against.

## Templates have no types

### Values are an untyped tree

A chart's `values.yaml` is a map of anything. A chart can ship a
`values.schema.json` to validate it, but few do, and the schemas that exist
rarely reject unknown keys:

- Of the 300 Helm charts with the most stars on
  [Artifact Hub](https://artifacthub.io) (queried October 12, 2026), 25.7%
  ship a `values.schema.json`. Charts without one include
  kube-prometheus-stack, argo-cd, ingress-nginx, metrics-server, harbor,
  keycloak, longhorn and the Bitnami redis, postgresql and kafka charts.
- Of 12 widely used charts that do ship a schema, only cert-manager and
  traefik reject unknown top-level keys. Seven of the 12 (prometheus, vault,
  external-secrets, cilium, velero, cloudnative-pg and loki) set
  `additionalProperties: false` nowhere, so a misspelled key is silently
  ignored.
- Schema validation can be turned off with `--skip-schema-validation`.

### Values are parsed as YAML 1.1

Helm reads values with `sigs.k8s.io/yaml`, which follows YAML 1.1. Plain
scalars that look like booleans or numbers change type on the way in:

| You write | The chart receives |
|---|---|
| `country: NO` | `false` |
| `enabled: yes`, `on`, `y` | `true` |
| `mode: 0b101` | `5` |
| `size: 1_000` | `1000` |

Large integers have turned into scientific notation
([helm#3001](https://github.com/helm/helm/issues/3001),
[#6431](https://github.com/helm/helm/issues/6431),
[#6867](https://github.com/helm/helm/issues/6867),
[#13254](https://github.com/helm/helm/issues/13254)), file modes into the
wrong number ([#6620](https://github.com/helm/helm/issues/6620)), and the
`yes`/`no` coercion is still open
([#32504](https://github.com/helm/helm/issues/32504)).

### Structure comes from indentation

Helm templates emit text that is parsed as YAML afterwards. Whether a block
lands under the right parent depends on `nindent` and `quote` being right; a
wrong indent can still be valid YAML, under the wrong key
([helm#4562](https://github.com/helm/helm/issues/4562)). `helm template` does
not validate its output against Kubernetes schemas, and `.Capabilities`
reports a Kubernetes version derived from Helm's own build unless you pass
one.

### Kustomize patches against an old schema

Kustomize's built-in OpenAPI schema is still based on Kubernetes v1.21.2
([kustomize v5.8.2 release notes](https://github.com/kubernetes-sigs/kustomize/releases/tag/kustomize/v5.8.2)).
For Custom Resources and newer fields, a strategic merge patch replaces lists
instead of merging them unless you supply an `openapi:` file. JSON 6902 patch
paths are strings: a wrong path that happens to exist applies without an
error.

### What akuapkg does instead

A Package is a [KCL](https://kcl-lang.io) program. Everything it emits can be
an instance of a closed schema, so mistakes fail the render, with the file and
line:

- **Inputs** are a KCL `schema Input`, with types, defaults and `check:`
  rules. `akuapkg export` turns it into JSON Schema or OpenAPI.
- **Kubernetes resources** are typed against the schemas of one Kubernetes
  version. `akuapkg init` pins Kubernetes 1.35 in `akua.toml` and
  `akua.lock`; switching to another version is one command and type-checks
  the whole Package against it.
- **Custom Resources** get the same treatment: any CRD source (a URL, a git
  tag, an OCI artifact, a Helm chart, a local directory) becomes KCL schemas
  under `.akua/crds/`.
- **Helm charts** are called through a typed alias: `charts.<name>.Values`
  is generated from the chart's `values.schema.json` when it has one.
  Values travel to the Helm engine as JSON, so a KCL string stays a string.

A misspelled field on a typed resource:

```text
error[E2L23]: CompileError
---> File package.k:23:13: Cannot add member 'secretname' to schema 'CertificateSpec', did you mean '["secretTemplate", "secretName"]'?
```

A value outside a CRD's enum:

```text
error[E2G22]: TypeError
---> File package.k:26:24: expected str(RSA) | str(ECDSA) | str(Ed25519), got str(ECDSB)
```

An API the pinned Kubernetes version no longer serves
(`flowcontrol.apiserver.k8s.io/v1beta3` with Kubernetes 1.32):

```text
error[E2G22]: TypeError
---> File package.k:3:14: attribute 'FlowSchema' not found in 'module 'k8s.api.flowcontrol.v1beta3''
```

These outputs come from `akuapkg render` v0.13.0; see
[typed-resources.md](typed-resources.md) for the full guide.

Typed values from a chart schema have limits: `$ref`, `allOf`, `oneOf`,
`anyOf`, `pattern` and `format` collapse to `any`, and a chart without a
schema gets an open `Values`. The resources you write yourself, and the CRDs
you depend on, are fully typed.

## Rendering runs someone else's program

### What Helm and Kustomize can reach

Upstream Helm and Kustomize include features that read host files, make
network requests and run executables. Some are on by default, some are
behind flags; all run with the authority of the process that renders:

| Feature | Reaches | Default |
|---|---|---|
| Helm directory charts follow symlinks; `.Files.Get` returns their targets | host files | on for directory charts |
| Helm `file://` dependencies accept absolute and `../` paths | host files | on dependency update or build |
| Helm `values.schema.json` `$ref` resolved with file and HTTP loaders | host files, network | on unless `--skip-schema-validation` |
| Helm `lookup` | the live cluster, with your credentials | off in `helm template`, on with `--dry-run=server` and on install |
| Helm plugins, getters and post-renderers | process execution, your environment | when installed or requested |
| Kustomize remote bases | runs `git` with your environment and credentials | on |
| Kustomize remote file resources | network | on |
| Kustomize exec, Go and container plugins | process execution | behind `--enable-alpha-plugins` / `--enable-exec` |
| Kustomize `helmCharts` generator | runs `helm` with your environment | behind `--enable-helm` |
| Kustomize directory bases | any non-ancestor directory | on |

Upstream hardens these with flags and point fixes: `env` and `expandenv` were
removed from Helm templates, `getHostByName` moved behind `--enable-dns`,
`lookup` stopped working in `helm template`, and Kustomize puts plugins behind
alpha flags. The stream of advisories continues:

| Advisory | Component | What happened |
|---|---|---|
| [CVE-2020-11013](https://github.com/advisories/GHSA-q8q8-93cv-v6h8) | Helm | `lookup` read cluster resources the chart user did not intend to expose |
| [CVE-2023-25165](https://github.com/advisories/GHSA-pwcw-6f5g-gxf8) | Helm | `getHostByName` disclosed values through DNS lookups |
| [CVE-2022-24348](https://github.com/advisories/GHSA-63qx-x74g-jcr7) | Argo CD | path traversal through a Helm chart's values files exposed files on the repo server |
| [CVE-2023-40026](https://github.com/advisories/GHSA-6jqw-jwf5-rp8h) | Argo CD | a crafted Helm chart leaked other Helm charts from the repo server |
| [CVE-2022-24877](https://www.cve.org/CVERecord?id=CVE-2022-24877) | Flux | path traversal in a `kustomization.yaml` exposed data from the controller |
| [CVE-2021-41254](https://www.cve.org/CVERecord?id=CVE-2021-41254) | Flux | a kustomization could escalate to cluster admin in multi-tenant setups |
| [CVE-2024-25620](https://www.cve.org/CVERecord?id=CVE-2024-25620) | Helm | a chart name with a relative path wrote outside the target directory |
| [CVE-2025-32387](https://www.cve.org/CVERecord?id=CVE-2025-32387), [CVE-2025-55199](https://www.cve.org/CVERecord?id=CVE-2025-55199) | Helm | a crafted `values.schema.json` exhausted the stack or memory |
| [CVE-2025-53547](https://www.cve.org/CVERecord?id=CVE-2025-53547) | Helm | a crafted `Chart.yaml` and symlinked `Chart.lock` ran code on dependency update |
| [CVE-2026-35204](https://www.cve.org/CVERecord?id=CVE-2026-35204), [CVE-2026-35205](https://www.cve.org/CVERecord?id=CVE-2026-35205) | Helm | a plugin wrote outside the plugin directory; unsigned plugins installed despite required verification |
| [CVE-2026-35206](https://www.cve.org/CVERecord?id=CVE-2026-35206) | Helm | `helm pull --untar` wrote a chart's contents to the wrong directory |
| [GHSA-9v9p-x54c-58gc](https://github.com/argoproj/argo-cd/security/advisories/GHSA-9v9p-x54c-58gc) | Argo CD | a Kustomize remote ref ran commands in the repo server (critical, October 7, 2026) |
| [GHSA-fw5c-w8rc-j7fx](https://github.com/argoproj/argo-cd/security/advisories/GHSA-fw5c-w8rc-j7fx) | Argo CD | a Kustomize Helm config home ran commands in the repo server (critical, October 7, 2026) |

The root cause is the same in every row: the renderer can reach things a
package should never need.

### What akuapkg does instead

akuapkg compiles Helm (v4.1.4) and Kustomize (api v0.21.3) to
`wasm32-wasip1` and runs them, and the KCL runtime, inside
[Wasmtime](https://wasmtime.dev). The features listed in
[What Helm and Kustomize can reach](#what-helm-and-kustomize-can-reach) are
not switched off; they do not exist inside the sandbox:

- **No host filesystem.** The engines get no preopened directory: a chart or
  kustomization arrives as an in-memory archive the host built from the
  Package. The KCL worker sees a read-only copy of the Package. A symlink
  that points outside the Package fails the render before anything runs.
- **No network, environment or processes.** WASI preview 1 gives the guests
  clocks, randomness and in-memory standard streams, and nothing else: no
  sockets, no environment variables, no process spawning, no plugins. The
  Helm engine is built without a Kubernetes client, so `lookup` has no
  cluster to query; `NOTES.txt` is dropped; values schemas are never fetched
  or evaluated.
- **Budgets.** Each sandbox has a memory cap; the Package's KCL has a CPU
  (fuel) budget, and all Helm and Kustomize calls of one render share another
  (about 25 seconds). Running out exits 6 with `E_RENDER_BUDGET_DEADLINE`. An
  engine result larger than 64 MiB is refused before the host reads it.
- **Deterministic.** The wall clock is fixed, so the same Package, inputs,
  lockfile and akuapkg version produce byte-identical output, unless a chart
  asks Helm for randomness (`randAlphaNum`, `genCA`), which stays real.
- **Pinned inputs.** Dependencies are fetched by the host only from sources
  named in `akua.toml`, with size caps and no HTTPS downgrade, and pinned by
  digest in `akua.lock`. A render needs no network once dependencies are
  cached or vendored (`--offline`). With a cosign public key configured,
  `akua.lock` also records the key that verified each OCI dependency.

The details, with every limit and where it is enforced, are in
[security-model.md](security-model.md).

## What akuapkg does not protect against

- **The manifests themselves.** The sandbox protects the machine that
  renders. A Package can still render a privileged pod, a cluster-admin
  RoleBinding, a webhook or a Helm hook Job, and akuapkg will write it
  faithfully. Gate what reaches a cluster with policy and admission control.
- **The first fetch.** `add`, `lock`, `update` and `pull` reach the network
  for the sources `akua.toml` names, from outside the sandbox. A digest pin
  proves you get the same bytes again, not that the first bytes were good.
  Cosign verification is opt-in (a `[signing]` key) and keyed only; Helm
  `.prov` files are not checked. Services that render untrusted Packages
  should restrict egress or render from the lockfile and vendored
  dependencies with `--offline`.
- **Denial of service, entirely.** Budgets bound a render; they do not make
  it free. Run long-lived services with their own time and concurrency
  limits. The JavaScript host used for browser embedding has no memory or
  fuel caps and relies on the browser's own isolation.
- **Wasmtime and the host.** Wasmtime and akuapkg's host code are the trusted
  computing base. Wasmtime has had sandbox escapes
  ([CVE-2026-34971](https://www.cve.org/CVERecord?id=CVE-2026-34971));
  akuapkg pins Wasmtime 49.0.4 and updates it deliberately.
- **Helm semantics.** Inside the sandbox, Helm is still Helm: templates emit
  text that is parsed as YAML 1.1. akuapkg passes values as JSON, but a chart
  that writes an unquoted `yes` into its own template output still gets a
  boolean.

## Related topics

- [Typed resources](typed-resources.md): Kubernetes versions and CRDs as
  typed dependencies
- [Security model](security-model.md): the sandbox, budgets and supply chain
  in detail
- [Package format](package-format.md): writing `package.k`
- [Examples](../examples/): runnable Packages
