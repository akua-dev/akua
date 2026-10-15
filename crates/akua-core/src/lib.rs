//! # akua-core
//!
//! The KCL side of akuapkg, compiled into the sandboxed render worker
//! (`crates/akua-render-worker`). Typed primitives for:
//!
//! - [`cli_contract`] — universal flags, exit codes, structured errors,
//!   agent-context detection.
//! - [`lock_file`] / [`mod_file`] — `akua.lock` + `akua.toml` parsers.
//! - [`package_k`] — `Package.k` loader (KCL-only subset).
//! - [`package_render`] — writes a rendered Package to disk as raw YAML.
//!
//! Spec: [`docs/package-format.md`](../../../docs/package-format.md),
//! [`docs/lockfile-format.md`](../../../docs/lockfile-format.md),
//! [`docs/cli-contract.md`](../../../docs/cli-contract.md).

#![allow(dead_code)]

/// Marks a CLI contract type definition. Expands to the item unchanged.
#[macro_export]
#[doc(hidden)]
macro_rules! contract_type {
    ($item:item) => {
        $item
    };
}

#[cfg(feature = "engine-kcl")]
pub mod chart_resolver;
#[cfg(feature = "engine-kcl")]
pub mod check;
pub mod cli_contract;
#[cfg(feature = "engine-kcl")]
pub mod dir_diff;
pub mod duration_parse;
#[cfg(feature = "engine-kcl")]
pub mod export;
pub(crate) mod hex;
pub mod host_auth;
#[cfg(feature = "engine-kcl")]
pub mod kcl_plugin;
pub mod lock_file;
pub mod mod_file;
#[cfg(feature = "engine-kcl")]
pub mod package_k;
#[cfg(feature = "engine-kcl")]
pub mod package_render;
#[cfg(feature = "engine-kcl")]
pub mod pkg_render;
#[cfg(feature = "engine-kcl")]
pub mod pkg_stub;
#[cfg(feature = "engine-kcl")]
pub mod stdlib;
#[cfg(feature = "engine-kcl")]
pub mod test_runner;
pub mod tree;
#[cfg(feature = "engine-kcl")]
pub mod values_schema;
#[cfg(feature = "engine-kcl")]
pub mod vendor;
pub(crate) mod walk;
#[cfg(feature = "engine-kcl")]
pub(crate) mod yaml_multidoc;

#[cfg(feature = "engine-kcl")]
pub use chart_resolver::{ChartResolveError, ResolvedChart, ResolvedCharts};
#[cfg(feature = "engine-kcl")]
pub use check::{check_from_sources, CheckOutput, CheckResult};
pub use cli_contract::{AgentContext, AgentSource, ExitCode, StructuredError};
#[cfg(feature = "engine-kcl")]
pub use dir_diff::{diff as dir_diff, DirDiff, DirDiffError, FileChange};
pub use lock_file::{
    AkuaLock, LockError, LockLoadError, LockedPackage, Replaced, CURRENT_VERSION as LOCK_VERSION,
};
pub use mod_file::{
    is_valid_package_name, AkuaManifest, DependencySource, ManifestError, ManifestLoadError,
    PackageSection, Replace, WorkspaceSection,
};
#[cfg(feature = "engine-kcl")]
pub use package_k::{
    eval_source, eval_source_full, eval_source_full_with_pkgs, eval_source_with_inputs, format_kcl,
    lint_kcl, lint_kcl_source, lint_kcl_source_with_pkgs, list_options_kcl,
    list_options_kcl_source, parse_rendered_yaml, LintIssue, OptionInfo, PackageK, PackageKError,
    RenderedPackage,
};
#[cfg(feature = "engine-kcl")]
pub use package_render::{
    render, RenderError as PackageRenderError, RenderSummary, FORMAT_RAW_MANIFESTS,
};
pub use tree::{
    tree_from_parsed, tree_from_sources, DepRow, LockedInfo, PackageInfo, TreeOutput,
    TreeSourceError,
};
#[cfg(feature = "engine-kcl")]
pub use vendor::{
    VendorAddOutput, VendorCheckEntry, VendorCheckOutput, VendorError, VendorListEntry,
    VendorListOutput,
};
