//! `akua.toml` — the human-edited manifest.
//!
//! Spec: [`docs/lockfile-format.md §akua.toml`](../../../docs/lockfile-format.md).
//!
//! Two-file package manager split inherited from Go (intent + evidence),
//! with TOML format borrowed from Cargo because our dep forms are richer
//! than go.mod's directives can express cleanly. Companion file is
//! [`crate::lock_file`] (`akua.lock`).
//!
//! This module is **pure parsing and serialization**. No network, no fs
//! walks, no resolution. Digest resolution lives elsewhere.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The top-level shape of an `akua.toml` file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AkuaManifest {
    pub package: PackageSection,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<WorkspaceSection>,

    /// Supply-chain signing policy. When `[signing].cosign_public_key`
    /// is set, every OCI dep must pull with a matching cosign
    /// signature or the resolver fails. Absent section → cosign
    /// verification is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signing: Option<SigningSection>,

    /// Dependencies keyed by local alias (the name as it appears in `import`
    /// statements). `BTreeMap` canonicalizes order alphabetically on
    /// serialize — the on-disk order is not preserved across round-trip.
    #[serde(default)]
    pub dependencies: BTreeMap<String, Dependency>,
}

/// `[signing]` table. exposes keyed cosign verification
/// only. Keyless (fulcio + rekor) will land a sibling field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SigningSection {
    /// Filesystem path to a PEM-encoded P-256 cosign public key,
    /// relative to the workspace root. Applies to every OCI dep in
    /// this manifest (verify path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cosign_public_key: Option<String>,

    /// Filesystem path to a PEM-encoded P-256 cosign private key
    /// (unencrypted PKCS#8), relative to the workspace root. When
    /// set, `akua publish` signs every published artifact by
    /// default. Absent → publish unsigned.
    ///
    /// Store with restrictive filesystem perms (0600). Passphrase /
    /// HSM support is a follow-up slice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cosign_private_key: Option<String>,
}

/// `[package]` table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackageSection {
    pub name: String,
    pub version: String,
    pub edition: String,

    /// Whether every remote dep in `akua.lock` must record a verifying
    /// signature. Absent: true exactly when `[signing].cosign_public_key`
    /// is set (see [`AkuaManifest::strict_signing`]), as the akuapkg host
    /// decides it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict_signing: Option<bool>,
}

impl AkuaManifest {
    /// `[package].strict_signing`, or whether a cosign public key is configured.
    pub fn strict_signing(&self) -> bool {
        self.package.strict_signing.unwrap_or_else(|| {
            self.signing
                .as_ref()
                .is_some_and(|signing| signing.cosign_public_key.is_some())
        })
    }
}

/// `[workspace]` table, present in monorepos.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceSection {
    /// Glob patterns resolving to member package directories.
    #[serde(default)]
    pub members: Vec<String>,
}

/// A single dependency. Form is discriminated by which source-type field is
/// set (`oci` / `git` / `path` / `repo`). Exactly one must be present; more
/// than one present is a validation error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(Default))]
pub struct Dependency {
    /// OCI ref. Exclusive with `git`, `path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oci: Option<String>,

    /// Git URL. Exclusive with `oci`, `path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<String>,

    /// Local filesystem path. Exclusive with `oci`, `git`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,

    /// HTTPS Helm-repo URL (the `index.yaml` lives at `<repo>/index.yaml`).
    /// Exclusive with `oci`, `git`, `path`. Pairs with `chart`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,

    /// Chart entry name within a `repo`'s `index.yaml`. Required for
    /// `repo` deps; unused by other sources.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<String>,

    /// Version constraint (semver exact or range). Required for `oci`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,

    /// Git tag. Set for `git` deps to pin a specific release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,

    /// Git commit SHA. Alternative to `tag` for `git` deps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,

    /// Local-fork override. Keeps the `oci` / `git` ref recorded as the
    /// canonical source; resolves from `replace.path` at build time instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace: Option<Replace>,
}

/// Local-fork override.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Replace {
    pub path: String,
}

/// The source form discriminant, computed from which field is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DependencySource {
    Oci,
    Git,
    Path,
    Helm,
}

/// Typed projection of a [`Dependency`]'s source form. Returned by
/// [`Dependency::spec`] post-validation; field shapes encode the
/// validate-enforced invariants (OCI deps have a version; git deps
/// have at least one of tag/rev; helm deps have chart + version) so
/// consumers don't re-prove them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DependencySpec<'a> {
    Path {
        declared: &'a str,
    },
    Oci {
        oci: &'a str,
        version: &'a str,
    },
    Git {
        git: &'a str,
        tag: Option<&'a str>,
        rev: Option<&'a str>,
    },
    Helm {
        repo: &'a str,
        chart: &'a str,
        version: &'a str,
    },
}

