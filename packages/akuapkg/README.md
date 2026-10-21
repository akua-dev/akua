<div align="center">
  <img src="../../assets/logo.png" height="300" alt="Akuapkg" />

  <h1>Akuapkg</h1>

  <p>
    <samp>
      Typed Kubernetes packages &bull; Sandboxed Helm and Kustomize<br>
      Digest-locked dependencies &bull; One binary
    </samp>
  </p>

  <p>
    <a href="https://github.com/akua-dev/akua/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/akua-dev/akua?label=release&style=flat-square"></a>
    <a href="https://docs.akua.dev/akua/cli"><img alt="Docs" src="https://img.shields.io/badge/docs-docs.akua.dev-blue?style=flat-square"></a>
    <a href="../../LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>
  </p>
</div>

Part of [Akua's open-source tools](../../README.md).

---

akuapkg builds Kubernetes packages that are typed, rendered in a sandbox and
pinned by digest. You write a Package in [KCL](https://kcl-lang.io); it can
call existing Helm charts and Kustomize overlays, and every resource it
emits is checked against the schemas of the Kubernetes version and the CRDs
you depend on.

## Why akuapkg

- **Typed packages instead of YAML templates.** Helm values are an untyped
  tree (only about a quarter of the 300 most-starred charts on Artifact Hub
  ship a values schema) parsed as YAML 1.1, where `NO` becomes `false`.
  In akuapkg, inputs, Kubernetes resources, Custom Resources and chart
  values are schemas: a typo, a wrong type or an API your cluster version
  does not serve fails the render, with the file and line.
- **Sandboxed engines, because charts are programs.** Rendering a Helm chart
  or a Kustomize overlay can read host files, make network requests and,
  through plugins, run executables with your credentials. Advisories keep
  coming, most recently two critical Argo CD advisories in October 2026
  where a kustomization ran commands on the repo server. akuapkg runs Helm,
  Kustomize and KCL as WebAssembly in [Wasmtime](https://wasmtime.dev),
  with no filesystem, network, environment or process access, under memory
  and CPU budgets.
- **A locked supply chain.** Every dependency (OCI artifact, git tag, Helm
  repository chart, URL) is pinned by digest in `akua.lock`. With a cosign
  key configured, dependencies must be signed by it, and `akuapkg publish`
  signs and attests what you push.
- **One binary.** No `helm`, `kustomize`, `kcl` or `kubectl` on the
  machine; nothing is looked up on `$PATH`.

The evidence and the limits are in [docs/why.md](../../docs/why.md).

## Install

```sh
# The standalone akuapkg binary (macOS, Linux); installs to ~/.akuapkg/bin
curl -fsSL https://cli.akua.dev/install | sh

# Or with Homebrew
brew install akua-dev/tap/akuapkg
```

On Windows, run `irm https://cli.akua.dev/install.ps1 | iex` in PowerShell,
or download an archive from [the releases](https://github.com/akua-dev/akua/releases).

The Akua CLI (`brew install akua-dev/tap/akua`, source in [`packages/cli/`](../cli/))
embeds the same toolchain: every command in this README also works as
`akua pkg <command>`.

## Quick start

Scaffold a Package. It is typed by default: `akua.toml` declares the
Kubernetes 1.35 schemas and `akua.lock` pins them by digest.

```sh
akuapkg init hello
cd hello
```

Add a CRD dependency. `add` downloads cert-manager's CRDs, pins their
`sha256` and generates KCL schemas into `.akua/crds/`:

```sh
akuapkg add cert-manager --url https://github.com/cert-manager/cert-manager/releases/download/v1.16.0/cert-manager.crds.yaml
```

Write `package.k` with a typed Kubernetes resource and a typed Custom
Resource:

```kcl
import akua.ctx
import k8s.api.core.v1 as corev1
import crds.cert_manager.cert_manager_io.v1 as certmanager

schema Input:
    appName: str
    replicas: int = 2
    host: str = "hello.example.com"

    check:
        replicas >= 1, "replicas must be at least 1"

input: Input = ctx.input()

resources = [
    corev1.ConfigMap {
        metadata.name = input.appName
        data.replicas = str(input.replicas)
    }
    certmanager.Certificate {
        metadata.name = input.appName
        spec = {
            secretName = "${input.appName}-tls"
            dnsNames = [input.host]
            issuerRef = {name = "letsencrypt", kind = "ClusterIssuer"}
            privateKey.algorithm = "ECDSA"
        }
    }
]
```

Render it in the sandbox:

```sh
akuapkg render --inputs inputs.example.yaml
```

```text
rendered: 2 manifest(s) → ./deploy (sha256:1c57f0b8610c340703c79f9aebdfd850c3d7a27eb4921c8b21c429a3b006e0e0)
```

Now break it. Change `secretName` to `secretname`, or `"ECDSA"` to
`"ECDSB"`, and render again:

```text
error[E2L23]: CompileError
---> File package.k:23:13: Cannot add member 'secretname' to schema 'CertificateSpec', did you mean '["secretTemplate", "secretName"]'?
```

```text
error[E2G22]: TypeError
---> File package.k:26:24: expected str(RSA) | str(ECDSA) | str(Ed25519), got str(ECDSB)
```

Target another Kubernetes version with `akuapkg add k8s --k8s 1.33 --force`;
the next render type-checks the Package against it. CRDs can also come from
a git tag, an OCI artifact, a Helm chart or a local directory: see
[docs/typed-resources.md](../../docs/typed-resources.md).

Helm charts are dependencies too, called through a typed alias. When the
chart ships a `values.schema.json`, as Traefik's does, `traefik.Values` is
generated from it:

```sh
akuapkg add traefik --oci oci://ghcr.io/traefik/helm/traefik --version 37.1.1
```

```kcl
import charts.traefik

resources = traefik.template(traefik.TemplateOpts {
    values = traefik.Values {deployment.replicas = 2}
})
```

A misspelled value is then a compile error as well:

```text
error[E2L23]: CompileError
---> File package.k:4:41: Cannot add member 'replica' to schema 'ValuesDeployment', did you mean '["replicas"]'?
```

## Documentation

| | |
|---|---|
| **Start here** | [Why akuapkg](../../docs/why.md) · [Typed resources](../../docs/typed-resources.md) · [Examples](../../examples/) |
| **Authoring** | [Package format](../../docs/package-format.md) · [`akua.toml` and `akua.lock`](../../docs/lockfile-format.md) · [Agent usage and skills](../../docs/agent-usage.md) |
| **Reference** | [Commands](https://docs.akua.dev/akua/cli) · [Error codes](https://docs.akua.dev/akua/errors) · [CLI contract](../../docs/cli-contract.md) · [SDK](../../docs/sdk.md) |
| **Internals** | [Security model](../../docs/security-model.md) · [Architecture](../../docs/architecture.md) · [Embedded engines](../../docs/embedded-engines.md) · [Debugging](../../docs/debugging.md) |
| **Project** | [Roadmap](../../docs/roadmap.md) · [Building](../../docs/building.md) · [Releasing](../../docs/releasing.md) · [Changelog](../../CHANGELOG.md) |

## Status

Alpha. The Package format, the JSON output and the error and exit codes are
stable enough to build on; interfaces can still change before 1.0.
`akuapkg --help` is the authoritative command list.

## Security

Threat model and guarantees: [docs/security-model.md](../../docs/security-model.md).
Report vulnerabilities privately as described in [SECURITY.md](../../SECURITY.md).

## Contributing

Issues are welcome: bug reports, reproductions, root-cause analysis and
design feedback. External code pull requests are not accepted yet:
development happens in Akua's internal monorepo, the source of truth that
this repository projects; a reviewed import path for pull requests may come
later. See [CONTRIBUTING.md](../../CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

## License

[Apache-2.0](../../LICENSE).
