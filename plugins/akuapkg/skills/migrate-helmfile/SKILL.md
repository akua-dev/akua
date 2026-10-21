---
name: migrate-helmfile
description: Convert an existing helmfile.yaml into a typed akuapkg Package written in KCL. Use when migrating from Helmfile, consolidating several Helm releases into one Package, replacing Helmfile's templated values with a typed input schema, or moving a platform repository from helmfile apply to rendering in CI.
license: Apache-2.0
---

# Migrate from Helmfile

Each Helmfile release becomes a chart dependency and one `template` call;
templated values become fields of a typed `Input` schema.

## Steps

1. Scaffold: `akuapkg init PACKAGE_NAME` and `cd` into it.

2. Inventory `helmfile.yaml`: for each release note `chart`, `version`,
   `namespace` and `values`, and every `{{ .Values.X }}` or
   `{{ requiredEnv ... }}` expression.

3. Add every chart as a dependency:

   ```sh
   # repositories: entries with an HTTPS URL
   akuapkg add cnpg --repo https://cloudnative-pg.github.io/charts --chart cloudnative-pg --version 0.22.1
   # oci:// charts
   akuapkg add traefik --oci oci://ghcr.io/traefik/helm/traefik --version 37.1.1
   # local chart directories inside the repository
   akuapkg add webapp --path ./charts/webapp
   ```

4. Turn every templated value into an `Input` field. Values that came from
   environment variables become inputs too: a render cannot read the
   environment.

   ```kcl
   schema Input:
       appName: str
       hostname: str
       replicas: int = 3
   ```

5. Write one call per release, with the release name and namespace:

   ```kcl
   _cnpg = cnpg.template(cnpg.TemplateOpts {
       values = cnpg.Values {}
       release = "cnpg"
       namespace = "cnpg-system"
   })

   _webapp = webapp.template(webapp.TemplateOpts {
       values = {replicaCount = input.replicas, ingress.hostname = input.hostname}
       release = "webapp"
       namespace = "apps"
   })

   resources = [*_cnpg, *_webapp]
   ```

   When a chart ships a `values.schema.json`, use `<chart>.Values {...}` so
   values are checked.

6. Move each environment's values into an inputs file
   (`inputs.dev.yaml`, `inputs.prod.yaml`) and compare with Helmfile's
   output before switching:

   ```sh
   helmfile template > /tmp/helmfile.yaml
   akuapkg render --inputs inputs.prod.yaml --stdout > /tmp/akuapkg.yaml
   ```

   Differences in key order and quoting are expected; check that the same
   resources and fields appear.

## What does not carry over

- `hooks`, `needs` ordering and `helmfile apply`: akuapkg renders; apply
  with Argo CD, Flux or `kubectl`.
- `exec`, `readFile`, `requiredEnv` and other Go-template functions that
  touch the host: replace them with inputs.
- Kustomize or remote values files: copy them into the Package.

## References

- [docs/package-format.md](../../../../docs/package-format.md)
- [docs/typed-resources.md](../../../../docs/typed-resources.md)
