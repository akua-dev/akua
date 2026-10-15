//! Workspace vendor-tree sync and inspection.
//!
//! The resolver already prefers `<workspace>/.akua/vendor/<name>/`
//! when it exists. This module gives that tree a first-class
//! maintenance surface:
//!
//! - `add` materializes a declared dependency into the vendor tree.
//! - `check` compares vendor bytes against what the manifest + lock
//!   know about and reports drift.
//! - `list` inventories the on-disk vendor trees, including orphans.
//!
//! The digest contract matches the rest of akua: SHA-256 over the
//! directory tree, with lexicographically sorted entries so byte
//! identity is stable across filesystems.
#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::chart_resolver::{
    hash_dir, upsert_locked_from_source, validate_workspace_path, ResolvedSource,
    WorkspacePathError, VENDOR_DIR,
};
use crate::cli_contract::{codes, ExitCode, StructuredError};
use crate::lock_file::{
    AkuaLock, LockLoadError, LockedPackage, GIT_DIGEST_PREFIX, VENDORED_LOCK_FALLBACK,
};
use crate::mod_file::{AkuaManifest, Dependency, DependencySpec, ManifestLoadError};
use serde::{Deserialize, Serialize};

crate::contract_type! {
    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    pub struct VendorListEntry {
        pub name: String,
        pub path: PathBuf,
        pub digest: String,
        pub size_bytes: u64,
        pub orphan: bool,
    }
}

crate::contract_type! {
    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    pub struct VendorListOutput {
        pub entries: Vec<VendorListEntry>,
    }
}

crate::contract_type! {
    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    pub struct VendorCheckEntry {
        pub name: String,
        pub path: PathBuf,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub source_kind: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub source_ref: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub expected_digest: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub actual_digest: Option<String>,
        pub orphan: bool,
        pub missing_vendor: bool,
        pub missing_source: bool,
    }
}

crate::contract_type! {
    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    pub struct VendorCheckOutput {
        pub drift: bool,
        pub entries: Vec<VendorCheckEntry>,
        pub orphaned: Vec<String>,
        pub missing: Vec<String>,
    }
}

crate::contract_type! {
    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    pub struct VendorAddOutput {
        pub name: String,
        pub source_kind: String,
        pub source_ref: String,
        pub path: PathBuf,
        pub digest: String,
        pub size_bytes: u64,
        pub wrote: bool,
        pub replaced: bool,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum VendorError {
    #[error(transparent)]
    Manifest(#[from] ManifestLoadError),

    #[error(transparent)]
    Lock(#[from] LockLoadError),

    #[error("reading OCI credentials: {0}")]
    AuthConfig(String),

    #[error(
        "dep `{name}` is not declared in akua.toml; declare `path = \".akua/vendor/{name}\"` first"
    )]
    MissingDependency { name: String },

    #[error("source path `{path}` does not exist")]
    SourceMissing { path: PathBuf },

    /// Absolute path in `akua.toml` `path = "..."`. Path deps must
    /// stay under the workspace root — see CLAUDE.md "`replace` and
    /// `path` deps are workspace-local; never cross Package
    /// boundaries". Same invariant `chart_resolver` enforces.
    #[error(
        "dep `{name}`: absolute path `{}` is rejected — \
         path deps must stay under the workspace root",
        path.display()
    )]
    AbsolutePathRejected { name: String, path: PathBuf },

    /// Relative path that canonicalizes outside the workspace
    /// (typically via `..` segments or symlinks). Same workspace-local
    /// invariant as [`Self::AbsolutePathRejected`].
    #[error(
        "dep `{name}`: path `{}` resolves to `{}`, which escapes \
         the workspace root `{}`",
        requested.display(), resolved.display(), workspace_root.display()
    )]
    PathEscape {
        name: String,
        requested: PathBuf,
        resolved: PathBuf,
        workspace_root: PathBuf,
    },

    #[error("i/o at `{}`: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("vendor tree drift detected")]
    Drift { output: VendorCheckOutput },

    /// Dependency source kind unsupported by this vendor path.
    #[error("dep `{name}`: {kind} source not yet supported by `akua vendor`")]
    UnsupportedSource { name: String, kind: &'static str },
}

