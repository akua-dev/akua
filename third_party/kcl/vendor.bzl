"""Materialize Cargo's three patched KCL crate inputs from the canonical source."""

load("@bazel_lib//lib:copy_to_directory.bzl", "copy_to_directory")

def package_kcl_vendor(name):
    for suffix, crate, prefix in [
        ("parser_vendor", "kcl_parser_srcs", "crates/parser/"),
        ("language_server_vendor", "kcl_language_server_srcs", "crates/tools/src/LSP/"),
        ("runtime_vendor", "kcl_runtime_srcs", "crates/runtime/"),
    ]:
        copy_to_directory(
            name = name + "_" + suffix,
            srcs = ["@kcl_lang_kcl_da013146//:" + crate],
            include_external_repositories = ["*"],
            include_srcs_patterns = [prefix + "**"],
            replace_prefixes = {prefix: ""},
            visibility = ["//visibility:public"],
        )
    native.filegroup(
        name = name + "_vendor_pin_check",
        srcs = [":" + name + "_" + suffix for suffix in ["language_server_vendor", "parser_vendor", "runtime_vendor"]],
        visibility = ["//visibility:public"],
    )
