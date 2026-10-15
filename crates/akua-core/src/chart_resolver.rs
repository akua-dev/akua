//! Resolve `charts.*` dependencies declared in `akua.toml` into typed
//! [`ResolvedChart`] values.
//!
//! A `Package.k` that writes
//!
//! ```kcl
//! import charts.nginx
//! ```
//!
//! is asking akua's loader to materialize a per-render KCL package named
//! `charts` whose `nginx.k` points at the on-disk chart directory the
//! `nginx` dep in `akua.toml` resolves to. That path + a content-addressed
//! digest of the chart tree is exactly what this module computes.
//!
//! Resolves local-path deps, vendored trees and `replace` directives.
//! The host fetches remote dependencies before rendering; unresolved remote
//! sources return [`ChartResolveError::UnsupportedSource`].

#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::hex::hex_encode;
use crate::lock_file::VENDORED_LOCK_FALLBACK;
use crate::mod_file::{AkuaManifest, Dependency, DependencySource, DependencySpec};

/// The kind of package materialized on disk for rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageKind {
    HelmChart,
    KclModule,
}

/// A single resolved dep — a materialized on-disk directory plus
/// a content-addressed digest of the tree (filenames + contents).
/// "Chart" in the type name is historical; the resolver also handles
/// KCL ecosystem packages now (see [`ResolvedChart::kind`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedChart {
    /// Local alias in `akua.toml`. Imported as `import charts.<name>`
    /// for Helm charts (akua synthesizes a wrapper) or as
    /// `import <name>` for KCL packages (registered as a kcl-lang
    /// `ExternalPkg` directly).
    pub name: String,

    /// Canonicalized absolute path on disk. For Helm, hand directly to
    /// `helm-engine-wasm::render_dir`. For KCL, this is the package
    /// root containing `kcl.mod`.
    pub abs_path: PathBuf,

    /// `sha256:<hex>` of the chart tree. Stable across machines when
    /// file contents + names are identical.
    pub sha256: String,

    /// Whether the resolved tree is a Helm chart or a KCL package.
    /// The render pipeline routes on this — Helm goes to
    /// `materialize_charts_if_any` (synthesized wrapper); KCL goes to
    /// `materialize_kcl_pkgs_if_any` (mounted as ExternalPkg).
    /// Path-deps default to [`PackageKind::HelmChart`] for backwards
    /// compatibility — every existing path-dep is a vendored chart.
    pub kind: PackageKind,

    /// Where the chart canonically comes from. Used by the lockfile
    /// writer to record the source of record even when a `replace`
    /// directive is pulling it off local disk.
    pub source: ResolvedSource,
}

impl ResolvedChart {
    /// `true` when the resolved tree is a KCL module with a top-level
    /// `package.k`. Used by the render path to mount these via the
    /// `pkgs.<alias>` stub umbrella instead of as raw
    /// `kcl_pkgs` ExternalPkg entries (which would fire the upstream's
    /// body at consumer-import time).
    pub fn is_akua_package(&self) -> bool {
        self.kind == PackageKind::KclModule && self.abs_path.join("package.k").is_file()
    }
}

/// The source of a resolved chart in a form suitable for lockfile
/// serialization. Distinct from `mod_file::DependencySource` because
/// it carries the concrete identifier (path / oci ref / git URL) and
/// the replace-override, not just the discriminant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedSource {
    /// Bare path dep — `nginx = { path = "./vendor/nginx" }`. Lockfile
    /// writes `source = "path+file://<declared>"` with `version = "local"`.
    Path { declared: String },

    /// OCI-fetched dep. `blob_digest` is what the registry served us
    /// (sha256 of the helm chart layer); lockfile stores it under
    /// `digest`, subsequent pulls verify against it.
    Oci {
        oci: String,
        version: String,
        blob_digest: String,
    },

    /// OCI-sourced dep with a local fork override applied via
    /// `replace = { path = "..." }`. Lockfile still records the
    /// canonical `oci://…@version` — removing the replace just works.
    OciReplaced {
        oci: String,
        version: String,
        replace_path: String,
    },

    /// Git-sourced dep. `commit_sha` is the resolved full 40-hex git SHA-1;
    /// the lockfile stores it under
    /// `digest` with a `git:` prefix so it doesn't collide with OCI's
    /// `sha256:` scheme.
    Git {
        git: String,
        tag_or_rev: String,
        commit_sha: String,
    },

    /// Git-sourced dep with a `replace` override. Same semantics as
    /// `OciReplaced`.
    GitReplaced {
        git: String,
        /// Either the tag (preferred) or commit SHA.
        tag_or_rev: String,
        replace_path: String,
    },

    /// Helm-repo-sourced dep. `digest` is the `.tgz` sha256
    /// (same value used as the cache key and the
    /// lockfile pin), mirroring how OCI uses its blob digest.
    Helm {
        repo: String,
        chart: String,
        version: String,
        digest: String,
    },
}

impl ResolvedSource {
    /// Project into the triple `merge_into_lock` writes into every
    /// `LockedPackage`: canonical source string, version (or `"local"`
    /// for path deps), replace marker when a fork is active. Isolates
    /// the "how does this variant map to the lockfile" knowledge here
    /// instead of leaking it across every call site.
    /// Stable discriminator for consumers (CLI JSON, verdicts).
    /// `"path" | "oci" | "git"` — collapses the `*Replaced`
    /// variants into their canonical source kind, matching how
    /// `akua.lock` records source-of-record.
    pub fn kind_str(&self) -> &'static str {
        match self {
            ResolvedSource::Path { .. } => "path",
            ResolvedSource::Oci { .. } | ResolvedSource::OciReplaced { .. } => "oci",
            ResolvedSource::Git { .. } | ResolvedSource::GitReplaced { .. } => "git",
            ResolvedSource::Helm { .. } => "helm",
        }
    }

    pub fn to_locked_fields(&self) -> (String, String, Option<crate::lock_file::Replaced>) {
        use crate::lock_file::Replaced;
        match self {
            ResolvedSource::Path { declared } => {
                (format!("path+file://{declared}"), "local".to_string(), None)
            }
            ResolvedSource::Oci { oci, version, .. } => (oci.clone(), version.clone(), None),
            ResolvedSource::OciReplaced {
                oci,
                version,
                replace_path,
            } => (
                oci.clone(),
                version.clone(),
                Some(Replaced {
                    path: replace_path.clone(),
                }),
            ),
            ResolvedSource::Git {
                git, tag_or_rev, ..
            } => (
                format!(
                    "git+{}@{tag_or_rev}",
                    crate::host_auth::canonicalize_url(git)
                ),
                tag_or_rev.clone(),
                None,
            ),
            ResolvedSource::GitReplaced {
                git,
                tag_or_rev,
                replace_path,
            } => (
                format!(
                    "git+{}@{tag_or_rev}",
                    crate::host_auth::canonicalize_url(git)
                ),
                tag_or_rev.clone(),
                Some(Replaced {
                    path: replace_path.clone(),
                }),
            ),
            // Encode the chart in the source-ref fragment so the lockfile
            // shape (name/version/source/digest) is unchanged. The digest
            // already pins the exact `.tgz`; version is the resolved semver.
            ResolvedSource::Helm {
                repo,
                chart,
                version,
                ..
            } => (format!("helm+{repo}#{chart}"), version.clone(), None),
        }
    }
}

/// The resolver's output. Canonical order (alphabetical by dep name)
/// so downstream users — `akua.lock` writers, `charts/` KCL module
/// generators — get deterministic iteration for free. Newtype (rather
/// than a bare `BTreeMap` alias) leaves room for future metadata —
/// resolution timestamps, manifest digest, replace-provenance — to
/// attach without breaking callers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResolvedCharts {
    pub entries: BTreeMap<String, ResolvedChart>,
}

