"""Checksum-pinned Bun releases: the compiler per execution platform and the
runtime `bun build --compile` embeds per target."""

# The compiler that runs on the build machine (actions, tests).
BUN_VERSION = "1.4.4"

BUN_RELEASES = {
    "bun-darwin-arm64": ("bun-darwin-aarch64", "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510"),
    "bun-darwin-x64": ("bun-darwin-x64", "50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e"),
    "bun-linux-arm64": ("bun-linux-aarch64", "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e"),
    "bun-linux-x64-baseline": ("bun-linux-x64-baseline", "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76"),
}

# Keep the embedded runtime on the same security release as the compiler.
BUN_COMPILE_RUNTIME_VERSION = "1.4.4"

BUN_COMPILE_RUNTIME_RELEASES = {
    "bun-darwin-arm64": ("bun-darwin-aarch64", "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510"),
    "bun-darwin-x64": ("bun-darwin-x64", "50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e"),
    "bun-linux-arm64": ("bun-linux-aarch64", "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e"),
    "bun-linux-x64": ("bun-linux-x64", "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c"),
    "bun-linux-x64-baseline": ("bun-linux-x64-baseline", "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76"),
    "bun-windows-x64-baseline": ("bun-windows-x64-baseline", "0f20ce6674d4f2dbcc8c5d59fdf99f7ba45f8c3b367e0f5781cbfa30a1c78d99"),
}

def _bun_release_impl(rctx):
    releases = BUN_RELEASES if rctx.attr.kind == "compiler" else BUN_COMPILE_RUNTIME_RELEASES
    version = BUN_VERSION if rctx.attr.kind == "compiler" else BUN_COMPILE_RUNTIME_VERSION
    if rctx.attr.target not in releases:
        fail("No pinned Bun {} {} for {}".format(rctx.attr.kind, version, rctx.attr.target))
    asset, sha256 = releases[rctx.attr.target]
    rctx.download_and_extract(
        url = "https://github.com/oven-sh/bun/releases/download/bun-v{}/{}.zip".format(version, asset),
        sha256 = sha256,
        stripPrefix = asset,
    )
    executable = "bun.exe" if "windows" in rctx.attr.target else "bun"
    rctx.execute(["chmod", "+x", executable])
    rctx.file("BUILD.bazel", 'exports_files(["{}"], visibility = ["//visibility:public"])\n'.format(executable))

bun_release = repository_rule(
    implementation = _bun_release_impl,
    attrs = {
        "kind": attr.string(mandatory = True, values = ["compiler", "runtime"]),
        "target": attr.string(mandatory = True),
    },
)
