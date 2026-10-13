# example 16 - typed resources: Kubernetes types + a CRD from a git tag

> **Renders end-to-end, offline.** Every resource is a typed KCL schema:
> a misspelled field, a wrong type or a value outside an enum is a
> compile error in `package.k`, not a manifest the API server rejects.

Two dependencies give the types:

| dependency | source | import |
|---|---|---|
| `k8s` | `oci://ghcr.io/kcl-lang/k8s` at `1.35`: the core types of one Kubernetes version | `import k8s.api.apps.v1 as appsv1` |
| `cert-manager` | the `Certificate` CRD in cert-manager's repository at tag `v1.16.0` (`crds = "deploy/crds/crd-certificates.yaml"`) | `import crds.cert_manager.cert_manager_io.v1 as certmanager` |

`akuapkg add` generated the cert-manager schemas into
`.akua/crds/cert_manager/` (committed) and pinned the commit in
`akua.lock`. A render uses that directory as long as its `source.toml`
matches `akua.toml` and `akua.lock`, so it needs neither the network nor
the cert-manager repository; the `k8s` module comes from the OCI cache by
its pinned digest.

## Reproduce it

```sh
akuapkg init 16-typed-crds          # typed scaffold, k8s 1.35 pinned
cd 16-typed-crds
akuapkg add cert-manager \
  --git https://github.com/cert-manager/cert-manager --tag v1.16.0 \
  --crds deploy/crds/crd-certificates.yaml
akuapkg render --out ./rendered
```

`--crds deploy/crds` would generate every cert-manager kind (`Issuer`,
`ClusterIssuer`, `CertificateRequest`, and the ACME `Order` and
`Challenge`); this example takes one file to keep the committed tree small.

## Changing versions

- Kubernetes: `akuapkg add k8s --k8s 1.36 --force`. An API or field the new
  version no longer serves fails the next render.
- cert-manager: `akuapkg add cert-manager --git ... --tag v1.17.0 --crds ... --force`,
  or edit the tag in `akua.toml` and run `akuapkg lock`. Until then the render
  refuses the stale schemas with `E_CRDS_STALE`.

See [docs/typed-resources.md](../../docs/typed-resources.md).
