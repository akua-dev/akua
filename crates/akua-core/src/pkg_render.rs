//! `pkg.render(opts) -> [resource]` — recursive Package composition.
//!
//! # Architecture: synchronous engine plugin
//!
//! Mirrors the call shape of [`crate::helm`] and [`crate::kustomize`]:
//! the plugin handler runs the inner Package's `render()`
//! synchronously and returns the resulting list of resources to the
//! KCL caller. List-comprehension patches, filter expressions, and
//! anything else KCL does to a `[{str:}]` work natively because the
//! return is a real list, not a placeholder.
//!
//! ## Why this needs the patched KCL fork
//!
//! Upstream `kcl-runtime/src/stdlib/plugin.rs` holds
//! `PLUGIN_HANDLER_FN_PTR` across the user-supplied callback. A
//! plugin that re-entered KCL deadlocked on the same thread —
//! `std::sync::Mutex` isn't reentrant. akua carries a one-line patch
//! at `cnap-tech/kcl#akua-wasm32` (commit `d584c0bc`) that copies the
//! fn pointer out of the lock before invoking it, freeing the
//! reentrant call. Without that patch this design hangs.
//!
//! Cycle detection uses the thread-local render stack
//! [`crate::kcl_plugin::RenderScope`]: `pkg.render` of a path
//! already on the stack returns [`crate::package_k::PackageKError::Cycle`]
//! before the inner load.

use std::path::{Path, PathBuf};

use crate::{kcl_plugin, PackageK};

pub const PLUGIN_NAME: &str = "pkg.render";

const OPT_PACKAGE: &str = "package";
const OPT_INPUTS: &str = "inputs";

/// Prefix every error with the plugin name + the target path so
/// nested failures read as a stack (`pkg.render(a.k): pkg.render(b.k): …`)
/// rather than a repeated tag.
fn err_at(target: &Path, msg: impl std::fmt::Display) -> String {
    format!("{PLUGIN_NAME}({}): {msg}", target.display())
}

fn err(msg: impl std::fmt::Display) -> String {
    format!("{PLUGIN_NAME}: {msg}")
}

pub fn install() {
    kcl_plugin::register(PLUGIN_NAME, |args, _kwargs| {
        let opts = kcl_plugin::extract_options_arg(args, PLUGIN_NAME, "pkg.Render")?;
        let inputs_json = opts
            .get(OPT_INPUTS)
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        // `PackageK::render` takes the same `serde_yaml::Value` shape that
        // `ctx.input()` flows through. `serde_yaml::to_value` walks the
        // serde_json::Value via serde directly — no string intermediate.
        let inputs_yaml: serde_yaml::Value =
            serde_yaml::to_value(&inputs_json).map_err(|e| err(format!("inputs: {e}")))?;

        // Resolve target package by its typed dep alias. The alias is
        // declared under `[dependencies]` in the calling Package's
        // `akua.toml`; the resolver maps it to the upstream's directory.
        // CLAUDE.md "No filesystem paths in user-authored KCL" — there
        // is no `path = "..."` escape hatch: cross-Package composition
        // goes through typed aliases only.
        let target = match opts.get(OPT_PACKAGE).and_then(serde_json::Value::as_str) {
            Some(alias) => resolve_by_alias(alias)?,
            None => {
                return Err(err(format!(
                    "set `{OPT_PACKAGE} = \"<dep-alias>\"` — declare the sub-package under \
                     `[dependencies]` in akua.toml and compose it by alias \
                     (filesystem paths are not allowed in composition)"
                )));
            }
        };

        // Pre-render checks — cycle, depth cap, wall-clock — in one
        // pass over the render stack. Cycle rejects re-entry of a
        // Package already on the chain; depth + deadline cover the
        // remaining runaway shapes (unbounded fan-out through fresh
        // Packages; host-side eval spinning past the wasm epoch
        // deadline).
        let pre = kcl_plugin::pre_check(&target);
        if pre.cycle {
            return Err(err_at(
                &target,
                "cycle detected — already on the render stack",
            ));
        }
        if pre.depth >= pre.budget.max_depth {
            return Err(err_at(
                &target,
                format!(
                    "render depth limit ({}) exceeded — likely composition runaway",
                    pre.budget.max_depth
                ),
            ));
        }
        if let Some(deadline) = pre.budget.deadline {
            if std::time::Instant::now() >= deadline {
                return Err(err_at(
                    &target,
                    "wall-clock budget exhausted in nested render",
                ));
            }
        }

        // Load + render the inner Package. The recursion is bounded
        // by RenderScope (push on enter, pop on drop): even when the
        // inner Package itself calls pkg.render, the stack stays
        // balanced and the cycle check fires correctly.
        let pkg = PackageK::load(&target).map_err(|e| err_at(&target, e))?;

        // A composed sub-package needs its OWN external-package
        // context: resolve the child's `akua.toml` so its
        // `import charts.<x>` / `import <kcl-ecosystem>` deps register
        // for the child eval. Without this the child rendered with an
        // empty `ResolvedCharts` and any chart/ecosystem import failed
        // with `CannotFindModule`, even though the child manifest
        // declares the dep. No child manifest → empty charts, which
        // preserves the pure-KCL sub-package path.
        let child_charts = resolve_child_charts(&target).map_err(|e| err_at(&target, e))?;
        let rendered = pkg
            .render_with_charts(&inputs_yaml, &child_charts)
            .map_err(|e| err_at(&target, e))?;

        // Convert back to serde_json — KCL's plugin contract returns
        // JSON, and the caller's `_up = pkg.render(...)` binding is
        // a real list of real dicts after this returns.
        let json_resources: Vec<serde_json::Value> = rendered
            .resources
            .into_iter()
            .map(|y| serde_json::to_value(y).map_err(|e| err_at(&target, e)))
            .collect::<Result<_, _>>()?;
        Ok(serde_json::Value::Array(json_resources))
    });
}

