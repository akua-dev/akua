# 00-helm-hello

The smallest Package that calls Helm. `package.k` imports `akua.helm` and
renders the chart in `./chart` (one ConfigMap template) with values built
from the typed `Input`.

```sh
akuapkg render --out ./out
```

The output, `000-configmap-hello-greeting.yaml`, is committed in
`rendered/`. The chart is rendered by the Helm engine embedded in akuapkg,
inside its sandbox; no `helm` binary is used.

`helm.template` with a path inside the Package is the low-level form, and
`akuapkg render --strict` rejects it. [01-hello-webapp](../01-hello-webapp/)
declares the chart as a dependency instead, which is the form to prefer.
