# 11-install-as-package

Installs a third-party Package with local changes, without forking it: the
install renders the upstream Package, labels every resource with the
tenant, drops one kind and adds a ConfigMap.

| File | Purpose |
|---|---|
| `upstream/` | the upstream Package: Deployment, Service, PodDisruptionBudget |
| `akua.toml` | declares `upstream = { path = "./upstream" }` |
| `package.k` | the install |
| `inputs.example.yaml` | tenant, app name, replicas |

```sh
akuapkg render --out ./out
```

This writes a Deployment, a Service and a ConfigMap; the
PodDisruptionBudget is filtered out.

```kcl
import pkgs.upstream as upstream

_up = upstream.render(upstream.Input {appName = input.app, replicas = input.replicas})
_patched = [r | {metadata.labels = {"install.cnap.tech/tenant" = input.tenant}} for r in _up]
_filtered = [r for r in _patched if r.kind != "PodDisruptionBudget"]
```

`import pkgs.upstream` exposes the upstream's own `Input` schema, so a
misspelled or mistyped input is a compile error at the call site.
