"""One pinned, patched KCL source for private and projected source builds."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

def _upstream_impl(module_ctx):
    revision = module_ctx.read(Label(":.upstream-rev")).strip()
    sha256 = module_ctx.read(Label(":.upstream-sha256")).strip()
    http_archive(
        name = "kcl_lang_kcl_da013146",
        build_file = Label(":upstream.BUILD.bazel"),
        patch_args = ["-p1"],
        patches = [
            Label(":patches/0001-parser-trust-caller-registered-external_pkgs-without.patch"),
            Label(":patches/0002-parser-probe-preopen-paths-via-read_dir-open-on-wasm.patch"),
            Label(":patches/0003-vendor-standalone-manifests-for-the-three-patched-cr.patch"),
            Label(":patches/0004-runtime-record-missing-required-attribute-on-wasm32.patch"),
            Label(":patches/0005-loader-skip-unresolved-identifiers-when-listing-options.patch"),
            Label(":patches/0006-evaluator-record-a-failed-type-check-on-wasm32.patch"),
        ],
        sha256 = sha256,
        strip_prefix = "kcl-" + revision,
        urls = ["https://github.com/kcl-lang/kcl/archive/" + revision + ".tar.gz"],
    )
    return module_ctx.extension_metadata(reproducible = True)

upstream = module_extension(implementation = _upstream_impl)
