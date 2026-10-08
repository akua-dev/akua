# AGENTS.md

Ambient context for Claude Code and other agents working in the akua repo (`CLAUDE.md` is a symlink to this file). If a change doesn't sit well against these invariants, it's wrong — regardless of whether it looks correct.

## What the Package toolchain is

Akuapkg is the **bun/deno pattern applied to cloud-native packages**. One binary (`akuapkg`) for authoring, rendering, validating, and publishing packages:

| bun / deno has | Akuapkg has |
|---|---|
| package manager | `akuapkg add` / `akuapkg pull` / `akuapkg publish` + `akua.toml` + `akua.lock` |
| runtime (executes your program) | `akuapkg render` (executes a Package's KCL + engine calls) |
| test runner | `akuapkg test` (*_test.rego + test_*.k, golden tests) |
| formatter | `akuapkg fmt` (.k + .rego) |
| linter | `akuapkg lint` (Regal + kcl lint + cross-engine) |
| REPL | `akuapkg repl` (Rego / KCL) |
| dev loop | `akuapkg dev` (sub-second hot reload) |
| bundler / ship | `akuapkg publish` (signed OCI + SLSA attestation) |

**Primary user:** AI agents operating in Linux sandboxes. Humans at policy-gated checkpoints. See [docs/agent-usage.md](docs/agent-usage.md).

**Positioning:** substrate, not content. We ship the pipeline, the format, the signing, the verification. The ecosystem ships packages, policies, and patterns.

## Before making any change

1. Check if a skill already covers the task: [`skills/`](skills/)
2. Read the relevant format spec in [`docs/`](docs/)
3. Obey [`docs/cli-contract.md`](docs/cli-contract.md) — every verb
4. Run `akuapkg check && akuapkg lint && akuapkg test && akuapkg fmt --check` locally

## Canonical reference map

| concern | authoritative doc |
|---|---|
| CLI verbs + flags + exit codes | [docs/cli.md](docs/cli.md) |
| CLI invariants (universal contract) | [docs/cli-contract.md](docs/cli-contract.md) |
| Package authoring shape | [docs/package-format.md](docs/package-format.md) |
| Policy authoring shape | [docs/policy-format.md](docs/policy-format.md) |
| `akua.toml` + `akua.lock` | [docs/lockfile-format.md](docs/lockfile-format.md) |
| Embedded engines (KCL / Helm / OPA / Regal / Kyverno / CEL / Kustomize) | [docs/embedded-engines.md](docs/embedded-engines.md) |
| Debugging the render pipeline | [docs/debugging.md](docs/debugging.md) |
| Agent install + skill format | [docs/agent-usage.md](docs/agent-usage.md) |
| TypeScript SDK | [docs/sdk.md](docs/sdk.md) |
| Roadmap + phasing | [docs/roadmap.md](docs/roadmap.md) |
| Implementation plan (agent-driven) | [docs/impl-plan.md](docs/impl-plan.md) |
| Runnable examples | [examples/](examples/) |
| Agent-executable workflows | [skills/](skills/) |
| Strategic spine (internal, maintainers) | `../cortex/workspaces/robin/akua-masterplan.md` |

## Non-negotiable invariants

Violations of these are architectural bugs:

**CLI contract holds universally.** Every verb emits `--json`, supports `--plan`, uses typed exit codes (0/1/2/3/4/5/6), accepts `--timeout` and `--idempotency-key` on writes. Structured errors on stderr, never prose. Agent-context auto-detection runs silently; see [cli-contract §1.5](docs/cli-contract.md#15-agent-context-auto-detection).

**Hosted API commands are optional extensions.** `akuapkg api` and later resource-specific cloud commands must not become dependencies of the local toolchain. Package authoring plus `render`, `export`, `check`, `lint`, `test`, and `verify` must remain cloud-independent and must not import hosted API code.

**Canonical form is typed code.** KCL for Packages; Rego for Policies. YAML is a derived view via `akuapkg export`, never authoritative. Users author their own higher-level schemas (App, Environment, Cluster, Workspace — whatever fits their shape) in KCL inside their workspace; akua does not ship a KRM vocabulary.

**Determinism is load-bearing.** No `now()`, no `random()`, no env reads, no filesystem reads, no cluster reads inside the render pipeline. Same inputs + same lockfile + same akuapkg version → byte-identical output.

**Signed + attested by default.** `akuapkg publish` emits cosign signature + SLSA v1 predicate unless the caller explicitly opts out. On pull, **digest-pinning is the universal, verified-before-write integrity gate** (every dep's bytes are checked against the `akua.lock` digest before they touch disk, always). **Cosign signature/attestation verification engages when a `[signing].cosign_public_key` is configured** — and is then fail-closed (a missing/mismatched signature fails the pull; `strict_signing` defaults true). Absent a configured key, integrity rests on the digest pin, not the signer identity.

**Sandboxed by default. No shell-out, ever.** Every render executes inside a wasmtime WASI sandbox with memory / CPU / wall-clock caps and capability-model filesystem preopens. Untrusted Packages are safe to render on shared hosts. The render path **must not** spawn subprocesses, must not call `$PATH` binaries, must not grant ambient filesystem or network access. Engines (helm, kustomize, kro, etc.) are Go-source wrappers compiled to `wasm32-wasip1`, hosted inside Akuapkg's own wasmtime — not shell-outs. There is no `--unsafe-host` escape hatch: if the engine isn't WASM-ready, the feature doesn't ship. Benchmarks confirm this is viable (`docs/performance.md` — 2× overhead vs native, sub-100ms for typical Packages). See [docs/security-model.md](docs/security-model.md).

**No filesystem paths in user-authored KCL.** Cross-Package references go through typed dep aliases — `import <alias>` for Akua/KCL packages, `charts.<alias>.path` for Helm charts (where the resolver hands the engine a path it produced itself). User code never writes a literal path string, never concatenates path segments, never reaches across the filesystem. `akua.toml [dependencies]` is the single source of truth for what's reachable; the resolver materializes deps into the cache and the path-escape guard only has to validate paths the resolver itself produced. This shrinks the sandbox-escape attack surface to zero in user code: a malicious Package cannot construct a path-escape string because there are no path strings in the call surface to begin with.

**`replace` and `path` deps are workspace-local; never cross Package boundaries.** Path-based escape hatches in `akua.toml` (`path = "..."`, `replace = { path = "..." }`) exist for fast local iteration — they must not become an attack surface when akua processes third-party Packages in production:
- `replace.path` and bare `path = "..."` deps must canonicalize under the workspace root. Absolute paths and `..` escape are rejected at resolve time.
- `akuapkg publish` strips every `replace` directive from the artifact's manifest before signing — consumers never inherit a publisher's replace.
- Production deployments (`AKUA_REJECT_REPLACE=1`, auto in agent context) fail any render whose dep graph touches a replace directive.
- `chart_resolver` runs on the host, outside the wasmtime sandbox; the path-safety + no-replace rules are the only thing standing between a malicious `akua.toml` and the host filesystem (service-account tokens, mounted secrets, in-cluster TLS material).

**`akuapkg render` ≠ `akuapkg export`.** `render` executes the Package's program (invokes engines, produces deploy-ready manifests). `export` converts a canonical artifact to a format view (JSON Schema, OpenAPI, YAML, Rego bundle). They are different verbs for different jobs.

## Architecture discipline

- **Substrate, not content.** We do not curate a package catalog. Upstream projects publish their own signed packages; akua provides signing + distribution + diff + audit infrastructure. Same logic for policy: Rego is a host, not a DSL we own.
- **Typed deps surface as alias-method calls.** When a dep is registered in `akua.toml`, the synthesized stub owns the engine call: `webapp.template(webapp.TemplateOpts{values = webapp.Values{...}})` for Helm charts, `upstream.render(upstream.Input{...})` for Akua packages. The engine import (`akua.helm`, `akua.pkg`) is an implementation detail of the stub — user code reaches it via the alias, not directly. **Engine-direct callables (`akua.<engine>`) remain the surface for engines whose input is *not* a registered typed dep** — `kustomize.build({path = "./overlays"})` is the canonical case (kustomize bases are local-to-Package file organization, not external deps; the within-Package path is bounded by the workspace preopen + path-escape guard, not the cross-Package alias rule). Same logic for `kro.rgd`, `oci.fetch_manifests`. Kyverno / CEL / foreign Rego are `import data.…` in Rego, resolved via `akua.toml`. Never runtime string lookups like `kyverno.check({bundle: "oci://..."})`.
- **Embedded via wasmtime only.** KCL, Helm, OPA, Regal, Kustomize, kro offline instantiator, CEL, Kyverno-to-Rego converter all ship as wasip1 modules hosted inside Akuapkg's wasmtime. `$PATH` never required, never consulted. There is no shell-out fallback — "embedded by default" means "embedded only," because the sandbox invariant above forbids subprocess execution in the render path.
- **Compose with the ecosystem, don't replace it.** ArgoCD, Flux, kro, Helm release lifecycle, kubectl, Crossplane are first-class consumers of akua output. We target their formats (`RawManifests`, `HelmChart`, `ResourceGraphDefinition`, `Crossplane`, `OCIBundle`). We don't ask customers to switch reconcilers.

## The one akua-specified shape

- **`Package.k`** — a KCL program with three regions (imports / schema / body), publishable to OCI, signed, deterministically rendered. Top-level `resources = [...]` is the single render output; akua writes raw YAML. See [docs/package-format.md](docs/package-format.md).

That's it. akua does **not** specify `App`, `Environment`, `Cluster`, `Secret`, `SecretStore`, `Gateway`, `PolicySet`, `Runbook`, `Rollout`, `Budget`, `Incident`, `Experiment`, or `Tenant` as akua-owned kinds. Users define their own schemas for those concepts in their workspace, shaped to their reality; ecosystems like ArgoCD / Flux / kro consume the rendered raw-Kubernetes output. akua Cloud may carry its own Convex-backed schemas for coordination concepts (Workspace, Tenant, etc.) — those live in Cloud, not in the OSS surface.

## Shipping checklists

**New CLI verb — one PR moves all of these together** (binary/SDK/docs are one contract):

- `crates/akua-core/src/<verb>.rs` (logic) → `crates/akuapkg-cli/src/verbs/<verb>.rs` (verb wrapper) → `main.rs` (clap dispatch)
- `crates/akua-napi/src/lib.rs` (`#[napi]` wrapper calling `verbs::<verb>::run`) → `packages/sdk/src/mod.ts` (`Akua.<verb>()` method routes through `loadNapi()` + `callNapi`). The napi surface is declared in **three** hand-maintained places that must stay in sync: the `#[napi]` fn, `crates/akua-napi/index.d.ts` (committed despite its "auto-generated" header), and the `NapiAddon` interface in `packages/sdk/src/napi.ts` — a missing entry fails `task sdk:build` (`tsc`), not local `cargo`. Don't rely on `process.env` reaching the addon (Bun doesn't `setenv` on assignment) — pass values through napi args.
- Tests at every layer; integration golden under `crates/akuapkg-cli/tests/` if the verb operates on a Package
- `docs/cli.md` section, verb-count bump (grep for the current count across docs/README), 🚧 → ✅
- `CHANGELOG.md` entry; `task release:validate` still green

**Touching `eval_kcl` or anything called from it:** `cargo build` doesn't rebuild `akua-render-worker.cwasm` (the worker is compiled separately to `wasm32-wasip1` by `task build:render-worker`). `crates/akuapkg-cli/build.rs` watches `crates/akua-render-worker/src` and `crates/akua-core/src` and emits a `cargo:warning=` when sources are newer than the staged `.wasm` — heed it and run `task build:render-worker` before re-running `cargo build`.

**Embedded-engine builds + feature wiring** (these cost real time when missed): the engine wasm assets (`crates/{helm,kustomize}-engine-wasm/assets/*.wasm`) are **gitignored** — a fresh clone or `git worktree` can't compile `akua-core` until `task build:engines` runs (or you copy the built assets in). The Go engine source (`crates/helm-engine-wasm/go-src/`) rebuilds via `task build:helm-engine-wasm` (Go→wasip1) — a *different* artifact from the Rust render-worker's `task build:render-worker`; when you change Go engine code, rebuild the engine, not the worker. And a new `akua-core` feature is **dead in the shipped binary/SDK** unless it's added to the `akua-core` dep `features = [...]` in **both** `crates/akuapkg-cli/Cargo.toml` and `crates/akua-napi/Cargo.toml` — otherwise it silently compiles to its `#[cfg(not(feature))]` stub there even though `cargo test -p akua-core --features …` passes.

**Releases use admitted Bazel artifacts.** Review a committed Cargo version bump, then let the canonical Main pipeline build once and publish the fixed source projection, immutable tag, and verified assets. Public CI is advisory; public workflows never publish releases. Never move a tag or replace an asset. See [docs/releasing.md](docs/releasing.md).

**Project domain is `akua.dev`.** Reverse-DNS namespaces (OCI annotations, Java-style package roots, anything following the `org.kcllang.*` shape) use **`dev.akua.*`** — *not* `org.akua.*`. The npm scope is `@akua-dev` because npm scopes have to be unique on the registry and bare `@akua` was taken; the scope name doesn't follow the reverse-DNS rule.

**CLI documentation domains follow [the CLI contract](docs/cli-contract.md).** Do not rewrite legitimate `https://akua.dev` product, dashboard, API, logo, or unrelated links.

## What we refuse

- Marketing-speak ("empower," "democratize," "unlock," "revolutionize," "AI-first"). Describe what things do; don't frame.
- Emoji in files (unless explicitly requested by a human user).
- **PR-history narration in code comments.** No `#<num>` task/PR/issue references, no "Closes spike-1 issue #X", no "tracked at #Y", no "Pre-fix:" / "Pre-#N", no "Now (post-#N):". Code comments explain *why* the code is shaped the way it is — for a reader who has never seen the PR. Issue numbers belong in commit messages, PR descriptions, and changelog entries; the codebase outlives them. Cross-references that survive (`[cli-contract §1.5](docs/...)`, upstream PRs like `kcl-lang/kcl#2086`) are fine.
- Feature-bingo changelogs. Ship refinements, not bullets.
- Settings panels for things with an obvious correct default. Pick a default and defend it.
- Inventing akua-specific vocabulary when a standard exists (JSON Schema, OpenAPI, KRM, OCI, cosign, SLSA, Agent Skills Specification).
- Vendor lock-in without escape hatches. Every artifact exports to standards; every user can leave.
- YAML-typed-everywhere. Typed composition demands KCL; raw values can be YAML; don't confuse layers.
- Verbose edits to this file. New rules go in as one bullet or one short paragraph — the rule itself, no preamble. If it needs a section, the section gets a one-line lede and a tight body. If you can't say it tersely, the rule isn't crisp enough yet.

## Quality gates

```sh
akuapkg check          # fast syntax / type / dep check, no execution
akuapkg fmt --check    # fail CI if any file needs formatting
akuapkg lint           # Regal + kcl lint + cross-engine
akuapkg test           # unit tests (*_test.rego, test_*.k) + golden
akuapkg verify         # akua.toml ↔ akua.lock integrity + cosign
```

All are embedded — no installation of `opa` / `kcl` / `regal` needed.

**Pre-push hook.** `task hooks:install` wires `.githooks/` into this repo (`core.hooksPath`). The default pre-push hook runs the non-mutating `task fmt:check` and prints the full local gate to run before merge/release. Use `PRE_PUSH_FULL=1 git push` when you deliberately want the hook to run `task ci`; that path builds sandbox artifacts and can be slow.

## Development stance

- The project is **pre-alpha** (v0.x). APIs churn. Every change should be reviewed against the invariants above before shipping.
- **Always verify doc freshness.** If you're about to quote a spec, open the file; the design has iterated.
- **Never defeat determinism "temporarily."** If you need non-determinism for a reason, it's a design bug in the calling code.
- **When uncertain, ask.** Don't guess at contract shape. The specs are precise for a reason.

## How to add a skill

Skills live under [`skills/<skill-name>/SKILL.md`](skills/) and follow the [Agent Skills Specification](https://agentskills.io/specification):

```
---
name: skill-name              # lowercase, hyphens, matches directory
description: 1–1024 chars; include trigger keywords
---

# Title

Step-by-step instructions...
```

Validate: `npx skills-ref validate ./skills/<name>`. Skills ship with the repo and install across Claude Code / Cursor / Codex / Gemini CLI / Goose / Amp / OpenCode / Cline / 25+ others (see [docs/agent-usage.md](docs/agent-usage.md)).

## The one-sentence discipline

Everything in akua follows one rule: **typed, signed, deterministic state lives in git; tools compose through shell; renderers target any substrate.** When a proposed change reads well against that rule, it's probably right. When it doesn't, it probably isn't.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