impl ResolvedCharts {
    /// Iterate over the Helm subset only — the deps that flow through
    /// `materialize_charts_if_any` and `helm.template`.
    pub fn helm_charts(&self) -> impl Iterator<Item = (&str, &ResolvedChart)> {
        self.entries
            .iter()
            .filter(|(_, c)| c.kind == PackageKind::HelmChart)
            .map(|(k, v)| (k.as_str(), v))
    }

    /// Iterate over the KCL subset only — the deps that mount as
    /// `ExternalPkg` entries in the KCL evaluator.
    pub fn kcl_pkgs(&self) -> impl Iterator<Item = (&str, &ResolvedChart)> {
        self.entries
            .iter()
            .filter(|(_, c)| c.kind == PackageKind::KclModule)
            .map(|(k, v)| (k.as_str(), v))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ChartResolveError {
    #[error("chart `{name}`: path-dep target `{}` does not exist", path.display())]
    NotFound { name: String, path: PathBuf },

    #[error("chart `{name}`: path-dep target `{}` is not a directory", path.display())]
    NotADirectory { name: String, path: PathBuf },

    #[error("chart `{name}`: i/o at `{}`: {source}", path.display())]
    Io {
        name: String,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// A remote source cannot be resolved inside the offline worker.
    #[error("chart `{name}`: {} source not resolvable in the current mode — {reason}", source_kind_label(*kind))]
    UnsupportedSource {
        name: String,
        kind: DependencySource,
        /// Explains the required host-side materialization.
        reason: &'static str,
    },

    /// Absolute paths in `path = "..."` / `replace.path` are rejected
    /// — the resolver only mounts directories under the workspace.
    /// See CLAUDE.md "`replace` and `path` deps are workspace-local".
    #[error(
        "dependency `{name}`: absolute path `{}` is rejected — \
         path / replace deps must stay under the workspace root",
        path.display()
    )]
    AbsolutePathRejected { name: String, path: PathBuf },

    /// Relative path that canonicalizes outside the workspace
    /// (typically via `..` segments or symlinks). Same workspace-local
    /// invariant as [`AbsolutePathRejected`].
    #[error(
        "dependency `{name}`: path `{}` resolves to `{}`, which escapes the \
         workspace root `{}`",
        requested.display(), resolved.display(), workspace_root.display()
    )]
    PathEscape {
        name: String,
        requested: PathBuf,
        resolved: PathBuf,
        workspace_root: PathBuf,
    },

    /// `replace = { path = "..." }` directive present, but the
    /// process refuses to apply replaces (production / agent
    /// context, or `AKUA_REJECT_REPLACE=1`).
    #[error(
        "dependency `{name}`: `replace` directive rejected — \
         AKUA_REJECT_REPLACE=1 (or agent context) requires unmodified \
         dep resolution"
    )]
    ReplaceRejected { name: String },
}

/// Options passed to the offline render-worker resolver.
/// `reject_replace` controls local overrides. The remaining fields are
/// retained but do not enable fetching, caching or verification here.
#[derive(Debug, Clone, Default)]
pub struct ResolverOptions {
    /// Retained offline-mode setting; this resolver always runs offline.
    pub offline: bool,

    /// Retained artifact-cache location.
    pub cache_root: Option<PathBuf>,

    /// Retained lockfile-pinned digests keyed by dependency name.
    pub expected_digests: BTreeMap<String, String>,

    /// Retained PEM-encoded cosign public key.
    pub cosign_public_key_pem: Option<String>,

    /// Refuse to apply `replace = { path = "..." }` directives. Set
    /// by the CLI in agent context or whenever `AKUA_REJECT_REPLACE`
    /// is in the env — production deployments processing third-party
    /// Packages must run with this on. See CLAUDE.md "`replace` and
    /// `path` deps are workspace-local".
    pub reject_replace: bool,

    /// Retained caller-supplied credentials keyed by URL prefix.
    pub auth: Option<crate::host_auth::HostAuthMap>,
}

impl ResolverOptions {
    /// Construct options with expected digests and the local replace policy.
    /// This does not enable remote resolution inside the worker.
    pub fn online_with(expected_digests: BTreeMap<String, String>) -> Self {
        Self {
            offline: false,
            cache_root: None,
            expected_digests,
            cosign_public_key_pem: None,
            reject_replace: replace_rejected_from_env(),
            auth: None,
        }
    }
}

/// `AKUA_REJECT_REPLACE=1` hard-disables `replace = { path = "..." }`.
/// The CLI also OR's agent-context detection into this default before
/// calling the resolver. Matches the `AKUA_BRIDGE_TRACE` convention
/// (strict `"1"`, anything else is off — including `"true"` / `"yes"` —
/// so production deployments don't silently misread a typo as enabled).
pub fn replace_rejected_from_env() -> bool {
    std::env::var("AKUA_REJECT_REPLACE").is_ok_and(|v| v == "1")
}

/// Resolve with default options. Remote dependencies must already be
/// materialized locally.
pub fn resolve(
    manifest: &AkuaManifest,
    workspace_root: &Path,
) -> Result<ResolvedCharts, ChartResolveError> {
    resolve_with_options(
        manifest,
        workspace_root,
        &ResolverOptions {
            offline: true,
            ..Default::default()
        },
    )
}

/// Resolve local paths, vendored trees and permitted replace overrides.
/// Remote sources without local materialization return
/// [`ChartResolveError::UnsupportedSource`].
pub fn resolve_with_options(
    manifest: &AkuaManifest,
    workspace_root: &Path,
    opts: &ResolverOptions,
) -> Result<ResolvedCharts, ChartResolveError> {
    let mut entries = BTreeMap::new();
    for (name, dep) in &manifest.dependencies {
        // A `replace` directive on oci/git deps overrides resolution:
        // source-of-record stays the canonical oci/git (tracked in
        // lockfile for audit) but files come from the local fork.
        // Bare path deps don't use `replace` (rejected upstream by
        // manifest validation).
        if let Some(replace) = &dep.replace {
            if opts.reject_replace {
                return Err(ChartResolveError::ReplaceRejected { name: name.clone() });
            }
            let chart = resolve_path(
                name,
                &replace.path,
                workspace_root,
                resolved_source_for_replace(name, dep, &replace.path)?,
                PathOrigin::UserManifest,
            )?;
            entries.insert(name.clone(), chart);
            continue;
        }
        let spec = dep.spec();
        // Prefer vendored trees for path/OCI/git dependencies because
        // pulled Packages may no longer contain their canonical sources.
        // Helm-repo dependencies do not support this vendor layout.
        let vendored = if matches!(spec, DependencySpec::Helm { .. }) {
            None
        } else {
            let vendor_kind = match spec {
                DependencySpec::Path { declared } => VendorKind::Path { declared },
                DependencySpec::Oci { oci, version } => VendorKind::Oci {
                    oci,
                    version: version.to_string(),
                },
                DependencySpec::Git { git, .. } => VendorKind::Git {
                    git,
                    tag_or_rev: spec
                        .tag_or_rev()
                        .unwrap_or(VENDORED_LOCK_FALLBACK)
                        .to_string(),
                },
                DependencySpec::Helm { .. } => unreachable!("helm skips vendor-first"),
            };
            resolve_from_vendor(name, workspace_root, dep, vendor_kind)?
        };
        if let Some(chart) = vendored {
            entries.insert(name.clone(), chart);
            continue;
        }
        let chart = match spec {
            DependencySpec::Path { declared } => resolve_path(
                name,
                declared,
                workspace_root,
                ResolvedSource::Path {
                    declared: declared.to_string(),
                },
                PathOrigin::UserManifest,
            )?,
            DependencySpec::Oci { oci, .. } => resolve_oci(name, dep, oci, opts)?,
            DependencySpec::Git { git, .. } => resolve_git(name, dep, git, opts)?,
            DependencySpec::Helm {
                repo,
                chart,
                version,
            } => resolve_helm(name, repo, chart, version, opts)?,
        };
        entries.insert(name.clone(), chart);
    }
    Ok(ResolvedCharts { entries })
}

