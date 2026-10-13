"""Linux-executed MSVC C toolchain for the package Rust crates' C dependencies."""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc:cc_toolchain_config_lib.bzl", "action_config", "env_entry", "env_set", "feature", "tool")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/toolchains:cc_toolchain_config_info.bzl", "CcToolchainConfigInfo")

_COMPILE_ACTIONS = [ACTION_NAMES.c_compile, ACTION_NAMES.cpp_compile]
_LINK_ACTIONS = [
    ACTION_NAMES.cpp_link_executable,
    ACTION_NAMES.cpp_link_dynamic_library,
    ACTION_NAMES.cpp_link_nodeps_dynamic_library,
    ACTION_NAMES.cpp_link_static_library,
]

def _windows_cc_toolchain_config_impl(ctx):
    sdk = ctx.file.sdk.path
    includes = [sdk + "/" + path for path in [
        "crt/include",
        "sdk/include/ucrt",
        "sdk/include/um",
        "sdk/include/shared",
        "sdk/include/winrt",
    ]]
    libraries = [sdk + "/" + path for path in [
        "crt/lib/x86_64",
        "sdk/lib/um/x86_64",
        "sdk/lib/ucrt/x86_64",
    ]]
    tinfo_paths = [file.dirname for file in ctx.attr.build_tools[DefaultInfo].files.to_list() if file.basename == "libtinfo.so.5"]
    if len(tinfo_paths) != 1:
        fail("Expected exactly one pinned libtinfo.so.5")
    runtime_libs = ":".join(["${pwd}/" + path for path in [ctx.file.clang_cl.dirname + "/../lib", tinfo_paths[0]]])
    return cc_common.create_cc_toolchain_config_info(
        ctx = ctx,
        toolchain_identifier = "platform-package-windows-msvc",
        host_system_name = "x86_64-unknown-linux-gnu",
        target_system_name = "x86_64-pc-windows-msvc",
        target_cpu = "x64_windows",
        target_libc = "msvc",
        compiler = "clang-cl",
        abi_version = "msvc",
        abi_libc_version = "msvc",
        # Every tool is an action_config naming its file, so its path is an
        # execution-root path wherever this package lives; a legacy tool_path
        # would be relative to the cc_toolchain's package instead.
        tool_paths = [],
        action_configs = [
            action_config(action_name = action, enabled = True, tools = [tool(tool = ctx.file.clang_cl)])
            for action in _COMPILE_ACTIONS
        ] + [
            action_config(action_name = action, enabled = True, tools = [tool(tool = ctx.file.lld_link)])
            for action in _LINK_ACTIONS
            if action != ACTION_NAMES.cpp_link_static_library
        ] + [
            action_config(action_name = ACTION_NAMES.cpp_link_static_library, enabled = True, tools = [tool(tool = ctx.file.llvm_lib)]),
        ],
        features = [
            feature(
                name = "platform_package_windows_env",
                enabled = True,
                env_sets = [
                    env_set(
                        actions = _COMPILE_ACTIONS,
                        env_entries = [env_entry(key = "INCLUDE", value = ";".join(["${pwd}/" + path for path in includes]))],
                    ),
                    env_set(
                        actions = _LINK_ACTIONS,
                        env_entries = [env_entry(key = "LIB", value = ";".join(["${pwd}/" + path for path in libraries]))],
                    ),
                    env_set(
                        actions = _COMPILE_ACTIONS + _LINK_ACTIONS,
                        env_entries = [env_entry(key = "LD_LIBRARY_PATH", value = runtime_libs)],
                    ),
                ],
            ),
            feature(name = "supports_dynamic_linker", enabled = True),
        ],
        cxx_builtin_include_directories = includes,
    )

windows_cc_toolchain_config = rule(
    implementation = _windows_cc_toolchain_config_impl,
    attrs = {
        "build_tools": attr.label(mandatory = True),
        "clang_cl": attr.label(mandatory = True, allow_single_file = True),
        "lld_link": attr.label(mandatory = True, allow_single_file = True),
        "llvm_lib": attr.label(mandatory = True, allow_single_file = True),
        "sdk": attr.label(mandatory = True, allow_single_file = True),
    },
    provides = [CcToolchainConfigInfo],
)
