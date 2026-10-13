"""Offline source compilation for the embedded package engines."""

load(":source_cross_sdks.bzl", "PACKAGE_WINDOWS_CRT_VERSION", "PACKAGE_WINDOWS_SDK_VERSION")

PackageWindowsSdkInfo = provider("Declared MSVC headers, libraries, compiler and assembly tools.", fields = ["sdk", "llvm", "nasm", "tools"])

def _go_engine_impl(ctx):
    output = ctx.actions.declare_file(ctx.attr.out)
    args = ctx.actions.args()
    args.add(ctx.file._go.path)
    args.add(ctx.file._go.dirname + "/..")
    args.add(ctx.file.module.dirname)
    args.add(output.path)
    ctx.actions.run_shell(
        mnemonic = "PackageGoWasiCompile",
        progress_message = "Compiling {} from pinned Go source".format(ctx.attr.out),
        inputs = depset(transitive = [ctx.attr.source[DefaultInfo].files, ctx.attr._sdk[DefaultInfo].files]),
        outputs = [output],
        arguments = [args],
        command = """
export GOROOT="$PWD/$2"
export GOCACHE="$PWD/$4.gocache"
exec "$PWD/$1" build -C "$PWD/$3" -mod=vendor -trimpath -buildvcs=false -buildmode=c-shared -ldflags='-s -w' -o "$PWD/$4" .
""",
        env = {
            "CGO_ENABLED": "0",
            "GOARCH": "wasm",
            "GOENV": "off",
            "GOOS": "wasip1",
            "GOPROXY": "off",
            "GOSUMDB": "off",
            "GOTOOLCHAIN": "local",
        },
        execution_requirements = {"block-network": "1"},
    )
    return [DefaultInfo(files = depset([output]))]

go_wasi_engine = rule(
    implementation = _go_engine_impl,
    attrs = {
        "out": attr.string(mandatory = True),
        "source": attr.label(mandatory = True),
        "module": attr.label(mandatory = True, allow_single_file = True),
        "_go": attr.label(default = "@go_linux_x64//:go/bin/go", allow_single_file = True, cfg = "exec"),
        "_sdk": attr.label(default = "@go_linux_x64//:go_files", cfg = "exec"),
    },
)

def _windows_sdk_impl(ctx):
    output = ctx.actions.declare_directory(ctx.label.name)
    args = ctx.actions.args()
    args.add_all([
        ctx.file._xwin.path,
        ctx.file._manifest.path,
        ctx.file._manifest.dirname + "/cache",
        output.path,
        PACKAGE_WINDOWS_SDK_VERSION,
        PACKAGE_WINDOWS_CRT_VERSION,
    ])

    # xwin copies duplicate SDK headers and preserves source modes. Keep its
    # cache writable without changing the immutable action inputs.
    ctx.actions.run_shell(
        command = """
set -eu
cache_root="$PWD/$4.cache"
out="$PWD/$4"
cp -RL "$PWD/$3" "$cache_root"
chmod -R u+w "$cache_root"
"$PWD/$1" --accept-license --manifest "$PWD/$2" --sdk-version "$5" --crt-version "$6" --arch x86_64 --cache-dir "$cache_root" splat --copy --output "$out"
# Bazel traverses directory aliases; these unused links point to their parents.
rm "$out/sdk/include/$5" "$out/sdk/lib/$5"
# Every other xwin link is a case alias: a sibling's spelling as headers and
# linker inputs reference it. Bazel recreates output symlinks on the invoking
# host even without downloading outputs, and on a case-insensitive filesystem
# (macOS) an alias names itself: a loop or an existing file. Hardlinks keep
# each spelling and its inode for the executor with no output symlink. The
# toolchain passes lowercase include and lib paths, so the title-case
# directory aliases are unused; <GL/gl.h> gets a hardlinked directory.
rm "$out/sdk/Include" "$out/sdk/Lib" "$out/sdk/include/um/GL"
find "$out" -type l -exec sh -c 'for link do target="${link%/*}/$(readlink "$link")"; rm "$link"; ln "$target" "$link"; done' sh {} +
mkdir "$out/sdk/include/um/GL"
ln "$out/sdk/include/um/gl/"* "$out/sdk/include/um/GL/"
if [ -n "$(find "$out" -type l)" ]; then
  echo "Windows SDK output still contains symlinks:" >&2
  find "$out" -type l >&2
  exit 1
fi
""",
        arguments = [args],
        inputs = depset([ctx.file._manifest], transitive = [ctx.attr._cache[DefaultInfo].files]),
        tools = [ctx.file._xwin],
        outputs = [output],
        env = {"RAYON_NUM_THREADS": "2"},
        execution_requirements = {"block-network": "1"},
        mnemonic = "PackageWindowsSdk",
        progress_message = "Preparing pinned Windows SDK headers and libraries",
    )
    return [
        DefaultInfo(files = depset([output])),
        PackageWindowsSdkInfo(
            sdk = output,
            llvm = ctx.file._clang_cl.dirname + "/..",
            nasm = ctx.file._nasm,
            tools = depset(transitive = [ctx.attr._windows_tools[DefaultInfo].files, ctx.attr._build_tools[DefaultInfo].files]),
        ),
    ]

package_windows_sdk = rule(
    implementation = _windows_sdk_impl,
    attrs = {
        "_cache": attr.label(default = "@windows_sdk_inputs//:files"),
        "_manifest": attr.label(default = "@windows_sdk_inputs//:manifest.json", allow_single_file = True),
        "_xwin": attr.label(default = "@windows_sdk_inputs//:linux/xwin", allow_single_file = True, cfg = "exec"),
        "_windows_tools": attr.label(default = "@llvm//:windows_tools", cfg = "exec"),
        "_clang_cl": attr.label(default = "@llvm//:bin/clang-cl", allow_single_file = True, cfg = "exec"),
        "_nasm": attr.label(default = "@windows_build_tools//:usr/bin/nasm", allow_single_file = True, cfg = "exec"),
        "_build_tools": attr.label(default = "@windows_build_tools//:files", cfg = "exec"),
    },
)