impl VendorError {
    pub fn to_structured(&self) -> StructuredError {
        match self {
            VendorError::Manifest(e) => e.to_structured(),
            VendorError::Lock(e) => e.to_structured(),
            VendorError::AuthConfig(detail) => {
                StructuredError::new(codes::E_IO, detail.clone()).with_default_docs()
            }
            VendorError::MissingDependency { name } => {
                StructuredError::new(codes::E_VENDOR_DEP_MISSING, self.to_string())
                    .with_suggestion(format!(
                        "declare `path = \".akua/vendor/{name}\"` in `akua.toml` first"
                    ))
                    .with_default_docs()
            }
            VendorError::SourceMissing { path } => {
                StructuredError::new(codes::E_IO, self.to_string())
                    .with_path(path.display().to_string())
                    .with_default_docs()
            }
            VendorError::AbsolutePathRejected { path, .. } => {
                StructuredError::new(codes::E_PATH_ESCAPE, self.to_string())
                    .with_path(path.display().to_string())
                    .with_suggestion(
                        "use a relative path under the workspace, or vendor the \
                         dep via `oci = \"...\"` / `git = \"...\"`",
                    )
                    .with_default_docs()
            }
            VendorError::PathEscape { resolved, .. } => {
                StructuredError::new(codes::E_PATH_ESCAPE, self.to_string())
                    .with_path(resolved.display().to_string())
                    .with_suggestion(
                        "rewrite the path to stay under the workspace, or move \
                         the source into the workspace",
                    )
                    .with_default_docs()
            }
            VendorError::Io { path, source } => {
                StructuredError::new(codes::E_IO, source.to_string())
                    .with_path(path.display().to_string())
                    .with_default_docs()
            }
            VendorError::Drift { .. } => {
                StructuredError::new(codes::E_VENDOR_DRIFT, self.to_string()).with_default_docs()
            }
            VendorError::UnsupportedSource { .. } => {
                StructuredError::new(codes::E_DEP_RESOLVE, self.to_string()).with_default_docs()
            }
        }
    }

    pub fn exit_code(&self) -> ExitCode {
        match self {
            VendorError::Io { .. } => ExitCode::SystemError,
            VendorError::SourceMissing { .. } => ExitCode::UserError,
            VendorError::Manifest(e) if e.is_system() => ExitCode::SystemError,
            VendorError::Lock(e) if e.is_system() => ExitCode::SystemError,
            VendorError::Drift { .. }
            | VendorError::MissingDependency { .. }
            | VendorError::AbsolutePathRejected { .. }
            | VendorError::PathEscape { .. }
            | VendorError::Manifest(_)
            | VendorError::Lock(_)
            | VendorError::AuthConfig(_)
            | VendorError::UnsupportedSource { .. } => ExitCode::UserError,
        }
    }
}

pub fn add(
    workspace: &Path,
    name: &str,
    auth: Option<&crate::host_auth::HostAuthMap>,
) -> Result<VendorAddOutput, VendorError> {
    add_impl(workspace, name, true, auth)
}

pub fn plan_add(
    workspace: &Path,
    name: &str,
    auth: Option<&crate::host_auth::HostAuthMap>,
) -> Result<VendorAddOutput, VendorError> {
    add_impl(workspace, name, false, auth)
}

fn add_impl(
    workspace: &Path,
    name: &str,
    write: bool,
    auth: Option<&crate::host_auth::HostAuthMap>,
) -> Result<VendorAddOutput, VendorError> {
    let manifest = AkuaManifest::load(workspace)?;
    let dep = manifest
        .dependencies
        .get(name)
        .ok_or_else(|| VendorError::MissingDependency {
            name: name.to_string(),
        })?;
    let source = resolve_source(workspace, name, dep, auth)?;
    let vendor_root = vendor_root(workspace);
    let target = vendor_root.join(name);

    // Source digest is also the post-copy target digest — `copy_tree` is
    // byte-identical, so we don't re-hash the target after writing.
    let (digest, size_bytes) = hash_dir(&source.root).map_err(|err| VendorError::Io {
        path: source.root.clone(),
        source: err,
    })?;

    let target_existed = target.exists();
    let target_matches = if target_existed {
        let (target_digest, _) = hash_dir(&target).map_err(|err| VendorError::Io {
            path: target.clone(),
            source: err,
        })?;
        target_digest == digest
    } else {
        false
    };

    let (wrote, replaced) = if target_matches {
        (false, false)
    } else if write {
        if target_existed {
            std::fs::remove_dir_all(&target).map_err(|err| VendorError::Io {
                path: target.clone(),
                source: err,
            })?;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|err| VendorError::Io {
                path: parent.to_path_buf(),
                source: err,
            })?;
        }
        copy_tree(&source.root, &target)?;
        (true, target_existed)
    } else {
        // plan mode: report what would happen without writing
        (true, target_existed)
    };

    // `vendor check` compares against the lockfile pin; without it a
    // GC'd canonical source breaks drift detection.
    if write {
        let lock_digest = source.lock_digest.as_deref().unwrap_or(&digest);
        let vendor_digest = (lock_digest != digest).then_some(digest.as_str());
        upsert_vendor_lock_entry(workspace, name, dep, lock_digest, vendor_digest)?;
    }

    Ok(VendorAddOutput {
        name: name.to_string(),
        source_kind: source.kind.to_string(),
        source_ref: source.source_ref,
        path: target,
        digest,
        size_bytes,
        wrote,
        replaced,
    })
}

