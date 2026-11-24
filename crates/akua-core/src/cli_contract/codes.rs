//! Stable error code constants per [cli-contract §1.2](../../../../docs/cli-contract.md#12-structured-errors-on-stderr).
//!
//! Codes are part of the stability contract — agents branch on them
//! and docs link to them. Collecting them here prevents typo drift
//! across verbs and makes the inventory greppable.
//!
//! Naming: `SHOUTY_SNAKE_CASE` prefixed with `E_`.

// ----- Lockfile / manifest -------------------------------------------------

pub const E_MANIFEST_MISSING: &str = "E_MANIFEST_MISSING";
pub const E_MANIFEST_PARSE: &str = "E_MANIFEST_PARSE";
pub const E_LOCK_MISSING: &str = "E_LOCK_MISSING";
pub const E_LOCK_PARSE: &str = "E_LOCK_PARSE";
/// `akua.lock` is out of sync with `akua.toml` - `akua pkg lock --check`
/// found drift. Re-run `akua lock` without `--check` to refresh.
pub const E_LOCK_DRIFT: &str = "E_LOCK_DRIFT";

/// A dep alias referenced by `import <alias>` (or `pkg.render({package =
/// "<alias>"})`) in `package.k` resolves to a kind that's unreachable
/// from KCL. Most common case: an Akua/KCL-module dep was misclassified
/// as a Helm chart by the resolver, or the user declared a Helm chart
/// alias they then tried to `import`. `akua lock` catches this before
/// `akua check` later fails with the opaque `CannotFindModule` from KCL.
pub const E_DEP_KIND_MISMATCH: &str = "E_DEP_KIND_MISMATCH";

/// `akua.toml` declares a `git = "..."` dep whose URL contains
/// embedded credentials (`https://user:pass@host/...`). Rejected at
/// parse time so the credential never reaches the lockfile or git
/// history. Pass credentials via the SDK `auth` parameter or the CLI
/// `--auth` flag instead.
pub const E_MANIFEST_GIT_USERINFO: &str = "E_MANIFEST_GIT_USERINFO";

/// `akua.toml` declares a `repo` (HTTPS Helm repository) dep that
/// is missing the required `chart` field.
pub const E_MANIFEST_HELM_MISSING_CHART: &str = "E_MANIFEST_HELM_MISSING_CHART";
/// `akua.toml` declares a `repo` dep that is missing the required
/// `version` field (a semver constraint is mandatory for
/// reproducibility).
pub const E_MANIFEST_HELM_MISSING_VERSION: &str = "E_MANIFEST_HELM_MISSING_VERSION";
/// `akua.toml` declares a `repo` dep whose URL contains embedded
/// credentials (`https://user:pass@host/...`). Rejected at parse
/// time so the credential never reaches the lockfile or git history.
/// Pass credentials via the SDK `auth` parameter or `--auth` instead.
pub const E_MANIFEST_HELM_USERINFO: &str = "E_MANIFEST_HELM_USERINFO";
/// `akua.toml` declares a `repo` dep whose `chart` value contains
/// path separators (`/`, `\`) or `..` — a chart name must be a plain
/// single-component name. Rejected at parse time to prevent path
/// confusion in the chart cache.
pub const E_MANIFEST_HELM_CHART_INVALID: &str = "E_MANIFEST_HELM_CHART_INVALID";
/// `akua.toml` declares an `oci` dep whose URL contains embedded
/// credentials (`oci://user:pass@host/...`). Rejected at parse time
/// so the credential never reaches the lockfile or git history.
/// Pass credentials via the SDK `auth` parameter or `--auth` instead.
pub const E_MANIFEST_OCI_USERINFO: &str = "E_MANIFEST_OCI_USERINFO";

/// CLI `--auth <prefix>=<user>:<password>` value (or `--auth-file`
/// TOML payload) didn't parse. Distinct from `E_INVALID_FLAG` so
/// agents can branch on credential-input shape errors specifically.
pub const E_AUTH_PARSE: &str = "E_AUTH_PARSE";

// ----- Render --------------------------------------------------------------

pub const E_PACKAGE_MISSING: &str = "E_PACKAGE_MISSING";
pub const E_PACKAGE_PARSE: &str = "E_PACKAGE_PARSE";
pub const E_INPUTS_MISSING: &str = "E_INPUTS_MISSING";
pub const E_INPUTS_PARSE: &str = "E_INPUTS_PARSE";
/// CLI-level flag value didn't parse — `--timeout=5min`,
/// `--max-depth=foo`, etc. Distinct from `E_INPUTS_PARSE` (which
/// covers `inputs.yaml` content) so agents can branch on the right
/// thing.
pub const E_INVALID_FLAG: &str = "E_INVALID_FLAG";
pub const E_RENDER_KCL: &str = "E_RENDER_KCL";
pub const E_RENDER_YAML: &str = "E_RENDER_YAML";
/// A render produced more output than the host is willing to buffer
/// from the sandboxed worker (the per-render stdout ceiling — a DoS
/// bound on shared hosts). The Package renders, but its manifest set
/// is too large to deliver. Distinct from `E_RENDER_KCL` so agents
/// don't mistake an over-large-but-valid render for a program error.
pub const E_RENDER_OUTPUT_TOO_LARGE: &str = "E_RENDER_OUTPUT_TOO_LARGE";
/// Package called an engine plugin whose WASM backend hasn't shipped
/// yet (docs/roadmap.md tracks the blocked features). Shell-out is
/// not an option — see CLAUDE.md "No shell-out, ever."
pub const E_ENGINE_NOT_AVAILABLE: &str = "E_ENGINE_NOT_AVAILABLE";
/// Package argument to an engine plugin resolved to a path outside
/// the Package directory (traversal / symlink escape).
pub const E_PATH_ESCAPE: &str = "E_PATH_ESCAPE";

