# AGENTS.md

Ambient context for Claude Code and other agents working in the akua repo (`CLAUDE.md` is a symlink to this file). If a change doesn't sit well against these invariants, it's wrong - regardless of whether it looks correct.

Akuapkg is the standalone Package toolchain and the in-process host of `akua pkg`.
It owns authoring, resolution, typed schemas, sandboxed rendering, signing and
verification. The hosted API and platform concepts belong to the CLI.

## Before making any change

1. Check if a skill already covers the task: [`skills/`](../../plugins/akuapkg/skills/)
2. Read the relevant format spec in [`docs/`](../../docs/)
3. Obey [`docs/cli-contract.md`](../../docs/cli-contract.md) - every verb
4. Run `akuapkg check && akuapkg lint && akuapkg test && akuapkg fmt --check` locally

## References

- Commands and universal output: [CLI contract](../../docs/cli-contract.md).
- Authoring and dependency locks: [Package format](../../docs/package-format.md), [lockfile](../../docs/lockfile-format.md), [typed resources](../../docs/typed-resources.md).
- Rendering: [architecture](../../docs/architecture.md), [sandbox security](../../docs/security-model.md), [debugging](../../docs/debugging.md).
- Consumers: [SDK](../../docs/sdk.md), [CLI](../cli/AGENTS.md), [agent skills](../../plugins/akuapkg/skills/).
- Build and release: [building](../../docs/building.md), [releasing](../../docs/releasing.md).

## Non-negotiable invariants

Violations of these are architectural bugs:

