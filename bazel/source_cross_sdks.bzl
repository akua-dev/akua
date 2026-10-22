"""Fixed cross SDK inputs for native package source compilation."""

def _macos_sdk_impl(rctx):
    rctx.download_and_extract(
        url = "https://github.com/joseluisq/macosx-sdks/releases/download/11.3/MacOSX11.3.sdk.tar.xz",
        sha256 = "9adc1373d3879e1973d28ad9f17c9051b02931674a3ec2a2498128989ece2cb1",
        stripPrefix = "MacOSX11.3.sdk",
    )
    rctx.file("BUILD.bazel", """
exports_files(["SDKSettings.json"], visibility = ["//visibility:public"])
filegroup(name = "files", srcs = glob(["SDKSettings.*", "usr/include/**", "usr/lib/**", "System/Library/**"]), visibility = ["//visibility:public"])
""")
    return rctx.repo_metadata(reproducible = True)

macos_sdk = repository_rule(implementation = _macos_sdk_impl)

_XWIN_PINS = {
    "aarch64-apple-darwin": "21acd1e35d23b72efc8c47cbeda5028989f98089174b8c87074f892b65adbc01",
    "x86_64-apple-darwin": "ecb2b19b30fa3786749fae600ad60b034b0c1c6a604ecf9f35f682c23a40e54b",
    "x86_64-unknown-linux-musl": "9fd53950b064d067f42428a69453b927656cae68dbd7f8d3f86dcb81c80dd22d",
}
_VSMAN_URL = "https://download.visualstudio.microsoft.com/download/pr/bc92e2cb-33de-4a0c-995d-efa817f16b16/6e470016e4324c84c255ffd0beb3767d17ec89cc8561e9409ee3e1f6d29400f5/VisualStudio.vsman"
_VSMAN_SHA = "f0a50ea157222c29abd5ea6ff01bfc3c33b04e011c5e45ee2ca38ef0778e5643"
PACKAGE_WINDOWS_SDK_VERSION = "10.0.26100"
PACKAGE_WINDOWS_CRT_VERSION = "14.44.17.14"

def _windows_sdk_inputs_impl(rctx):
    if rctx.os.name == "mac os x":
        host = "aarch64-apple-darwin" if rctx.os.arch == "aarch64" else "x86_64-apple-darwin"
    elif rctx.os.name == "linux" and rctx.os.arch in ["amd64", "x86_64"]:
        host = "x86_64-unknown-linux-musl"
    else:
        fail("Unsupported Windows SDK resolver host {}/{}".format(rctx.os.name, rctx.os.arch))
    for target, destination in [(host, "host"), ("x86_64-unknown-linux-musl", "linux")]:
        rctx.download_and_extract(
            url = "https://github.com/Jake-Shadle/xwin/releases/download/0.6.5/xwin-0.6.5-{}.tar.gz".format(target),
            sha256 = _XWIN_PINS[target],
            stripPrefix = "xwin-0.6.5-" + target,
            output = destination,
        )

    # Microsoft's channel checksum differs from the served manifest bytes.
    # Pin those actual bytes before xwin, which otherwise skips this check.
    rctx.download(
        url = _VSMAN_URL,
        sha256 = _VSMAN_SHA,
        output = "cache/dl/pkg_manifest_{}.vsman".format(_VSMAN_SHA),
    )
    rctx.file("manifest.json", json.encode({"channelItems": [{
        "id": "Microsoft.VisualStudio.Manifests.VisualStudio",
        "version": "17.14.37710.0",
        "type": "Manifest",
        "payloads": [{"fileName": "VisualStudio.vsman", "url": _VSMAN_URL, "sha256": _VSMAN_SHA, "size": 17954732}],
    }]}))

    # Repository environment overrides cannot unset keys; xwin treats an
    # empty proxy value as an address, so remove it at this host boundary.
    result = rctx.execute([
        "/usr/bin/env",
        "-u",
        "HTTPS_PROXY",
        "-u",
        "https_proxy",
        "-u",
        "HTTP_PROXY",
        "-u",
        "http_proxy",
        rctx.path("host/xwin"),
        "--accept-license",
        "--manifest",
        rctx.path("manifest.json"),
        "--sdk-version",
        PACKAGE_WINDOWS_SDK_VERSION,
        "--crt-version",
        PACKAGE_WINDOWS_CRT_VERSION,
        "--arch",
        "x86_64",
        "--cache-dir",
        rctx.path("cache"),
        "unpack",
    ], timeout = 1200)
    if result.return_code != 0:
        fail("Pinned Windows SDK input resolution failed:\n" + result.stderr)

    # xwin's debug trees reflect parallel extraction order, not SDK content.
    # Remove them from the repository itself, not just its action inputs, so
    # the repo contents cache only retains deterministic files.
    for package in rctx.path("cache/unpack").readdir():
        rctx.delete(package.get_child("tree.txt"))

    # Only the pinned Linux executable is an action input. The resolver must
    # not leave host-specific binaries in the shared repository contents.
    rctx.delete("host")
    rctx.file("BUILD.bazel", """
exports_files(["manifest.json", "linux/xwin"], visibility = ["//visibility:public"])
filegroup(name = "files", srcs = glob(["cache/dl/**", "cache/unpack/**"], exclude = ["cache/unpack/**/tree.txt"]), visibility = ["//visibility:public"])
""")
    return rctx.repo_metadata(reproducible = True)

windows_sdk_inputs = repository_rule(implementation = _windows_sdk_inputs_impl)

def _windows_build_tools_impl(rctx):
    rctx.download_and_extract(
        url = "https://deb.debian.org/debian/pool/main/n/nasm/nasm_2.16.01-1_amd64.deb",
        sha256 = "0180693ad5d2da8b36e7d73b9b596dc3e9f900238e3de699976c0576875b878f",
        output = "package",
    )
    rctx.extract("package/data.tar.xz")
    rctx.download_and_extract(
        url = "https://deb.debian.org/debian/pool/main/n/ncurses/libtinfo5_6.4-4_amd64.deb",
        sha256 = "dd347f794e651039e7b4c391f86c674fed7f415b3dca6b0937beb0d470f09c1a",
        output = "tinfo-package",
    )
    rctx.extract("tinfo-package/data.tar.xz")
    rctx.file("BUILD.bazel", """
exports_files(["usr/bin/nasm"], visibility = ["//visibility:public"])
filegroup(name = "files", srcs = ["usr/bin/nasm"] + glob(["lib/x86_64-linux-gnu/libtinfo.so.5*"]), visibility = ["//visibility:public"])
""")
    return rctx.repo_metadata(reproducible = True)

windows_build_tools = repository_rule(implementation = _windows_build_tools_impl)
