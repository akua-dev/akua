"""Derive archive names from the canonical Cargo workspace version."""

def _source_version_impl(rctx):
    section = ""
    version = None
    for raw in rctx.read(rctx.attr.manifest).splitlines():
        line = raw.strip()
        if line.startswith("["):
            section = line
        elif section == "[workspace.package]" and line.startswith("version = "):
            version = json.decode(line.removeprefix("version = "))
    if type(version) != "string" or not version:
        fail("Cargo workspace.package.version must be a quoted version")
    rctx.file("version.bzl", "PACKAGE_SOURCE_VERSION = " + json.encode(version) + "\n")
    rctx.file("BUILD.bazel", 'exports_files(["version.bzl"], visibility = ["//visibility:public"])\n')

source_version = repository_rule(
    implementation = _source_version_impl,
    attrs = {"manifest": attr.label(default = "//:Cargo.toml")},
)
