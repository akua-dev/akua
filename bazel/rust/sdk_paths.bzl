"""Darwin paths used by the official Rust package actions."""

# Rust links need the SDK directory, while Bazel labels identify files within it.
PACKAGE_MACOS_SDK_ROOT = "$${pwd}/" + Label("@macos_sdk//:SDKSettings.json").workspace_root

# buildifier: disable=canonical-repository
PACKAGE_DARWIN_X64_RUST_LIB = "$${pwd}/" + Label("@@rules_rust++rust+akua_rust_linux_x64__x86_64-apple-darwin__stable_tools//:rust_lld_runtime_libs").workspace_root + "/lib"

# buildifier: disable=canonical-repository
PACKAGE_DARWIN_ARM64_RUST_LIB = "$${pwd}/" + Label("@@rules_rust++rust+akua_rust_linux_x64__aarch64-apple-darwin__stable_tools//:rust_lld_runtime_libs").workspace_root + "/lib"
