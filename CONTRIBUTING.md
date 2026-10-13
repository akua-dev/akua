# Contributing to Akua

Thanks for your interest. Akua is **pre-alpha**: APIs, schemas, and CLI
surfaces are all in flux.

## What we accept today

- **Issues are welcome**: bug reports, minimal reproductions, root-cause
  analysis, feature requests and design feedback.
- **External code pull requests are not accepted yet.** Development happens in
  Akua's internal monorepo, which is the source of truth; this repository is
  its exact, read-only projection. A pull request here cannot be merged, so
  please open an issue instead, with a reproduction or a proposed fix
  described in it. A reviewed path for importing outside pull requests may
  come later.

Especially useful issues:

- **Rendering regressions on real charts**: `akuapkg render` against popular
  Helm charts from Artifact Hub; report any that render differently from
  `helm template`, beyond the differences in
  [docs/embedded-engines.md](docs/embedded-engines.md).
- **CRDs that convert badly**: a CRD source whose generated schemas reject
  valid resources or accept invalid ones.
- **Docs** that drifted from behavior: `docs/`, example READMEs, skills.
- **Sandbox findings** go through [SECURITY.md](SECURITY.md), not issues.

## Repository layout

This repository holds two products that release together, on one version and
one `v<version>` release (see [docs/releasing.md](docs/releasing.md)):

- `akuapkg`, the package toolchain (`host/`, `native/`, `crates/`), installed
  by `https://cli.akua.dev/install`;
- `akua`, the Akua CLI (`cli/`), installed with
  `brew install akua-dev/tap/akua`. `akua pkg` embeds the same package
  toolchain host.

## Development setup

Bazel builds both from a clone, pinning every toolchain (Rust, Go, Zig, Bun)
and every npm package; the release archives come from the same `BUILD` files.
See [docs/building.md](docs/building.md):

```bash
bazel build //bazel:akuapkg_darwin_arm64 //bazel:akua_darwin_arm64
bazel test //bazel:cli_unit_test //bazel:cli_typecheck_test //bazel:host_typecheck_test
```

Every target cross-compiles on Linux x86_64; on macOS add `--config=remote`
with a Remote Execution endpoint, or run Bazel in a Linux container.

For quick iteration on the TypeScript, `bun install` at the repository root
and use each workspace's scripts (`cd cli && bun run check`).

Build the render worker with Bazel: KCL patches 0005 and 0006
([third_party/kcl/patches](third_party/kcl/patches/README.md)) are applied
only there, so a plain `cargo build` produces a worker without them.

## Running the examples

```bash
bazel build //bazel:akuapkg_darwin_arm64    # or the target for your machine
cd examples/01-hello-webapp
../../bazel-bin/bazel/bin/darwin_arm64/akuapkg render --out /tmp/hello
diff -r /tmp/hello rendered
```

## Where changes land

The canonical, writable history lives in the Akua monorepo
(`oss/akua`), and this repository is its exact projection. Every
change, and every release, is made there and appears here when the projection
catches up. See [docs/releasing.md](docs/releasing.md).

## What's landed / what's next

See [`docs/roadmap.md`](docs/roadmap.md).

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). Be kind.

## License

Akua is licensed under the Apache License 2.0.
