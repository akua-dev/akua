"""Cargo manifest projection for crate_universe, and the pinned Go engine sources."""

_CRATES = [
    "akua-core",
    "akua-render-worker",
]

_RESOLUTION_ROOTS = {
    "worker": "akua-render-worker",
}

_RESOLUTION_CRATES = {
    "worker": ["akua-core", "akua-render-worker"],
}

# crate_universe resolves each workspace member as a Cargo tree root when it
# generates first-party dependency maps. Give those roots the exact features
# selected by the worker, CLI, or NAPI consumer in this private projection.
_RESOLUTION_NONROOT_DEFAULTS = {
    "worker": {"akua-core": ["engine-kcl"]},
}

_CRATE_TARGET_STUBS = {
    "akua-core": ["src/lib.rs"],
    "akua-render-worker": ["src/main.rs"],
}

def _cargo_manifest_workspace_impl(rctx):
    manifest_contents = rctx.read(rctx.attr.manifest)
    lock_contents = rctx.read(rctx.attr.lockfile)
    resolution_root = _RESOLUTION_ROOTS.get(rctx.attr.resolution_root)
    if rctx.attr.resolution_root and not resolution_root:
        fail("Unsupported Cargo resolution root: " + rctx.attr.resolution_root)

    # Public Cargo uses three prepared path patches. crate_universe instead
    # applies their code patches to the same locked Git revision at fetch.
    patch_block = """[patch."https://github.com/kcl-lang/kcl"]
kcl-language-server = { path = "third_party/kcl/vendor/kcl-language-server" }
kcl-parser = { path = "third_party/kcl/vendor/kcl-parser" }
kcl-runtime = { path = "third_party/kcl/vendor/kcl-runtime" }
"""
    if len(manifest_contents.split(patch_block)) != 2:
        fail("Expected the three source-owned KCL path patches")
    manifest_contents = manifest_contents.replace(patch_block, "")
    revision = rctx.read(rctx.attr.kcl_revision).strip()
    source = "git+https://github.com/kcl-lang/kcl#" + revision
    if 'name = "kcl-lexer"\nversion = "0.13.0"\nsource = "{}"'.format(source) not in lock_contents:
        fail("KCL Git revision differs from the committed Cargo lock")
    if 'source = "{}"'.format(source) not in lock_contents:
        fail("Private resolution lock lost the public KCL Git revision")
    rctx.file("Cargo.toml", manifest_contents)
    rctx.file("Cargo.lock", lock_contents)
    for manifest in rctx.attr.crate_manifests:
        name = rctx.path(manifest).dirname.basename
        if resolution_root and name not in _RESOLUTION_CRATES[rctx.attr.resolution_root]:
            # Keep path dependencies as workspace members. crate_universe's
            # path-dependency renderer writes BUILD.bazel into the source
            # checkout, while workspace members stay in its generated repo.
            # Unrelated members are inert Cargo packages in this private
            # resolution view so `cargo tree --workspace` cannot unify their
            # native features into the selected release graph.
            crate_contents = '[package]\nname = "{}"\nversion.workspace = true\nedition.workspace = true\n\n[lib]\npath = "src/lib.rs"\n'.format(name)
        else:
            crate_contents = rctx.read(manifest)
            if resolution_root and name in _RESOLUTION_NONROOT_DEFAULTS[rctx.attr.resolution_root]:
                default_lines = [line for line in crate_contents.split("\n") if line.startswith("default = [")]
                if len(default_lines) != 1:
                    fail("Expected one default feature list in " + name)
                features = _RESOLUTION_NONROOT_DEFAULTS[rctx.attr.resolution_root][name]
                crate_contents = crate_contents.replace(default_lines[0], "default = [{}]".format(", ".join(['"{}"'.format(feature) for feature in features])), 1)
        rctx.file("crates/{}/Cargo.toml".format(name), crate_contents)

        # Metadata and vendoring do not compile first-party crates. Declared
        # targets remain present in this manifest-only resolution workspace.
        sources = ["src/lib.rs"] if resolution_root and name not in _RESOLUTION_CRATES[rctx.attr.resolution_root] else _CRATE_TARGET_STUBS[name]
        for source in sources:
            rctx.file("crates/{}/{}".format(name, source), "")
    path = "BUILD.bazel"
    files = ["Cargo.toml", "Cargo.lock"] + ["crates/{}/Cargo.toml".format(name) for name in _CRATES]
    rctx.file(path, "exports_files({}, visibility = [\"//visibility:public\"])\n".format(json.encode(files)))