/// Resolve a composed sub-package's own `[dependencies]` so its
/// `import charts.<x>` (Helm) and KCL-ecosystem imports (`import k8s…`)
/// resolve during the child eval.
///
/// `target` is the child's `package.k`; its sibling `akua.toml` is the
/// child's manifest and `akua.lock` its pinned digests. The resolver's
/// security posture (`reject_replace`, `offline`, cache, cosign, auth)
/// is inherited from the parent render frame via
/// [`kcl_plugin::current_resolver_context`] — a sub-package can't open
/// a `replace`/`path` hole the root forbade, and can't reach the
/// network if the root ran offline. The child's `expected_digests`
/// come from the child's OWN lockfile, not the parent's.
///
/// No child `akua.toml` → empty [`ResolvedCharts`], preserving the
/// pure-KCL sub-package path (a sub-package with no deps renders as
/// before).
fn resolve_child_charts(target: &Path) -> Result<crate::chart_resolver::ResolvedCharts, String> {
    use crate::chart_resolver::{self, ResolverOptions};
    use crate::{AkuaLock, AkuaManifest, LockedPackage, ManifestLoadError};

    let workspace = target.parent().unwrap_or(Path::new("."));
    let manifest = match AkuaManifest::load(workspace) {
        Ok(m) => m,
        // No manifest: pure-KCL / no-dep sub-package. Render with no
        // external-package context, same as before this fix.
        Err(ManifestLoadError::Missing { .. }) => {
            return Ok(chart_resolver::ResolvedCharts::default())
        }
        Err(e) => return Err(format!("loading child akua.toml: {e}")),
    };

    // Child's own lockfile pins OCI digests; absence is fine (path-dep
    // children, or unlocked workspaces — `akua verify` covers lock
    // integrity separately).
    let expected_digests = match AkuaLock::load(workspace) {
        Ok(lock) => lock
            .packages
            .into_iter()
            .filter(LockedPackage::is_oci)
            .map(|p| (p.name, p.digest))
            .collect(),
        Err(_) => Default::default(),
    };

    let ctx = kcl_plugin::current_resolver_context();
    let opts = ResolverOptions {
        offline: ctx.offline,
        cache_root: ctx.cache_root,
        expected_digests,
        cosign_public_key_pem: ctx.cosign_public_key_pem,
        reject_replace: ctx.reject_replace,
        auth: ctx.auth,
    };
    chart_resolver::resolve_with_options(&manifest, workspace, &opts)
        .map_err(|e| format!("resolving child deps: {e}"))
}

/// Accept either a directory (append `package.k`) or a direct file path.
fn resolve_package_file(resolved: &Path) -> PathBuf {
    if resolved.is_dir() {
        resolved.join("package.k")
    } else {
        resolved.to_path_buf()
    }
}

