# kcl wasm32 patch series

akuapkg's per-render wasmtime sandbox needs several `kcl-lang/kcl` crates
(`kcl-parser`, `kcl-language-server`, `kcl-runtime`) to build and behave
correctly on `wasm32-wasip1` (the render worker, see
`crates/akua-render-worker`) and, eventually, `wasm32-unknown-unknown` (the
planned browser/JS SDK bundle, Phase 4B, not yet built in this repo). None of
these are upstream-rejected akua-specific hacks; they are general wasm32
portability fixes upstream simply hasn't landed yet, so we carry them here as
a patch series instead of pointing `[patch]` at a maintained fork.

This replaces the former `git = "https://github.com/akua-dev/kcl", branch =
"akua-wasm32"` dependency. Never reference that fork from this repo again.

## Pin

The tracked upstream commit is recorded in `.upstream-rev` (also embedded in
`MODULE.bazel`'s `kcl_lang_kcl_da013146` `http_archive`, and, for the ~17
unpatched `kcl-*` crates plus `kcl-lang` itself, enforced via the committed
`Cargo.lock`; see "Applying" below for why there are two places).

akuapkg depends on `kcl-lang` (from `https://github.com/kcl-lang/lib`,
`crates/akua-core/Cargo.toml`'s `engine-kcl` feature), which declares every
`kcl-*` crate it needs as a plain, unpinned `git =
"https://github.com/kcl-lang/kcl"` dependency. Cargo has no `rev=` on that
declaration, so for every crate this series does not patch, the pin lives in
the committed `Cargo.lock` - the normal, idiomatic way Cargo makes an
otherwise-floating git dependency reproducible, refreshed only by an explicit
`cargo update -p kcl-lang`. As of this series, `Cargo.lock` pins every
`kcl-*` crate (and `kcl-lang` itself) to:

- `kcl-lang` (`https://github.com/kcl-lang/lib`): commit `efa2893a83b4`
  (2026-09-29, `feat(ruby): add Ruby bindings...`, #362), the oldest
  `kcl-lang/lib` commit whose own `kcl-api` requirement (`version = "0.13.0"`)
  is satisfiable by the kcl pin below. The previously-locked `kcl-lang`
  v0.12.3 (`bde7439b`) requires `kcl-api ^0.12.3`, incompatible with current
  upstream kcl (`0.13.0`); updating `kcl-lang` is a required part of this
  migration, not an unrelated bump.
- Every `kcl-*` crate (`https://github.com/kcl-lang/kcl`): commit
  `da013146648e2c322b5bab52e78dd7187a862ae5`, upstream `main` as of
  2026-09-29 (`fix(runtime): self-contained plugin stub on
  wasm32-unknown-unknown (#2208)`). No tagged release exists past
  `v0.11.2` (2025-04-18), well before the fixes this crate needs, so the pin
  is a main commit rather than a tag; reassess when upstream cuts a new
  release. Its ancestry contains both fixes that used to require the fork:
  - `kcl-lang/kcl#2105` ("fix(driver): guard current_dir() panic on wasm32",
    commit `8bbe5823`), this alone is why the `[patch]` block existed in the
    first place; no patch file needed for it anymore.
  - `kcl-lang/kcl#2203` ("fix(api): make ValidateCode, Rename and
    UpdateDependencies work on WASI/wasm32", commit `dccc38ec`, 2026-09-26).
  - `kcl-lang/kcl#2207` (LSP wasm32 `Url::from_file_path` shim, commit
    `d2b50eb8`) and `kcl-lang/kcl#2208` (self-contained plugin stub on
    `wasm32-unknown-unknown`, commit `da013146`), both merged 2026-09-29;
    these were our former patches 0003/0004.

Moving the pin forward: `cargo update -p kcl-lang` (scoped; do not delete
`Cargo.lock` and run a bare `cargo update`, which re-resolves the entire
workspace including unrelated dependencies and can pull in packages whose
MSRV exceeds this repo's pinned Rust toolchain). Re-verify the patch series
still applies after moving the pin; upstream file drift can require hand
porting (see "Verified" below for the last known-clean state).

## Applying

`kcl-parser`, `kcl-language-server`, and `kcl-runtime` need patching (see the
table below); `tools/akuapkg/source/Cargo.toml`'s
`[patch."https://github.com/kcl-lang/kcl"]` block points just those three
crates at `path = "third_party/kcl/vendor/<crate>"`. No other `kcl-*` crate
gets a `[patch]` entry - Cargo rejects a patch whose source is the exact
same git URL as what it patches ("patches must point to different
sources") - so the other ~17 crates resolve straight from `kcl-lang/lib`'s
own unpinned git declaration, pinned only via `Cargo.lock` (see "Pin" above).

`third_party/kcl/vendor/` is **gitignored, never committed**. It is
materialized by Bazel from the pinned, patched archive:

1. `MODULE.bazel`'s `kcl_lang_kcl_da013146` `http_archive` fetches
   `https://github.com/kcl-lang/kcl/archive/<rev>.tar.gz`, verifies its
   `sha256`, and applies all three patches below (`patch_args = ["-p1"]`) at
   fetch time. A drifted hash or a patch that no longer applies fails the
   fetch outright.
2. `tools/akuapkg/source/third_party/kcl/BUILD.bazel` exposes the three
   patched crate subtrees from that archive as `copy_to_directory` targets,
   rerooted so each crate's own directory content lands at the destination
   root (matching Cargo's `[patch] path =` expectations).
3. `bazel run //tools/akuapkg:write_kcl_vendor` writes those three
   directories into `third_party/kcl/vendor/kcl-parser`,
   `kcl-language-server`, and `kcl-runtime`. This step is **required before
   any `cargo build`/`test`/`check`/`clippy` invocation on a clean
   checkout** - akuapkg's own Rust build is not part of Bazel's build graph
   (Bazel only downloads prebuilt `akuapkg` release binaries), so nothing
   runs this automatically as a side effect of a cargo command.
4. `//tools/akuapkg/source/third_party/kcl:kcl_vendor_pin_check` is
   registered as the `kcl_vendor_pin` gate in root `BUILD.bazel`'s
   `core_verification_roots(...)`, part of `//:ci_build` - building it forces
   the same fetch+patch, so a broken pin fails CI even though nothing else
   in the Bazel graph depends on kcl.

This is why each vendored crate's manifest cannot use Cargo workspace
inheritance (`version.workspace = true`, `kcl-lexer.workspace = true`, ...):
that only resolves inside kcl-lang/kcl's own workspace root, which the
vendored copy isn't part of. Patch 0003 rewrites each manifest to concrete
values, an empty `[workspace]` table (marks it a standalone package instead
of one Cargo tries, and fails, to fold into an ancestor workspace), and
plain `git = "https://github.com/kcl-lang/kcl"` (**no** `rev=`) for every
`kcl-*` sibling dependency. That last part is load-bearing, not cosmetic:
Cargo unifies a crate across the graph by source identity, and a `?rev=<sha>`
git source is a *different* identity than the same URL with no rev even when
both resolve to the same commit; pinning only inside the vendored manifests
while `kcl-lang/lib` stays unpinned produced two incompatible copies of
`kcl-ast` (and other shared types) in one build ("multiple different
versions of crate kcl_ast in the dependency graph").

The `.patch` files here are the source of truth and audit trail; Bazel
applies them fresh from the pin on every `bazel run
//tools/akuapkg:write_kcl_vendor`, so `vendor/` never drifts from them.

### Public projected repo gap (open, undecided)

`tools/akuapkg/source` is Josh-projected verbatim to the public
`akua-dev/akuapkg` repo, including this directory and its own
`.github/workflows/{ci,release}.yml`. Those workflows run `task ci` /
`cargo build` directly and need `third_party/kcl/vendor/` populated - but the
public repo has no cnap `MODULE.bazel`, no `@bazel_lib`, and no
`kcl_lang_kcl_da013146` repo to fetch from, so `bazel run
//tools/akuapkg:write_kcl_vendor` cannot run there at all. This is a real,
currently-unresolved gap, not addressed by this patch series. Options, none
chosen yet:

- Give the public repo its own independent prepare mechanism (a script or
  Taskfile task there, mirroring `crates/helm-engine-wasm/fork/apply.sh`'s
  existing shallow-clone-plus-patch shape) - but `tools/akuapkg/source` is
  projected 1:1 from cnap, so any such file would have to be added on the
  cnap side too, which conflicts with cnap's Bazel-only-orchestration
  convention for this migration.
- Commit a prepared, patched snapshot of `vendor/` specifically for the
  public repo's own CI to consume, diverging it from what cnap tracks (adds
  drift risk between the two).
- Change the public repo's CI to fetch/patch some other way that does not
  need Bazel or a checked-in vendor tree.

Until this is decided, a fresh clone of the public `akua-dev/akuapkg` repo's
own CI (and anyone building outside cnap) cannot build `akua-render-worker`
or run `task test`/`task ci`.

## Patch list

| # | File | Crate | What | Upstream PR | Remove when |
|---|------|-------|------|--------------|-------------|
| 0001 | `0001-parser-trust-caller-registered-external_pkgs-without.patch` | `kcl-parser` | `is_external_pkg` skips the redundant `Path::exists()` probe for pkgs the caller explicitly registered via `opts.package_maps` - on `wasm32-wasip1`, `Path::exists()` on an absolute path through a WASI preopen is unreliable in Rust's current std and silently discards the caller's registration. | [kcl-lang/kcl#2206](https://github.com/kcl-lang/kcl/pull/2206), open, review feedback (format CI) addressed 2026-09-30. | Upstream merges #2206 or an equivalent fix, or `std`'s WASI `path_filestat_get` starts resolving preopens correctly for absolute paths. |
| 0002 | `0002-parser-probe-preopen-paths-via-read_dir-open-on-wasm.patch` | `kcl-parser` | Adds `path_exists_or_file`, which falls back to `read_dir`/`File::open` (uses WASI's `path_open`, which does walk preopens) instead of `Path::exists()` on `wasm32`. Also short-circuits `is_internal_pkg` when `pkg_root` is empty. | [kcl-lang/kcl#2206](https://github.com/kcl-lang/kcl/pull/2206), open, review feedback (format CI) addressed 2026-09-30 (combined with 0001 - same root cause, one upstream PR). | Upstream merges #2206 or an equivalent fix. |
| 0003 | `0003-vendor-standalone-manifests-for-the-three-patched-cr.patch` | `kcl-parser`, `kcl-language-server`, `kcl-runtime` | Rewrites each crate's `Cargo.toml` to a standalone manifest (concrete `version`/`edition`, empty `[workspace]` table, plain unpinned `git` sibling deps) so it can be vendored outside kcl-lang/kcl's own workspace. Cargo/build-only, not an upstream-relevant behavior change. | N/A, akuapkg-vendoring mechanics, not a kcl fix. | Never carried upstream; regenerate whenever the pin moves or a vendored crate's own dependency list changes. |

Dropped from the old fork (superseded by upstream, not carried forward):

- `cfg-guard current_dir() for wasm32 in driver::get_pkg_list`, superseded by
  upstream `kcl-lang/kcl#2105` (commit `8bbe5823`), merged 2026-07-21. Same
  file, same fix, near-identical code and comment.
- `runtime/plugin: drop the dispatch lock before invoking user handler`,
  superseded by upstream `kcl-lang/kcl#2106` (commit `3031d7ef`), merged
  2026-07-21. Same file, same fix (copy the fn pointer out from under the
  mutex before invoking it), plus upstream added a regression test
  (`dispatch_lock_released_before_handler`) we get for free.

## Notes

- The two still-needed code patches (0001, 0002) are not akua-specific hacks:
  they are general WASI portability fixes in `kcl-parser`, open as one
  upstream PR (#2206) from a personal fork (`robinbraemer/kcl`, not
  `akua-dev/kcl`). The former 0003/0004 (`wasm32-unknown-unknown` fixes for
  `kcl-language-server` and `kcl-runtime`) landed upstream in #2207/#2208 and
  were dropped by moving the pin; 0005 was renumbered to 0003.
- Pin moved 2026-09-30: patches 0001-0003 apply cleanly to the new pin
  (`git apply` against a fresh checkout). The verification notes below date
  from the previous pin (`931e6a98`) and are re-checked in the PR that moved it.
- Verified 2026-09-29 against a fresh checkout of the pinned commit: all five
  patches apply cleanly in order (`git apply` fuzz-free), the full kcl
  workspace (`cargo check --workspace`) compiles clean, `kcl-parser` and
  `kcl-runtime`'s own unit test suites pass 100% (200/200), and `kcl-runtime`
  additionally checks clean for `wasm32-unknown-unknown` once paired with a
  one-line `uuid` feature addition (`features = ["js", "v4"]`, a separate,
  pre-existing, orthogonal gap tracked in akuapkg's own
  `docs/spikes/kcl-wasm-feasibility.md`, not part of this patch series).
  `kcl-language-server`'s own test suite has 2 pre-existing failures
  (`tests::pkg_mod_test`, `completion::tests::complete_unimport_schemas`) that
  reproduce identically against the pristine, unpatched pin, confirmed not
  caused by these patches.
- Verified end-to-end in akuapkg itself the same day: `cargo check --workspace`
  (native), `cargo check -p akua-render-worker --target wasm32-wasip1` (the
  real per-render sandbox target), `task sandbox-artifacts` (builds the
  render-worker `.wasm` plus the helm/kustomize engine `.wasm` assets),
  `cargo test --workspace` (922 tests across the workspace, 100% pass on a
  clean run, including `sandbox_nested_wasmtime::charts_import_resolves_inside_sandbox_via_preopen`,
  which directly exercises patches 0001/0002's preopen-probing fix, and every
  golden-example render test), `cargo clippy --workspace --all-targets -- -D
  warnings`, and `cargo fmt --all -- --check` are all clean.
