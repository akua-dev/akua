# Contributing to Akua

Thanks for your interest. Akua is **pre-alpha** — APIs, schemas, and CLI
surfaces are all in flux. Small focused fixes are welcome; big
architectural PRs are probably better raised as issues first so we can
discuss direction.

## Ways to help

- **Issues** — bug reports, feature requests, design feedback
- **Docs** — `docs/`, example READMEs, the top-level `README.md`; these drift fastest
- **Test coverage** — especially for engines + CEL expression edge cases
- **Regression coverage on real charts** — `akuapkg render` against popular Helm charts from ArtifactHub; file issues for any that mis-render

## Development setup

Akuapkg builds in cnap with Bazel, which pins every toolchain (Rust, Go,
Bun) and builds the render worker, the Helm/Kustomize engines and the
Wasmtime addon for each target:

```bash
bazel run //tools/dev:bazel_env        # developer CLIs on PATH (via direnv)
bazel build //tools/akuapkg:akuapkg_darwin_arm64
bazel test //tools/akuapkg:host_render_contract_test
```

## Running the examples

```bash
cargo run -p akuapkg-cli -- tree --package examples/hello-package
cargo run -p akuapkg-cli -- render --package examples/hello-package --out dist/chart --release demo
```

## What's landed / what's next

See [`docs/roadmap.md`](docs/roadmap.md). Phases 0–7 landed: Akua renders
end-to-end as a single binary with no external CLI deps in the default
flow. Upcoming: install UI reference, Package Studio IDE, upstream HIP
proposals.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). Be kind.

## License

By contributing, you agree your contributions will be licensed under
Apache License 2.0.