/// Look up an Akua-package dep alias against the current render frame's
/// resolved-deps map. Errors when the alias is missing, listing the
/// aliases the caller could have used so typos surface immediately.
fn resolve_by_alias(alias: &str) -> Result<PathBuf, String> {
    match kcl_plugin::resolve_pkg_alias(alias) {
        Some(dir) => Ok(resolve_package_file(&dir)),
        None => {
            let known = kcl_plugin::current_pkg_aliases();
            let hint = if known.is_empty() {
                String::from("none — declare it under `[dependencies]` in akua.toml")
            } else {
                format!("known: {}", known.join(", "))
            };
            Err(err(format!(
                "package `{alias}` is not in the current Package's dependencies ({hint})"
            )))
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_yaml::Value as YamlValue;
    use std::fs;
    use tempfile::TempDir;

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, body).unwrap();
        path
    }

    /// Resolve a workspace's `akua.toml` deps into a `ResolvedCharts`
    /// so `render_with_charts` populates the frame's `resolved_pkgs`
    /// alias map. Path deps that contain a `package.k` become
    /// `pkg.render(package = "<alias>")` targets.
    fn resolve_ws(dir: &Path) -> crate::chart_resolver::ResolvedCharts {
        let manifest = crate::AkuaManifest::load(dir).expect("load akua.toml");
        crate::chart_resolver::resolve(&manifest, dir).expect("resolve deps")
    }

    /// Write a minimal Akua package manifest declaring `deps` (a list
    /// of `(alias, relative-path)` path deps) so they're addressable
    /// by alias via `pkg.render(package = "<alias>")`.
    fn write_manifest(dir: &Path, name: &str, deps: &[(&str, &str)]) {
        let mut body = format!(
            "[package]\nname = \"{name}\"\nversion = \"0.1.0\"\nedition = \"akua.dev/v1alpha1\"\n\n[dependencies]\n"
        );
        for (alias, path) in deps {
            body.push_str(&format!("{alias} = {{ path = \"{path}\" }}\n"));
        }
        write(dir, "akua.toml", &body);
    }

    /// Minimal inner Package body — ConfigMap with name driven by input.
    const INNER: &str = r#"
schema Input:
    name: str = "inner"

input: Input = option("input") or Input {}

resources = [{
    apiVersion: "v1"
    kind: "ConfigMap"
    metadata.name: input.name
}]
"#;

    #[test]
    fn outer_package_renders_inner_synchronously() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("inner"), "package.k", INNER);
        write_manifest(&tmp.path().join("inner"), "inner", &[]);
        write_manifest(tmp.path(), "outer", &[("inner", "./inner")]);
        let outer_path = write(
            tmp.path(),
            "package.k",
            r#"
import kcl_plugin.pkg

resources = pkg.render({ package = "inner", inputs = { name = "from-outer" } })"#,
        );

        let charts = resolve_ws(tmp.path());
        let outer = PackageK::load(&outer_path).expect("load outer");
        let rendered = outer
            .render_with_charts(&YamlValue::Mapping(Default::default()), &charts)
            .expect("render outer");

        assert_eq!(rendered.resources.len(), 1);
        let cm = &rendered.resources[0];
        assert_eq!(cm["kind"], YamlValue::String("ConfigMap".into()));
        assert_eq!(
            cm["metadata"]["name"],
            YamlValue::String("from-outer".into())
        );
    }

    /// List-comprehension overlay applied to `pkg.render` output reaches
    /// the inner resources — the return is a real list, not a placeholder.
    #[test]
    fn list_comprehension_patches_apply_to_pkg_render_output() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("inner"), "package.k", INNER);
        write_manifest(&tmp.path().join("inner"), "inner", &[]);
        write_manifest(tmp.path(), "outer", &[("inner", "./inner")]);
        let outer_path = write(
            tmp.path(),
            "package.k",
            r#"
import kcl_plugin.pkg

_up = pkg.render({ package = "inner" })
resources = [r | {metadata.labels = {"patched" = "yes"}} for r in _up]"#,
        );

        let charts = resolve_ws(tmp.path());
        let outer = PackageK::load(&outer_path).expect("load outer");
        let rendered = outer
            .render_with_charts(&YamlValue::Mapping(Default::default()), &charts)
            .expect("render outer");

        assert_eq!(rendered.resources.len(), 1);
        let cm = &rendered.resources[0];
        assert_eq!(
            cm["metadata"]["labels"]["patched"],
            YamlValue::String("yes".into())
        );
    }

    /// Filter expressions on `pkg.render` output preserve only the
    /// matching resources.
    #[test]
    fn filter_expression_works_on_pkg_render_output() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp.path().join("multi"),
            "package.k",
            r#"
