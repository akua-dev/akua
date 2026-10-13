"""Bun actions over this repository's sources and its bun.lock packages.

Both rules rebuild a private copy of the workspace: sources are copied (Bun
resolves imports from a file's real path, so a symlink back into the source
tree would resolve against whatever happens to be there), and each
`node_modules` entry of the bun.lock repository is linked in beside them.
Workspace members are linked to their copied sources, as `bun install` would.
"""

BUN_TOOLCHAIN_TYPE = Label("//bazel/bun:toolchain_type")

def _bun_toolchain_impl(ctx):
    return [platform_common.ToolchainInfo(executable = ctx.file.executable)]

bun_toolchain_info = rule(
    implementation = _bun_toolchain_impl,
    attrs = {"executable": attr.label(allow_single_file = True, mandatory = True)},
)

def bun_toolchain(name, executable, exec_compatible_with):
    bun_toolchain_info(name = name + "_impl", executable = executable)
    native.toolchain(
        name = name,
        exec_compatible_with = exec_compatible_with,
        toolchain = ":" + name + "_impl",
        toolchain_type = BUN_TOOLCHAIN_TYPE,
    )

def _repository_path(file):
    """The file's path inside its own repository."""
    if file.short_path.startswith("../"):
        return file.short_path.split("/", 2)[2]
    return file.short_path

def _runfiles_path(ctx, short_path):
    """A runfiles-relative path for a File.short_path (or a prefix of one)."""
    if short_path.startswith("../"):
        return short_path[3:]
    return ctx.workspace_name + "/" + short_path

def _node_modules_entries(files):
    """{(directory in the workspace, entry): (exec path, short path)} per node_modules entry."""
    entries = {}
    for file in files:
        relative = _repository_path(file)
        marker = relative.find("node_modules/")
        if marker < 0:
            fail("{} is not inside a node_modules directory".format(file.path))
        prefix = relative[:marker]
        parts = relative[marker + len("node_modules/"):].split("/")
        entry = "/".join(parts[:2]) if parts[0].startswith("@") else parts[0]
        suffix = prefix + "node_modules/" + entry
        entries[(prefix, entry)] = (
            file.path[:len(file.path) - len(relative)] + suffix,
            file.short_path[:len(file.short_path) - len(relative)] + suffix,
        )
    return entries

def _stage(sources, node_modules, workspace_links, workspace, source_path, entry_path):
    lines = []
    directories = {}

    def mkdir(path):
        directory = path.rsplit("/", 1)[0]
        if directory not in directories:
            directories[directory] = True
            lines.append("mkdir -p \"{}\"".format(directory))

    for file in sources:
        destination = "{}/{}".format(workspace, _repository_path(file))
        mkdir(destination)
        lines.append("cp -L \"{}\" \"{}\"".format(source_path(file), destination))
    for (prefix, entry), paths in sorted(_node_modules_entries(node_modules).items()):
        link = "{}/{}node_modules/{}".format(workspace, prefix, entry)
        mkdir(link)
        lines.append("ln -s \"{}\" \"{}\"".format(entry_path(paths), link))
    for link, target in sorted(workspace_links.items()):
        destination = "{}/{}".format(workspace, link)
        mkdir(destination)
        lines.append("ln -s \"{}/{}\" \"{}\"".format(workspace, target, destination))
    return lines

def stage_workspace_commands(sources, node_modules, workspace_links, workspace):
    """Shell commands, run from the execution root, that rebuild the workspace in `workspace`."""
    return _stage(
        sources,
        node_modules,
        workspace_links,
        workspace,
        lambda file: "$ROOT/" + file.path,
        lambda paths: "$ROOT/" + paths[0],
    )

