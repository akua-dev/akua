"""Selects a fixed package Rust target and publishes its release filename."""

# Canonical strings: transition keys must not depend on the repository that
# loads this file (this tree is also consumed as a module of a monorepo).
_RUST_VERSION = str(Label("//bazel/platforms:package_rust_version"))
_LINUX_X64_EXEC = str(Label("//bazel/platforms:linux_x64_exec"))

def _package_rust_transition_impl(_settings, attr):
    if attr.profile == "worker":
        lto = "fat"
        codegen_units = 1
        rustc_flags = ["-Cdebuginfo=line-tables-only", "-Cstrip=none"]
    elif attr.profile == "native":
        lto = "off"
        codegen_units = 16
        rustc_flags = ["-Cdebuginfo=line-tables-only", "-Cstrip=symbols"]
    else:
        fail("Unsupported package Rust release profile: " + attr.profile)
    return {
        "//command_line_option:compilation_mode": "opt",
        "//command_line_option:platforms": str(attr.target_platform),
        _RUST_VERSION: "1.98.1",
        "@rules_rust//rust/settings:lto": lto,
        "@rules_rust//rust/settings:codegen_units": codegen_units,
        "@rules_rust//rust/settings:extra_rustc_flags": rustc_flags,
    }

_package_rust_transition = transition(
    implementation = _package_rust_transition_impl,
    inputs = [],
    outputs = [
        "//command_line_option:compilation_mode",
        "//command_line_option:platforms",
        _RUST_VERSION,
        "@rules_rust//rust/settings:lto",
        "@rules_rust//rust/settings:codegen_units",
        "@rules_rust//rust/settings:extra_rustc_flags",
    ],
)

# Build-time package Rust tools run on the Linux executors with the package
# toolchain; the default exec configuration would select another Rust.
def _package_rust_tool_transition_impl(_settings, _attr):
    return {
        "//command_line_option:compilation_mode": "opt",
        "//command_line_option:platforms": _LINUX_X64_EXEC,
        _RUST_VERSION: "1.98.1",
    }

_package_rust_tool_transition = transition(
    implementation = _package_rust_tool_transition_impl,
    inputs = [],
    outputs = [
        "//command_line_option:compilation_mode",
        "//command_line_option:platforms",
        _RUST_VERSION,
    ],
)

def _package_rust_artifact_impl(ctx):
    if len(ctx.attr.compiled) != 1:
        fail("Expected exactly one configured package Rust target")
    compiled_files = ctx.attr.compiled[0][DefaultInfo].files.to_list()
    if ctx.attr.out.endswith(".node"):
        compiled_files = [file for file in compiled_files if file.extension in ["so", "dylib", "dll"]]
    elif ctx.attr.out.endswith(".exe"):
        compiled_files = [file for file in compiled_files if file.extension == "exe"]
    if len(compiled_files) != 1:
        fail("Expected exactly one compiled release binary, got {}".format(len(compiled_files)))

    output = ctx.actions.declare_file(ctx.attr.out)
    ctx.actions.symlink(output = output, target_file = compiled_files[0])
    return [
        DefaultInfo(files = depset([output])),
        OutputGroupInfo(compiled = depset([output])),
    ]

package_rust_artifact = rule(
    implementation = _package_rust_artifact_impl,
    attrs = {
        "compiled": attr.label(mandatory = True, cfg = _package_rust_transition),
        "out": attr.string(mandatory = True),
        "profile": attr.string(mandatory = True, values = ["worker", "native"]),
        "target_platform": attr.label(mandatory = True, providers = [platform_common.PlatformInfo]),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def _wasm_precompile_impl(ctx):
    output = ctx.actions.declare_file(ctx.attr.out)
    ctx.actions.run(
        executable = ctx.executable._precompile,
        arguments = [ctx.attr.target_triple, str(ctx.attr.zstd_level), output.path, ctx.file.wasm.path],
        inputs = [ctx.file.wasm],
        outputs = [output],
        mnemonic = "PackageWasmPrecompile",
        progress_message = "Precompiling %{input} for " + ctx.attr.target_triple,
    )
    return [DefaultInfo(files = depset([output]))]

wasm_precompile = rule(
    doc = """Compiles a wasm module to zstd-compressed Wasmtime machine code for one target.

The precompiler shares the runtime addon's engine settings
(source/native/src/config.rs), so the addon accepts exactly these artifacts.""",
    implementation = _wasm_precompile_impl,
    attrs = {
        "wasm": attr.label(mandatory = True, allow_single_file = [".wasm"]),
        "target_triple": attr.string(mandatory = True),
        "out": attr.string(mandatory = True),
        "zstd_level": attr.int(default = 19),
        "_precompile": attr.label(
            default = Label("//bazel/rust:precompile"),
            executable = True,
            cfg = _package_rust_tool_transition,
        ),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def _package_rust_tool_impl(ctx):
    # Re-published under this target's own path: a location expansion in the
    # consuming rule must name the file that rule stages as its input.
    output = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.symlink(output = output, target_file = ctx.executable.tool, is_executable = True)
    return [DefaultInfo(files = depset([output]))]

package_rust_tool = rule(
    doc = "A package Rust tool built for the Linux executors, for use as an action input of a target-configured rule.",
    implementation = _package_rust_tool_impl,
    attrs = {
        "tool": attr.label(mandatory = True, executable = True, cfg = _package_rust_tool_transition),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)