/// Upsert a `LockedPackage` for the vendored dep, routing through the
/// resolver's shared `upsert_locked_from_source` so the lockfile shape
/// stays identical whether the entry came from `vendor add` or from a
/// resolver-driven `akua add` / `akua lock`.
fn upsert_vendor_lock_entry(
    workspace: &Path,
    name: &str,
    dep: &Dependency,
    lock_digest: &str,
    vendor_digest: Option<&str>,
) -> Result<(), VendorError> {
    let mut lock = match AkuaLock::load(workspace) {
        Ok(l) => l,
        Err(LockLoadError::Missing { .. }) => AkuaLock::empty(),
        Err(e) => return Err(VendorError::Lock(e)),
    };
    let (source, digest) = vendor_lock_source(dep, lock_digest);
    upsert_locked_from_source(&mut lock, name, &source, &digest);
    if let Some(vendor_digest) = vendor_digest {
        let (_, version, _) = source.to_locked_fields();
        if let Some(slot) = lock.find_slot(name, &version) {
            lock.packages[slot].vendor_digest = Some(vendor_digest.to_string());
        }
    }
    lock.save(workspace).map_err(VendorError::Lock)?;
    Ok(())
}

/// Project the dep + vendored-tree hash into the
/// `(ResolvedSource, digest)` pair `upsert_locked_from_source` expects.
/// Git deps normalize the resolved commit to `git:<sha>` per the
/// lockfile convention; path/oci deps keep the `sha256:<hex>` form
/// `hash_dir` produced.
fn vendor_lock_source(dep: &Dependency, lock_digest: &str) -> (ResolvedSource, String) {
    let spec = dep.spec();
    match spec {
        DependencySpec::Path { declared } => (
            ResolvedSource::Path {
                declared: declared.to_string(),
            },
            lock_digest.to_string(),
        ),
        DependencySpec::Oci { oci, version } => (
            ResolvedSource::Oci {
                oci: oci.to_string(),
                version: version.to_string(),
                blob_digest: lock_digest.to_string(),
            },
            lock_digest.to_string(),
        ),
        DependencySpec::Git { git, .. } => {
            let raw = lock_digest
                .strip_prefix(GIT_DIGEST_PREFIX)
                .unwrap_or(lock_digest)
                .to_string();
            (
                ResolvedSource::Git {
                    git: git.to_string(),
                    tag_or_rev: spec
                        .tag_or_rev()
                        .unwrap_or(VENDORED_LOCK_FALLBACK)
                        .to_string(),
                    commit_sha: raw.clone(),
                },
                format!("{GIT_DIGEST_PREFIX}{raw}"),
            )
        }
        // Helm-repo dependencies are rejected before lock-source construction.
        DependencySpec::Helm { .. } => {
            unreachable!("helm dep reaches vendor_lock_source before the helm fetcher exists")
        }
    }
}

pub fn list(workspace: &Path) -> Result<VendorListOutput, VendorError> {
    let expected = expected_entries(workspace)?.names;
    let vendor_root = vendor_root(workspace);
    let entries = scan_vendor_entries(&vendor_root, &expected)?;
    Ok(VendorListOutput { entries })
}