/// `pkg.render` re-entered a Package already on the render stack
/// — composition cycle. Caught before the inner load to bound
/// recursion; covers both direct and transitive cycles.
pub const E_RENDER_CYCLE: &str = "E_RENDER_CYCLE";

/// `pkg.render` exceeded the render-stack depth cap. Default is
/// generous (16); hitting it usually means runaway composition
/// through fresh Packages, which cycle detection alone can't catch.
pub const E_RENDER_BUDGET_DEPTH: &str = "E_RENDER_BUDGET_DEPTH";

/// `pkg.render` was called after the wall-clock deadline the
/// outer caller installed for the render had already expired.
pub const E_RENDER_BUDGET_DEADLINE: &str = "E_RENDER_BUDGET_DEADLINE";

/// A dep in `akua.toml` failed to resolve (missing path, not-a-directory,
/// OCI/git fetch failure, lockfile mismatch). Covers all dep kinds —
/// path / oci / git / vendor — not chart-specific. See chart_resolver
/// and vendor.
pub const E_DEP_RESOLVE: &str = "E_DEP_RESOLVE";
/// `akua render --strict`: a plugin was handed a raw-string chart
/// path instead of a typed `charts.*` import. Surfaces the Package
/// authoring site that needs to migrate.
pub const E_STRICT_UNTYPED_CHART: &str = "E_STRICT_UNTYPED_CHART";
/// Cosign signature failed cryptographic verification, or the payload
/// disagrees with the fetched digest. Attacker-side signal —
/// someone served bytes the configured key didn't approve.
pub const E_COSIGN_VERIFY: &str = "E_COSIGN_VERIFY";
/// A cosign public key was configured but the registry has no
/// `.sig` sidecar (or it's malformed). Publisher-side signal —
/// actionable by the artifact's author, not the consumer.
pub const E_COSIGN_SIG_MISSING: &str = "E_COSIGN_SIG_MISSING";

// ----- Init ----------------------------------------------------------------

pub const E_INIT_EXISTS: &str = "E_INIT_EXISTS";
pub const E_INIT_EMPTY_NAME: &str = "E_INIT_EMPTY_NAME";

// ----- Fmt -----------------------------------------------------------------

pub const E_FMT_CHANGED: &str = "E_FMT_CHANGED";
pub const E_FMT_KCL: &str = "E_FMT_KCL";

// ----- Lint ----------------------------------------------------------------

pub const E_LINT_FAIL: &str = "E_LINT_FAIL";

// ----- Check ---------------------------------------------------------------

pub const E_CHECK_FAIL: &str = "E_CHECK_FAIL";

// ----- Inspect -------------------------------------------------------------

pub const E_INSPECT_FAIL: &str = "E_INSPECT_FAIL";

// ----- Diff ----------------------------------------------------------------

pub const E_DIFF_FOUND: &str = "E_DIFF_FOUND";
pub const E_DIFF_NOT_DIR: &str = "E_DIFF_NOT_DIR";

// ----- Add -----------------------------------------------------------------

pub const E_ADD_DEP_EXISTS: &str = "E_ADD_DEP_EXISTS";
pub const E_ADD_INVALID_DEP: &str = "E_ADD_INVALID_DEP";

// ----- Vendor --------------------------------------------------------------

pub const E_VENDOR_DEP_MISSING: &str = "E_VENDOR_DEP_MISSING";
pub const E_VENDOR_DRIFT: &str = "E_VENDOR_DRIFT";

// ----- Remove --------------------------------------------------------------

pub const E_REMOVE_NOT_FOUND: &str = "E_REMOVE_NOT_FOUND";

// ----- Publish / Pull ------------------------------------------------------

/// `akua publish` failed to upload the artifact. Wraps every registry-
/// side failure (auth rejected, upload PUT non-2xx, manifest malformed).
pub const E_PUBLISH_FAILED: &str = "E_PUBLISH_FAILED";
/// `akua pull` couldn't retrieve / extract the requested artifact.
pub const E_PULL_FAILED: &str = "E_PULL_FAILED";

// ----- Hosted API ----------------------------------------------------------

/// Hosted Akua API auth token is required but was not provided.
pub const E_AUTH_REQUIRED: &str = "E_AUTH_REQUIRED";
/// Hosted Akua API token was rejected as invalid or expired.
pub const E_AUTH_INVALID: &str = "E_AUTH_INVALID";
/// Hosted Akua API token is valid but lacks permission for the request.
pub const E_FORBIDDEN: &str = "E_FORBIDDEN";
/// Requested CLI option or hosted API bridge feature is not implemented.
pub const E_UNSUPPORTED: &str = "E_UNSUPPORTED";
/// Hosted Akua API request failed before a structured response was available.
pub const E_API_REQUEST: &str = "E_API_REQUEST";

// Test failures surface via the JSON `status: "fail"` verdict +
// exit code 1 (UserError). No structured stderr error — matches
// the `render` / `verify` pattern where a valid-but-negative
// verdict is an output, not an error.

// ----- General -------------------------------------------------------------

pub const E_IO: &str = "E_IO";
