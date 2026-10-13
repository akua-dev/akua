"""Checksum-pinned Bun releases: the compiler per execution platform and the
runtime `bun build --compile` embeds per target."""

# The compiler that runs on the build machine (actions, tests).
BUN_VERSION = "1.4.2"

BUN_RELEASES = {
    "bun-darwin-arm64": ("bun-darwin-aarch64", "90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f"),
    "bun-darwin-x64": ("bun-darwin-x64", "80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012"),
    "bun-linux-arm64": ("bun-linux-aarch64", "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7"),
    "bun-linux-x64-baseline": ("bun-linux-x64-baseline", "c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f"),
}

# The runtime embedded in the released executables. Bun 1.4.2 standalone
# executables regress authenticated fetches, so the shipped runtime stays on
# the last release proven in production while the compiler moves ahead.
BUN_COMPILE_RUNTIME_VERSION = "1.3.14"

BUN_COMPILE_RUNTIME_RELEASES = {
    "bun-darwin-arm64": ("bun-darwin-aarch64", "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620"),
    "bun-darwin-x64": ("bun-darwin-x64", "4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633"),
    "bun-linux-arm64": ("bun-linux-aarch64", "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b"),
    "bun-linux-x64": ("bun-linux-x64", "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f"),
    "bun-linux-x64-baseline": ("bun-linux-x64-baseline", "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7"),
    "bun-windows-x64-baseline": ("bun-windows-x64-baseline", "538f9c846355d9e847b2671bc00c47da4229a0befb24df3282b739770f3b475f"),
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