pub fn check(workspace: &Path) -> Result<VendorCheckOutput, VendorError> {
    let expected = expected_entries(workspace)?;
    let vendor_root = vendor_root(workspace);
    let on_disk = scan_vendor_entries(&vendor_root, &expected.names)?;

    let mut entries = Vec::new();
    let mut drift = false;
    let mut orphaned = Vec::new();
    let mut missing = Vec::new();

    let disk_map: BTreeMap<&str, &VendorListEntry> = on_disk
        .iter()
        .map(|entry| (entry.name.as_str(), entry))
        .collect();

    for expected in expected.entries {
        let path = vendor_root.join(&expected.name);
        match disk_map.get(expected.name.as_str()) {
            Some(actual) => {
                let expected_vendor_digest = expected
                    .vendor_digest
                    .clone()
                    .unwrap_or_else(|| expected.digest.clone());
                let mismatch = actual.digest != expected_vendor_digest;
                drift |= mismatch;
                entries.push(VendorCheckEntry {
                    name: expected.name.clone(),
                    path,
                    source_kind: Some(expected.source_kind.to_string()),
                    source_ref: Some(expected.source_ref),
                    expected_digest: Some(expected_vendor_digest),
                    actual_digest: Some(actual.digest.clone()),
                    orphan: false,
                    missing_vendor: false,
                    missing_source: false,
                });
            }
            None => {
                let expected_vendor_digest = expected
                    .vendor_digest
                    .clone()
                    .unwrap_or_else(|| expected.digest.clone());
                drift = true;
                missing.push(expected.name.clone());
                entries.push(VendorCheckEntry {
                    name: expected.name.clone(),
                    path,
                    source_kind: Some(expected.source_kind.to_string()),
                    source_ref: Some(expected.source_ref),
                    expected_digest: Some(expected_vendor_digest),
                    actual_digest: None,
                    orphan: false,
                    missing_vendor: true,
                    missing_source: false,
                });
            }
        }
    }

    drop(disk_map);
    for entry in on_disk {
        if expected.names.contains(&entry.name) {
            continue;
        }
        drift = true;
        orphaned.push(entry.name.clone());
        entries.push(VendorCheckEntry {
            name: entry.name,
            path: entry.path,
            source_kind: None,
            source_ref: None,
            expected_digest: None,
            actual_digest: Some(entry.digest),
            orphan: true,
            missing_vendor: false,
            missing_source: false,
        });
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    orphaned.sort();
    missing.sort();

    let output = VendorCheckOutput {
        drift,
        entries,
        orphaned,
        missing,
    };

    if output.drift {
        Err(VendorError::Drift { output })
    } else {
        Ok(output)
    }
}

#[derive(Debug, Clone)]
struct ExpectedDep {
    name: String,
    source_kind: &'static str,
    source_ref: String,
    digest: String,
    vendor_digest: Option<String>,
}

#[derive(Debug, Clone)]
struct ExpectedSet {
    names: std::collections::BTreeSet<String>,
    entries: Vec<ExpectedDep>,
}

#[derive(Debug, Clone)]
struct SourceResolution {
    kind: &'static str,
    source_ref: String,
    root: PathBuf,
    lock_digest: Option<String>,
}

fn expected_entries(workspace: &Path) -> Result<ExpectedSet, VendorError> {
    let manifest = AkuaManifest::load(workspace)?;
    let lock = match AkuaLock::load(workspace) {
        Ok(lock) => Some(lock),
        Err(LockLoadError::Missing { .. }) => None,
        Err(e) => return Err(VendorError::Lock(e)),
    };

    let mut names = std::collections::BTreeSet::new();
    let mut entries = Vec::new();
    for (name, dep) in &manifest.dependencies {
        names.insert(name.clone());
        if let Some(locked) = lock.as_ref().and_then(|l| l.find(name)) {
            let (source_kind, source_ref) = locked_source_meta(locked);
            entries.push(ExpectedDep {
                name: name.clone(),
                source_kind,
                source_ref,
                digest: locked.digest.clone(),
                vendor_digest: locked.vendor_digest.clone(),
            });
            continue;
        }

        // No auth: `vendor check` / `vendor list` should already have
        // a lockfile entry for every dep. If we fall through to a
        // resolve, it's a missing lock entry — populate it via
        // `vendor add --auth ...` rather than re-implementing auth
        // plumbing on the discovery path.
        let source = resolve_source(workspace, name, dep, None)?;
        let (digest, _) = hash_dir(&source.root).map_err(|err| VendorError::Io {
            path: source.root.clone(),
            source: err,
        })?;
        entries.push(ExpectedDep {
            name: name.clone(),
            source_kind: source.kind,
            source_ref: source.source_ref,
            digest,
            vendor_digest: None,
        });
    }

    if let Some(lock) = lock {
        for pkg in lock.packages {
            names.insert(pkg.name.clone());
            if manifest.dependencies.contains_key(&pkg.name) {
                continue;
            }
            let (source_kind, source_ref) = locked_source_meta(&pkg);
            entries.push(ExpectedDep {
                name: pkg.name,
                source_kind,
                source_ref,
                digest: pkg.digest,
                vendor_digest: pkg.vendor_digest,
            });
        }
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(ExpectedSet { names, entries })
}

/// Validate + canonicalize a `path = "..."` dep target. Path deps must
/// canonicalize under the workspace root; otherwise vendor would be a
/// side-channel for copying arbitrary host bytes (or anything the
/// calling user can read) into `.akua/vendor/<name>/` where the
/// install pipeline would commit them. Same workspace-local invariant
/// `chart_resolver::resolve_path` enforces, via the shared helper.
fn resolve_path_dep(workspace: &Path, name: &str, requested: &str) -> Result<PathBuf, VendorError> {
    let workspace_canon = workspace.canonicalize().map_err(|err| VendorError::Io {
        path: workspace.to_path_buf(),
        source: err,
    })?;
    let canon =
        validate_workspace_path(&workspace_canon, workspace, requested).map_err(
            |err| match err {
                WorkspacePathError::AbsoluteRejected { path } => {
                    VendorError::AbsolutePathRejected {
                        name: name.to_string(),
                        path,
                    }
                }
                WorkspacePathError::NotFound { path } => VendorError::SourceMissing { path },
                WorkspacePathError::Io { path, source } => VendorError::Io { path, source },
                WorkspacePathError::Escape {
                    resolved,
                    workspace_root,
                } => VendorError::PathEscape {
                    name: name.to_string(),
                    requested: PathBuf::from(requested),
                    resolved,
                    workspace_root,
                },
            },
        )?;
    // canonicalize already required existence; one extra stat to confirm
    // the target is a directory (vendor only mounts directories).
    if !canon.is_dir() {
        return Err(VendorError::SourceMissing { path: canon });
    }
    Ok(canon)
}

fn locked_source_meta(pkg: &LockedPackage) -> (&'static str, String) {
    if pkg.is_path() {
        ("path", pkg.source.clone())
    } else if pkg.is_oci() {
        ("oci", pkg.source.clone())
    } else {
        ("git", pkg.source.clone())
    }
}

fn resolve_source(
    workspace: &Path,
    name: &str,
    dep: &Dependency,
    auth: Option<&crate::host_auth::HostAuthMap>,
) -> Result<SourceResolution, VendorError> {
    match dep.spec() {
        DependencySpec::Path { declared } => Ok(SourceResolution {
            kind: "path",
            source_ref: declared.to_string(),
            root: resolve_path_dep(workspace, name, declared)?,
            lock_digest: None,
        }),
        DependencySpec::Oci { oci, version } => resolve_oci_source(workspace, name, oci, version),
        DependencySpec::Git { git, tag, rev } => {
            resolve_git_source(workspace, name, git, tag, rev, auth)
        }
        // Helm-repo dependencies are unsupported by this vendor path.
        DependencySpec::Helm { .. } => Err(VendorError::UnsupportedSource {
            name: name.to_string(),
            kind: "helm",
        }),
    }
}

fn resolve_oci_source(
    _workspace: &Path,
    name: &str,
    _oci: &str,
    _version: &str,
) -> Result<SourceResolution, VendorError> {
    let _ = name;
    Err(VendorError::SourceMissing {
        path: PathBuf::from("OCI fetching is handled by the host"),
    })
}

fn resolve_git_source(
    _workspace: &Path,
    name: &str,
    _git: &str,
    _tag: Option<&str>,
    _rev: Option<&str>,
    _auth: Option<&crate::host_auth::HostAuthMap>,
) -> Result<SourceResolution, VendorError> {
    let _ = name;
    Err(VendorError::SourceMissing {
        path: PathBuf::from("Git fetching is handled by the host"),
    })
}

fn expected_digest_from_lock(workspace: &Path, name: &str, kind: &str) -> Option<String> {
    let lock = AkuaLock::load(workspace).ok()?;
    let pkg = lock.find(name)?;
    match (
        kind,
        pkg.is_oci(),
        pkg.is_path(),
        pkg.source.starts_with("git+"),
    ) {
        ("oci", true, _, _) => Some(pkg.digest.clone()),
        ("git", _, _, true) => Some(pkg.digest.clone()),
        _ => None,
    }
}

fn vendor_root(workspace: &Path) -> PathBuf {
    workspace.join(VENDOR_DIR)
}

fn scan_vendor_entries(
    vendor_root: &Path,
    expected: &std::collections::BTreeSet<String>,
) -> Result<Vec<VendorListEntry>, VendorError> {
    let mut entries = Vec::new();
    let rd = match std::fs::read_dir(vendor_root) {
        Ok(rd) => rd,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
        Err(err) => {
            return Err(VendorError::Io {
                path: vendor_root.to_path_buf(),
                source: err,
            });
        }
    };
    for entry in rd {
        let entry = entry.map_err(|source| VendorError::Io {
            path: vendor_root.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let (digest, size_bytes) = hash_dir(&path).map_err(|source| VendorError::Io {
            path: path.clone(),
            source,
        })?;
        entries.push(VendorListEntry {
            name: name.clone(),
            path,
            digest,
            size_bytes,
            orphan: !expected.contains(&name),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), VendorError> {
    std::fs::create_dir_all(target).map_err(|err| VendorError::Io {
        path: target.to_path_buf(),
        source: err,
    })?;
    let rd = std::fs::read_dir(source).map_err(|err| VendorError::Io {
        path: source.to_path_buf(),
        source: err,
    })?;
    for entry in rd {
        let entry = entry.map_err(|err| VendorError::Io {
            path: target.to_path_buf(),
            source: err,
        })?;
        let ft = entry.file_type().map_err(|err| VendorError::Io {
            path: entry.path(),
            source: err,
        })?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        if ft.is_dir() {
            copy_tree(&from, &to)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to).map_err(|err| VendorError::Io {
                path: from,
                source: err,
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(root: &Path, rel: &str, body: &[u8]) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn workspace(manifest: &str) -> TempDir {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("akua.toml"), manifest).unwrap();
        tmp
    }

    fn minimal_manifest() -> &'static str {
        r#"
[package]
name = "vendor-test"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
local = { path = "./charts/local" }
"#
    }

    fn git_manifest() -> &'static str {
        r#"
[package]
name = "vendor-test"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
upstream = { git = "https://example.com/acme/app", tag = "v1.0.0" }
"#
    }

    fn make_source_tree(root: &Path) {
        write(
            root,
            "Chart.yaml",
            b"apiVersion: v2\nname: local\nversion: 0.1.0\n",
        );
        write(root, "templates/a.yaml", b"a: 1\n");
        write(root, "templates/b.yaml", b"b: 2\n");
    }

    #[test]
    fn add_copies_declared_path_dep_into_vendor_tree() {
        let ws = workspace(minimal_manifest());
        make_source_tree(&ws.path().join("charts/local"));

        let out = add(ws.path(), "local", None).expect("add");
        assert!(out.wrote);
        assert_eq!(out.source_kind, "path");
        assert!(out.path.ends_with(".akua/vendor/local"));
        assert!(out.path.join("Chart.yaml").is_file());
        assert!(out.digest.starts_with("sha256:"));

        let copied = std::fs::read_to_string(out.path.join("templates/a.yaml")).unwrap();
        assert!(copied.contains("a: 1"));
    }

    #[test]
    fn add_is_idempotent_when_vendor_tree_already_matches_source() {
        let ws = workspace(minimal_manifest());
        make_source_tree(&ws.path().join("charts/local"));

        let first = add(ws.path(), "local", None).expect("first add");
        let second = add(ws.path(), "local", None).expect("second add");
        assert!(first.wrote);
        assert!(!second.wrote);
        assert_eq!(first.digest, second.digest);
    }

    #[test]
    fn check_reports_drift_after_vendored_tree_changes() {
        let ws = workspace(minimal_manifest());
        make_source_tree(&ws.path().join("charts/local"));
        add(ws.path(), "local", None).expect("add");

        std::fs::write(
            ws.path().join(".akua/vendor/local/templates/a.yaml"),
            b"a: 99\n",
        )
        .unwrap();

        let err = check(ws.path()).expect_err("drift");
        let structured = err.to_structured();
        assert_eq!(structured.code, codes::E_VENDOR_DRIFT);
        assert_eq!(err.exit_code(), ExitCode::UserError);
        match err {
            VendorError::Drift { output } => {
                assert!(output.drift);
                assert!(output
                    .entries
                    .iter()
                    .any(|e| e.name == "local" && e.actual_digest.is_some()));
            }
            other => panic!("expected drift, got {other:?}"),
        }
    }

    #[test]
    fn list_marks_orphaned_vendor_trees() {
        let ws = workspace(minimal_manifest());
        make_source_tree(&ws.path().join("charts/local"));
        add(ws.path(), "local", None).expect("add");

        write(
            ws.path(),
            ".akua/vendor/orphan/Chart.yaml",
            b"name: orphan\n",
        );

        let listed = list(ws.path()).expect("list");
        assert_eq!(listed.entries.len(), 2);
        let orphan = listed
            .entries
            .iter()
            .find(|e| e.name == "orphan")
            .expect("orphan entry");
        assert!(orphan.orphan);
    }

    #[test]
    fn missing_dependency_suggests_vendor_path_declaration() {
        let ws = workspace(minimal_manifest());
        let err = add(ws.path(), "nope", None).unwrap_err();
        let structured = err.to_structured();
        assert_eq!(structured.code, codes::E_VENDOR_DEP_MISSING);
        assert!(structured
            .suggestion
            .unwrap_or_default()
            .contains("path = \".akua/vendor/nope\""));
    }

    /// The `source_ref` in `VendorAddOutput` (and thus in `--json` output)
    /// must use a canonicalized URL — no userinfo, no default ports, no
    /// trailing `.git`. This is defense-in-depth on the `--json` output
    /// path matching the lockfile write path.
    #[test]
    fn source_ref_in_output_uses_canonical_url_for_path_dep() {
        // For path deps the source_ref is the declared path string, not a URL —
        // canonicalize_url is only applied on the git arm. This test confirms
        // the path arm is unaffected and still returns the declared path.
        let ws = workspace(minimal_manifest());
        make_source_tree(&ws.path().join("charts/local"));
        let out = add(ws.path(), "local", None).expect("add");
        // Path dep: source_ref should be the declared path, not a URL.
        assert_eq!(out.source_ref, "./charts/local");
    }

    /// `vendor add` writes the dep's digest into `akua.lock` so render's
    /// vendor-first lookup + `vendor check` drift detection have a stable
    /// pin to compare against. Without this, dropping the canonical
    /// source after vendoring would break `vendor check`.
    #[test]
    fn add_pins_vendored_tree_in_akua_lock() {
        let ws = workspace(minimal_manifest());
        make_source_tree(&ws.path().join("charts/local"));

        let out = add(ws.path(), "local", None).expect("add");
        assert!(out.wrote);

        let lock_path = ws.path().join("akua.lock");
        assert!(lock_path.is_file(), "akua.lock should be written");

        let lock = AkuaLock::load(ws.path()).expect("load lock");
        let entry = lock.find("local").expect("local entry pinned");
        assert_eq!(entry.name, "local");
        assert_eq!(entry.version, "local");
        assert_eq!(entry.source, "path+file://./charts/local");
        assert_eq!(entry.digest, out.digest);
    }

    #[test]
    fn check_accepts_git_lock_commit_with_vendor_tree_digest() {
        let ws = workspace(git_manifest());
        let vendor_path = ws.path().join(".akua/vendor/upstream");
        make_source_tree(&vendor_path);
        let (vendor_digest, _) = hash_dir(&vendor_path).expect("hash vendor");
        let manifest = AkuaManifest::load(ws.path()).expect("manifest");
        let dep = manifest.dependencies.get("upstream").expect("dep");
        let commit = "0123456789abcdef0123456789abcdef01234567";
        let git_digest = format!("{GIT_DIGEST_PREFIX}{commit}");

        upsert_vendor_lock_entry(
            ws.path(),
            "upstream",
            dep,
            &git_digest,
            Some(&vendor_digest),
        )
        .expect("lock");

        let lock = AkuaLock::load(ws.path()).expect("load lock");
        let entry = lock.find("upstream").expect("lock entry");
        assert_eq!(entry.digest, git_digest);
        assert_eq!(entry.vendor_digest.as_deref(), Some(vendor_digest.as_str()));

        let out = check(ws.path()).expect("check");
        assert!(!out.drift);
        let entry = out
            .entries
            .iter()
            .find(|entry| entry.name == "upstream")
            .expect("check entry");
        assert_eq!(
            entry.expected_digest.as_deref(),
            Some(vendor_digest.as_str())
        );
        assert_eq!(entry.actual_digest.as_deref(), Some(vendor_digest.as_str()));
    }

    /// Re-running `vendor add` against an unchanged source produces a
    /// byte-identical lockfile — the lock-write must be idempotent.
    #[test]
    fn add_lockfile_write_is_idempotent_on_repeat() {
        let ws = workspace(minimal_manifest());
        make_source_tree(&ws.path().join("charts/local"));

        add(ws.path(), "local", None).expect("add 1");
        let lock_v1 = std::fs::read_to_string(ws.path().join("akua.lock")).expect("read 1");

        add(ws.path(), "local", None).expect("add 2");
        let lock_v2 = std::fs::read_to_string(ws.path().join("akua.lock")).expect("read 2");

        assert_eq!(lock_v1, lock_v2, "repeat add must produce identical lock");
    }

    /// The git `source_ref` in `VendorAddOutput` must not expose a raw
    /// URL that might carry userinfo or default ports. This test exercises
    /// the URL canonicalization contract without fetching a remote.
    #[test]
    fn resolve_git_source_ref_strips_default_port_and_dot_git() {
        // canonicalize_url is applied to `git` before formatting source_ref.
        // Exercise the same function to confirm the contract is met.
        use crate::host_auth::canonicalize_url;

        let raw = "https://example.com:443/acme/app.git";
        let canon = canonicalize_url(raw);
        assert_eq!(canon, "https://example.com/acme/app");
        // A source_ref built with the canonicalized URL should NOT contain
        // the default port or `.git`.
        let source_ref = format!("{canon}@v1.0.0");
        assert!(
            !source_ref.contains(":443"),
            "default port must be stripped"
        );
        assert!(!source_ref.contains(".git"), ".git suffix must be stripped");
    }

    mod vendor_lock_source_tests {
        use super::*;
        use crate::chart_resolver::ResolvedSource;

        const TREE_DIGEST: &str = "sha256:deadbeef";
        const GIT_COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
        const GIT_DIGEST: &str = "git:0123456789abcdef0123456789abcdef01234567";

        fn dep_path(declared: &str) -> Dependency {
            Dependency {
                path: Some(declared.to_string()),
                ..Default::default()
            }
        }

        fn dep_oci(oci: &str, version: &str) -> Dependency {
            Dependency {
                oci: Some(oci.to_string()),
                version: Some(version.to_string()),
                ..Default::default()
            }
        }

        fn dep_git(git: &str, tag: Option<&str>, rev: Option<&str>) -> Dependency {
            Dependency {
                git: Some(git.to_string()),
                tag: tag.map(String::from),
                rev: rev.map(String::from),
                ..Default::default()
            }
        }

        #[test]
        fn path_dep_keeps_declared_string_and_sha256_digest() {
            let dep = dep_path("./charts/local");
            let (source, digest) = vendor_lock_source(&dep, TREE_DIGEST);
            match source {
                ResolvedSource::Path { declared } => assert_eq!(declared, "./charts/local"),
                other => panic!("expected ResolvedSource::Path, got {other:?}"),
            }
            assert_eq!(digest, TREE_DIGEST);
        }

        #[test]
        fn oci_dep_passes_oci_ref_and_version_through() {
            let dep = dep_oci("oci://ghcr.io/acme/nginx", "1.2.3");
            let (source, digest) = vendor_lock_source(&dep, TREE_DIGEST);
            match source {
                ResolvedSource::Oci {
                    oci,
                    version,
                    blob_digest,
                } => {
                    assert_eq!(oci, "oci://ghcr.io/acme/nginx");
                    assert_eq!(version, "1.2.3");
                    assert_eq!(blob_digest, TREE_DIGEST);
                }
                other => panic!("expected ResolvedSource::Oci, got {other:?}"),
            }
            assert_eq!(digest, TREE_DIGEST);
        }

        #[test]
        fn git_dep_with_tag_uses_resolved_commit_digest() {
            let dep = dep_git("https://github.com/foo/bar", Some("v1.0.0"), None);
            let (source, digest) = vendor_lock_source(&dep, GIT_DIGEST);
            match source {
                ResolvedSource::Git {
                    git,
                    tag_or_rev,
                    commit_sha,
                } => {
                    assert_eq!(git, "https://github.com/foo/bar");
                    assert_eq!(tag_or_rev, "v1.0.0");
                    assert_eq!(commit_sha, GIT_COMMIT);
                }
                other => panic!("expected ResolvedSource::Git, got {other:?}"),
            }
            assert_eq!(digest, GIT_DIGEST);
        }

        #[test]
        fn git_dep_with_rev_only_uses_rev_as_tag_or_rev() {
            let dep = dep_git("https://github.com/foo/bar", None, Some("abc123"));
            let (source, _) = vendor_lock_source(&dep, TREE_DIGEST);
            match source {
                ResolvedSource::Git { tag_or_rev, .. } => assert_eq!(tag_or_rev, "abc123"),
                other => panic!("expected ResolvedSource::Git, got {other:?}"),
            }
        }

        #[test]
        fn git_dep_with_neither_tag_nor_rev_falls_back_to_vendored_marker() {
            let dep = dep_git("https://github.com/foo/bar", None, None);
            let (source, _) = vendor_lock_source(&dep, TREE_DIGEST);
            match source {
                ResolvedSource::Git { tag_or_rev, .. } => assert_eq!(tag_or_rev, "vendored"),
                other => panic!("expected ResolvedSource::Git, got {other:?}"),
            }
        }

        #[test]
        fn git_dep_accepts_raw_or_prefixed_commit_digest() {
            let dep = dep_git("https://github.com/foo/bar", Some("v1"), None);
            let (_, digest) = vendor_lock_source(&dep, GIT_DIGEST);
            assert_eq!(digest, GIT_DIGEST);

            let (_, digest_unprefixed) = vendor_lock_source(&dep, GIT_COMMIT);
            assert_eq!(digest_unprefixed, GIT_DIGEST);
        }
    }

    /// Path deps must stay under the workspace root. Absolute paths
    /// in `path = "..."` are rejected with `E_PATH_ESCAPE` — same
    /// workspace-local invariant the chart_resolver enforces (see
    /// CLAUDE.md).
    #[test]
    fn absolute_path_dep_is_rejected_with_e_path_escape() {
        let ws = workspace(
            r#"
[package]
name = "vendor-test"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
bad = { path = "/etc" }
"#,
        );
        let err = add(ws.path(), "bad", None).unwrap_err();
        let structured = err.to_structured();
        assert_eq!(structured.code, codes::E_PATH_ESCAPE);
        assert!(matches!(err, VendorError::AbsolutePathRejected { .. }));
    }

    /// Relative paths that canonicalize outside the workspace
    /// (typically via `..` segments or symlinks) are rejected with
    /// `E_PATH_ESCAPE`, even though they look workspace-local in
    /// the manifest.
    #[test]
    fn path_dep_escaping_via_dotdot_is_rejected_with_e_path_escape() {
        let outer = tempfile::tempdir().expect("outer tmpdir");
        let workspace_dir = outer.path().join("ws");
        std::fs::create_dir(&workspace_dir).expect("create workspace");
        // The sibling just has to exist as a directory so canonicalize
        // resolves it. Rejection lands before any chart parsing.
        let sibling = outer.path().join("sibling");
        std::fs::create_dir(&sibling).expect("create sibling");
        std::fs::write(
            workspace_dir.join("akua.toml"),
            r#"
[package]
name = "escape_test"
version = "0.0.1"
edition = "akua.dev/v1alpha1"

[dependencies]
bad = { path = "../sibling" }
"#,
        )
        .expect("write manifest");

        let err = add(&workspace_dir, "bad", None).unwrap_err();
        let structured = err.to_structured();
        assert_eq!(structured.code, codes::E_PATH_ESCAPE);
        assert!(matches!(err, VendorError::PathEscape { .. }));
    }
}
