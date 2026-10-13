# 01-hello-webapp

A chart declared as a dependency and called through its typed alias.

| File | Purpose |
|---|---|
| `akua.toml` | declares `nginx = { path = "./vendor/nginx" }` |
| `akua.lock` | pins the chart directory's digest |
| `package.k` | the `Input` schema and one `nginx.template(...)` call |
| `inputs.yaml` | sample inputs |
| `vendor/nginx/` | a small nginx chart |

```sh
akuapkg render --out ./out
```

This writes `000-deployment-hello.yaml` and `001-service-hello.yaml`, the
same as the committed `rendered/`.

`import charts.nginx` gives a module with a `template` function and a
`TemplateOpts` schema (`values`, `release`, `namespace`). This chart has no
`values.schema.json`, so `values` is an open map; for a chart that has one,
`charts.<name>.Values` is a closed schema generated from it (see
[package-format.md](../../docs/package-format.md#helm-charts)).

Because the chart is a declared dependency, the example also renders under
`--strict`:

```sh
akuapkg render --strict --out ./out
```

To use a registry instead of the local copy, replace the dependency, for
example with `akuapkg add nginx --oci oci://registry-1.docker.io/bitnamicharts/nginx --version 18.2.0 --force`.