resources = [
    {apiVersion: "v1", kind: "ConfigMap", metadata.name: "keep-me"},
    {apiVersion: "v1", kind: "Secret", metadata.name: "drop-me"},
]"#,
        );
        write_manifest(&tmp.path().join("multi"), "multi", &[]);
        write_manifest(tmp.path(), "outer", &[("multi", "./multi")]);
        let outer_path = write(
            tmp.path(),
            "package.k",
            r#"
import kcl_plugin.pkg

_all = pkg.render({ package = "multi" })
resources = [r for r in _all if r.kind == "ConfigMap"]"#,
        );

        let charts = resolve_ws(tmp.path());
        let outer = PackageK::load(&outer_path).expect("load outer");
        let rendered = outer
            .render_with_charts(&YamlValue::Mapping(Default::default()), &charts)
            .expect("render outer");

        assert_eq!(rendered.resources.len(), 1);
        assert_eq!(
            rendered.resources[0]["metadata"]["name"],
            YamlValue::String("keep-me".into())
        );
    }

    /// A NESTED `pkg.render(package = "<alias>")` must resolve the
    /// alias against the child frame's OWN `akua.toml` deps. Shape:
    /// root composes `child` by alias; `child`'s `package.k` composes
    /// `grandchild` via `pkg.render({ package = "grandchild" })` where
    /// `child`'s `akua.toml` declares `grandchild` as a path dep.
    ///
    /// Before the nested-resolved_pkgs fix, `render_opts` entered the
    /// child frame with an EMPTY `resolved_pkgs` (via `enter_with`), so
    /// the child's `package = "grandchild"` lookup missed and the render
    /// failed with "package `grandchild` is not in the current Package's
    /// dependencies". After the fix (`enter_for_render` derives
    /// `resolved_pkgs` from the child's resolved charts), it resolves.
    ///
    /// Deterministic / offline: every dep is a workspace-local `path =`
    /// Akua package, resolved without any network.
    #[test]
    fn nested_pkg_render_resolves_typed_alias_from_child_manifest() {
        let tmp = TempDir::new().unwrap();

        // Child: declares grandchild (nested under child/, so the
        // path dep canonicalizes under the child workspace root) as a
        // path dep and composes it via the typed alias through a
        // NESTED pkg.render.
        let child = tmp.path().join("child");
        fs::create_dir_all(&child).unwrap();

        // Grandchild: a leaf Akua package emitting one ConfigMap.
        let grandchild = child.join("grandchild");
        fs::create_dir_all(&grandchild).unwrap();
        write_manifest(&grandchild, "grandchild", &[]);
        write(
            &grandchild,
            "package.k",
            "resources = [{apiVersion: \"v1\", kind: \"ConfigMap\", metadata.name: \"from-grandchild\"}]\n",
        );

        write_manifest(&child, "child", &[("grandchild", "./grandchild")]);
        write(
            &child,
            "package.k",
            r#"
import kcl_plugin.pkg

resources = pkg.render({ package = "grandchild" })"#,
        );

        // Root: declares child as a path dep and composes it by alias.
        write_manifest(tmp.path(), "root", &[("child", "./child")]);
        let root_path = write(
            tmp.path(),
            "package.k",
            r#"
import kcl_plugin.pkg

resources = pkg.render({ package = "child" })"#,
        );

        // Resolve the root's deps so the root frame has `child` in its
        // resolved_pkgs (mirrors the CLI render path).
        let charts = resolve_ws(tmp.path());

        let root = PackageK::load(&root_path).expect("load root");
        let rendered = root
            .render_with_charts(&YamlValue::Mapping(Default::default()), &charts)
            .expect("render root composing child which composes grandchild by alias");

        assert_eq!(rendered.resources.len(), 1, "grandchild resource present");
        assert_eq!(
            rendered.resources[0]["metadata"]["name"],
            YamlValue::String("from-grandchild".into())
        );
    }

    #[test]
    fn detects_direct_cycle_via_render_stack() {
        // A package that declares ITSELF as a dep (`me = { path = "." }`)
        // and composes itself by alias. The render stack catches the
        // re-entry before the inner load.
        let tmp = TempDir::new().unwrap();
        write_manifest(tmp.path(), "cyclic", &[("me", ".")]);
        write(
            tmp.path(),
            "package.k",
            r#"
import kcl_plugin.pkg

_self = pkg.render({ package = "me" })

resources = _self"#,
        );

        let charts = resolve_ws(tmp.path());
        let pkg = PackageK::load(&tmp.path().join("package.k")).expect("load");
        let err = pkg
            .render_with_charts(&YamlValue::Mapping(Default::default()), &charts)
            .unwrap_err()
            .to_string();
        assert!(err.contains("cycle detected"), "got: {err}");
    }

    /// Cycle detection fires for a self-loop reached one level DOWN:
    /// root composes `child`; `child` declares itself (`me = { path =
    /// "." }`) and composes itself. The render stack tracks every
    /// Package on the chain — when `child` re-enters `child`, the stack
    /// catches it. Confirms cycle detection survives the nested
    /// alias-resolution path, not just the top frame.
    ///
    /// (A true cross-Package A→B→A cycle is structurally prevented by
    /// the path-escape guard: a child path dep canonicalizes under the
    /// child's workspace root, so a child can't declare its parent as a
    /// dep. The self-loop is the reachable cycle shape, exercised here
    /// at depth.)
    #[test]
    fn detects_nested_cycle_via_render_stack() {
        let tmp = TempDir::new().unwrap();

        // child: declares ITSELF as a dep and composes itself.
        let child = tmp.path().join("child");
        fs::create_dir_all(&child).unwrap();
        write_manifest(&child, "child", &[("me", ".")]);
        write(
            &child,
            "package.k",
            r#"
import kcl_plugin.pkg

_self = pkg.render({ package = "me" })
resources = _self"#,
        );

        // root composes child.
        write_manifest(tmp.path(), "root", &[("child", "./child")]);
        let root = write(
            tmp.path(),
            "package.k",
            r#"
import kcl_plugin.pkg

resources = pkg.render({ package = "child" })"#,
        );

        let charts = resolve_ws(tmp.path());
        let pkg = PackageK::load(&root).expect("load");
        let err = pkg
            .render_with_charts(&YamlValue::Mapping(Default::default()), &charts)
            .unwrap_err()
            .to_string();
        assert!(err.contains("cycle detected"), "got: {err}");
    }

    /// Two-level recursion: outer → middle → deep. Inputs flow
    /// through both layers, and the render stack stays balanced.
    /// Each layer declares the next as a path dep nested under it so
    /// the alias resolves at every depth.
    #[test]
    fn nested_pkg_render_recurses() {
        let tmp = TempDir::new().unwrap();

        // deep (leaf, under middle/)
        let middle_dir = tmp.path().join("middle");
        let deep_dir = middle_dir.join("deep");
        fs::create_dir_all(&deep_dir).unwrap();
        write(&deep_dir, "package.k", INNER);
        write_manifest(&deep_dir, "deep", &[]);

        // middle (under root), composes deep with a fixed input.
        write_manifest(&middle_dir, "middle", &[("deep", "./deep")]);
        write(
            &middle_dir,
            "package.k",
            r#"
import kcl_plugin.pkg

resources = pkg.render({ package = "deep", inputs = { name = "deep-from-middle" } })"#,
        );

        // root composes middle.
        write_manifest(tmp.path(), "outer", &[("middle", "./middle")]);
        let outer_path = write(
            tmp.path(),
            "package.k",
            r#"
import kcl_plugin.pkg

resources = pkg.render({ package = "middle" })"#,
        );

        let charts = resolve_ws(tmp.path());
        let outer = PackageK::load(&outer_path).expect("load");
        let rendered = outer
            .render_with_charts(&YamlValue::Mapping(Default::default()), &charts)
            .expect("render");
        assert_eq!(rendered.resources.len(), 1);
        assert_eq!(
            rendered.resources[0]["metadata"]["name"],
            YamlValue::String("deep-from-middle".into())
        );
    }

    /// The legacy `path = "..."` composition form is gone: supplying
    /// it (or nothing) is a hard error directing the user to the typed
    /// `package = "<alias>"` form. Filesystem paths are not allowed in
    /// cross-Package composition.
    #[test]
    fn path_form_is_rejected_with_actionable_error() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("inner"), "package.k", INNER);
        let outer_path = write(
            tmp.path(),
            "package.k",
            r#"
import kcl_plugin.pkg

resources = pkg.render({ path = "./inner" })"#,
        );

        let outer = PackageK::load(&outer_path).expect("load outer");
        let err = outer
            .render(&YamlValue::Mapping(Default::default()))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("package = ") && err.contains("[dependencies]"),
            "expected a fix-it pointing at the typed alias form, got: {err}"
        );
    }

    /// Wall-clock budget that's already expired by the time the
    /// outer render starts trips on the first nested `pkg.render`
    /// call. Confirms the deadline propagates into the plugin
    /// handler via the inherited budget snapshot.
    #[test]
    fn budget_wall_clock_deadline_rejects_nested_render() {
        use kcl_plugin::BudgetSnapshot;
        use std::time::{Duration, Instant};

        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("inner"), "package.k", INNER);
        write_manifest(&tmp.path().join("inner"), "inner", &[]);
        write_manifest(tmp.path(), "outer", &[("inner", "./inner")]);
        let outer_path = write(
            tmp.path(),
            "package.k",
            r#"
import kcl_plugin.pkg

resources = pkg.render({ package = "inner" })"#,
        );

        // Deadline already in the past → first pkg.render call rejects.
        // Enter the outer frame with both the expired budget AND the
        // resolved deps (so the `inner` alias resolves and the handler
        // reaches the budget check).
        let charts = resolve_ws(tmp.path());
        let budget = BudgetSnapshot {
            deadline: Some(Instant::now() - Duration::from_secs(1)),
            max_depth: BudgetSnapshot::DEFAULT_MAX_DEPTH,
        };
        let _outer_scope = kcl_plugin::RenderScope::enter_for_render_with_budget(
            &outer_path,
            &charts,
            false,
            budget,
            kcl_plugin::ResolverContext::default(),
        );

        let outer = PackageK::load(&outer_path).expect("load outer");
        let err = outer
            .render_with_charts(&YamlValue::Mapping(Default::default()), &charts)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("wall-clock budget exhausted"),
            "expected wall-clock rejection, got: {err}"
        );
    }

    /// Depth cap rejects unbounded fan-out through fresh Packages
    /// — cycle detection alone doesn't catch this because every
    /// inner Package is a different file. Each level lives in a
    /// sub-directory of the previous and declares the next as a typed
    /// path dep, so aliases resolve at every depth.
    #[test]
    fn budget_depth_cap_rejects_runaway_recursion() {
        use kcl_plugin::BudgetSnapshot;

        // Build a nested chain where each level renders the next:
        //   level0/ → level0/level1/ → … → level0/…/levelN/
        let tmp = TempDir::new().unwrap();
        let chain_len = 5usize;

        // Compute each level's directory: level{i} nested under level{i-1}.
        let mut dirs = vec![tmp.path().to_path_buf()];
        for i in 1..=chain_len {
            dirs.push(dirs[i - 1].join(format!("level{i}")));
        }
        for d in &dirs[1..] {
            fs::create_dir_all(d).unwrap();
        }

        // Tail: a leaf with a literal resource list.
        write_manifest(&dirs[chain_len], &format!("level{chain_len}"), &[]);
        write(
            &dirs[chain_len],
            "package.k",
            "resources = [{apiVersion: \"v1\", kind: \"ConfigMap\", metadata.name: \"leaf\"}]\n",
        );

        for i in (0..chain_len).rev() {
            let next_alias = format!("level{}", i + 1);
            write_manifest(
                &dirs[i],
                &format!("level{i}"),
                &[(next_alias.as_str(), &format!("./level{}", i + 1))],
            );
            write(
                &dirs[i],
                "package.k",
                &format!(
                    r#"
import kcl_plugin.pkg

resources = pkg.render({{ package = "{next_alias}" }})"#
                ),
            );
        }

        // Cap depth at 3 — chain is 6 levels deep so the 3rd
        // pkg.render call must reject.
        let outer_path = dirs[0].join("package.k");
        let charts = resolve_ws(&dirs[0]);
        let budget = BudgetSnapshot {
            deadline: None,
            max_depth: 3,
        };
        let _outer_scope = kcl_plugin::RenderScope::enter_for_render_with_budget(
            &outer_path,
            &charts,
            false,
            budget,
            kcl_plugin::ResolverContext::default(),
        );

        let outer = PackageK::load(&outer_path).expect("load");
        let err = outer
            .render_with_charts(&YamlValue::Mapping(Default::default()), &charts)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("depth limit"),
            "expected depth-limit rejection, got: {err}"
        );
    }
}
