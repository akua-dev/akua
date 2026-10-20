# Contributing to the Akua CLI

This file covers building, testing, and releasing this repository's source.
If you only want to use the `akua` executable, see [README.md](README.md)
instead.

The CLI is the `packages/cli/` workspace of [`akua-dev/akua`](https://github.com/akua-dev/akua),
which also holds the package toolchain (`@akua-dev/sdk`, `host/`) that
`akua pkg` embeds. The canonical writable history is the Akua monorepo, of
which that repository is the exact projection. Issues are welcome; external
code pull requests are not accepted yet (see
[../../CONTRIBUTING.md](../../CONTRIBUTING.md)). The CLI shares one version with the
package toolchain: `../../Cargo.toml` `[workspace.package].version` is the source
of truth, and this directory's `package.json` `version` must equal it (the unit
suite fails otherwise). The public `v<version>` tag is created by the canonical
Main pipeline at the admitted projected commit; see
[../../docs/releasing.md](../../docs/releasing.md).

## Building and testing with Bazel

Bazel builds the release executables and runs the suite from a clone of
akua-dev/akua; see [../../docs/building.md](../../docs/building.md):

```sh
bazel build //bazel:akua_darwin_arm64       # akua with `akua pkg` embedded
bazel build //bazel:cli_release_archive     # all five archives and the release assets
bazel test //bazel:cli_unit_test //bazel:cli_typecheck_test
```

## Prerequisites for the Bun scripts

Bun 1.4+ is the only prerequisite. Run `bun install` at the repository root
(it links `@akua-dev/sdk` from `host/`), then in `packages/cli/`:

```sh
bun run check
bun run build:binary
./dist/akua --version
./dist/akua --help
./dist/akua commands --limit 1
```

`bun run check` typechecks, builds, and tests this standalone checkout.
Public API changes also require the canonical cnap Bazel drift gate below.

Canonical cnap Bazel releases embed the source host, its Wasmtime addon and
the precompiled WASM engines for each target; the release manifest records the
akuapkg version they come from.

## Command generation

The command surface is generated from Akua's public OpenAPI document, of
which `src/generated/openapi-public.json` is the committed copy. The Akua
monorepo regenerates both files from its own document and drift-gates them;
here, `bun run generate` rebuilds `src/generated/contract.gen.ts` from the
copy and `bun run generate:check` (also a unit test) fails on drift. There is
no weekly production fetch.

```sh
# In the Akua monorepo, after a public API change:
bazel run //:write_cli_generated         # regenerate src/generated/ from docs/openapi-public.json
bazel test //:sdk_generated_drift_test   # fail if committed generated output has drifted
```

Generation is deterministic and operationId-driven; only operations marked
`x-platform-visibility: PUBLIC` are included, and registry rows are sorted by
operationId. The generated output is `src/generated/contract.gen.ts`. Never hand-edit generated
files; regenerate and commit the result.

See [docs/architecture.md](docs/architecture.md) for the full command
derivation rules, the API/auth/config model, output modes, exit codes, and
the rest of the CLI's design contract.

## Testing

```sh
bun run test
```

`bun run check` (build and tests) is the required gate before
release changes; see [docs/architecture.md](docs/architecture.md#testing-strategy)
for what current test coverage includes.

## Release process

Bump the shared version (`../../Cargo.toml`, `../../host/package.json`, this
`package.json` and its `@akua-dev/sdk` dependency, `src/bin/akua.ts`) in a
reviewed cnap PR when a release is needed; `test/version.test.ts` keeps them
equal. The Main pipeline does not invent a new version for unrelated
changes.

Bazel produces the five compiled archives and the thirteen immutable release
assets under `//bazel:cli_release_archive`. Linux and available macOS hosts
exercise the compiled cloud CLI and `pkg init` → `check` → `render` → `inspect`.
Windows is cross-built and packaged without requiring native execution.

The successful canonical Main pipeline projects the fixed public source tree,
scans its full Git history, and hands public-only inputs to a dedicated writer.
That writer fast-forwards public main, creates the immutable `v<version>` tag,
and publishes the exact stamped Bazel assets. It downloads and re-verifies all
published assets before rendering the Homebrew formulas and publishing
`akua-dev/homebrew-tap`. No vendor token is mounted in the build or writer.
Public CI provides read-only advisory build and install checks.

The tap is a published source view. Its templates, formula rendering, audits,
and install tests are owned by the same canonical Main pipeline; public tap
workflows do not generate or publish changes.

`bun run release:package` remains a local packaging tool.
`bun run release:verify` re-verifies the files in `dist/release`.
`CLI_RELEASE_ARCHIVE_SHA256=<expected-sha256> bun run release:smoke` verifies,
extracts, and executes the current host archive. Supply its digest from the
verified manifest; a missing, malformed, or mismatched digest fails before
extraction. `scripts/release.ts` defines the target IDs, archive names, checksums,
and manifest contract consumed by the authoritative Bazel archive targets.

## Repository-specific engineering rules

See [AGENTS.md](AGENTS.md) for durable, repository-wide engineering rules
(Effect v4 production code conventions, the release contract, ownership
boundaries, and the public API command contract) that apply to any change in
`src/` or `scripts/`.
