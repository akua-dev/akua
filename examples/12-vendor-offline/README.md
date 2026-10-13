# 12-vendor-offline

Renders with no network, no credentials and no copy of the dependency's
source: the bytes come from `.akua/vendor/upstream/`, which is committed.

| File | Purpose |
|---|---|
| `akua.toml` | declares `upstream = { path = "./upstream-chart" }` |
| `akua.lock` | pins the vendored tree's digest |
| `.akua/vendor/upstream/` | the vendored chart |
| `package.k` | renders the chart at `.akua/vendor/upstream` |

`upstream-chart/` is deliberately absent: in practice it would be a
registry or private repository the render host cannot reach.

```sh
akuapkg render --out ./out    # works without upstream-chart/
akuapkg vendor check          # re-hashes the vendor tree against akua.lock
akuapkg vendor list           # what is vendored, including orphaned trees
```

With the source available, `akuapkg vendor add upstream` copies it into
`.akua/vendor/upstream/` and pins it. The resolver prefers a vendored copy
for every dependency kind (path, OCI, git, Helm repository), so with all
dependencies vendored, `akuapkg render --offline` needs no network.
`vendor add` takes one dependency at a time, and does not vendor that
dependency's own dependencies. A `path` that leaves the workspace fails with
`E_PATH_ESCAPE`.
