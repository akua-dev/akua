# Examples

Runnable Packages, each in its own directory. Every example in the following table renders
with akuapkg v0.13.0, and those with a `rendered/` directory reproduce it
byte for byte.

| # | Directory | Shows |
|---|---|---|
| 00 | [00-helm-hello](00-helm-hello/) | the smallest Helm call: `helm.template` on a chart inside the Package |
| 01 | [01-hello-webapp](01-hello-webapp/) | a chart declared in `akua.toml` and called as `charts.nginx` |
| 08 | [08-pkg-compose](08-pkg-compose/) | one Package rendering another twice with `pkg.render` |
| 09 | [09-kustomize-hello](09-kustomize-hello/) | the smallest `kustomize.build` call |
| 10 | [10-kcl-ecosystem](10-kcl-ecosystem/) | a typed Deployment from the `kcl-lang/k8s` Kubernetes schemas |
| 11 | [11-install-as-package](11-install-as-package/) | composing an upstream Package: overlay, filter, extras |
| 12 | [12-vendor-offline](12-vendor-offline/) | rendering from `.akua/vendor/` with no network or source |
| 13 | [13-subpackage-helm](13-subpackage-helm/) | a sub-package with its own Helm chart dependency |
| 14 | [14-helm-repo-dep](14-helm-repo-dep/) | a chart from a classic HTTPS Helm repository |
| 15 | [15-yaml-output](15-yaml-output/) | the exact YAML `akuapkg render` writes |
| 16 | [16-typed-crds](16-typed-crds/) | typed by default: Kubernetes 1.35 types plus a CRD from a git tag |

Start with 16 for the typed workflow, or 01 for a Helm chart.

## Running an example

From the example's directory:

```sh
akuapkg render --out ./out
diff -r out rendered
```

`render` picks up `inputs.yaml` or `inputs.example.yaml` by itself. Examples
with remote dependencies (10, 14, 16) fetch them on the first render and
use the cache afterwards; 16 needs the network only for the `k8s` module,
because its CRD schemas are committed under `.akua/crds/`.

## Related topics

- [Typed resources](../docs/typed-resources.md)
- [Package format](../docs/package-format.md)
- [`akua.toml` and `akua.lock`](../docs/lockfile-format.md)
