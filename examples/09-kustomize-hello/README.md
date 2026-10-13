# 09-kustomize-hello

The smallest Package that calls Kustomize: `package.k` builds `./overlay`,
which adds a `namePrefix` and a label to the ConfigMap in `./base`.

```sh
akuapkg render --out ./out
```

The output, `000-configmap-prod-hello.yaml`, is committed in `rendered/`.
Kustomize runs embedded in akuapkg, in its sandbox, on an in-memory copy of
the overlay and base. Every base must be inside the Package: remote bases
are not fetched (see [embedded-engines.md](../../docs/embedded-engines.md)).