impl<'a> DependencySpec<'a> {
    /// `tag` if set, else `rev`. Manifest validation guarantees one of
    /// the two is `Some` for git deps, so the [`Option`] in the return
    /// is purely for the non-Git arms (always `None`).
    pub fn tag_or_rev(&self) -> Option<&'a str> {
        match self {
            DependencySpec::Git { tag, rev, .. } => tag.or(*rev),
            _ => None,
        }
    }
}

/// Errors produced by this module.
#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("toml parse error: {0}")]
    Parse(#[from] toml::de::Error),

    #[error("toml serialize error: {0}")]
    Serialize(#[from] toml::ser::Error),

    #[error("dependency `{name}`: exactly one of oci / git / path must be set, got {count}")]
    AmbiguousSource { name: String, count: usize },

    #[error("dependency `{name}`: oci dep requires a version")]
    OciMissingVersion { name: String },

    #[error("dependency `{name}`: git dep requires either tag or rev")]
    GitMissingTagOrRev { name: String },

    #[error("dependency `{name}`: path dep must not set version / tag / rev")]
    PathHasPin { name: String },

    #[error("[package].edition must start with `akua.dev/`, got `{0}`")]
    BadEdition(String),

    #[error("[package].name must be a valid KCL identifier, got `{0}`")]
    BadPackageName(String),

    #[error(
        "dependency `{name}`: git URL must not embed credentials (`user:pass@`). \
         Pass credentials via the SDK `auth` parameter or the CLI `--auth` flag."
    )]
    GitUrlHasUserInfo { name: String },

    #[error("dependency `{name}`: helm-repo dep requires a `chart`")]
    HelmMissingChart { name: String },

    #[error("dependency `{name}`: helm-repo dep requires a `version`")]
    HelmMissingVersion { name: String },

    #[error(
        "dependency `{name}`: repo URL must not embed credentials (`user:pass@`). \
         Pass credentials via the SDK `auth` parameter or the CLI `--auth` flag."
    )]
    HelmUrlHasUserInfo { name: String },

    #[error(
        "dependency `{name}`: `chart` value `{chart}` must be a plain chart name \
         (no path separators or `..`)"
    )]
    HelmChartInvalid { name: String, chart: String },

    #[error(
        "dependency `{name}`: oci URL must not embed credentials (`user:pass@`). \
         Pass credentials via the SDK `auth` parameter or the CLI `--auth` flag."
    )]
    OciUrlHasUserInfo { name: String },
}

impl ManifestError {
    /// Stable error-code constant for this variant. Defaults to
    /// `E_MANIFEST_PARSE`; specific variants that have their own
    /// documented code override here so agents can branch precisely.
    pub fn structured_code(&self) -> &'static str {
        use crate::cli_contract::codes;
        match self {
            ManifestError::GitUrlHasUserInfo { .. } => codes::E_MANIFEST_GIT_USERINFO,
            ManifestError::HelmMissingChart { .. } => codes::E_MANIFEST_HELM_MISSING_CHART,
            ManifestError::HelmMissingVersion { .. } => codes::E_MANIFEST_HELM_MISSING_VERSION,
            ManifestError::HelmUrlHasUserInfo { .. } => codes::E_MANIFEST_HELM_USERINFO,
            ManifestError::HelmChartInvalid { .. } => codes::E_MANIFEST_HELM_CHART_INVALID,
            ManifestError::OciUrlHasUserInfo { .. } => codes::E_MANIFEST_OCI_USERINFO,
            _ => codes::E_MANIFEST_PARSE,
        }
    }
}

/// Result of loading an `akua.toml` from disk. Distinguishes the file
/// being absent (workspace not set up) from other I/O errors, and
/// preserves the file path on parse errors for diagnostics.
#[derive(Debug, thiserror::Error)]
pub enum ManifestLoadError {
    #[error("akua.toml not found at {path}")]
    Missing { path: std::path::PathBuf },

    #[error("i/o error reading {path}: {source}")]
    Io {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("failed to parse {path}: {source}")]
    Parse {
        path: std::path::PathBuf,
        #[source]
        source: ManifestError,
    },
}

