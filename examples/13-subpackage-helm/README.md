# 13-subpackage-helm

A root Package renders a sub-package that has its own Helm chart
dependency. The root passes typed inputs down; the sub-package resolves and
renders its chart from its own `akua.toml`.

| File | Purpose |
|---|---|
| `akua.toml` | declares `webserver = { path = "./deps/webserver" }` |
| `package.k` | `ws.render(ws.Input {namespace = input.namespace})` |
| `deps/webserver/` | the sub-package and its chart dependency |

```sh
akuapkg render --out ./out
```

This writes `000-deployment-web-nginx.yaml`, the same as `rendered/`.
