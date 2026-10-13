"""Installs the npm packages pinned by bun.lock into one repository.

Bun stays the only resolver: this rule reads the committed bun.lock and
nothing else. Every tarball is fetched through Bazel's downloader with the
lock's SRI integrity, so the repository cache, `--experimental_downloader_config`
mirrors and offline builds apply, and no package manager or install script
runs at fetch time.

The layout is bun's hoisted tree: a lock key `a/b` is installed at
`node_modules/a/node_modules/b`, and a key nested under a workspace member
(`@akua-dev/sdk/@types/bun`) at `<member>/node_modules/...`. Workspace
members themselves are not copied here; the staging rules link them to their
sources (`WORKSPACE_LINKS` in the generated `workspace.bzl`).

Platform packages (an `os`/`cpu` entry in the lock) are installed for the
supported release platforms only, and every platform gets its own filegroup
so an action receives only the native packages of the platform it runs on.
"""

_PLATFORMS = {
    "darwin_arm64": ("darwin", "arm64"),
    "darwin_x64": ("darwin", "x64"),
    "linux_arm64": ("linux", "arm64"),
    "linux_x64": ("linux", "x64"),
    "windows_x64": ("win32", "x64"),
}

_REGISTRY = "https://registry.npmjs.org"

def _strip_trailing_commas(text):
    # bun.lock is JSON with trailing commas; Starlark's decoder is strict.
    out = []
    in_string = False
    escaped = False
    pending_comma = -1
    for index in range(len(text)):
        char = text[index]
        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == "\"":
                in_string = False
            continue
        if char == "\"":
            in_string = True
            pending_comma = -1
        elif char == ",":
            pending_comma = len(out)
        elif char in "}]":
            if pending_comma >= 0:
                out[pending_comma] = ""
            pending_comma = -1
        elif char not in " \t\r\n":
            pending_comma = -1
        out.append(char)
    return "".join(out)

def _split_key(key):
    # "isomorphic-git/pify" -> ["isomorphic-git", "pify"]; scopes stay joined.
    parts = key.split("/")
    names = []
    index = 0
    for _ in range(len(parts)):
        if index >= len(parts):
            break
        if parts[index].startswith("@"):
            names.append(parts[index] + "/" + parts[index + 1])
            index += 2
        else:
            names.append(parts[index])
            index += 1
    return names

def _matches(meta, field, value):
    allowed = meta.get(field)
    if allowed == None:
        return True
    values = [allowed] if type(allowed) == "string" else allowed
    positive = [v for v in values if not v.startswith("!")]
    if "!" + value in values:
        return False
    return not positive or value in positive

def _platforms_of(meta):
    return [
        name
        for name, (os, cpu) in _PLATFORMS.items()
        if _matches(meta, "os", os) and _matches(meta, "cpu", cpu)
    ]

def _rewrite_patch(content, directory):
    # bun patch files are relative to the package root; repository_ctx.patch
    # applies relative to the repository root.
    lines = []
    for line in content.split("\n"):
        if line.startswith("diff --git a/"):
            rest = line[len("diff --git a/"):]
            split = rest.find(" b/")
            line = "diff --git a/{d}/{a} b/{d}/{b}".format(d = directory, a = rest[:split], b = rest[split + 3:])
        elif line.startswith("--- a/"):
            line = "--- a/{}/{}".format(directory, line[len("--- a/"):])
        elif line.startswith("+++ b/"):
            line = "+++ b/{}/{}".format(directory, line[len("+++ b/"):])
        lines.append(line)
    return "\n".join(lines)