/// Name of the directory `akua publish` drops embedded dep content
/// into. Convention — lives at `<workspace>/.akua/vendor/<dep-name>/`.
pub const VENDOR_DIR: &str = ".akua/vendor";

/// Which flavor of vendored dep we're materializing. Carries the
/// canonical-source metadata [`ResolvedSource`] needs post-hash.
enum VendorKind<'a> {
    Path { declared: &'a str },
    Oci { oci: &'a str, version: String },
    Git { git: &'a str, tag_or_rev: String },
}

/// If a dep has been pre-vendored at `<workspace>/.akua/vendor/<name>/`,
/// resolve from there without network access.
/// Returns `Ok(None)` when the vendor dir is absent; remote sources then
/// return [`ChartResolveError::UnsupportedSource`]. Mirrors
/// `ResolvedSource::Oci` / `::Git` so the lockfile shape is
/// unchanged; the digest is the recomputed tree sha256 (for Oci) or
/// the `git:<tree-sha>` blend (for Git) — trade-off for offline pulls.
fn resolve_from_vendor(
    name: &str,
    workspace_root: &Path,
    dep: &Dependency,
    kind: VendorKind<'_>,
) -> Result<Option<ResolvedChart>, ChartResolveError> {
    let _ = dep; // reserved for future vendor-time consistency checks
    let vendor_path = workspace_root.join(VENDOR_DIR).join(name);
    if !vendor_path.is_dir() {
        return Ok(None);
    }
    // Seed source with a placeholder digest; resolve_path hashes the
    // tree + assigns `sha256:<hex>`. We patch the source variant
    // with that digest in-place so the ResolvedChart is built once.
    let placeholder = match &kind {
        VendorKind::Path { declared } => ResolvedSource::Path {
            declared: (*declared).to_string(),
        },
        VendorKind::Oci { oci, version } => ResolvedSource::Oci {
            oci: (*oci).to_string(),
            version: version.clone(),
            blob_digest: String::new(),
        },
        VendorKind::Git { git, tag_or_rev } => ResolvedSource::Git {
            git: (*git).to_string(),
            tag_or_rev: tag_or_rev.clone(),
            commit_sha: String::new(),
        },
    };
    let mut chart = resolve_path(
        name,
        &vendor_path.to_string_lossy(),
        workspace_root,
        placeholder,
        PathOrigin::Internal,
    )?;
    match &mut chart.source {
        ResolvedSource::Oci { blob_digest, .. } => {
            *blob_digest = chart.sha256.clone();
        }
        ResolvedSource::Git { commit_sha, .. } => {
            // Commit SHA is stored raw hex (no prefix) in
            // ResolvedSource; the lockfile digest re-prefixes it.
            let raw = chart
                .sha256
                .strip_prefix("sha256:")
                .unwrap_or(&chart.sha256)
                .to_string();
            *commit_sha = raw.clone();
            chart.sha256 = format!("{}{}", crate::lock_file::GIT_DIGEST_PREFIX, raw);
        }
        // Path source has no embedded digest to patch — chart.sha256
        // already holds the vendored-tree hash.
        ResolvedSource::Path { .. } => {}
        _ => {}
    }
    Ok(Some(chart))
}

/// This resolver runs offline inside the render worker. The akuapkg host
/// fetches remote dependencies, verifies them against `akua.lock` and hands
/// the worker their materialized paths before render.
const REMOTE_SOURCE_REASON: &str =
    "the render worker resolves offline; the akuapkg host fetches remote dependencies before render";

fn resolve_oci(
    name: &str,
    _dep: &Dependency,
    _oci: &str,
    _opts: &ResolverOptions,
) -> Result<ResolvedChart, ChartResolveError> {
    Err(ChartResolveError::UnsupportedSource {
        name: name.to_string(),
        kind: DependencySource::Oci,
        reason: REMOTE_SOURCE_REASON,
    })
}

fn resolve_helm(
    name: &str,
    _repo: &str,
    _chart: &str,
    _version: &str,
    _opts: &ResolverOptions,
) -> Result<ResolvedChart, ChartResolveError> {
    Err(ChartResolveError::UnsupportedSource {
        name: name.to_string(),
        kind: DependencySource::Helm,
        reason: REMOTE_SOURCE_REASON,
    })
}

fn resolve_git(
    name: &str,
    _dep: &Dependency,
    _git: &str,
    _opts: &ResolverOptions,
) -> Result<ResolvedChart, ChartResolveError> {
    Err(ChartResolveError::UnsupportedSource {
        name: name.to_string(),
        kind: DependencySource::Git,
        reason: REMOTE_SOURCE_REASON,
    })
}

/// Build the `ResolvedSource::*Replaced` variant from a dep that has
/// both a canonical source (`oci` / `git`) and a `replace.path`.
/// Rejects replace on bare path deps — that shape has no canonical
/// source to preserve.
fn resolved_source_for_replace(
    name: &str,
    dep: &Dependency,
    replace_path: &str,
) -> Result<ResolvedSource, ChartResolveError> {
    let spec = dep.spec();
    match spec {
        DependencySpec::Oci { oci, version } => Ok(ResolvedSource::OciReplaced {
            oci: oci.to_string(),
            version: version.to_string(),
            replace_path: replace_path.to_string(),
        }),
        DependencySpec::Git { git, .. } => Ok(ResolvedSource::GitReplaced {
            git: git.to_string(),
            tag_or_rev: spec.tag_or_rev().unwrap_or("HEAD").to_string(),
            replace_path: replace_path.to_string(),
        }),
        DependencySpec::Path { .. } => unreachable!(
            "replace on a path-only dep should have been rejected by manifest \
             validation (dep `{name}`)"
        ),
        // Helm-repo deps have no resolver yet, so a replace on one is
        // likewise unsupported by this offline resolver.
        DependencySpec::Helm { .. } => Err(ChartResolveError::UnsupportedSource {
            name: name.to_string(),
            kind: DependencySource::Helm,
            reason: "helm-repo dependencies are not yet supported",
        }),
    }
}

/// Upsert every [`ResolvedChart`] into `lock` as a [`LockedPackage`].
/// Preserves prior `signature` / `attestation` when the entry already
/// existed so a merge doesn't silently drop cosign metadata a
/// follow-up `akua publish` has since populated.
/// Cross-validate that every dep alias referenced by a top-level
/// `import <alias>` statement in `package.k` resolves to a
/// `KclModule`-shaped artifact. Aliases that resolve as `HelmChart`
/// or aren't in `[dependencies]` at all aren't reachable through
/// KCL's import resolver — `akua check` would later fail with
/// `CannotFindModule`. Catching the mismatch at lock time gives
/// the user a clear "wrong dep kind" error pointing at the offending
/// alias instead of an opaque downstream parse error.
///
/// Returns the offending mismatches (each with the alias + the
/// kind the resolver landed on). Caller decides whether to fail
/// hard (`akua lock`) or report only (`akua tree`).
pub fn validate_import_kinds(
    package_k_source: &str,
    resolved: &ResolvedCharts,
) -> Vec<ImportKindMismatch> {
    // No deps declared → no possible mismatches. Common case for
    // standalone Packages; skip the line scan entirely.
    if resolved.entries.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for alias in scan_top_level_import_roots(package_k_source) {
        // Stdlib + ad-hoc aliases (`akua.*`, `kcl_plugin.*`, `charts.*`,
        // and anything else not declared in `[dependencies]`) don't
        // need a corresponding dep entry — they come from the host
        // stdlib mount or the chart-resolver's synthetic `charts/`
        // wrapper, neither of which is user-visible in akua.toml.
        if alias == "akua" || alias == "kcl_plugin" || alias == "charts" {
            continue;
        }
        let Some(chart) = resolved.entries.get(&alias) else {
            // Not in [dependencies] — the KCL parser will surface
            // CannotFindModule on its own; let it. Lock-time isn't
            // the place to invent new "import points at nothing"
            // errors when the existing one is sufficient.
            continue;
        };
        if chart.kind != PackageKind::KclModule {
            out.push(ImportKindMismatch {
                alias,
                resolved_kind: chart.kind,
            });
        }
    }
    out
}

/// One offending alias for [`validate_import_kinds`]. The pair is
/// enough for the caller to construct an `E_DEP_KIND_MISMATCH`
/// message — the resolved-source detail (path / oci / git) is
/// available off the `ResolvedCharts` map if needed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportKindMismatch {
    pub alias: String,
    pub resolved_kind: PackageKind,
}

/// Scan a `package.k` for top-level `import <alias>(.path)?( as Y)?`
/// statements and collect the root identifier (`<alias>`).
///
/// Conservative line-based parser — KCL imports are a single line, the
/// language doesn't support multi-line imports, and import statements
/// must precede any other top-level construct. Stops at the first
/// non-blank, non-comment, non-import line. We don't need a full KCL
/// parser for this; the workspace's KCL evaluator does the real
/// validation downstream (this pass is the early-warning gate).
fn scan_top_level_import_roots(source: &str) -> Vec<String> {
    // Cheap pre-check: if the file contains no `import ` token at all,
    // skip the per-line scan + per-line allocations. KCL forbids
    // imports anywhere except the top of the file, so a substring
    // miss is a definitive negative.
    if !source.contains("import ") {
        return Vec::new();
    }
    let mut out = Vec::new();
    for line in source.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("import ") else {
            // KCL forbids any other top-level construct above imports,
            // so the first non-blank, non-comment, non-import line
            // means the import block is over. Stop scanning.
            break;
        };
        // Take the dotted path up to whitespace, comment, or `as`.
        let path: String = rest
            .chars()
            .take_while(|c| !c.is_whitespace() && *c != '#')
            .collect();
        if path.is_empty() {
            continue;
        }
        // Root identifier is everything before the first `.`.
        let root = path.split('.').next().unwrap_or(&path).to_string();
        if !root.is_empty() {
            out.push(root);
        }
    }
    out
}

