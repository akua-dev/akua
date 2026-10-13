# Package format

A Package is a directory with a KCL program, `package.k`, and its manifest,
`akua.toml`. `akuapkg render` runs the program against inputs and writes the
Kubernetes resources it produces. This page specifies what `package.k`
contains; [lockfile-format.md](lockfile-format.md) covers `akua.toml` and
`akua.lock`, and [typed-resources.md](typed-resources.md) covers typing
resources against Kubernetes versions and CRDs.

```text
my-app/
  akua.toml             # name, version, dependencies
  akua.lock             # digests, written by akuapkg
  package.k             # the program
  inputs.example.yaml   # sample inputs
  .akua/crds/           # generated CRD schemas, when you depend on CRDs
```

## Anatomy

A `package.k` has three parts: imports, the `Input` schema, and a body that
assigns `resources`.

```kcl
# 1. Imports: the akua standard library and declared dependencies.
import akua.ctx
import k8s.api.apps.v1 as appsv1
import charts.traefik

# 2. The public input contract.
schema Input:
    appName: str
    replicas: int = 2

    check:
        replicas >= 1, "replicas must be at least 1"

input: Input = ctx.input()

# 3. The body: build resources, call engines, combine the results.
_proxy = traefik.template(traefik.TemplateOpts {
    values = traefik.Values {deployment.replicas = input.replicas}
    release = input.appName
})

resources = [
    *_proxy
    appsv1.Deployment {
        metadata.name = input.appName
        spec = {
            replicas = input.replicas
            selector.matchLabels.app = input.appName
            template = {
                metadata.labels.app = input.appName
                spec.containers = [{name = "app", image = "nginx:1.27"}]
            }
        }
    }
]
```

`resources` is the only output: a list of Kubernetes objects. Variables
whose names start with `_` are private and are not part of the output.

## Imports

| Import | What it is | Declared by |
|---|---|---|
| `import akua.ctx` | `ctx.input()`, the inputs passed to the render | built in |
| `import akua.helm`, `akua.kustomize`, `akua.pkg` | the engine calls | built in |
| `import charts.<name>` | a Helm chart dependency, with a typed `template` call | `akua.toml` |
| `import pkgs.<name>` | another akua Package, with a typed `render` call | `akua.toml` |
| `import crds.<name>.<group>.<version>` | schemas generated from a CRD dependency | `akua.toml` with `crds` |
| `import k8s.api.<group>.<version>` | Kubernetes core types, from the `k8s` dependency `init` declares | `akua.toml` |
| `import <name>` | any other KCL module published to OCI, such as those under `ghcr.io/kcl-lang` | `akua.toml` |

Every dependency is resolved from `akua.toml` and checked against
`akua.lock`. A Package never writes a filesystem path to reach another
Package or a remote chart; it uses the dependency's alias.

## The `Input` schema

`schema Input` is the Package's public contract: what a person, a pipeline
or an install form provides. Bind it with:

```kcl
input: Input = ctx.input()
```

The assignment validates the inputs against the schema, fills in defaults
and runs the `check:` block. A missing field, a wrong type or a failed check
stops the render.

- Types are KCL's: `str`, `int`, `float`, `bool`, lists `[T]`, maps
  `{str:T}`, literal unions such as `"startup" | "production"`, and nested
  schemas.
- A field with a default can be left out of the inputs.
- A docstring under a field becomes its `description` in the exported
  schema.
- `@ui(...)` on a field adds form hints, exported as an `x-ui` object. KCL
  does not know the decorator; akuapkg removes it before evaluation.

```kcl
schema Input:
    """Public inputs for this package."""

    @ui(order=10, group="Identity")
    appName: str
    """Application name."""

    @ui(order=30, group="Capacity", widget="slider", min=1, max=20)
    replicas: int = 3

    tier: "startup" | "production" = "startup"
```

`akuapkg export` turns the schema into JSON Schema 2020-12, or OpenAPI 3.1
with `--format openapi`, without rendering:

```json
"replicas": {
  "default": 3,
  "type": "integer",
  "x-ui": {"group": "Capacity", "max": 20, "min": 1, "order": 30, "widget": "slider"}
}
```