def _bun_lock_repository_impl(rctx):
    lock = json.decode(_strip_trailing_commas(rctx.read(rctx.attr.lock)))
    if lock.get("lockfileVersion") not in [1, 2]:
        fail("Unsupported bun.lock version {}".format(lock.get("lockfileVersion")))
    workspaces = lock["workspaces"]
    packages = lock["packages"]

    # Workspace member name -> directory, from "name@workspace:dir" entries.
    members = {}
    for key, entry in packages.items():
        if "@workspace:" in entry[0]:
            members[key] = entry[0].split("@workspace:")[1]

    patches = {}
    for spec, patch in lock.get("patchedDependencies", {}).items():
        label = rctx.attr.patches.get(patch)
        if label == None:
            fail("bun.lock patches {} with {}, which is not in `patches`".format(spec, patch))
        patches[spec] = label

    installed = {}
    for key, entry in packages.items():
        if key in members:
            continue
        spec, registry, meta, integrity = entry[0], entry[1], entry[2], entry[3]
        platforms = _platforms_of(meta)
        if not platforms:
            continue
        separator = spec.rfind("@")
        name, version = spec[:separator], spec[separator + 1:]
        names = _split_key(key)
        if names[0] in members:
            directory = members[names[0]] + "/node_modules/" + "/node_modules/".join(names[1:])
        else:
            directory = "node_modules/" + "/node_modules/".join(names)
        url = "{}/{}/-/{}-{}.tgz".format(
            registry.rstrip("/") if registry else _REGISTRY,
            name,
            name.split("/")[-1],
            version,
        )
        archive = "_archives/{}.tgz".format(key.replace("/", "+"))
        rctx.download(url = url, output = archive, integrity = integrity)

        # npm tarballs usually, but not always, keep their files under package/.
        probe = "_probe/" + key.replace("/", "+")
        rctx.extract(archive, output = probe)
        roots = rctx.path(probe).readdir()
        if len(roots) != 1:
            fail("{} must contain exactly one top-level directory".format(url))
        rctx.extract(archive, output = directory, strip_prefix = roots[0].basename)
        rctx.delete(probe)
        if spec in patches:
            rewritten = "_patches/{}.patch".format(key.replace("/", "+"))
            rctx.file(rewritten, _rewrite_patch(rctx.read(patches[spec]), directory))
            rctx.patch(rewritten, strip = 1)
        installed[key] = struct(
            directory = directory,
            platforms = platforms,
            dependencies = meta.get("dependencies", {}).keys() + meta.get("optionalDependencies", {}).keys(),
        )
    rctx.delete("_archives")
    rctx.delete("_probe")
    rctx.delete("_patches")

    # Production closure: what the workspace members need at runtime, resolved
    # the way Node does (innermost node_modules first).
    def resolve(owner, dependency):
        names = _split_key(owner) if owner else []
        for depth in range(len(names), -1, -1):
            candidate = "/".join(names[:depth] + [dependency])
            if candidate in installed or candidate in members:
                return candidate
        return None

    production = {}
    queue = []
    for member, workspace in workspaces.items():
        owner = [key for key, directory in members.items() if directory == member]
        for dependency in workspace.get("dependencies", {}).keys() + workspace.get("optionalDependencies", {}).keys():
            queue.append((owner[0] if owner else "", dependency))
    for _ in range(len(installed) * 4 + len(queue) + 1):
        if not queue:
            break
        owner, dependency = queue.pop()
        key = resolve(owner, dependency)
        if key == None or key in production:
            continue
        production[key] = True
        if key in members:
            for nested in workspaces.get(members[key], {}).get("dependencies", {}).keys():
                queue.append((key, nested))
        else:
            for nested in installed[key].dependencies:
                queue.append((key, nested))
    if queue:
        fail("bun.lock production closure did not converge")

    exclude = ["**/* *", "**/BUILD", "**/BUILD.bazel", "**/WORKSPACE", "**/WORKSPACE.bazel", "**/MODULE.bazel", "**/REPO.bazel"]

    def filegroup(name, keys):
        return """filegroup(
    name = {name},
    srcs = glob({patterns}, exclude = {exclude}, allow_empty = True),
    visibility = ["//visibility:public"],
)
""".format(
            name = json.encode(name),
            patterns = json.encode(sorted([installed[key].directory + "/**" for key in keys])),
            exclude = json.encode(exclude),
        )

    build = [filegroup("production", [key for key in production if key in installed and len(installed[key].platforms) == len(_PLATFORMS)])]
    for platform in _PLATFORMS:
        build.append(filegroup(platform, [key for key in installed if platform in installed[key].platforms]))
        build.append(filegroup(
            "production_" + platform,
            [key for key in production if key in installed and platform in installed[key].platforms],
        ))
    rctx.file("BUILD.bazel", "\n".join(build))

    links = {}
    for member, workspace in workspaces.items():
        for dependency in workspace.get("dependencies", {}).keys() + workspace.get("devDependencies", {}).keys():
            if dependency in members and member:
                links["{}/node_modules/{}".format(member, dependency)] = members[dependency]
    rctx.file("workspace.bzl", "WORKSPACE_LINKS = {}\n".format(json.encode(links)))

bun_lock_repository = repository_rule(
    implementation = _bun_lock_repository_impl,
    attrs = {
        "lock": attr.label(mandatory = True, allow_single_file = True),
        "patches": attr.string_keyed_label_dict(doc = "bun.lock patchedDependencies path -> patch file."),
    },
)
