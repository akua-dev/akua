# Building with Bazel

This repository builds `akuapkg` and the `akua` CLI with Bazel from a plain
clone. Bazel pins every toolchain - Rust, Go, Zig, clang-cl and the Windows
SDK, the macOS SDK, Bun - and every npm package, so no compiler, Node, Bun or
package manager on your machine takes part in a build.

The official releases are built from these same `BUILD` files: the Akua
monorepo consumes this repository as a Bazel module (see
[Inside the Akua monorepo](#inside-the-akua-monorepo)).

## Requirements

- [Bazelisk](https://github.com/bazelbuild/bazelisk) (it reads `.bazelversion`).
- A Linux x86_64 execution platform. Every release target - Linux, macOS and
  Windows, x64 and arm64 - is cross-compiled there:
  - on a Linux x86_64 machine nothing else is needed;
  - on macOS or other hosts, point Bazel at any
    [Remote Execution API](https://github.com/bazelbuild/remote-apis) service
    with Linux x86_64 workers (BuildBuddy, NativeLink, Buildbarn, ...) using
    `--config=remote`, or run Bazel in a Linux x86_64 container.

## Targets

```sh
# Executables for one target: akuapkg and akua (`akua pkg` embeds the same host).
bazel build //bazel:akuapkg_darwin_arm64 //bazel:akua_darwin_arm64

# All targets: linux_x64, linux_arm64, darwin_x64, darwin_arm64, windows_x64.
bazel build //bazel:release_archives        # akuapkg-v<version>-<triple> archives
bazel build //bazel:cli_release_archive     # the akua CLI's thirteen release assets

# Tests.
bazel test //bazel:cli_unit_test //bazel:cli_typecheck_test //bazel:host_typecheck_test
bazel test //bazel:render_worker_stamp_contract_test //bazel:darwin_arm64_link_inputs_test
```

On a non-Linux host, add the remote executor:

```sh
bazel build --config=remote --remote_executor=grpcs://<your REAPI endpoint> \
  //bazel:akuapkg_darwin_arm64 //bazel:akua_darwin_arm64
```

Put such flags, and credentials for your executor, in a `.bazelrc.user` (it is
git-ignored and imported by `.bazelrc`).

## Layout

| Path | Contents |
|---|---|
| `MODULE.bazel` | The `akua` Bazel module: dependencies, toolchain repositories, crate universes, Bun releases, npm packages |
| `toolchains.MODULE.bazel` | Toolchain configuration only a root module may declare (the release Rust toolchains, the Linux-executed Zig toolchains); included by every root that builds this module |
| `bazel/` | Build logic: `BUILD.bazel` (executables, release archives, tests), `rust/` (the render worker, the Wasmtime addon, the precompiler), `toolchains/` (C toolchains and the Windows SDK), `bun/` (Bun toolchain, `bun_compile`, `bun_test`), `npm/` (the `bun.lock` installer), `platforms/`, `patches/` |
| `host/` | The Bun/Effect host: CLI, render pipeline, Wasmtime sandbox adapter |
| `native/` | The Wasmtime sandbox addon (napi-rs) and its build-time precompiler |
| `crates/` | The KCL render worker (`akua-render-worker`, `akua-core`) and the Go Helm/Kustomize engines |
| `cli/` | The `akua` CLI |

npm packages come from `bun.lock` alone: `bazel/npm/bun_lock.bzl` downloads
each tarball with the lock's integrity hash, applies `patchedDependencies` and
lays out Bun's tree. After changing a `package.json`, run `bun install` and
commit `bun.lock`.

## Inside the Akua monorepo

The canonical, writable history of this repository lives in the Akua
monorepo, at `oss/akua`. That monorepo consumes this directory as
the `akua` module (`bazel_dep` plus `local_path_override`), includes
`toolchains.MODULE.bazel` into its own root module and builds the release
archives from `//bazel` here, as `@akua//bazel:...`. The `BUILD` files outside
`bazel/` are also loaded there as ordinary packages, so they keep to source
groups and local labels; every label in this tree resolves inside it.
