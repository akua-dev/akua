"""Analysis contracts for the release Rust artifacts: the render worker's
stamping, resource and input declarations, and the Darwin addon's link inputs."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")

_RustResourceInfo = provider("Compiler action and resource declarations behind a Rust artifact.", fields = ["actions", "exec_properties"])

def _rust_resource_aspect_impl(target, ctx):
    if hasattr(ctx.rule.attr, "compiled"):
        return [ctx.rule.attr.compiled[0][_RustResourceInfo]]
    return [_RustResourceInfo(actions = target.actions, exec_properties = ctx.rule.attr.exec_properties)]

_rust_resource_aspect = aspect(implementation = _rust_resource_aspect_impl, attr_aspects = ["compiled"])

def _render_worker_stamp_contract_test_impl(ctx):
    env = analysistest.begin(ctx)
    actions = [action for action in analysistest.target_actions(env) if action.mnemonic == "Rustc"]
    asserts.equals(env, 1, len(actions))
    if len(actions) == 1:
        wasm_outputs = [file.basename for file in actions[0].outputs.to_list() if file.extension == "wasm"]
        asserts.equals(env, ["render_worker.wasm"], wasm_outputs, "test must inspect the official WASI Rustc action")
        input_names = [file.basename for file in actions[0].inputs.to_list()]
        for status_file in ["stable-status.txt", "volatile-status.txt"]:
            asserts.false(env, status_file in input_names, "render worker must not consume release status: %s" % status_file)
        for status_flag in ["--stable-status-file", "--volatile-status-file"]:
            asserts.false(env, status_flag in actions[0].argv, "render worker must not request release status: %s" % status_flag)
    return analysistest.end(env)

render_worker_stamp_contract_test = analysistest.make(
    _render_worker_stamp_contract_test_impl,
    config_settings = {
        "//command_line_option:compilation_mode": "opt",
        "//command_line_option:platforms": [str(Label("//bazel/platforms:render_worker_wasi"))],
        "//command_line_option:stamp": True,
        str(Label("//bazel/platforms:package_rust_version")): "1.98.1",
        str(Label("@rules_rust//rust/settings:codegen_units")): 1,
        str(Label("@rules_rust//rust/settings:extra_rustc_flags")): ["-Cdebuginfo=line-tables-only", "-Cstrip=none"],
        str(Label("@rules_rust//rust/settings:lto")): "fat",
    },
)

def _render_worker_memory_contract_test_impl(ctx):
    env = analysistest.begin(ctx)
    target = analysistest.target_under_test(env)
    asserts.equals(env, "4194304", target[_RustResourceInfo].exec_properties.get("memory_kb"))
    return analysistest.end(env)

render_worker_memory_contract_test = analysistest.make(
    _render_worker_memory_contract_test_impl,
    extra_target_under_test_aspects = [_rust_resource_aspect],
)

def _render_worker_input_contract_test_impl(ctx):
    env = analysistest.begin(ctx)
    target = analysistest.target_under_test(env)
    actions = [action for action in target[_RustResourceInfo].actions if action.mnemonic == "Rustc"]
    asserts.equals(env, 1, len(actions))
    if len(actions) == 1:
        input_paths = [file.short_path for file in actions[0].inputs.to_list()]
        for rejected in ["/.git/index", "/.git/logs/", "/cargo-home/"]:
            asserts.equals(env, [], [path for path in input_paths if rejected in path], "unexpected mutable or legacy Cargo input: %s" % rejected)
    return analysistest.end(env)

render_worker_input_contract_test = analysistest.make(
    _render_worker_input_contract_test_impl,
    extra_target_under_test_aspects = [_rust_resource_aspect],
)

def _darwin_link_inputs_test_impl(ctx):
    env = analysistest.begin(ctx)
    target = analysistest.target_under_test(env)
    actions = [action for action in target[_RustResourceInfo].actions if action.mnemonic == "Rustc"]
    asserts.equals(env, 1, len(actions))
    if len(actions) == 1:
        sdk_inputs = [
            file.short_path
            for file in actions[0].inputs.to_list()
            if file.owner.repo_name == ctx.attr.sdk.label.repo_name
        ]
        expected_sdk_inputs = [
            file.short_path
            for file in ctx.attr.sdk[DefaultInfo].files.to_list()
            if file.extension != "h"
        ]
        asserts.equals(env, sorted(expected_sdk_inputs), sorted(sdk_inputs), "final Rust link must retain every non-header SDK file")
        for required in [
            "/SDKSettings.json",
            "/usr/lib/libSystem.tbd",
            "/System/Library/Frameworks/Foundation.framework/Foundation.tbd",
        ]:
            asserts.equals(env, 1, len([path for path in sdk_inputs if path.endswith(required)]), "missing Darwin link input: %s" % required)
        asserts.equals(env, 0, len([path for path in sdk_inputs if path.endswith(".h")]), "final Rust link must not declare SDK headers")
    return analysistest.end(env)

darwin_link_inputs_test = analysistest.make(
    _darwin_link_inputs_test_impl,
    attrs = {"sdk": attr.label(default = Label("@macos_sdk//:files"))},
    extra_target_under_test_aspects = [_rust_resource_aspect],
)