**CLI contract holds universally.** Every verb emits `--json`, accepts the universal flags, uses typed exit codes (0/1/2/6 in use; 3/4/5 reserved). Structured errors on stderr, never prose. Agent-context auto-detection runs silently; see [cli-contract §1.4](../../docs/cli-contract.md#14-agent-context).

**The toolchain is cloud-independent.** Hosted-platform commands live in the `akua` CLI (`packages/cli/`), never in this package. Package authoring plus `render`, `export`, `check`, `lint`, `test`, and `verify` must not import hosted API code.

**Canonical form is typed code.** KCL for Packages, typed against pinned Kubernetes and CRD schemas. YAML is a derived view via `akuapkg export`, never authoritative. Users author their own higher-level schemas (App, Environment, Cluster, Workspace - whatever fits their shape) in KCL inside their workspace; akua does not ship a KRM vocabulary.

**Determinism is load-bearing.** No `now()`, no `random()`, no env reads, no filesystem reads, no cluster reads inside the render pipeline. Same inputs + same lockfile + same akuapkg version → byte-identical output. Sole exception: Helm's `rand*`/`gen*` functions keep real cryptographic randomness (shared private keys would be worse).

**Signed + attested when keyed.** `akuapkg publish` emits a cosign signature + SLSA v1 predicate whenever `[signing].cosign_private_key` is configured (`--no-sign` / `--no-attest` opt out). On pull, **digest-pinning is the universal, verified-before-write integrity gate** (every dep's bytes are checked against the `akua.lock` digest before they touch disk, always). **Cosign signature/attestation verification engages when a `[signing].cosign_public_key` is configured** - and is then fail-closed (a missing/mismatched signature fails the pull; `strict_signing` defaults true when a key is configured, false without one, where `verify` only warns about unsigned deps). Absent a configured key, integrity rests on the digest pin, not the signer identity.

**Sandboxed by default. No shell-out, ever.** Every render executes inside a wasmtime WASI sandbox with memory caps, fuel (CPU) budgets, a fixed clock and read-only preopens (none for engines). Untrusted Packages are safe to render on shared hosts. The render path **must not** spawn subprocesses, must not call `$PATH` binaries, must not grant ambient filesystem or network access. Engines (helm, kustomize) are Go-source wrappers compiled to `wasm32-wasip1`, hosted inside Akuapkg's own wasmtime - not shell-outs. There is no `--unsafe-host` escape hatch: if the engine isn't WASM-ready, the feature doesn't ship. See [docs/security-model.md](../../docs/security-model.md).

**No filesystem paths in user-authored KCL.** Cross-Package references go through typed dep aliases - `import <alias>` for Akua/KCL packages, `charts.<alias>.path` for Helm charts (where the resolver hands the engine a path it produced itself). User code never writes a literal path string, never concatenates path segments, never reaches across the filesystem. `akua.toml [dependencies]` is the single source of truth for what's reachable; the resolver materializes deps into the cache and the path-escape guard only has to validate paths the resolver itself produced. This shrinks the sandbox-escape attack surface to zero in user code: a malicious Package cannot construct a path-escape string because there are no path strings in the call surface to begin with.

**`replace` and `path` deps are workspace-local; never cross Package boundaries.** Path-based escape hatches in `akua.toml` (`path = "..."`, `replace = { path = "..." }`) exist for fast local iteration - they must not become an attack surface when akua processes third-party Packages in production:
- `replace.path` and bare `path = "..."` deps must canonicalize under the workspace root. Absolute paths and `..` escape are rejected at resolve time.
- `akuapkg publish` strips every `replace` directive from the artifact's manifest before signing - consumers never inherit a publisher's replace.
- Production deployments (`AKUA_REJECT_REPLACE=1`, auto in agent context) fail any render whose dep graph touches a replace directive.
- Dependency resolution runs on the host, outside the wasmtime sandbox; the path-safety + no-replace rules are the only thing standing between a malicious `akua.toml` and the host filesystem (service-account tokens, mounted secrets, in-cluster TLS material).

**`akuapkg render` ≠ `akuapkg export`.** `render` executes the Package's program (invokes engines, produces deploy-ready manifests). `export` converts the Package's `Input` schema to a standard view (JSON Schema, OpenAPI). They are different verbs for different jobs.

## Architecture discipline

- **Substrate, not content.** We do not curate a package catalog. Upstream projects publish their own signed packages; akua provides signing + distribution + diff + audit infrastructure.
- **Typed deps surface as alias-method calls.** When a dep is registered in `akua.toml`, the synthesized stub owns the engine call: `webapp.template(webapp.TemplateOpts{values = webapp.Values{...}})` for Helm charts, `upstream.render(upstream.Input{...})` for Akua packages. The engine import (`akua.helm`, `akua.pkg`) is an implementation detail of the stub - user code reaches it via the alias, not directly. **Engine-direct callables (`akua.<engine>`) remain the surface for engines whose input is *not* a registered typed dep** - `kustomize.build({path = "./overlays"})` is the canonical case (kustomize bases are local-to-Package file organization, not external deps; the within-Package path is bounded by the workspace preopen + path-escape guard, not the cross-Package alias rule). Never runtime string lookups of remote sources.
- **Embedded via wasmtime only.** KCL, Helm and Kustomize ship as wasip1 modules hosted inside Akuapkg's wasmtime; any future engine must too. `$PATH` never required, never consulted. There is no shell-out fallback - "embedded by default" means "embedded only," because the sandbox invariant above forbids subprocess execution in the render path.
- **Compose with the ecosystem, don't replace it.** Argo CD, Flux and kubectl consume akua's raw manifests; Helm charts, Kustomize bases, kpm modules and CRDs are consumed as dependencies. We don't ask customers to switch reconcilers.

## The one akua-specified shape

- **`Package.k`** - a KCL program with three regions (imports / schema / body), publishable to OCI, signed, deterministically rendered. Top-level `resources = [...]` is the single render output; akua writes raw YAML. See [docs/package-format.md](../../docs/package-format.md).

That's it. akua does **not** specify `App`, `Environment`, `Cluster`, `Secret`, `SecretStore`, `Gateway`, `PolicySet`, `Runbook`, `Rollout`, `Budget`, `Incident`, `Experiment`, or `Tenant` as akua-owned kinds. Users define their own schemas for those concepts in their workspace, shaped to their reality; reconcilers like Argo CD and Flux consume the rendered raw-Kubernetes output. The hosted Akua platform may define its own schemas for coordination concepts (Workspace, Tenant, etc.); those live there, not in the OSS surface.

## Shipping checklists

**New CLI verb**: this package owns it in TypeScript: `src/cli.ts` (command), its logic beside `render.effect.ts`, and a golden or contract case if it operates on a Package. New error codes go in `src/error-catalog.ts`. Refresh the generated CLI reference through its owning documentation generator. `akua pkg` gets it automatically: the akua CLI embeds this host.

**Touching `eval_kcl` or the Go engines**: the render worker (Rust to `wasm32-wasip1`) and the Helm/Kustomize engines (Go to `wasip1`) are wasm modules the executable embeds precompiled; Bazel rebuilds and re-precompiles them for every target. Verify by rendering the examples against their committed `rendered/` goldens.

**Releases use admitted Bazel artifacts.** Review a committed Cargo version bump, then let the canonical Main pipeline build once and publish the fixed source projection, immutable tag, and verified assets. Public CI is advisory; public workflows never publish releases. Never move a tag or replace an asset. See [docs/releasing.md](../../docs/releasing.md).

**Project domain is `akua.dev`.** Reverse-DNS namespaces (OCI annotations, Java-style package roots, anything following the `org.kcllang.*` shape) use **`dev.akua.*`** - *not* `org.akua.*`. The npm scope is `@akua-dev` because npm scopes have to be unique on the registry and bare `@akua` was taken; the scope name doesn't follow the reverse-DNS rule.

**CLI documentation domains follow [the CLI contract](../../docs/cli-contract.md).** Do not rewrite legitimate `https://akua.dev` product, dashboard, API, logo, or unrelated links.

## Quality gates

```sh
akuapkg check          # manifest, lockfile and package.k, no execution
akuapkg fmt --check    # fail CI if any file needs formatting
akuapkg lint           # KCL parse and imports
akuapkg lock --check   # akua.lock and .akua/crds/ match akua.toml
akuapkg test --golden  # test_*.k assertions + golden snapshots
akuapkg verify         # akua.toml ↔ akua.lock integrity + signatures
```

All are embedded; no `kcl`, `helm` or `kustomize` installation needed. For the repository itself, see [docs/building.md](../../docs/building.md).

## Development stance

- The project is **pre-alpha** (v0.x). APIs churn. Every change should be reviewed against the invariants above before shipping.
- **Always verify doc freshness.** If you're about to quote a spec, open the file; the design has iterated.
- **Never defeat determinism "temporarily."** If you need non-determinism for a reason, it's a design bug in the calling code.
- **When uncertain, ask.** Don't guess at contract shape. The specs are precise for a reason.

## The one-sentence discipline

Everything in akua follows one rule: **typed, signed, deterministic state lives in git; tools compose through shell; renderers target any substrate.** When a proposed change reads well against that rule, it's probably right. When it doesn't, it probably isn't.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Host and sandbox architecture

The Bun + Effect host (`@akua-dev/sdk`) runs the render pipeline: the KCL
render worker (`crates/akua-render-worker`, Rust to `wasm32-wasip1`) and the
Helm and Kustomize engines (`crates/{helm,kustomize}-engine-wasm/go-src`, Go to
`wasip1`). This file records the hosting decision and the rules that keep it
intact.

## The decision

Untrusted Packages run inside **Wasmtime**, reached through a small
**napi-rs addon** (`../../crates/wasm-sandbox`, `@akua-dev/wasm-sandbox`). The JS engine's own
`WebAssembly` is used only where the environment already sandboxes the process
(the browser, `src/host-js.effect.ts`).

**Modules are precompiled at build time, per target.** `crates/wasm-sandbox/precompile`
(Cranelift, every backend, build-time only) turns each `.wasm` into
zstd-compressed machine code for each target triple, with baseline CPU
features. The shipped addon has no compiler: it loads the machine code the
executable embeds. Engine settings live once in `crates/wasm-sandbox/src/config.rs`,
shared by both, because Wasmtime rejects machine code built with other
settings.

**One host, three ways to run it.** `akuapkg` is the standalone
executable; the `akua` CLI embeds the same host in-process for `akua pkg`
(`runAkuapkgWith`), so a release ships one Bun runtime. Long-lived services
that render untrusted Packages use `src/process.ts`: the executable in a child
process under an OS sandbox, with a wall-clock deadline that kills it.

## Rules

- **`crates/wasm-sandbox/` stays generic.** It must not know about KCL, akua, Helm, Kustomize or any module ABI. Module-specific behaviour (reactor ABI, `_start`, the KCL bridge) belongs in `src/host-native.effect.ts`. Before adding Rust, check whether it can be TS over the addon's primitives.
- **Rust changes only for a Wasmtime upgrade or a new sandbox guarantee.** Change engine settings only in `config.rs`; Bazel re-precompiles every target.
- **The addon owns the guarantees and keeps them unconditional:** a memory cap that traps and reports `MemoryLimit`, fuel per call, read-only preopens, capped in-memory stdio, no env, no sockets, a wall clock fixed at the Unix epoch, NaN canonicalization.
- **The monotonic clock and cryptographic randomness are the host's.** Go's scheduler and GC pace themselves by the monotonic clock; a stepping fake clock made large charts spin for minutes. Charts generate keys (`genCA`, `genSignedCert`); constant or seeded bytes either never terminate (prime search) or hand every user the same private key. Renders that draw no randomness stay byte-identical.
- **Guest failures are values, host bugs are exceptions.** The addon returns `Outcome` (`Ok`, `Exited`, `OutOfFuel`, `MemoryLimit`, `Trap`); the TS adapter maps them to `GuestFailure` / `EngineError` / `RenderError`. A plugin failure reaches the guest as a KCL panic (a trap on wasm): report the plugin's own error, not the trap.
- **`unsafe` is limited to `Module::deserialize`** of machine code the executable embeds. Never load machine code from a user-writable location.
- **Fuel is split:** a Package's own KCL gets `workerFuel` (fractions of a second), all engine calls of one render together `engineFuel` (about 25 seconds), nested renders included. Running out is `E_RENDER_BUDGET_DEADLINE`, exit 6.
- **Guest output is bounded before the host reads it:** an engine result over `maxOutputBytes` is `E_RENDER_BUDGET_MEMORY`. An engine instance whose call failed is discarded, never reused. Values go to engines as JSON, never YAML: the engines read YAML 1.1.
- **Output is byte-compatible with the previous release:** keys in the Package's order, Helm/Kustomize output with sorted keys and YAML 1.1 octal file modes (`src/yaml-compat.ts`), serde_yml's quoting (`toYaml`). `examples/15-yaml-output` is the golden.
- **Callbacks from Rust into JS only run on the calling thread.** Never route WASI stdio or anything Wasmtime may run on another thread through a JS callback.
- **Host-side TS outside the sandbox is an escape boundary too.** It reads files the guest named, so it resolves real paths and rejects anything outside the Package (`PathEscape`).
- **Instances are not re-entrant** (`RefCell`): calling into an `Instance` from its own import is an error by design.
- **TypeScript follows Effect conventions:** services with static layers, `Effect.fn`, `Schema` for guest-controlled data. The one `Effect.runSync` is the KCL plugin callback, which the guest calls synchronously.

## Building and verifying

Bazel builds everything from `bazel/BUILD.bazel` (see `../../docs/building.md`):
the worker and engines, the addon per target (`sandbox_addon_<target>`), the
precompiled modules, and the `akuapkg_<target>` / `akua_<target>` release
executables. `bazel test //bazel:host_typecheck_test` type-checks this
package. The parent workspace owns the full render-contract tests: goldens,
determinism, CPU and memory budgets, plugin failures, octal modes, the Package
path boundary, and `src/process.ts`'s deadline.

`index.d.ts` in `crates/wasm-sandbox/` is generated by `bunx @napi-rs/cli build --dts`;
regenerate it when the addon's API changes.
