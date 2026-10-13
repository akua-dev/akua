# Typed resources

Every Package akuapkg scaffolds is typed against one Kubernetes version, and
any CustomResourceDefinition you depend on becomes a typed schema too. A
misspelled field, a wrong type, a missing required field, a value outside an
enum or an API the pinned Kubernetes version does not serve fails
`akuapkg render`, `check` or `lint` with the file and line, instead of
failing `kubectl apply` later, or silently doing nothing.

This guide is for Package authors. It assumes you have `akuapkg` installed
(see the [README](../README.md#install)) and know what a Kubernetes manifest
looks like; no KCL experience is needed to follow it.

## Five minutes from zero

Scaffold a Package. `init` declares the Kubernetes 1.35 schemas as a
dependency, pins them in `akua.lock`, and writes a `package.k` that uses
them:

```sh
akuapkg init hello
cd hello
```

```kcl
# package.k, as scaffolded
import akua.ctx
import k8s.api.core.v1 as corev1

schema Input:
    """Public inputs for this Package."""
    appName: str
    """Application name. Used as resource-name prefix."""

    replicas: int = 2
    """Number of replicas."""

    check:
        replicas >= 1, "replicas must be at least 1"

input: Input = ctx.input()

resources = [corev1.ConfigMap {
    metadata.name = input.appName
    data.replicas = str(input.replicas)
}]
```

Add a CRD source. Here it is cert-manager's release asset; `add` downloads
it, pins its `sha256` in `akua.lock` and generates the schemas into
`.akua/crds/`:

```sh
akuapkg add cert-manager --url https://github.com/cert-manager/cert-manager/releases/download/v1.16.0/cert-manager.crds.yaml
```

```text
added cert-manager (url: https://github.com/cert-manager/cert-manager/releases/download/v1.16.0/cert-manager.crds.yaml)
  typed CRD schemas in .akua/crds/cert_manager:
    import crds.cert_manager.acme_cert_manager_io.v1  (Challenge, Order)
    import crds.cert_manager.cert_manager_io.v1  (Certificate, CertificateRequest, ClusterIssuer, Issuer)
```

Use the new schema next to the core types. Replace `package.k` with:

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

Render it:

```sh
akuapkg render --inputs inputs.example.yaml
```

```text
rendered: 2 manifest(s) → ./deploy (sha256:1c57f0b8610c340703c79f9aebdfd850c3d7a27eb4921c8b21c429a3b006e0e0)
```

`apiVersion` and `kind` are filled in by the schemas. Commit `akua.toml`,
`akua.lock` and `.akua/crds/`; [examples/16-typed-crds](../examples/16-typed-crds/)
is the same setup with the CRDs taken from a git tag.

## What a mistake looks like

Each of these renders fails with exit code 1 and error code `E_RENDER_KCL`.
The output is from akuapkg v0.13.0, rendering the Package from the
preceding section with one line changed.

A misspelled field, with a suggestion:

```text
error[E2L23]: CompileError
---> File package.k:23:13: Cannot add member 'secretname' to schema 'CertificateSpec', did you mean '["secretTemplate", "secretName"]'?
```

A value outside the CRD's enum:

```text
error[E2G22]: TypeError
---> File package.k:26:24: expected str(RSA) | str(ECDSA) | str(Ed25519), got str(ECDSB)
```

A number where Kubernetes wants a string (`data.replicas = input.replicas`):

```text
error[E2G22]: TypeError
---> File package.k:18:14: expected str, got int
```

A required field left out of a Custom Resource names the attribute, though
the location points into the generated schema:

```text
error[E_RENDER_KCL]: kcl eval failed: EvaluationError
 --> /kcl-pkgs/crds/widgets/example_com/v1/widget.k:6:1
  |  attribute 'size' of WidgetSpec is required and can't be None or Undefined
```

`akuapkg check` and `akuapkg lint` report the same errors without writing
any output.

## Two kinds of schema dependencies

| What | Dependency | Import |
|---|---|---|
| Kubernetes core types of one Kubernetes version | `k8s = { oci = "oci://ghcr.io/kcl-lang/k8s", version = "1.35" }` | `import k8s.api.apps.v1 as appsv1` |
| Custom Resources | any source plus `crds = ...` | `import crds.<name>.<group>.<version>` |

Both are ordinary `[dependencies]`: digest-pinned in `akua.lock`, resolved
on the host, mounted read-only into the render sandbox.

## Kubernetes versions

The `k8s` dependency is the KCL ecosystem's `kcl-lang/k8s` module, one tag
per Kubernetes minor release (`1.14` to `1.36` today). The default is the
oldest minor still supported upstream, `1.35`, so what renders applies to
every supported cluster.

| To | Run |
|---|---|
| Scaffold against another version | `akuapkg init my-app --k8s 1.33`, then `akuapkg lock` to pin it |
| Switch an existing Package | `akuapkg add k8s --k8s 1.36 --force` (re-locks) |
| Check that the lock matches | `akuapkg lock --check` |

A version switch type-checks the whole Package. An API the new release no
longer serves is a missing schema; a removed field is an unknown attribute.
For example, `flowcontrol.apiserver.k8s.io/v1beta3` renders with
`--k8s 1.31` and fails with `--k8s 1.32`, which stopped serving it:

```text
error[E2G22]: TypeError
---> File package.k:3:14: attribute 'FlowSchema' not found in 'module 'k8s.api.flowcontrol.v1beta3''
```

To support a range of clusters, pin the oldest version you support: newer
API servers keep serving what older ones did, until a removal you will see
when you switch.

## CRD dependencies

`crds` on a dependency turns the CustomResourceDefinitions in its source into
typed schemas. `crds = true` reads the whole source; a string names a file or
directory inside it. Every source kind works:

```toml
[dependencies]
# A release asset: one CRD manifest file, pinned by sha256.
cert-manager = { url = "https://github.com/cert-manager/cert-manager/releases/download/v1.16.0/cert-manager.crds.yaml", crds = true }
# CRD YAML in a git repository, at a tag (or `rev`), narrowed to a directory or file.
prometheus = { git = "https://github.com/prometheus-operator/prometheus-operator", tag = "v0.80.0", crds = "example/prometheus-operator-crd" }
# A Helm chart from an OCI registry: its `crds/` and `templates/`.
cnpg-crds = { oci = "oci://ghcr.io/cloudnative-pg/charts/cloudnative-pg", version = "0.22.1", crds = true }
# A Helm chart from an HTTPS repository, narrowed to `templates/`.
jetstack = { repo = "https://charts.jetstack.io", chart = "cert-manager", version = "v1.16.0", crds = "templates" }
# A local directory (read fresh on every render).
widgets = { path = "./widgets", crds = true }
```

The same from the CLI (`--url` implies `crds = true`; `--crds .` means the
whole source):

```sh
akuapkg add cert-manager --url https://github.com/cert-manager/cert-manager/releases/download/v1.16.0/cert-manager.crds.yaml
akuapkg add prometheus --git https://github.com/prometheus-operator/prometheus-operator --tag v0.80.0 --crds example/prometheus-operator-crd
akuapkg add cnpg-crds --oci oci://ghcr.io/cloudnative-pg/charts/cloudnative-pg --version 0.22.1 --crds .
akuapkg add jetstack --repo https://charts.jetstack.io --chart cert-manager --version v1.16.0 --crds templates
akuapkg add widgets --path ./widgets --crds .
```

Each `add` prints the modules it generated; with `--json` they are in the
`crds.modules` field:

```text
added prometheus (git: https://github.com/prometheus-operator/prometheus-operator)
  typed CRD schemas in .akua/crds/prometheus:
    import crds.prometheus.monitoring_coreos_com.v1  (Alertmanager, PodMonitor, Probe, Prometheus, PrometheusRule, ServiceMonitor, ThanosRuler)
    import crds.prometheus.monitoring_coreos_com.v1alpha1  (AlertmanagerConfig, PrometheusAgent, ScrapeConfig)
```

A dependency with `crds` is a CRD source only: a chart declared with `crds`
gives schemas, not `charts.<name>`. To render a chart and type its Custom
Resources, declare it twice (for example `cnpg` without `crds` and
`cnpg-crds` with it); the cache holds the chart once.

### Naming

`crds.<name>.<group>.<version>`, each segment a KCL identifier (`-` and `.`
become `_`): dependency `cert-manager`, group `cert-manager.io`, version
`v1` import as `crds.cert_manager.cert_manager_io.v1`. One schema per kind,
named after it (`Certificate`); nested objects are `<Kind><Path>`
(`CertificateSpecPrivateKey`). Every served version gets its own package, so
`v1alpha1` and `v1` of a group sit side by side; versions with
`served: false` are left out, deprecated ones say so in their docstring.

### The generated sub-package

`akuapkg add`, `lock` and `update` write the schemas to `.akua/crds/`, the
KCL package `crds`, next to `akua.toml`:

```
.akua/crds/
  kcl.mod                                   # [package] name = "crds"
  cert_manager/
    source.toml                             # dependency, source, version, crds, digest, converter
    meta/v1/object_meta.k                   # ObjectMeta
    cert_manager_io/v1/certificate.k        # schema Certificate, CertificateSpec, ...
```

Commit it. A render uses a directory while its `source.toml` matches
`akua.toml` (source, version, `crds`) and `akua.lock` (digest), and its files
match the `crds_digest` that `akua.lock` records for them: it then needs
neither the network nor the source. Otherwise (an edited schema file, or a
lock entry without that digest) the render fails with `E_CRDS_STALE`;
`akuapkg lock` regenerates it. `akuapkg lock --check` (CI)
fails with `E_CRDS_STALE` too when a directory is missing or differs from
what `lock` would write. Downloaded `url` files are cached beside the OCI,
git and Helm caches (`akuapkg cache list`, `cache clear --url`). Without
the directory, the render resolves the source (cache or network) and
generates the same schemas in memory. `path` sources and `replace` overrides are always read
fresh. `akuapkg remove` deletes the directory; `pack` / `publish` ship it.

### Conversion rules

From each served version's `openAPIV3Schema` (`spec.validation` for legacy
`v1beta1` CRDs):

| OpenAPI | KCL |
|---|---|
| `properties` | a closed `schema`; unknown attributes are errors |
| `required` | attribute without `?` |
| `nullable: true` | optional |
| `string` / `integer` / `number` / `boolean` | `str` / `int` / `float` / `bool` |
| `enum` of strings or integers | literal union (`"RSA" \| "ECDSA" \| "Ed25519"`) |
| `array` | `[T]` |
| `additionalProperties: <schema>` (map) | `{str:T}` |
| `x-kubernetes-int-or-string` | `int \| str` |
| `x-kubernetes-preserve-unknown-fields`, `x-kubernetes-embedded-resource`, `additionalProperties: true` | declared attributes plus `[...str]: any` |
| object without properties | `{str:any}` |
| `description` | docstring under the attribute |
| root `apiVersion`, `kind` | literal types with defaults: the fields are set for you |
| root `metadata` | `meta.v1.ObjectMeta` (closed; `managedFields` and `ownerReferences` untyped) |
| root `status` | left out: a Package does not write status |

Attribute names that are KCL keywords are written `$type`; names that are
not identifiers are quoted (`"x-ref"`). In config literals they are written
as usual (`type = "a"`, `"x-ref" = "r"`). Defaults, `pattern`, `format`,
length and range limits, and CEL rules are not converted: the API server
still enforces them.

### Sources and safety

Only YAML is parsed (`.yaml`, `.yml`, `.json`; multi-document files and
`kind: List` included). Files under a chart's `templates/` are read with their
`{{ ... }}` actions removed; nothing is executed. Documents that are not
`CustomResourceDefinition`s, or do not parse, are skipped; no CRD at all is
`E_CRDS_INVALID`, as are two different definitions of one kind and version
(narrow `crds`). Fetching reuses the dependency resolvers: OCI (any single
`tar` / `tar+gzip` layer is accepted for CRD sources), git (a shallow fetch,
pinned as `git:<commit>`), Helm repositories, and HTTPS URLs (pinned as the
file's `sha256:`). The output depends only on the source bytes and the
converter version, so it is deterministic.

## Known limits

- `kcl-lang/k8s` modules are not cosign-signed: without a
  `[signing].cosign_public_key`, `akuapkg verify` lists `k8s` as an unsigned
  warning (exit 0) and the digest pin in `akua.lock` is the integrity check;
  with a key (strict signing), it reports `missing-signature`.
- Generated CRD schemas carry their own `ObjectMeta`, so they need no other
  dependency. A `k8s` `ObjectMeta` value is a different schema: assign it as
  `metadata = {**meta}`, or set the fields (`metadata.name = ...`).

## Related topics

- [Why akuapkg](why.md): why typed packages instead of YAML templates
- [Package format](package-format.md): `package.k`, `Input` schemas and
  typed Helm values
- [Lockfile format](lockfile-format.md): `akua.toml` and `akua.lock`
- [examples/10-kcl-ecosystem](../examples/10-kcl-ecosystem/) and
  [examples/16-typed-crds](../examples/16-typed-crds/)