pub fn merge_into_lock(lock: &mut crate::lock_file::AkuaLock, resolved: &ResolvedCharts) {
    for chart in resolved.entries.values() {
        upsert_locked_from_source(lock, &chart.name, &chart.source, &chart.sha256);
    }
    lock.sort();
}

/// Upsert one `LockedPackage` from a resolved source + digest. Shared
/// between [`merge_into_lock`] and `vendor::add_impl`.
///
/// Bytes-tied metadata (signature / attestation / dependencies /
/// yanked / kyverno-converter fields) carries forward only when the
/// digest is unchanged — preserving them across a digest change would
/// write `(digest=B, sig=sig(A))` entries that no consumer can verify.
pub fn upsert_locked_from_source(
    lock: &mut crate::lock_file::AkuaLock,
    name: &str,
    source: &ResolvedSource,
    digest: &str,
) {
    use crate::lock_file::LockedPackage;
    let (source_str, version, replaced) = source.to_locked_fields();
    // Single linear scan: find_slot pinpoints the upsert position AND
    // gives us the prior entry for digest-match check, so the bigger
    // merge_into_lock loop is O(n) rather than O(n²).
    let slot = lock.find_slot(name, &version);
    let carry = slot
        .map(|i| &lock.packages[i])
        .filter(|p| p.digest == digest);
    let entry = LockedPackage {
        name: name.to_string(),
        version,
        source: source_str,
        digest: digest.to_string(),
        vendor_digest: carry.and_then(|p| p.vendor_digest.clone()),
        signature: carry.and_then(|p| p.signature.clone()),
        attestation: carry.and_then(|p| p.attestation.clone()),
        dependencies: carry.map(|p| p.dependencies.clone()).unwrap_or_default(),
        replaced,
        yanked: carry.and_then(|p| p.yanked),
        kyverno_source_digest: carry.and_then(|p| p.kyverno_source_digest.clone()),
        converter_version: carry.and_then(|p| p.converter_version.clone()),
    };
    lock.upsert_at(slot, entry);
}

/// Pick the package kind for a path/git dep tree: a KCL package when it has
/// `kcl.mod`, or `akua.toml` with `package.k`; otherwise a Helm chart.
fn detect_dep_kind(dir: &Path) -> PackageKind {
    if dir.join("kcl.mod").is_file()
        || (dir.join("akua.toml").is_file() && dir.join("package.k").is_file())
    {
        PackageKind::KclModule
    } else {
        PackageKind::HelmChart
    }
}

/// Human-readable tag for a dep source. Used by `UnsupportedSource`'s
/// `#[error(...)]` template.
fn source_kind_label(source: DependencySource) -> &'static str {
    match source {
        DependencySource::Oci => "oci://",
        DependencySource::Git => "git",
        DependencySource::Path => "path",
        DependencySource::Helm => "helm",
    }
}

/// Origin of a path string handed to [`resolve_path`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathOrigin {
    /// `path = "..."` or `replace.path = "..."` in user-authored
    /// `akua.toml`. Absolute and escape paths are rejected — see
    /// CLAUDE.md "`replace` and `path` deps are workspace-local".
    UserManifest,
    /// Resolver-managed vendor path, rather than a user-declared path.
    Internal,
}

/// Outcome of [`validate_workspace_path`]. Each variant maps to a
/// caller-domain error variant + the `E_PATH_ESCAPE` structured code.
#[derive(Debug)]
pub(crate) enum WorkspacePathError {
    AbsoluteRejected {
        path: PathBuf,
    },
    NotFound {
        path: PathBuf,
    },
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Escape {
        resolved: PathBuf,
        workspace_root: PathBuf,
    },
}

/// Validate a user-authored relative path against the workspace-local
/// invariant. Used by `chart_resolver::resolve_path` (path-dep
/// resolution) and `vendor::resolve_path_dep` (vendoring path deps)
/// — both must canonicalize the joined target and reject anything
/// that escapes the workspace root.
///
/// Returns the canonical target on success. Caller is responsible
/// for the kind-specific check (`is_dir` for vendor, full chart
/// validation for the resolver).
///
/// `workspace_canon` should be the **already-canonicalized** workspace
/// root — caller canonicalizes once and threads it through, so we
/// don't pay the syscall on every dep in a multi-dep manifest. If
/// the workspace root itself can't be canonicalized that's a fatal
/// caller-side condition (broken workspace), not something this
/// helper should silently paper over.
pub(crate) fn validate_workspace_path(
    workspace_canon: &Path,
    workspace_root: &Path,
    requested: &str,
) -> Result<PathBuf, WorkspacePathError> {
    let rel = PathBuf::from(requested);
    if rel.is_absolute() {
        return Err(WorkspacePathError::AbsoluteRejected { path: rel });
    }
    let joined = workspace_root.join(&rel);
    let canon = match joined.canonicalize() {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(WorkspacePathError::NotFound { path: joined });
        }
        Err(e) => {
            return Err(WorkspacePathError::Io {
                path: joined,
                source: e,
            });
        }
    };
    if !canon.starts_with(workspace_canon) {
        return Err(WorkspacePathError::Escape {
            resolved: canon,
            workspace_root: workspace_canon.to_path_buf(),
        });
    }
    Ok(canon)
}

