---
name: new-package
description: Scaffold a new akuapkg Package in KCL, typed against a Kubernetes version and any CRDs it uses, optionally wrapping Helm charts. Use when the user wants to start a new Kubernetes package, package an application, replace a hand-written Helm chart or YAML with typed KCL, or add typed Custom Resources such as cert-manager Certificates or Prometheus ServiceMonitors.
license: Apache-2.0
---

# Scaffold a typed Package

## Steps

1. Scaffold. The Package is typed against Kubernetes 1.35 from the start:

   ```sh
   akuapkg init my-app
   cd my-app
   ```

   For an older cluster, pass the oldest Kubernetes minor you must support:
   `akuapkg init my-app --k8s 1.33`, then `akuapkg lock`.

2. Add a CRD dependency for every Custom Resource kind you will emit. Pick
   the source the project publishes:

   ```sh
   akuapkg add cert-manager --url https://github.com/cert-manager/cert-manager/releases/download/v1.16.0/cert-manager.crds.yaml
   akuapkg add prometheus --git https://github.com/prometheus-operator/prometheus-operator --tag v0.80.0 --crds example/prometheus-operator-crd
   ```

   `add` prints the import path of each generated module, for example
   `import crds.cert_manager.cert_manager_io.v1 (Certificate, ...)`.

3. Add Helm charts the Package wraps:

   ```sh
   akuapkg add traefik --oci oci://ghcr.io/traefik/helm/traefik --version 37.1.1
   ```

4. Write `package.k`: a `schema Input` with defaults and `check:` rules,
   `input: Input = ctx.input()`, and `resources = [...]` built from typed
   schemas (`corev1.ConfigMap {...}`, `certmanager.Certificate {...}`) and
   chart calls (`traefik.template(traefik.TemplateOpts {...})`). Prefer
   typed schemas over plain dicts: a dict is not checked.

5. Put sample inputs in `inputs.example.yaml`, then check and render:

   ```sh
   akuapkg check
   akuapkg render --inputs inputs.example.yaml
   ```

6. Fix every `E_RENDER_KCL` error at the reported `package.k:LINE:COL`.
   Errors such as `Cannot add member 'x' to schema 'Y', did you mean ...`
   name the fix.

7. Commit `akua.toml`, `akua.lock`, `package.k`, `inputs.example.yaml` and
   `.akua/crds/`. Do not commit `deploy/` unless the repository tracks
   rendered output.

## Done when

- `akuapkg check` and `akuapkg lock --check` pass;
- `akuapkg render` writes the expected files under `./deploy`;
- every emitted resource comes from a typed schema or a chart call.

## References

- [docs/typed-resources.md](../../docs/typed-resources.md)
- [docs/package-format.md](../../docs/package-format.md)
- [examples/16-typed-crds](../../examples/16-typed-crds/)