_CARGO_MANIFEST_WORKSPACE_ATTRS = {
    "manifest": attr.label(default = "//:Cargo.toml"),
    "lockfile": attr.label(default = "//:Cargo.lock"),
    "crate_manifests": attr.label_list(default = ["//crates/{}:Cargo.toml".format(name) for name in _CRATES]),
    "kcl_revision": attr.label(default = "//third_party/kcl:.upstream-rev"),
    "resolution_root": attr.string(default = ""),
}

cargo_manifest_workspace = repository_rule(
    implementation = _cargo_manifest_workspace_impl,
    attrs = _CARGO_MANIFEST_WORKSPACE_ATTRS,
)

def _go_sources_impl(rctx):
    engine = rctx.attr.engine
    if engine not in ["helm", "kustomize"]:
        fail("Unsupported embedded engine " + engine)
    for source in rctx.attr.sources:
        rctx.file(rctx.path(source).basename, rctx.read(source))
    if engine == "helm":
        rctx.download_and_extract(
            url = "https://codeload.github.com/helm/helm/tar.gz/refs/tags/v4.1.4",
            sha256 = "cc365ae17de9bd856972198f9c372f9fd2146852434ade3b3c96303b564cdb15",
            stripPrefix = "helm-4.1.4",
            output = "helm",
            type = "tar.gz",
        )

        # Separate file patches preserve the upstream patch's hunk order.
        for index, file_patch in enumerate(rctx.read(rctx.attr.helm_patch).split("--- helm-v4/")[1:]):
            patch_name = "helm-{}.patch".format(index)
            patch = "--- a/helm/" + file_patch.replace("+++ helm-fork/", "+++ b/helm/")
            rctx.file(patch_name, patch)
            rctx.patch(rctx.path(patch_name), strip = 1)
        rctx.file("go.mod", rctx.read("go.mod") + "\nreplace helm.sh/helm/v4 => ./helm\n")
    go = rctx.path(rctx.attr.go)
    environment = {
        "GOENV": "off",
        "GOAUTH": "off",
        "GOTOOLCHAIN": "local",
        "GOPROXY": "https://proxy.golang.org",
        "GOSUMDB": "sum.golang.org",
        "GOPRIVATE": "",
        "GONOPROXY": "",
        "GONOSUMDB": "",
        "GOMODCACHE": str(rctx.path("_module-cache")),
        "GOCACHE": str(rctx.path("_build-cache")),
    }
    manifest = rctx.read("go.mod")
    checksums = rctx.read("go.sum")
    for args in [["mod", "download"], ["mod", "vendor"]]:
        result = rctx.execute([go] + args, environment = environment, timeout = 600)
        if result.return_code != 0:
            fail("Pinned Go dependency resolution failed:\n" + result.stderr)
    if rctx.read("go.mod") != manifest or rctx.read("go.sum") != checksums:
        fail("Go dependency resolution changed the committed module/checksum closure")
    rctx.file("BUILD.bazel", """
exports_files(["go.mod", "go.sum"], visibility = ["//visibility:public"])
filegroup(name = "sources", srcs = ["go.mod", "go.sum"] + glob(["*.go", "vendor/**"]), visibility = ["//visibility:public"])
""")

go_sources = repository_rule(
    implementation = _go_sources_impl,
    attrs = {
        "engine": attr.string(mandatory = True),
        "sources": attr.label_list(mandatory = True),
        "go": attr.label(default = "@go_host//:go/bin/go"),
        "helm_patch": attr.label(default = "//crates/helm-engine-wasm:fork/helm-v4.1.4.patch"),
    },
)
