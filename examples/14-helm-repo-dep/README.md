# 14-helm-repo-dep

A chart from a classic HTTPS Helm repository (an `index.yaml`, not OCI):
podinfo 6.12.0 from `https://stefanprodan.github.io/podinfo`.

```toml
[dependencies.podinfo]
repo = "https://stefanprodan.github.io/podinfo"
chart = "podinfo"
version = "6.12.0"
```

`akua.lock` pins the chart archive's `sha256`. The first render downloads
the archive and checks it against that digest; later renders use the cache.

```sh
akuapkg render --out ./out
```

This writes five manifests. podinfo ships no `values.schema.json`, so its
values are an open map here. Its test-hook Pods get names from Helm's
`randAlphaNum`, which uses real randomness, so they differ on every render;
that is why this example has no committed `rendered/`. The same dependency from the command line:

```sh
akuapkg add podinfo --repo https://stefanprodan.github.io/podinfo --chart podinfo --version 6.12.0
```

`version` can also be a semver requirement such as `">=6.0, <7"`; the
highest matching version is locked.
