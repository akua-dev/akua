"""Builds the complete public CLI release archive set from Bazel binaries."""

load("//bazel/bun:defs.bzl", "BUN_TOOLCHAIN_TYPE", "stage_workspace_commands")

_RELEASE_TARGETS = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "windows-x64",
]

# Stable status carries STABLE_SOURCE_SHA, which changes with every commit.
# Reading it unconditionally made all six packaging actions miss the cache on
# every PR run (on the critical path in 68 of 141 PR runs, 2026-09-26..29,
# cnap#2279). Like other Bazel stamping rules, the release reads it only when
# the build asks for stamping (`--stamp`); otherwise the program records a
# placeholder source SHA and the actions stay cacheable.
_UNSTAMPED = "-"

def _repository_path(file):
    if file.short_path.startswith("../"):
        return file.short_path.split("/", 2)[2]
    return file.short_path

def _release_files_by_target(targets, description):
    files_by_target = {}
    for target, target_id in targets.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("CLI release {} {} must produce exactly one file, got {}".format(description, target.label, len(files)))
        if target_id in files_by_target:
            fail("CLI release target {} is declared more than once".format(target_id))
        files_by_target[target_id] = files[0]
    if sorted(files_by_target.keys()) != _RELEASE_TARGETS:
        fail("CLI release {} must be exactly {}, got {}".format(
            description,
            ", ".join(_RELEASE_TARGETS),
            ", ".join(sorted(files_by_target.keys())),
        ))
    return files_by_target

def _cli_release_archive_impl(ctx):
    binaries_by_target = _release_files_by_target(ctx.attr.binaries, "binaries")

    # The packaging program runs from a private copy of the workspace with its
    # own dependencies linked beside it.
    sources = ctx.files.srcs + [ctx.file.program]
    node_modules = ctx.files.node_modules
    stage = "\n".join(["set -eu", "ROOT=\"$(pwd)\"", "WORKSPACE=\"$(mktemp -d)/workspace\""] + stage_workspace_commands(
        sources,
        node_modules,
        ctx.attr.workspace_links,
        "$WORKSPACE",
    ) + [
        "cli_bun=\"$ROOT/$1\"",
        "shift",
        "program=\"$WORKSPACE/$1\"",
        "shift",
        "\"$cli_bun\" --no-install \"$program\" \"$@\"",
        "rm -rf \"$WORKSPACE\"",
    ])
    program = _repository_path(ctx.file.program)

    bun = ctx.toolchains[BUN_TOOLCHAIN_TYPE].executable
    zipper = ctx.file.zipper
    parts = {}
    for target_id in _RELEASE_TARGETS:
        part = ctx.actions.declare_directory("{}-{}".format(ctx.attr.out, target_id))
        parts[target_id] = part
        args = ctx.actions.args()
        args.add(bun.path)
        args.add(program)
        args.add("target")
        args.add(ctx.file.package_json.path)

        # A part is one platform's archive; the source SHA only enters the
        # assembled release metadata, so no part reads Bazel's stable status.
        args.add(_UNSTAMPED)
        args.add(part.path)
        args.add(ctx.attr.package_version)
        args.add(zipper.path)
        args.add("{}={}".format(target_id, binaries_by_target[target_id].path))

        ctx.actions.run_shell(
            command = stage,
            arguments = [args],
            inputs = depset(sources + node_modules + [ctx.file.package_json, binaries_by_target[target_id]]),
            outputs = [part],
            tools = [bun, zipper],
            execution_requirements = {"block-network": "1"},
            mnemonic = "CliReleaseArchivePart",
            progress_message = "Packaging public CLI archive {}".format(target_id),
        )

    output = ctx.actions.declare_directory(ctx.attr.out)
    args = ctx.actions.args()
    args.add(bun.path)
    args.add(program)
    args.add("assemble")
    args.add(ctx.file.package_json.path)
    args.add(ctx.info_file.path if ctx.attr.stamp else _UNSTAMPED)
    args.add(output.path)
    args.add(ctx.attr.package_version)
    args.add(zipper.path)
    for target_id in _RELEASE_TARGETS:
        args.add("{}={}".format(target_id, parts[target_id].path))

    ctx.actions.run_shell(
        command = stage,
        arguments = [args],
        inputs = depset(sources + node_modules + [ctx.file.package_json] + ([ctx.info_file] if ctx.attr.stamp else []) + [parts[id] for id in _RELEASE_TARGETS]),
        outputs = [output],
        tools = [bun, zipper],
        execution_requirements = {"block-network": "1"},
        mnemonic = "CliReleaseArchiveAssemble",
        progress_message = "Assembling five public CLI archives",
    )
    return [DefaultInfo(files = depset([output]))]

cli_release_archive = rule(
    implementation = _cli_release_archive_impl,
    attrs = {
        "binaries": attr.label_keyed_string_dict(
            allow_files = True,
            mandatory = True,
            doc = "Compiled executable target to stable public release target id.",
        ),
        "package_version": attr.string(
            mandatory = True,
            doc = "Version of the package toolchain the executables embed for `akua pkg`, recorded in the release provenance.",
        ),
        "out": attr.string(mandatory = True),
        "package_json": attr.label(allow_single_file = [".json"], mandatory = True),
        "program": attr.label(allow_single_file = [".ts"], mandatory = True),
        "node_modules": attr.label(
            mandatory = True,
            doc = "Package files from the bun.lock repository for the packaging program.",
        ),
        "workspace_links": attr.string_dict(doc = "node_modules link path -> workspace member directory."),
        "srcs": attr.label_list(allow_files = [".ts"]),
        "stamp": attr.bool(
            default = False,
            doc = "Record the checkout source SHA from Bazel's stable status (set from --stamp).",
        ),
        "zipper": attr.label(
            allow_single_file = True,
            cfg = "exec",
            default = Label("@bazel_tools//tools/zip:zipper"),
        ),
    },
    toolchains = [BUN_TOOLCHAIN_TYPE],
)