impl ManifestLoadError {
    /// Map to a [`StructuredError`] with the right CLI-contract code,
    /// the file path, and the default docs URL. Callers layer on their
    /// own `.with_suggestion(...)` where the UX differs by verb.
    pub fn to_structured(&self) -> crate::cli_contract::StructuredError {
        use crate::cli_contract::{codes, StructuredError};
        match self {
            ManifestLoadError::Missing { path } => {
                StructuredError::new(codes::E_MANIFEST_MISSING, "akua.toml not found")
                    .with_path(path.display().to_string())
                    .with_default_docs()
            }
            ManifestLoadError::Io { path, source } => {
                StructuredError::new(codes::E_IO, source.to_string())
                    .with_path(path.display().to_string())
                    .with_default_docs()
            }
            ManifestLoadError::Parse { path, source } => {
                StructuredError::new(source.structured_code(), source.to_string())
                    .with_path(path.display().to_string())
                    .with_default_docs()
            }
        }
    }

    /// `true` when the underlying cause is a system-side I/O failure
    /// (disk gone, permission denied) rather than a user mistake.
    /// Callers route this to [`crate::ExitCode::SystemError`].
    pub fn is_system(&self) -> bool {
        matches!(self, ManifestLoadError::Io { .. })
    }
}

impl AkuaManifest {
    /// Parse an `akua.toml` from a string.
    pub fn parse(s: &str) -> Result<Self, ManifestError> {
        let manifest: AkuaManifest = toml::from_str(s)?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// Load `akua.toml` from a workspace directory. Maps filesystem
    /// NotFound to [`ManifestLoadError::Missing`] so callers can
    /// distinguish "no manifest" from "disk broke."
    pub fn load(workspace: &std::path::Path) -> Result<Self, ManifestLoadError> {
        let path = workspace.join("akua.toml");
        let content = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(ManifestLoadError::Missing { path });
            }
            Err(e) => return Err(ManifestLoadError::Io { path, source: e }),
        };
        Self::parse(&content).map_err(|source| ManifestLoadError::Parse { path, source })
    }

    /// Serialize back to canonical TOML. Fields in deterministic order;
    /// dependencies alphabetical (BTreeMap guarantees this).
    pub fn to_toml(&self) -> Result<String, ManifestError> {
        Ok(toml::to_string_pretty(self)?)
    }

    /// Cross-field validation that serde's structural parse can't catch on
    /// its own.
    pub fn validate(&self) -> Result<(), ManifestError> {
        if !self.package.edition.starts_with("akua.dev/") {
            return Err(ManifestError::BadEdition(self.package.edition.clone()));
        }
        if !is_valid_package_name(&self.package.name) {
            return Err(ManifestError::BadPackageName(self.package.name.clone()));
        }
        for (name, dep) in &self.dependencies {
            dep.validate(name)?;
        }
        Ok(())
    }
}

impl Dependency {
    /// Which source form is this? `Some` when exactly one of `oci` /
    /// `git` / `path` / `repo` is set; `None` when zero or more than
    /// one are set (which is a validation error handled by [`validate`]).
    pub fn source(&self) -> Option<DependencySource> {
        match (
            self.oci.is_some(),
            self.git.is_some(),
            self.path.is_some(),
            self.repo.is_some(),
        ) {
            (true, false, false, false) => Some(DependencySource::Oci),
            (false, true, false, false) => Some(DependencySource::Git),
            (false, false, true, false) => Some(DependencySource::Path),
            (false, false, false, true) => Some(DependencySource::Helm),
            _ => None,
        }
    }