fn resolve_path(
    name: &str,
    requested: &str,
    workspace_root: &Path,
    source: ResolvedSource,
    origin: PathOrigin,
) -> Result<ResolvedChart, ChartResolveError> {
    let canon = match origin {
        PathOrigin::UserManifest => {
            // Canonicalize the workspace once. If this fails the
            // workspace itself is broken; surface it.
            let workspace_canon =
                workspace_root
                    .canonicalize()
                    .map_err(|e| ChartResolveError::Io {
                        name: name.to_string(),
                        path: workspace_root.to_path_buf(),
                        source: e,
                    })?;
            match validate_workspace_path(&workspace_canon, workspace_root, requested) {
                Ok(canon) => canon,
                Err(WorkspacePathError::AbsoluteRejected { path }) => {
                    return Err(ChartResolveError::AbsolutePathRejected {
                        name: name.to_string(),
                        path,
                    });
                }
                Err(WorkspacePathError::NotFound { path }) => {
                    return Err(ChartResolveError::NotFound {
                        name: name.to_string(),
                        path,
                    });
                }
                Err(WorkspacePathError::Io { path, source }) => {
                    return Err(ChartResolveError::Io {
                        name: name.to_string(),
                        path,
                        source,
                    });
                }
                Err(WorkspacePathError::Escape {
                    resolved,
                    workspace_root: ws,
                }) => {
                    return Err(ChartResolveError::PathEscape {
                        name: name.to_string(),
                        requested: PathBuf::from(requested),
                        resolved,
                        workspace_root: ws,
                    });
                }
            }
        }
        PathOrigin::Internal => {
            // This path is constructed by the resolver, rather than supplied
            // by the manifest. Canonicalize without the user-path escape guard.
            let rel = PathBuf::from(requested);
            let joined = if rel.is_absolute() {
                rel
            } else {
                workspace_root.join(&rel)
            };
            match joined.canonicalize() {
                Ok(p) => p,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(ChartResolveError::NotFound {
                        name: name.to_string(),
                        path: joined,
                    });
                }
                Err(e) => {
                    return Err(ChartResolveError::Io {
                        name: name.to_string(),
                        path: joined,
                        source: e,
                    });
                }
            }
        }
    };

    let meta = canon.metadata().map_err(|e| ChartResolveError::Io {
        name: name.to_string(),
        path: canon.clone(),
        source: e,
    })?;
    if !meta.is_dir() {
        return Err(ChartResolveError::NotADirectory {
            name: name.to_string(),
            path: canon,
        });
    }

    let (sha256, _size_bytes) = hash_dir(&canon).map_err(|e| ChartResolveError::Io {
        name: name.to_string(),
        path: canon.clone(),
        source: e,
    })?;

    let kind = detect_dep_kind(&canon);

    Ok(ResolvedChart {
        name: name.to_string(),
        abs_path: canon,
        sha256,
        kind,
        source,
    })
}

/// Content-hash a directory tree. Walks files in sorted-by-relative-path
/// order so the digest is stable across filesystems (ext4 returns
/// `readdir` order; APFS returns arbitrary order). For each file the
/// hasher absorbs `<rel_path>\0<bytes>\n` — the NUL separator rules out
/// a "file A ends where file B's name begins" collision.
///
/// Symlinks are skipped entirely: their target lives outside the chart
/// dir, which breaks both determinism and the sandbox assumption that
/// the tarball we hand the engine has no escape hatches. An actual
/// chart needing a symlink is already broken on Windows hosts.
/// Deterministic content-hash of a directory tree, plus the total bytes
/// hashed. Returns `(sha256:<hex>, size_bytes)`. Used by both the chart
/// resolver (path-dep digest) and the vendor module (vendored-tree digest)
/// — keep this the single canonical implementation.
pub(crate) fn hash_dir(root: &Path) -> std::io::Result<(String, u64)> {
    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    let mut size_bytes = 0_u64;
    for (rel, abs) in files {
        // Use `to_string_lossy` for cross-platform parity: Windows uses
        // UTF-16 OsStr internally; Unix is bytes. A chart with
        // non-UTF8-path filenames is broken regardless — collapsing
        // here doesn't create realistic collisions.
        hasher.update(rel.to_string_lossy().as_bytes());
        hasher.update(b"\0");
        // Stream the file into the hasher so multi-MB values.yaml
        // or long template trees don't balloon memory. BufReader
        // + io::copy is the standard pattern. `io::copy` returns the
        // bytes streamed — accumulate it instead of a separate
        // `metadata().len()` syscall.
        let file = std::fs::File::open(&abs)?;
        let mut reader = std::io::BufReader::new(file);
        let copied = std::io::copy(&mut reader, &mut hasher)?;
        size_bytes = size_bytes.saturating_add(copied);
        hasher.update(b"\n");
    }
    Ok((
        format!("sha256:{}", hex_encode(&hasher.finalize())),
        size_bytes,
    ))
}