def _bun_compile_impl(ctx):
    out = ctx.actions.declare_file(ctx.attr.out)
    workspace = "_ws_" + ctx.label.name
    bun = ctx.toolchains[BUN_TOOLCHAIN_TYPE].executable
    sources = ctx.files.srcs
    node_modules = ctx.files.node_modules
    stage = stage_workspace_commands(sources, node_modules, ctx.attr.workspace_links, "$ROOT/" + workspace)
    script = "\n".join([
        "set -eu",
        "ROOT=\"$(pwd)\"",
        "rm -rf \"$ROOT/{}\"".format(workspace),
    ] + stage + [
        "cd \"$ROOT/{}\"".format(workspace),
        # --minify-whitespace drops the per-module `// <path>` banners, and the
        # __dirname define replaces the absolute build path Bun would otherwise
        # embed for CommonJS modules: both describe where the action ran, not
        # its inputs, and would make the executable differ per machine.
        "\"$ROOT/{bun}\" --no-install build --compile --minify-whitespace --define '__dirname=\"/$bunfs/root\"' --target={target} --compile-executable-path=\"$ROOT/{runtime}\" --outfile=\"$ROOT/{out}\" ./{entry}".format(
            bun = bun.path,
            target = ctx.attr.target,
            runtime = ctx.file.target_runtime.path,
            out = out.path,
            entry = _repository_path(ctx.file.entry),
        ),
        "cd \"$ROOT\"",
        # The artifact must name neither this action's root nor its staging directory.
        "if grep -aqF -- \"$ROOT\" \"{out}\" || grep -aqF -- \"{workspace}/\" \"{out}\"; then echo \"{label}: the executable embeds a build path\" >&2; exit 1; fi".format(
            out = out.path,
            workspace = workspace,
            label = ctx.label,
        ),
        "rm -rf \"$ROOT/{}\"".format(workspace),
    ])
    ctx.actions.run_shell(
        inputs = depset(sources + node_modules + [ctx.file.target_runtime]),
        outputs = [out],
        tools = [bun],
        command = script,
        mnemonic = "BunCompile",
        progress_message = "Compiling %{label} for " + ctx.attr.target,
        execution_requirements = {"block-network": "1"},
    )
    return [DefaultInfo(files = depset([out]), executable = out)]

bun_compile = rule(
    doc = "Compiles a TypeScript entry point and its imports into a standalone executable for one target.",
    implementation = _bun_compile_impl,
    attrs = {
        "srcs": attr.label_list(allow_files = True, mandatory = True),
        "entry": attr.label(allow_single_file = [".ts"], mandatory = True),
        "node_modules": attr.label(mandatory = True, doc = "Package files from the bun.lock repository."),
        "workspace_links": attr.string_dict(doc = "node_modules link path -> workspace member directory."),
        "out": attr.string(mandatory = True),
        "target": attr.string(mandatory = True, doc = "bun build --compile --target value."),
        "target_runtime": attr.label(allow_single_file = True, mandatory = True, doc = "The pinned Bun runtime for `target`."),
    },
    executable = True,
    toolchains = [BUN_TOOLCHAIN_TYPE],
)

def _shell_quote(value):
    return "'" + value.replace("'", "'\\''") + "'"

def _bun_test_impl(ctx):
    bun = ctx.toolchains[BUN_TOOLCHAIN_TYPE].executable
    sources = ctx.files.srcs
    node_modules = ctx.files.node_modules
    stage = _stage(
        sources,
        node_modules,
        ctx.attr.workspace_links,
        "$WORKSPACE",
        lambda file: "$RUNFILES/" + _runfiles_path(ctx, file.short_path),
        lambda paths: "$RUNFILES/" + _runfiles_path(ctx, paths[1]),
    )
    expand = lambda value: _shell_quote(ctx.expand_location(value, ctx.attr.data))
    lines = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "RUNFILES=\"$(cd \"${RUNFILES_DIR:-$0.runfiles}\" && pwd)\"",
        "WORKSPACE=\"$TEST_TMPDIR/workspace\"",
        "export TMPDIR=\"$TEST_TMPDIR\"",
        "mkdir -p \"$TEST_TMPDIR/bin\"",
        "ln -sf \"$RUNFILES/{}\" \"$TEST_TMPDIR/bin/bun\"".format(_runfiles_path(ctx, bun.short_path)),
        "export PATH=\"$TEST_TMPDIR/bin:/usr/bin:/bin\"",
    ] + stage + [
        "cd \"$WORKSPACE/{}\"".format(ctx.attr.chdir),
    ] + [
        "export {}=\"{}\"".format(key, ctx.expand_location(value, ctx.attr.data))
        for key, value in sorted(ctx.attr.env.items())
    ] + [
        "exec bun {} \"$@\"".format(" ".join([expand(arg) for arg in ctx.attr.bun_args])),
    ]
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(launcher, "\n".join(lines) + "\n", is_executable = True)
    runfiles = ctx.runfiles(files = sources + node_modules + [bun] + ctx.files.data)
    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

bun_test = rule(
    doc = "Runs `bun <bun_args>` in a private copy of the workspace, with the pinned Bun first on PATH.",
    implementation = _bun_test_impl,
    attrs = {
        "srcs": attr.label_list(allow_files = True, doc = "Files copied into the workspace."),
        "data": attr.label_list(allow_files = True, doc = "Runfiles referenced by `bun_args` or `env` locations."),
        "node_modules": attr.label(mandatory = True),
        "workspace_links": attr.string_dict(),
        "chdir": attr.string(default = ".", doc = "Workspace directory the command runs in."),
        "bun_args": attr.string_list(),
        "env": attr.string_dict(doc = "Exported before running; values expand `$(rlocationpath ...)` and shell variables such as $RUNFILES."),
    },
    test = True,
    toolchains = [BUN_TOOLCHAIN_TYPE],
)
