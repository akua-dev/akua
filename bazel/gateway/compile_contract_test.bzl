"""Checks the actual gateway compile actions and their platform runtime inputs."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")

def _compile_contract_test_impl(ctx):
    env = analysistest.begin(ctx)
    actions = [action for action in analysistest.target_actions(env) if action.mnemonic == "BunCompile"]
    asserts.equals(env, 1, len(actions))
    if len(actions) == 1:
        action = actions[0]
        command = " ".join(action.argv)
        inputs = [file.path for file in action.inputs.to_list()]
        asserts.true(env, "--target=" + ctx.attr.bun_target in command)
        asserts.true(env, "packages/private-ingress-gateway/src/index.ts" in command)
        asserts.true(env, "--compile-executable-path=" in command)
        asserts.true(env, len([path for path in inputs if ctx.attr.runtime_repository in path and path.endswith("/bun")]) == 1)
        asserts.equals(env, [], [path for path in inputs if "/apps/" in path or "/packages/domains/" in path])
        scans = [file for file in action.outputs.to_list() if file.basename.endswith("_path_scan.json")]
        asserts.equals(env, 1, len(scans), "the compile action must also produce its path-scan verdict")
    return analysistest.end(env)

compile_contract_test = analysistest.make(
    _compile_contract_test_impl,
    attrs = {
        "bun_target": attr.string(mandatory = True),
        "runtime_repository": attr.string(mandatory = True),
    },
)
