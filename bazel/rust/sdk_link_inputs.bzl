"""SDK files needed by a final Darwin Rust link."""

def _sdk_link_inputs_impl(ctx):
    return [DefaultInfo(files = depset([
        file
        for file in ctx.attr.sdk[DefaultInfo].files.to_list()
        if file.extension != "h"
    ]))]

sdk_link_inputs = rule(
    implementation = _sdk_link_inputs_impl,
    attrs = {"sdk": attr.label(mandatory = True)},
)

# buildifier: disable=canonical-repository
def darwin_link_inputs(sdk):
    return select({
        Label("//bazel/platforms:darwin_x64"): [
            sdk,
            "@@rules_rust++rust+akua_rust_linux_x64__x86_64-apple-darwin__stable_tools//:rust_lld",
            "@@rules_rust++rust+akua_rust_linux_x64__x86_64-apple-darwin__stable_tools//:rust_lld_runtime_libs",
        ],
        Label("//bazel/platforms:darwin_arm64"): [
            sdk,
            "@@rules_rust++rust+akua_rust_linux_x64__aarch64-apple-darwin__stable_tools//:rust_lld",
            "@@rules_rust++rust+akua_rust_linux_x64__aarch64-apple-darwin__stable_tools//:rust_lld_runtime_libs",
        ],
        "//conditions:default": [],
    })