Inputs come from `--inputs` (YAML or JSON). Without the flag, `render` reads
`inputs.yaml`, then `inputs.example.yaml`; with neither, it renders with
no inputs, which fails when `Input` has a field without a default.

## Calling engines

### Helm charts

Declare the chart in `akua.toml` (`akuapkg add`), import it as
`charts.<name>` and call `template`:

```kcl
import charts.traefik

resources = traefik.template(traefik.TemplateOpts {
    values = traefik.Values {deployment.replicas = 2}
    release = "edge"        # default "release"
    namespace = "ingress"   # default "default"
})
```

When the chart has a `values.schema.json`, `Values` is a closed KCL schema
generated from it, and `values` must be one. `$ref`, `allOf`, `oneOf`,
`anyOf`, `pattern` and `format` become `any`. Without a schema, `values` is
an open map.

`akua.helm` is the lower-level call underneath. It takes a chart path inside
the Package, which `akuapkg render --strict` rejects:

```kcl
import akua.helm

resources = helm.template(helm.Template {
    chart = "./chart"
    values = {replicaCount = 2}
})
```

### Kustomize overlays

A kustomization is part of the Package, so it is called by path:

```kcl
import akua.kustomize

resources = kustomize.build(kustomize.Build {path = "./overlay"})
```

The overlay and every base it uses must be inside the Package.

### Other Packages

Declare the other Package in `akua.toml` and render it with its own typed
inputs, through the `pkgs` module:

```kcl
import pkgs.upstream

_base = upstream.render(upstream.Input {appName = "shop"})
```

`akua.pkg` is the lower-level form: `pkg.render(pkg.Render {package =
"upstream", inputs = {...}})`, where `package` is the dependency alias.
Nested renders share the outer render's CPU budget and are capped at depth
16. [examples/08-pkg-compose](../examples/08-pkg-compose/),
[11-install-as-package](../examples/11-install-as-package/) and
[13-subpackage-helm](../examples/13-subpackage-helm/) show composition.

### Transforming results

Every call returns a list of resources, so ordinary KCL works on it:

```kcl
_labels = {"app.example.com/tenant" = input.tenant}

resources = [
    r | {metadata.labels = _labels}
    for r in _base
    if r.kind != "Secret"
]
```

## What a Package cannot do

The render runs in a sandbox (see [security-model.md](security-model.md)):

- no file reads outside the Package, no network, no environment variables;
- no clock: the wall clock is fixed at the Unix epoch;
- no cluster access: Helm's `lookup` returns nothing;
- no writes: only `resources` leaves the render.

The result depends only on the Package, its inputs, `akua.lock` and the
akuapkg version. The one exception is randomness a chart asks Helm for
(`randAlphaNum`, `genCA` and the like), which stays real so generated keys
are not shared.

## Render output

`akuapkg render` writes each entry of `resources` to its own file in the
output directory (default `./deploy`), named `NNN-<kind>-<name>.yaml` in list
order:

```text
deploy/
  000-configmap-hello.yaml
  001-certificate-hello.yaml
```

`render` does not delete files already in the output directory: clear it
first when the set of resources can shrink. `--stdout` writes one YAML stream
instead, and `--dry-run` writes nothing.
[examples/15-yaml-output](../examples/15-yaml-output/) shows the exact YAML
formatting.

## Tests

`akuapkg test` runs two kinds of tests:

- **Assertion tests**: every `test_*.k` or `*_test.k` file is evaluated as
  a standalone KCL program; a failing `assert` or `check:` fails the test.
  Test files do not see the Package's dependencies.
- **Golden tests** (`--golden`): every `package.k` is rendered against each
  sibling `inputs*.yaml`, `inputs*.yml` or `inputs*.json` file and compared
  with `snapshots/<package directory>/<inputs name>/`.
  `--update-snapshots` writes the snapshots.

```kcl
# test_naming.k
_name = "hello"
assert len(_name) <= 63, "names fit a DNS label"
```

```sh
akuapkg test --update-snapshots   # establish snapshots/
akuapkg test --golden             # fail on any drift
```

## Related topics

- [Typed resources](typed-resources.md)
- [Lockfile format](lockfile-format.md)
- [Embedded engines](embedded-engines.md): how Helm and Kustomize behave
  inside akuapkg
- [Examples](../examples/)