fn collect_files(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(PathBuf, PathBuf)>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let path = entry.path();
        if ft.is_dir() {
            collect_files(root, &path, out)?;
        } else if ft.is_file() {
            let rel = path
                .strip_prefix(root)
                .expect("walker stays under root")
                .to_path_buf();
            out.push((rel, path));
        }
        // Symlinks deliberately skipped — see `hash_dir` rationale.
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_extracts_root_idents_from_dotted_aliased_imports() {
        let src = "\
            import akua.ctx\n\
            import akua.pkg as p\n\
            import upstream\n\
            import upstream.subpkg as sub\n\
            \n\
            # not an import\n\
            schema Input:\n\
                x: str\n\
        ";
        let roots = scan_top_level_import_roots(src);
        assert_eq!(
            roots,
            vec![
                "akua".to_string(),
                "akua".to_string(),
                "upstream".to_string(),
                "upstream".to_string(),
            ],
        );
    }

    #[test]
    fn scan_stops_at_first_non_import_top_level_line() {
        // KCL forbids any other top-level construct above imports;
        // the scanner mirrors that — once non-import code starts the
        // import block is over, even if a later line happens to start
        // with "import" (it'd be syntactically invalid KCL anyway).
        let src = "\
            import akua.ctx\n\
            schema X:\n    y: str\n\
            import too_late\n\
        ";
        let roots = scan_top_level_import_roots(src);
        assert_eq!(roots, vec!["akua".to_string()]);
    }

    #[test]
    fn scan_skips_blanks_and_comments_in_import_block() {
        let src = "\
            # leading comment\n\
            \n\
            import akua.ctx\n\
            \n\
            # mid-block comment\n\
            import upstream\n\
        ";
        let roots = scan_top_level_import_roots(src);
        assert_eq!(roots, vec!["akua".to_string(), "upstream".to_string()]);
    }

    #[test]
    fn validate_flags_helm_chart_referenced_via_import() {
        // Spike-1 issue #3 repro at the unit level: a dep classified
        // as HelmChart with a matching `import` in package.k surfaces
        // the mismatch.
        let mut entries = std::collections::BTreeMap::new();
        entries.insert(
            "upstream".to_string(),
            ResolvedChart {
                name: "upstream".to_string(),
                abs_path: PathBuf::from("/cache/upstream"),
                sha256: "deadbeef".into(),
                kind: PackageKind::HelmChart,
                source: ResolvedSource::Path {
                    declared: "../upstream".into(),
                },
            },
        );
        let resolved = ResolvedCharts { entries };
        let mismatches = validate_import_kinds("import upstream\nresources = []\n", &resolved);
        assert_eq!(mismatches.len(), 1);
        assert_eq!(mismatches[0].alias, "upstream");
        assert_eq!(mismatches[0].resolved_kind, PackageKind::HelmChart);
    }

    #[test]
    fn validate_passes_when_kcl_module_is_imported() {
        let mut entries = std::collections::BTreeMap::new();
        entries.insert(
            "upstream".to_string(),
            ResolvedChart {
                name: "upstream".to_string(),
                abs_path: PathBuf::from("/cache/upstream"),
                sha256: "deadbeef".into(),
                kind: PackageKind::KclModule,
                source: ResolvedSource::Path {
                    declared: "../upstream".into(),
                },
            },
        );
        let resolved = ResolvedCharts { entries };
        let mismatches = validate_import_kinds("import upstream\nresources = []\n", &resolved);
        assert!(
            mismatches.is_empty(),
            "expected no mismatches, got {mismatches:?}"
        );
    }

    #[test]
    fn validate_ignores_stdlib_and_unknown_aliases() {
        // `akua.*` and `kcl_plugin.*` are stdlib mounts — never in
        // [dependencies]. Aliases NOT in the resolved map are left to
        // KCL's CannotFindModule path; lock-time isn't the place.
        let entries = std::collections::BTreeMap::new();
        let resolved = ResolvedCharts { entries };
        let src = "\
            import akua.ctx\n\
            import kcl_plugin.helm\n\
            import charts.nginx\n\
            import never_declared\n\
        ";
        assert!(validate_import_kinds(src, &resolved).is_empty());
    }

    fn minimal_manifest(body: &str) -> AkuaManifest {
        let src = format!(
            r#"
[package]
name    = "test"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
{body}
"#
        );
        AkuaManifest::parse(&src).expect("manifest parse")
    }

    /// Write a minimal chart tree (Chart.yaml + templates/cm.yaml) at
    /// `root`. Returns `root` for fluency in the callsite.
    fn write_minimal_chart(root: &Path) -> PathBuf {
        std::fs::create_dir_all(root.join("templates")).unwrap();
        std::fs::write(
            root.join("Chart.yaml"),
            "apiVersion: v2\nname: demo\nversion: 0.1.0\n",
        )
        .unwrap();
        std::fs::write(
            root.join("templates/cm.yaml"),
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n",
        )
        .unwrap();
        root.to_path_buf()
    }

    #[test]
    fn resolves_local_path_dep() {
        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join("charts/nginx"));
        let manifest = minimal_manifest(r#"nginx = { path = "./charts/nginx" }"#);

        let resolved = resolve(&manifest, ws.path()).expect("resolve");
        assert_eq!(resolved.entries.len(), 1);
        let nginx = resolved.entries.get("nginx").expect("nginx entry");
        assert_eq!(nginx.name, "nginx");
        assert!(nginx.abs_path.ends_with("charts/nginx"));
        assert!(nginx.abs_path.is_absolute());
        assert!(
            nginx.sha256.starts_with("sha256:"),
            "digest shape: {}",
            nginx.sha256
        );
        assert_eq!(nginx.sha256.len(), "sha256:".len() + 64);
    }

    #[test]
    fn helm_dep_skips_vendor_first_and_needs_a_pinned_digest_offline() {
        // Helm-repo deps do not use this vendor layout and remain unsupported
        // inside the worker even if a vendor directory happens to exist.
        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join(".akua/vendor/temporal"));
        let manifest = minimal_manifest(
            r#"temporal = { repo = "https://go.temporal.io/helm-charts", chart = "temporal", version = "0.62.0" }"#,
        );
        let err = resolve(&manifest, ws.path()).expect_err("offline helm dep must be unsupported");
        assert!(
            matches!(
                err,
                ChartResolveError::UnsupportedSource {
                    kind: DependencySource::Helm,
                    ..
                }
            ),
            "expected UnsupportedSource(Helm), got: {err:?}"
        );
    }

    #[test]
    fn digest_is_stable_across_calls() {
        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join("charts/nginx"));
        let manifest = minimal_manifest(r#"nginx = { path = "./charts/nginx" }"#);

        let a = resolve(&manifest, ws.path()).unwrap();
        let b = resolve(&manifest, ws.path()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn digest_changes_when_chart_contents_change() {
        let ws = tempfile::tempdir().unwrap();
        let chart = ws.path().join("charts/nginx");
        write_minimal_chart(&chart);
        let manifest = minimal_manifest(r#"nginx = { path = "./charts/nginx" }"#);
        let before = resolve(&manifest, ws.path()).unwrap();

        // Mutate one template.
        std::fs::write(
            chart.join("templates/cm.yaml"),
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo2\n",
        )
        .unwrap();

        let after = resolve(&manifest, ws.path()).unwrap();
        assert_ne!(
            before.entries.get("nginx").unwrap().sha256,
            after.entries.get("nginx").unwrap().sha256
        );
    }

    #[test]
    fn digest_stable_across_file_creation_order() {
        // Create two charts with the same final contents but different
        // creation sequences — digest should match. Guards against
        // `readdir`-order flakiness on unsorted hashing.
        let ws_a = tempfile::tempdir().unwrap();
        let ws_b = tempfile::tempdir().unwrap();
        let chart_a = ws_a.path().join("c");
        let chart_b = ws_b.path().join("c");
        std::fs::create_dir_all(chart_a.join("templates")).unwrap();
        std::fs::create_dir_all(chart_b.join("templates")).unwrap();

        // A: Chart.yaml first, then cm.yaml
        std::fs::write(chart_a.join("Chart.yaml"), "v: 1\n").unwrap();
        std::fs::write(chart_a.join("templates/cm.yaml"), "body\n").unwrap();
        // B: cm.yaml first, then Chart.yaml
        std::fs::write(chart_b.join("templates/cm.yaml"), "body\n").unwrap();
        std::fs::write(chart_b.join("Chart.yaml"), "v: 1\n").unwrap();

        let mani_a = minimal_manifest(r#"x = { path = "./c" }"#);
        let mani_b = minimal_manifest(r#"x = { path = "./c" }"#);
        let a = resolve(&mani_a, ws_a.path()).unwrap();
        let b = resolve(&mani_b, ws_b.path()).unwrap();
        assert_eq!(
            a.entries.get("x").unwrap().sha256,
            b.entries.get("x").unwrap().sha256
        );
    }

    #[test]
    fn multiple_deps_alphabetical() {
        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join("charts/zulu"));
        write_minimal_chart(&ws.path().join("charts/alpha"));
        let manifest = minimal_manifest(
            r#"
zulu  = { path = "./charts/zulu" }
alpha = { path = "./charts/alpha" }
"#,
        );
        let resolved = resolve(&manifest, ws.path()).unwrap();
        let names: Vec<&str> = resolved.entries.keys().map(String::as_str).collect();
        assert_eq!(names, vec!["alpha", "zulu"], "BTreeMap iteration is sorted");
    }

    #[test]
    fn missing_path_dep_produces_typed_error() {
        let ws = tempfile::tempdir().unwrap();
        let manifest = minimal_manifest(r#"ghost = { path = "./nope" }"#);
        let err = resolve(&manifest, ws.path()).unwrap_err();
        assert!(
            matches!(err, ChartResolveError::NotFound { ref name, .. } if name == "ghost"),
            "got: {err:?}"
        );
    }

    #[test]
    fn path_dep_pointing_at_a_file_is_rejected() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::write(ws.path().join("not-a-chart.txt"), "hi").unwrap();
        let manifest = minimal_manifest(r#"bad = { path = "./not-a-chart.txt" }"#);
        let err = resolve(&manifest, ws.path()).unwrap_err();
        assert!(
            matches!(err, ChartResolveError::NotADirectory { ref name, .. } if name == "bad"),
            "got: {err:?}"
        );
    }

    #[test]
    fn oci_dep_surfaces_typed_error_in_offline_mode() {
        let ws = tempfile::tempdir().unwrap();
        let manifest =
            minimal_manifest(r#"nginx = { oci = "oci://ghcr.io/foo/nginx", version = "1.0.0" }"#);
        let err = resolve(&manifest, ws.path()).unwrap_err();
        assert!(
            matches!(
                err,
                ChartResolveError::UnsupportedSource {
                    ref name,
                    kind: DependencySource::Oci,
                    ..
                } if name == "nginx"
            ),
            "got: {err:?}"
        );
        // Explain the worker's offline boundary in the error.
        assert!(err.to_string().contains("offline"), "got: {err}");
    }

    #[test]
    fn git_dep_surfaces_typed_error_in_offline_mode() {
        // A Git dependency without local materialization is unsupported
        // inside the offline worker.
        let ws = tempfile::tempdir().unwrap();
        let manifest =
            minimal_manifest(r#"libs = { git = "https://github.com/foo/bar", tag = "v1.0.0" }"#);
        let err = resolve(&manifest, ws.path()).unwrap_err();
        assert!(
            matches!(
                err,
                ChartResolveError::UnsupportedSource {
                    ref name,
                    kind: DependencySource::Git,
                    ..
                } if name == "libs"
            ),
            "got: {err:?}"
        );
        assert!(err.to_string().contains("offline"), "got: {err}");
    }

    #[test]
    fn resolved_source_is_path_for_bare_path_dep() {
        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join("charts/nginx"));
        let manifest = minimal_manifest(r#"nginx = { path = "./charts/nginx" }"#);
        let resolved = resolve(&manifest, ws.path()).unwrap();
        let nginx = resolved.entries.get("nginx").unwrap();
        assert_eq!(
            nginx.source,
            ResolvedSource::Path {
                declared: "./charts/nginx".to_string()
            }
        );
    }

    #[test]
    fn oci_dep_with_replace_resolves_from_fork_path() {
        // Dev-workflow staple: pull chart source from local fork while
        // the lockfile still pins the canonical `oci://` digest.
        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join("charts/nginx-fork"));
        let manifest = minimal_manifest(
            r#"nginx = { oci = "oci://r/n", version = "1.0.0", replace = { path = "./charts/nginx-fork" } }"#,
        );
        let resolved = resolve(&manifest, ws.path()).expect("replace should resolve");
        let nginx = resolved.entries.get("nginx").unwrap();
        assert!(nginx.abs_path.ends_with("charts/nginx-fork"));
        assert!(nginx.sha256.starts_with("sha256:"));
        match &nginx.source {
            ResolvedSource::OciReplaced {
                oci,
                version,
                replace_path,
            } => {
                assert_eq!(oci, "oci://r/n");
                assert_eq!(version, "1.0.0");
                assert_eq!(replace_path, "./charts/nginx-fork");
            }
            other => panic!("expected OciReplaced, got {other:?}"),
        }
    }

    #[test]
    fn git_dep_with_replace_carries_canonical_source_through() {
        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join("charts/lib-fork"));
        let manifest = minimal_manifest(
            r#"libs = { git = "https://github.com/foo/bar", tag = "v1.2.3", replace = { path = "./charts/lib-fork" } }"#,
        );
        let resolved = resolve(&manifest, ws.path()).unwrap();
        match &resolved.entries.get("libs").unwrap().source {
            ResolvedSource::GitReplaced {
                git,
                tag_or_rev,
                replace_path,
            } => {
                assert_eq!(git, "https://github.com/foo/bar");
                assert_eq!(tag_or_rev, "v1.2.3");
                assert_eq!(replace_path, "./charts/lib-fork");
            }
            other => panic!("expected GitReplaced, got {other:?}"),
        }
    }

    #[test]
    fn git_dep_replace_prefers_tag_over_rev() {
        // When both tag and rev are set, tag wins in the lockfile source.
        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join("fork"));
        let manifest = minimal_manifest(
            r#"libs = { git = "https://x/y", tag = "v1.0", rev = "abc123", replace = { path = "./fork" } }"#,
        );
        let resolved = resolve(&manifest, ws.path()).unwrap();
        match &resolved.entries.get("libs").unwrap().source {
            ResolvedSource::GitReplaced { tag_or_rev, .. } => {
                assert_eq!(tag_or_rev, "v1.0", "tag takes precedence over rev");
            }
            _ => panic!("expected GitReplaced"),
        }
    }

    #[test]
    fn replace_with_missing_path_still_surfaces_typed_error() {
        // Replace directive pointing at a non-existent path is a user
        // error — the resolver must report NotFound naming the dep.
        let ws = tempfile::tempdir().unwrap();
        let manifest = minimal_manifest(
            r#"nginx = { oci = "oci://r/n", version = "1.0.0", replace = { path = "./nope" } }"#,
        );
        let err = resolve(&manifest, ws.path()).unwrap_err();
        assert!(
            matches!(err, ChartResolveError::NotFound { ref name, .. } if name == "nginx"),
            "got: {err:?}"
        );
    }

    #[test]
    fn merge_into_lock_populates_path_deps() {
        use crate::lock_file::AkuaLock;

        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join("charts/nginx"));
        let manifest = minimal_manifest(r#"nginx = { path = "./charts/nginx" }"#);
        let resolved = resolve(&manifest, ws.path()).unwrap();

        let mut lock = AkuaLock::empty();
        merge_into_lock(&mut lock, &resolved);

        assert_eq!(lock.packages.len(), 1);
        let entry = &lock.packages[0];
        assert_eq!(entry.name, "nginx");
        assert_eq!(entry.version, "local");
        assert_eq!(entry.source, "path+file://./charts/nginx");
        assert!(entry.digest.starts_with("sha256:"));
        assert!(entry.replaced.is_none());
    }

    #[test]
    fn merge_into_lock_records_replaced_canonical_source() {
        use crate::lock_file::AkuaLock;

        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join("charts/nginx-fork"));
        let manifest = minimal_manifest(
            r#"nginx = { oci = "oci://r/n", version = "1.0.0", replace = { path = "./charts/nginx-fork" } }"#,
        );
        let resolved = resolve(&manifest, ws.path()).unwrap();

        let mut lock = AkuaLock::empty();
        merge_into_lock(&mut lock, &resolved);

        let entry = &lock.packages[0];
        assert_eq!(entry.source, "oci://r/n");
        assert_eq!(entry.version, "1.0.0");
        assert_eq!(
            entry.replaced.as_ref().map(|r| r.path.as_str()),
            Some("./charts/nginx-fork")
        );
    }

    #[test]
    fn merge_into_lock_preserves_signature_when_digest_unchanged() {
        use crate::lock_file::{AkuaLock, LockedPackage};

        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join("charts/nginx"));
        let manifest = minimal_manifest(r#"nginx = { path = "./charts/nginx" }"#);

        // Pre-populate the lock with a prior entry whose digest matches
        // what the resolver will produce — first compute the live digest.
        let resolved = resolve(&manifest, ws.path()).unwrap();
        let live_digest = resolved.entries.get("nginx").unwrap().sha256.clone();

        let mut lock = AkuaLock::empty();
        lock.packages.push(LockedPackage {
            name: "nginx".to_string(),
            version: "local".to_string(),
            source: "path+file://./charts/nginx".to_string(),
            digest: live_digest.clone(),
            vendor_digest: None,
            signature: Some("cosign:sigstore:prior-publish".to_string()),
            attestation: Some("slsa:prior".to_string()),
            dependencies: vec!["transitive@1.0.0".to_string()],
            replaced: None,
            yanked: Some(false),
            kyverno_source_digest: None,
            converter_version: None,
        });

        merge_into_lock(&mut lock, &resolved);

        let entry = &lock.packages[0];
        assert_eq!(entry.digest, live_digest);
        assert_eq!(
            entry.signature.as_deref(),
            Some("cosign:sigstore:prior-publish")
        );
        assert_eq!(entry.attestation.as_deref(), Some("slsa:prior"));
        assert_eq!(entry.dependencies, vec!["transitive@1.0.0".to_string()]);
        assert_eq!(entry.yanked, Some(false));
    }

    /// Bytes-tied metadata (sig / attestation / deps / yanked / kyverno)
    /// must drop when digest changes, so the lockfile never carries
    /// `(digest=B, sig=sig(A))`.
    #[test]
    fn merge_into_lock_clears_signature_when_digest_changes() {
        use crate::lock_file::{AkuaLock, LockedPackage};

        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join("charts/nginx"));
        let manifest = minimal_manifest(r#"nginx = { path = "./charts/nginx" }"#);

        let mut lock = AkuaLock::empty();
        lock.packages.push(LockedPackage {
            name: "nginx".to_string(),
            version: "local".to_string(),
            source: "path+file://./charts/nginx".to_string(),
            digest: "sha256:0000".to_string(), // stale — won't match live
            vendor_digest: Some("sha256:vendor-prior".to_string()),
            signature: Some("cosign:sigstore:prior-publish".to_string()),
            attestation: Some("slsa:prior".to_string()),
            dependencies: vec!["transitive@1.0.0".to_string()],
            replaced: None,
            yanked: Some(true),
            kyverno_source_digest: Some("sha256:kyverno-prior".to_string()),
            converter_version: Some("v1.2.3".to_string()),
        });

        let resolved = resolve(&manifest, ws.path()).unwrap();
        merge_into_lock(&mut lock, &resolved);

        let entry = &lock.packages[0];
        assert_ne!(entry.digest, "sha256:0000");
        assert_eq!(entry.signature, None);
        assert_eq!(entry.attestation, None);
        assert!(entry.dependencies.is_empty());
        assert_eq!(entry.yanked, None);
        assert_eq!(entry.vendor_digest, None);
        assert_eq!(entry.kyverno_source_digest, None);
        assert_eq!(entry.converter_version, None);
    }

    #[test]
    fn resolver_options_carry_cosign_public_key() {
        let opts = ResolverOptions {
            cosign_public_key_pem: Some(
                "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n".into(),
            ),
            ..Default::default()
        };
        assert!(opts.cosign_public_key_pem.is_some());
    }

    #[test]
    fn vendored_oci_dep_resolves_locally_and_skips_network() {
        let ws = tempfile::tempdir().unwrap();
        // `akua publish` convention: chart content pre-populated at
        // `.akua/vendor/<name>/`.
        write_minimal_chart(&ws.path().join(".akua/vendor/nginx"));
        let manifest = minimal_manifest(
            r#"nginx = { oci = "oci://ghcr.io/acme/charts/nginx", version = "1.0.0" }"#,
        );

        let resolved = resolve(&manifest, ws.path()).expect("vendor resolves offline");
        let nginx = resolved.entries.get("nginx").unwrap();
        assert!(nginx.abs_path.ends_with(".akua/vendor/nginx"));
        match &nginx.source {
            ResolvedSource::Oci {
                oci,
                version,
                blob_digest,
            } => {
                assert_eq!(oci, "oci://ghcr.io/acme/charts/nginx");
                assert_eq!(version, "1.0.0");
                // blob_digest is the recomputed tree sha, not empty.
                assert!(blob_digest.starts_with("sha256:"));
            }
            other => panic!("expected ResolvedSource::Oci, got {other:?}"),
        }
    }

    #[test]
    fn vendored_git_dep_resolves_locally() {
        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join(".akua/vendor/libs"));
        let manifest =
            minimal_manifest(r#"libs = { git = "https://github.com/foo/bar", tag = "v1.0.0" }"#);
        let resolved = resolve(&manifest, ws.path()).expect("vendor resolves offline");
        let libs = resolved.entries.get("libs").unwrap();
        match &libs.source {
            ResolvedSource::Git {
                git,
                tag_or_rev,
                commit_sha,
            } => {
                assert_eq!(git, "https://github.com/foo/bar");
                assert_eq!(tag_or_rev, "v1.0.0");
                assert!(!commit_sha.is_empty());
            }
            other => panic!("expected ResolvedSource::Git, got {other:?}"),
        }
        assert!(libs.sha256.starts_with("git:"));
    }

    #[test]
    fn vendored_path_dep_resolves_from_vendor_tree() {
        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join(".akua/vendor/local"));
        let manifest = minimal_manifest(r#"local = { path = "./vendored-source" }"#);
        let resolved = resolve(&manifest, ws.path()).expect("vendor-first works for path deps");
        let local = resolved.entries.get("local").unwrap();
        assert!(local.abs_path.ends_with(".akua/vendor/local"));
        match &local.source {
            ResolvedSource::Path { declared } => {
                assert_eq!(declared, "./vendored-source");
            }
            other => panic!("expected ResolvedSource::Path, got {other:?}"),
        }
        assert!(local.sha256.starts_with("sha256:"));
    }

    #[test]
    fn vendored_path_wins_over_canonical_path_source() {
        let ws = tempfile::tempdir().unwrap();
        write_minimal_chart(&ws.path().join(".akua/vendor/local"));
        write_minimal_chart(&ws.path().join("canonical-source"));
        let manifest = minimal_manifest(r#"local = { path = "./canonical-source" }"#);
        let resolved = resolve(&manifest, ws.path()).expect("vendor-first wins");
        let local = resolved.entries.get("local").unwrap();
        assert!(local.abs_path.ends_with(".akua/vendor/local"));
    }

    #[test]
    fn missing_vendor_dir_falls_through_to_normal_resolver() {
        // An unmaterialized OCI dependency is rejected by the offline worker.
        let ws = tempfile::tempdir().unwrap();
        let manifest = minimal_manifest(r#"nginx = { oci = "oci://r/n", version = "1.0.0" }"#);
        let err = resolve(&manifest, ws.path()).unwrap_err();
        assert!(
            matches!(err, ChartResolveError::UnsupportedSource { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn empty_deps_returns_empty() {
        let ws = tempfile::tempdir().unwrap();
        let manifest = minimal_manifest("");
        let resolved = resolve(&manifest, ws.path()).unwrap();
        assert!(resolved.entries.is_empty());
    }

    #[test]
    fn is_akua_package_distinguishes_kcl_module_with_package_k() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("kcl.mod"), "").unwrap();

        // KclModule without package.k — plain KCL ecosystem dep.
        let plain = ResolvedChart {
            name: "plain".into(),
            abs_path: dir.path().to_path_buf(),
            sha256: "sha256:abc".into(),
            kind: PackageKind::KclModule,
            source: ResolvedSource::Path {
                declared: ".".into(),
            },
        };
        assert!(!plain.is_akua_package());

        // KclModule WITH package.k — Akua Package.
        std::fs::write(dir.path().join("package.k"), "resources = []\n").unwrap();
        assert!(plain.is_akua_package());

        // HelmChart kind never qualifies, even with a package.k present.
        let helm = ResolvedChart {
            kind: PackageKind::HelmChart,
            ..plain
        };
        assert!(!helm.is_akua_package());
    }

    #[test]
    fn absolute_path_dep_is_rejected() {
        let ws = tempfile::tempdir().unwrap();
        let manifest = minimal_manifest(r#"evil = { path = "/etc" }"#);
        let err = resolve(&manifest, ws.path()).unwrap_err();
        assert!(
            matches!(err, ChartResolveError::AbsolutePathRejected { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn parent_escape_is_rejected() {
        // Workspace at <tmp>/ws; dep points at <tmp>/sibling — outside ws.
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let sibling = tmp.path().join("sibling");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("Chart.yaml"), "name: x\nversion: 0\n").unwrap();
        let manifest = minimal_manifest(r#"escape = { path = "../sibling" }"#);
        let err = resolve(&manifest, &ws).unwrap_err();
        assert!(
            matches!(err, ChartResolveError::PathEscape { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn replace_rejected_when_opt_set() {
        let tmp = tempfile::tempdir().unwrap();
        let chart_dir = tmp.path().join("fork");
        std::fs::create_dir_all(&chart_dir).unwrap();
        std::fs::write(chart_dir.join("Chart.yaml"), "name: x\nversion: 0\n").unwrap();
        let manifest = minimal_manifest(
            r#"locked = { oci = "oci://r/x", version = "1.0.0", replace = { path = "fork" } }"#,
        );
        let opts = ResolverOptions {
            offline: true,
            reject_replace: true,
            ..Default::default()
        };
        let err = resolve_with_options(&manifest, tmp.path(), &opts).unwrap_err();
        assert!(
            matches!(err, ChartResolveError::ReplaceRejected { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn replace_rejected_from_env_reads_var() {
        // Save and restore the env var; tests run in the same process.
        let prev = std::env::var("AKUA_REJECT_REPLACE").ok();
        std::env::set_var("AKUA_REJECT_REPLACE", "1");
        assert!(replace_rejected_from_env());
        std::env::set_var("AKUA_REJECT_REPLACE", "0");
        assert!(!replace_rejected_from_env());
        // Strict "1" semantics — typos / "true" / "yes" do NOT enable
        // the gate (a permissive parser could mask a misconfigured
        // production deployment).
        std::env::set_var("AKUA_REJECT_REPLACE", "true");
        assert!(!replace_rejected_from_env());
        std::env::remove_var("AKUA_REJECT_REPLACE");
        assert!(!replace_rejected_from_env());
        if let Some(v) = prev {
            std::env::set_var("AKUA_REJECT_REPLACE", v);
        }
    }
}