    /// Typed projection of the dep's source. Caller must have
    /// validated; reach for [`source`] when working with raw input.
    ///
    /// # Panics
    ///
    /// Panics on an unvalidated manifest (zero / multiple sources, OCI
    /// without version, git without tag-or-rev). `AkuaManifest::load`
    /// runs validation; direct `Dependency` construction outside tests
    /// must call [`validate`] first.
    pub fn spec(&self) -> DependencySpec<'_> {
        match (
            self.path.as_deref(),
            self.oci.as_deref(),
            self.git.as_deref(),
            self.repo.as_deref(),
        ) {
            (Some(declared), None, None, None) => DependencySpec::Path { declared },
            (None, Some(oci), None, None) => DependencySpec::Oci {
                oci,
                version: self.version.as_deref().expect(
                    "Dependency::spec called on an unvalidated manifest — call validate() first",
                ),
            },
            (None, None, Some(git), None) => DependencySpec::Git {
                git,
                tag: self.tag.as_deref(),
                rev: self.rev.as_deref(),
            },
            (None, None, None, Some(repo)) => DependencySpec::Helm {
                repo,
                chart: self.chart.as_deref().expect(
                    "Dependency::spec called on an unvalidated manifest — call validate() first",
                ),
                version: self.version.as_deref().expect(
                    "Dependency::spec called on an unvalidated manifest — call validate() first",
                ),
            },
            _ => unreachable!(
                "Dependency::spec called on an unvalidated manifest — call validate() first"
            ),
        }
    }

    /// Full validation. Callers pass the local alias so errors name the dep.
    pub fn validate(&self, name: &str) -> Result<(), ManifestError> {
        let Some(source) = self.source() else {
            let count = self.oci.is_some() as usize
                + self.git.is_some() as usize
                + self.path.is_some() as usize
                + self.repo.is_some() as usize;
            return Err(ManifestError::AmbiguousSource {
                name: name.to_string(),
                count,
            });
        };
        match source {
            DependencySource::Oci if self.version.is_none() => {
                Err(ManifestError::OciMissingVersion {
                    name: name.to_string(),
                })
            }
            DependencySource::Oci
                if crate::host_auth::url_has_userinfo(
                    self.oci.as_deref().expect("oci source set"),
                ) =>
            {
                Err(ManifestError::OciUrlHasUserInfo {
                    name: name.to_string(),
                })
            }
            DependencySource::Git if self.tag.is_none() && self.rev.is_none() => {
                Err(ManifestError::GitMissingTagOrRev {
                    name: name.to_string(),
                })
            }
            DependencySource::Git
                if crate::host_auth::url_has_userinfo(
                    self.git.as_deref().expect("git source set"),
                ) =>
            {
                Err(ManifestError::GitUrlHasUserInfo {
                    name: name.to_string(),
                })
            }
            DependencySource::Path
                if self.version.is_some() || self.tag.is_some() || self.rev.is_some() =>
            {
                Err(ManifestError::PathHasPin {
                    name: name.to_string(),
                })
            }
            DependencySource::Helm if self.chart.is_none() => {
                Err(ManifestError::HelmMissingChart {
                    name: name.to_string(),
                })
            }
            DependencySource::Helm if self.version.is_none() => {
                Err(ManifestError::HelmMissingVersion {
                    name: name.to_string(),
                })
            }
            DependencySource::Helm
                if crate::host_auth::url_has_userinfo(
                    self.repo.as_deref().expect("repo source set"),
                ) =>
            {
                Err(ManifestError::HelmUrlHasUserInfo {
                    name: name.to_string(),
                })
            }
            DependencySource::Helm => {
                // chart is Some at this point (HelmMissingChart arm above).
                let chart = self.chart.as_deref().expect("chart validated present");
                if is_path_traversal_chart_name(chart) {
                    return Err(ManifestError::HelmChartInvalid {
                        name: name.to_string(),
                        chart: chart.to_string(),
                    });
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

/// Map a dep key to a legal KCL identifier by replacing every char
/// outside `[A-Za-z0-9_]` with `_`. Dep keys allow `-` (and validate
/// as Cargo/npm-style names), but KCL identifiers don't — a module
/// written to `cnpg-operator.k` binds its symbols under the literal
/// `cnpg-operator`, which `import charts.cnpg_operator` can't see.
/// Sanitizing at every site that turns a dep key into a KCL module /
/// alias name keeps the on-disk module name aligned with the `import`
/// alias the user has to write.
///
/// Every char outside `[A-Za-z0-9_]` maps to `_`. A KCL identifier may
/// not start with a digit, and [`is_valid_package_name`] permits
/// digit-leading dep keys (e.g. `01-foo`), so a leading digit is
/// prefixed with `_` (`01-foo` → `_01_foo`).
pub fn kcl_ident(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}

/// True when a helm `chart` value contains path separators or `..`
/// segments that could be path-joined into the chart cache to escape
/// its directory. A chart name must be a plain single-component name
/// (e.g. `temporal`, `nginx`); it never contains `/`, `\`, or `..`.
fn is_path_traversal_chart_name(chart: &str) -> bool {
    chart.contains('/') || chart.contains('\\') || chart.contains("..")
}

/// Package name rules (aligned with Cargo / npm / poetry conventions):
/// - non-empty
/// - ASCII alphanumeric, `-`, `_` only
/// - must not start with `-` (registry ergonomics)
///
/// Digit-prefixed names are permitted (e.g. `01-hello-webapp`).
pub fn is_valid_package_name(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if first == '-' {
        return false;
    }
    if !(first.is_ascii_alphanumeric() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Lifted from `examples/01-hello-webapp/akua.toml`.
    const EXAMPLE_01: &str = r#"
[package]
name    = "01-hello-webapp"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
nginx = { oci = "oci://registry-1.docker.io/bitnamicharts/nginx", version = "18.2.0" }
"#;

    /// Exercises workspace + multiple deps + mixed sources.
    const EXAMPLE_WORKSPACE: &str = r#"
[package]
name    = "acme-platform"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[workspace]
members = ["./apps/*", "./policies/*"]

[dependencies]
k8s       = { oci = "oci://ghcr.io/kcl-lang/k8s",              version = "1.31.2" }
cnpg      = { oci = "oci://ghcr.io/cloudnative-pg/charts/cluster", version = "0.20.0" }
our-glue  = { oci = "oci://pkg.acme.internal/glue", version = "0.3.0", replace = { path = "../glue-fork" } }
local-dev = { path = "../shared" }
from-git  = { git = "https://github.com/foo/bar", tag = "v1.2.3" }
"#;

    #[test]
    fn parses_minimal_example() {
        let m = AkuaManifest::parse(EXAMPLE_01).expect("parse");
        assert_eq!(m.package.name, "01-hello-webapp");
        assert_eq!(m.package.version, "0.1.0");
        assert_eq!(m.package.edition, "akua.dev/v1alpha1");
        assert!(!m.strict_signing());
        assert!(m.workspace.is_none());
        assert_eq!(m.dependencies.len(), 1);
        let nginx = m.dependencies.get("nginx").expect("nginx dep");
        assert_eq!(
            nginx.oci.as_deref(),
            Some("oci://registry-1.docker.io/bitnamicharts/nginx")
        );
        assert_eq!(nginx.version.as_deref(), Some("18.2.0"));
        assert!(nginx.git.is_none());
        assert!(nginx.path.is_none());
    }

    #[test]
    fn parses_workspace_with_mixed_sources() {
        let m = AkuaManifest::parse(EXAMPLE_WORKSPACE).expect("parse");
        assert_eq!(
            m.workspace.as_ref().unwrap().members,
            vec!["./apps/*".to_string(), "./policies/*".to_string()]
        );
        assert_eq!(m.dependencies.len(), 5);

        assert_eq!(
            m.dependencies["our-glue"].replace.as_ref().unwrap().path,
            "../glue-fork"
        );

        assert_eq!(
            m.dependencies["local-dev"].source().unwrap(),
            DependencySource::Path
        );
        assert_eq!(
            m.dependencies["from-git"].source().unwrap(),
            DependencySource::Git
        );
        assert_eq!(
            m.dependencies["k8s"].source().unwrap(),
            DependencySource::Oci
        );
    }

    #[test]
    fn round_trips_canonical_form() {
        let original = AkuaManifest::parse(EXAMPLE_WORKSPACE).expect("parse");
        let serialized = original.to_toml().expect("serialize");
        let reparsed = AkuaManifest::parse(&serialized).expect("reparse");
        assert_eq!(original, reparsed, "round-trip should preserve structure");
    }

    #[test]
    fn rejects_ambiguous_source() {
        let bad = r#"
[package]
name    = "bad"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
twosrc = { oci = "oci://foo", git = "https://example.com/bar", version = "1.0.0", tag = "v1" }
"#;
        let err = AkuaManifest::parse(bad).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("twosrc"), "error should name the dep: {msg}");
        assert!(msg.contains("exactly one"), "err: {msg}");
    }

    #[test]
    fn rejects_oci_without_version() {
        let bad = r#"
[package]
name    = "bad"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
bare = { oci = "oci://foo" }
"#;
        let err = AkuaManifest::parse(bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::OciMissingVersion { ref name } if name == "bare"),
            "expected OciMissingVersion, got {err:?}"
        );
    }

    #[test]
    fn rejects_git_without_tag_or_rev() {
        let bad = r#"
[package]
name    = "bad"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
bare-git = { git = "https://github.com/foo/bar" }
"#;
        let err = AkuaManifest::parse(bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::GitMissingTagOrRev { ref name } if name == "bare-git"),
            "expected GitMissingTagOrRev, got {err:?}"
        );
    }

    #[test]
    fn rejects_git_url_with_userinfo() {
        let bad = r#"
[package]
name    = "fine"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
upstream = { git = "https://alice:secret@example.com/foo/bar", tag = "v1" }
"#;
        let err = AkuaManifest::parse(bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::GitUrlHasUserInfo { ref name } if name == "upstream"),
            "expected GitUrlHasUserInfo, got {err:?}"
        );
        assert_eq!(
            err.structured_code(),
            crate::cli_contract::codes::E_MANIFEST_GIT_USERINFO
        );
    }

    #[test]
    fn accepts_git_url_with_at_in_path() {
        // `@` outside the authority is fine — only authority `@` is
        // userinfo. Paths can legally contain `@` though it's unusual.
        let ok = r#"
[package]
name    = "fine"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
upstream = { git = "https://example.com/foo/bar@v1.git", tag = "v1" }
"#;
        AkuaManifest::parse(ok).unwrap();
    }

    #[test]
    fn rejects_path_with_version() {
        let bad = r#"
[package]
name    = "bad"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
pinned-path = { path = "../foo", version = "1.0.0" }
"#;
        let err = AkuaManifest::parse(bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::PathHasPin { ref name } if name == "pinned-path"),
            "expected PathHasPin, got {err:?}"
        );
    }

    #[test]
    fn rejects_bad_edition() {
        let bad = r#"
[package]
name    = "fine"
version = "0.1.0"
edition = "cargo/v1"

[dependencies]
"#;
        let err = AkuaManifest::parse(bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::BadEdition(ref e) if e == "cargo/v1"),
            "expected BadEdition, got {err:?}"
        );
    }

    #[test]
    fn rejects_bad_package_name_has_space() {
        let bad = r#"
[package]
name    = "has space"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
"#;
        let err = AkuaManifest::parse(bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::BadPackageName(ref n) if n == "has space"),
            "expected BadPackageName, got {err:?}"
        );
    }

    #[test]
    fn package_name_validation() {
        // Allowed
        assert!(is_valid_package_name("webapp"));
        assert!(is_valid_package_name("web-app"));
        assert!(is_valid_package_name("web_app_123"));
        assert!(is_valid_package_name("_leading_underscore"));
        assert!(is_valid_package_name("01-hello-webapp")); // digit-prefix OK
        assert!(is_valid_package_name("9starts-with-digit"));

        // Disallowed
        assert!(!is_valid_package_name(""));
        assert!(!is_valid_package_name("-leading-hyphen"));
        assert!(!is_valid_package_name("has space"));
        assert!(!is_valid_package_name("has.dot"));
    }

    #[test]
    fn kcl_ident_sanitizes_separators() {
        assert_eq!(kcl_ident("cnpg-operator"), "cnpg_operator");
        // Idempotent / unchanged on already-legal identifiers.
        assert_eq!(kcl_ident("traefik"), "traefik");
        assert_eq!(kcl_ident("web_app_123"), "web_app_123");
        // Collapses other separators a dep key might carry.
        assert_eq!(kcl_ident("a.b"), "a_b");
        assert_eq!(kcl_ident("a-b.c"), "a_b_c");
        // A leading digit is illegal in a KCL identifier, so it's prefixed
        // with `_` (digit-leading dep keys are otherwise permitted).
        assert_eq!(kcl_ident("01-hello-webapp"), "_01_hello_webapp");
        assert_eq!(kcl_ident("9lives"), "_9lives");
    }

    #[test]
    fn kcl_ident_collision_is_detectable() {
        // Two distinct dep keys that sanitize to the same identifier —
        // the materializers reject this rather than overwrite a module.
        assert_eq!(kcl_ident("a-b"), kcl_ident("a_b"));
        assert_ne!("a-b", "a_b");
    }

    #[test]
    fn rejects_bad_package_name_leading_hyphen() {
        let bad = r#"
[package]
name    = "-bad-name"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
"#;
        let err = AkuaManifest::parse(bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::BadPackageName(ref n) if n == "-bad-name"),
            "expected BadPackageName, got {err:?}"
        );
    }

    #[test]
    fn strict_signing_defaults_to_whether_a_key_is_configured() {
        let m = AkuaManifest::parse(EXAMPLE_01).expect("parse");
        assert_eq!(m.package.strict_signing, None);
        assert!(!m.strict_signing());
        let keyed = r#"
[package]
name    = "keyed"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[signing]
cosign_public_key = "./cosign.pub"

[dependencies]
"#;
        assert!(AkuaManifest::parse(keyed).expect("parse").strict_signing());
        let unkeyed = keyed.replace("[signing]\ncosign_public_key = \"./cosign.pub\"\n", "");
        assert!(!AkuaManifest::parse(&unkeyed).expect("parse").strict_signing());
    }

    #[test]
    fn strict_signing_can_be_disabled() {
        let s = r#"
[package]
name           = "unsigned-ok"
version        = "0.1.0"
edition        = "akua.dev/v1alpha1"
strict_signing = false

[dependencies]
"#;
        let m = AkuaManifest::parse(s).expect("parse");
        assert_eq!(m.package.strict_signing, Some(false));
        assert!(!m.strict_signing());
    }

    #[test]
    fn spec_projects_path_dep() {
        let dep = Dependency {
            path: Some("./local".to_string()),
            ..Default::default()
        };
        assert!(matches!(dep.spec(), DependencySpec::Path { declared } if declared == "./local"));
    }

    #[test]
    fn spec_projects_oci_dep_with_version() {
        let dep = Dependency {
            oci: Some("oci://ghcr.io/acme/app".to_string()),
            version: Some("1.0.0".to_string()),
            ..Default::default()
        };
        match dep.spec() {
            DependencySpec::Oci { oci, version } => {
                assert_eq!(oci, "oci://ghcr.io/acme/app");
                assert_eq!(version, "1.0.0");
            }
            other => panic!("expected Oci, got {other:?}"),
        }
    }

    /// `Dependency::spec` documents that OCI without a version panics
    /// (manifest validation rejects this shape upstream). Pin the
    /// contract so the `version: &str` field on `DependencySpec::Oci`
    /// can't be silently downgraded back to `Option`.
    #[test]
    #[should_panic(expected = "unvalidated manifest")]
    fn spec_panics_on_oci_without_version() {
        let dep = Dependency {
            oci: Some("oci://ghcr.io/acme/app".to_string()),
            ..Default::default()
        };
        let _ = dep.spec();
    }

    #[test]
    fn spec_projects_git_dep_exposes_tag_and_rev_separately() {
        let dep = Dependency {
            git: Some("https://github.com/foo/bar".to_string()),
            tag: Some("v1.0.0".to_string()),
            rev: Some("abc123".to_string()),
            ..Default::default()
        };
        match dep.spec() {
            DependencySpec::Git { git, tag, rev } => {
                assert_eq!(git, "https://github.com/foo/bar");
                assert_eq!(tag, Some("v1.0.0"));
                assert_eq!(rev, Some("abc123"));
            }
            other => panic!("expected Git, got {other:?}"),
        }
    }

    #[test]
    fn spec_tag_or_rev_prefers_tag() {
        let dep = Dependency {
            git: Some("https://github.com/foo/bar".to_string()),
            tag: Some("v1.0.0".to_string()),
            rev: Some("abc123".to_string()),
            ..Default::default()
        };
        assert_eq!(dep.spec().tag_or_rev(), Some("v1.0.0"));
    }

    #[test]
    fn spec_tag_or_rev_falls_back_to_rev_when_tag_absent() {
        let dep = Dependency {
            git: Some("https://github.com/foo/bar".to_string()),
            rev: Some("abc123".to_string()),
            ..Default::default()
        };
        assert_eq!(dep.spec().tag_or_rev(), Some("abc123"));
    }

    /// `Dependency::spec` is documented as panicking on an unvalidated
    /// manifest — the `_ => unreachable!` arm. This test pins that
    /// contract so a regression is caught immediately.
    #[test]
    #[should_panic(expected = "unvalidated manifest")]
    fn spec_panics_on_ambiguous_source() {
        let dep = Dependency {
            path: Some("./local".to_string()),
            oci: Some("oci://ghcr.io/acme/app".to_string()),
            ..Default::default()
        };
        let _ = dep.spec();
    }

    #[test]
    fn repo_dep_is_helm_source() {
        let dep = Dependency {
            repo: Some("https://go.temporal.io/helm-charts".into()),
            chart: Some("temporal".into()),
            version: Some("0.62.0".into()),
            ..Default::default()
        };
        assert_eq!(dep.source(), Some(DependencySource::Helm));
        dep.validate("temporal").expect("valid helm dep");
        match dep.spec() {
            DependencySpec::Helm {
                repo,
                chart,
                version,
            } => {
                assert_eq!(repo, "https://go.temporal.io/helm-charts");
                assert_eq!(chart, "temporal");
                assert_eq!(version, "0.62.0");
            }
            other => panic!("expected Helm, got {other:?}"),
        }
    }

    #[test]
    fn helm_dep_requires_chart_and_version() {
        let no_chart = Dependency {
            repo: Some("https://r".into()),
            version: Some("1.0.0".into()),
            ..Default::default()
        };
        assert!(matches!(
            no_chart.validate("x"),
            Err(ManifestError::HelmMissingChart { .. })
        ));
        let no_version = Dependency {
            repo: Some("https://r".into()),
            chart: Some("c".into()),
            ..Default::default()
        };
        assert!(matches!(
            no_version.validate("x"),
            Err(ManifestError::HelmMissingVersion { .. })
        ));
    }

    #[test]
    fn helm_repo_url_rejects_userinfo() {
        let dep = Dependency {
            repo: Some("https://user:pass@r".into()),
            chart: Some("c".into()),
            version: Some("1.0.0".into()),
            ..Default::default()
        };
        assert!(matches!(
            dep.validate("x"),
            Err(ManifestError::HelmUrlHasUserInfo { .. })
        ));
    }

    // --- Security: OCI userinfo ---

    /// An OCI dep URL with embedded credentials (`oci://user:pass@host/...`)
    /// must be rejected at parse time, matching the symmetry with git and
    /// helm-repo validation.
    #[test]
    fn rejects_oci_url_with_userinfo() {
        let bad = r#"
[package]
name    = "bad"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
pkg = { oci = "oci://alice:secret@ghcr.io/acme/nginx", version = "1.0.0" }
"#;
        let err = AkuaManifest::parse(bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::OciUrlHasUserInfo { ref name } if name == "pkg"),
            "expected OciUrlHasUserInfo, got {err:?}"
        );
        assert_eq!(
            err.structured_code(),
            crate::cli_contract::codes::E_MANIFEST_OCI_USERINFO
        );
    }

    // --- Security: helm chart name ---

    /// A `chart` value containing a path separator (`/`) must be rejected —
    /// a chart name is a plain single-component identifier, never a path.
    #[test]
    fn rejects_helm_chart_with_path_separator() {
        let bad = r#"
[package]
name    = "bad"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
evil = { repo = "https://charts.example.com", chart = "../../foo", version = "1.0.0" }
"#;
        let err = AkuaManifest::parse(bad).unwrap_err();
        assert!(
            matches!(err, ManifestError::HelmChartInvalid { ref name, ref chart }
                if name == "evil" && chart.contains("../")),
            "expected HelmChartInvalid, got {err:?}"
        );
        assert_eq!(
            err.structured_code(),
            crate::cli_contract::codes::E_MANIFEST_HELM_CHART_INVALID
        );
    }

    /// A `chart` value containing `..` (without a slash) must also be
    /// rejected — any occurrence of `..` is sufficient to disallow it.
    #[test]
    fn rejects_helm_chart_with_dotdot() {
        let dep = Dependency {
            repo: Some("https://r".into()),
            chart: Some("../x".into()),
            version: Some("1.0.0".into()),
            ..Default::default()
        };
        assert!(matches!(
            dep.validate("x"),
            Err(ManifestError::HelmChartInvalid { .. })
        ));
    }

    /// A `chart` value containing a backslash must also be rejected.
    #[test]
    fn rejects_helm_chart_with_backslash() {
        let dep = Dependency {
            repo: Some("https://r".into()),
            chart: Some("foo\\bar".into()),
            version: Some("1.0.0".into()),
            ..Default::default()
        };
        assert!(matches!(
            dep.validate("x"),
            Err(ManifestError::HelmChartInvalid { .. })
        ));
    }

    /// A plain chart name (no separators) must be accepted normally.
    #[test]
    fn accepts_plain_helm_chart_name() {
        let dep = Dependency {
            repo: Some("https://go.temporal.io/helm-charts".into()),
            chart: Some("temporal".into()),
            version: Some("0.62.0".into()),
            ..Default::default()
        };
        dep.validate("temporal").expect("plain chart name is valid");
    }

    #[test]
    fn repo_is_mutually_exclusive_with_other_sources() {
        let dep = Dependency {
            repo: Some("https://r".into()),
            oci: Some("oci://x".into()),
            chart: Some("c".into()),
            version: Some("1.0.0".into()),
            ..Default::default()
        };
        assert_eq!(dep.source(), None);
        assert!(matches!(
            dep.validate("x"),
            Err(ManifestError::AmbiguousSource { .. })
        ));
    }
}
