# akua examples

Working examples of akua Packages, Apps, Environments, and Policies. Each directory is a standalone example you can copy, edit, and render locally.

Every green row in the table below renders through the shipped `akua` binary and has a `rendered/` directory committed as golden output — CI verifies the render is byte-identical on every change.

## The examples

| # | directory | what it shows | status |
|---|---|---|---|
| 00 | [00-helm-hello/](00-helm-hello/) | simplest Package exercising `helm.template` against a bundled chart | ✅ renders |
| 01 | [01-hello-webapp/](01-hello-webapp/) | typed `charts.*` dep from `akua.toml`, Helm template, Deployment + Service | ⏳ needs dependency resolution, not in the Bun host yet |
| 02 | [02-webapp-postgres/](02-webapp-postgres/) | cross-source wiring — a webapp consuming a CNPG-managed Postgres secret via convention; `test_package.k` | ⚠ target-state (OCI chart refs need refreshing) |
| 03 | [03-multi-env-app/](03-multi-env-app/) | Package + App + Environment as typed KCL — the full workspace authoring shape | 📘 pattern reference (no single `akuapkg render` target) |
| 04 | [04-policy-tier/](04-policy-tier/) | Rego tier + Kyverno compile-resolved import, passing + failing fixtures | 📘 target-state (policy engine not shipped) |
| 05 | [05-tests-and-golden/](05-tests-and-golden/) | `test_*.k` + `*_test.rego` + golden-fixture render snapshots | ⚠ target-state (lockfile pins OCI refs that need refreshing) |
| 06 | [06-multi-engine/](06-multi-engine/) | Helm + Kustomize + kro RGD + inline KCL in one Package | ⚠ target-state (references `pkg.akua.dev` — not yet published) |
| 07 | [07-package-reuse/](07-package-reuse/) | one akua Package composing another via `pkg.render()` | ⚠ target-state (references `pkg.acme.corp` — fictional) |
| 08 | [08-pkg-compose/](08-pkg-compose/) | pure-KCL Package-of-Packages composition via local `pkg.render("./shared", …)` | ⏳ needs `pkg.render`, not in the Bun host yet |
| 09 | [09-kustomize-hello/](09-kustomize-hello/) | smallest `kustomize.build` example — overlay adds namePrefix + labels | ✅ renders |
| 10 | [10-kcl-ecosystem/](10-kcl-ecosystem/) | pull `oci://ghcr.io/kcl-lang/k8s` (a kpm-published KCL package) and author a typed `Deployment` against it | ⏳ needs dependency resolution, not in the Bun host yet |
| 11 | [11-install-as-package/](11-install-as-package/) | install-as-Package shape — `pkg.render` an upstream, overlay tenant label, filter out a kind, append extras | ⏳ needs `pkg.render`, not in the Bun host yet |
| 12 | [12-vendor-offline/](12-vendor-offline/) | render off the local vendor tree (`.akua/vendor/`): no registry, network or credentials at render time | ✅ renders |
| 13 | [13-subpackage-helm/](13-subpackage-helm/) | a root Package composes a sub-package (via `pkgs.<alias>`) whose own `akua.toml` declares a Helm chart dep — chart context propagates through the composition | ⏳ needs dependency resolution, not in the Bun host yet |
| 14 | [14-helm-repo-dep/](14-helm-repo-dep/) | pull podinfo from a classic HTTPS Helm repository (`repo`/`chart`/`version`); sha256-pinned in `akua.lock` — no OCI, no local path | ⏳ needs dependency resolution, not in the Bun host yet |
| 15 | [15-yaml-output/](15-yaml-output/) | the exact YAML `akuapkg render` writes: key order, sequence layout, which strings get quoted | ✅ renders |

**Legend:**

- ✅ **renders** — end-to-end through `akuapkg render`, golden output committed, deterministic across machines.
- 📘 **pattern reference** — illustrates an authoring shape; not a single-command render target (policy composition, multi-env workspace walks).
- ⚠ **target-state** — references remote sources (OCI registries we don't yet publish to, or example corporate registries). The shape is current; the concrete refs will work once `pkg.akua.dev` is live or once the tagged chart versions are pinned against current registries.

---

## Running the examples

Prerequisite: build the embedded engines once.

```sh
task build:engines          # helm + kustomize wasip1 artifacts
cargo install --path crates/akuapkg-cli
```

Render a green example:

```sh
cd examples/00-helm-hello
akuapkg render --out /tmp/hello
diff -r /tmp/hello rendered/   # byte-identical to committed golden
```

The other green examples (01, 08, 09, 10, 11, 13) follow the same pattern — `akuapkg render --package ./package.k --inputs ./inputs.yaml --out /tmp/<name>` and compare against `rendered/`. Example 14 requires `akuapkg add` online first (to populate the cache) then renders identically to a local Helm dep.

---

## Reading order

Each example adds concepts over the prior one:

- **00 → 01:** adds a typed `charts.*` dep from `akua.toml` and switches from engine-direct `helm.template(...)` to the alias-method form `nginx.template(nginx.TemplateOpts{...})` that the resolver's per-dep stub exposes.
- **01 → 02:** adds a second source, cross-source value wiring, and a unit-test file.
- **02 → 03:** separates the Package (reusable, OCI-published) from the App (per-install) — the shape most production workspaces use.
- **03 → 04:** adds the policy stack — Rego tier, compile-resolved Kyverno import, tests, fixture-driven verdicts.
- **04 → 05:** formalizes testing — KCL unit tests, Rego policy tests, and golden render fixtures side by side.
- **05 → 06:** demonstrates multi-engine composition — Helm + Kustomize + kro RGD + inline KCL flattened into one render.
- **06 → 07:** introduces package-of-packages composition — `upstream.render(upstream.Input{...})` via the synthesized `pkgs.<name>` stub, the same alias-method shape `webapp.template(webapp.TemplateOpts{...})` uses for Helm charts.
- **07 ← 08:** drops network-dependence by replacing the OCI-pinned base with a local path. The shape cross-package reuse takes — both in local and distributed form.
- **11 → 13:** the composed sub-package itself uses a Helm chart — chart context now propagates through `pkgs.<alias>` so a sub-package can declare and render its own `charts.*` dep.
- **00 → 14:** the same `charts.<alias>.template(...)` call surface, but the chart is pulled from a classic HTTPS Helm repository instead of a local path or OCI image — `repo`/`chart`/`version` in `akua.toml`, sha256-pinned tarball in `akua.lock`.

Beyond 07, realistic workspaces combine these patterns at scale. See the [use cases](../docs/use-cases.md) for archetypes (solo dev, small SaaS, platform team, ISV).

---

## Related reference

- [cli.md](../docs/cli.md) — the `akua` CLI surface
- [cli-contract.md](../docs/cli-contract.md) — the universal verb invariants
- [package-format.md](../docs/package-format.md) — Package authoring spec
- [policy-format.md](../docs/policy-format.md) — Policy authoring spec
- [lockfile-format.md](../docs/lockfile-format.md) — `akua.toml` + `akua.lock`
- [sdk.md](../docs/sdk.md) — TypeScript SDK
- [architecture.md](../docs/architecture.md) — why the pipeline is shaped this way
