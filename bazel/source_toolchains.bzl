"""Checksum-pinned Go compiler and build tools for the package source build."""

load(":source_toolchain_pins.bzl", "SOURCE_TOOLCHAIN_PINS")

def _source_compilers_impl(rctx):
    host = rctx.attr.host
    if host == "":
        if rctx.os.name == "mac os x":
            host = "aarch64-apple-darwin" if rctx.os.arch == "aarch64" else "x86_64-apple-darwin"
        elif rctx.os.name == "linux" and rctx.os.arch in ["amd64", "x86_64"]:
            host = "x86_64-unknown-linux-gnu"
        else:
            fail("Unsupported source compiler host {}/{}".format(rctx.os.name, rctx.os.arch))
    pin = SOURCE_TOOLCHAIN_PINS["go"][host]
    rctx.download_and_extract(
        url = pin["url"],
        sha256 = pin["sha256"],
        output = "go",
        stripPrefix = "go",
    )
    rctx.file("BUILD.bazel", """
exports_files(["go/bin/go"], visibility = ["//visibility:public"])
filegroup(name = "go_files", srcs = glob(["go/bin/**", "go/pkg/**", "go/src/**", "go/lib/**", "go/go.env"]), visibility = ["//visibility:public"])
""")

source_compilers = repository_rule(
    implementation = _source_compilers_impl,
    attrs = {"host": attr.string()},
)
