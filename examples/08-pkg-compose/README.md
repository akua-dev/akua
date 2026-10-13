# 08-pkg-compose

An outer Package renders an inner one twice, with different inputs, and
combines the results.

| File | Purpose |
|---|---|
| `akua.toml` | declares `shared = { path = "./shared" }` |
| `package.k` | calls `pkg.render(pkg.Render {package = "shared", inputs = ...})` twice |
| `shared/` | the inner Package: one ConfigMap from `name` and `payload` |
| `inputs.example.yaml` | inputs for both components |

```sh
akuapkg render --out ./out
```

This writes `000-configmap-frontend.yaml` and `001-configmap-backend.yaml`.

`package` names a dependency alias, never a path. `pkg.render` returns the
inner Package's resources as a list, so the outer Package can patch or
filter them with ordinary KCL. A Package that renders itself, directly or
through others, fails with `E_RENDER_CYCLE`; nesting is capped at depth 16.
For the typed form, `pkgs.<name>.render(pkgs.<name>.Input {...})`, see
[11-install-as-package](../11-install-as-package/).
