# 10-kcl-ecosystem

A typed Deployment written against the Kubernetes schemas from
[`kcl-lang/k8s`](https://github.com/kcl-lang/modules), a KCL module published
to `oci://ghcr.io/kcl-lang/k8s`. akuapkg treats it like any other
dependency: pinned by digest in `akua.lock`, cached after the first fetch,
imported as `k8s.api.apps.v1`.

```sh
akuapkg render --out ./out
```

This writes `000-deployment-hello.yaml`. A misspelled field or a value of
the wrong type in `package.k` fails the render.

This example pins Kubernetes `1.31.2`. New Packages get the same dependency
from `akuapkg init`, at `1.35`; see
[typed-resources.md](../../docs/typed-resources.md) for switching versions
and for CRDs, and [16-typed-crds](../16-typed-crds/) for both together.
