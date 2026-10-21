# Akua open-source tools

This repository contains the `akua` CLI, the akuapkg package toolchain,
its sandbox and engines, and package-authoring agent skills.

## Route changes to their owner

| Area | Instructions and reference |
| --- | --- |
| `packages/cli/` | [CLI guide](packages/cli/AGENTS.md) and its local Effect skill |
| `packages/akuapkg/` | [Package and host invariants](packages/akuapkg/AGENTS.md) |
| `crates/` | [Engine and sandbox map](crates/README.md); the package guide owns their sandbox invariants |
| `plugins/akuapkg/` | [Package-authoring skills](plugins/akuapkg/README.md) |
| Format specs and examples | [docs/](docs/) and [examples/](examples/) |
| Build and release | [Building](docs/building.md), [releasing](docs/releasing.md) |

## Repository contract

- Build and test with the declarative Bazel targets in [docs/building.md](docs/building.md). Keep public target names stable.
- Both binaries share the Cargo workspace version and one immutable `v<version>` release. The CLI imports akuapkg in process for `akua pkg`.
- Keep source groups outside `bazel/` limited to local labels and sources so the same module can be consumed by its parent workspace.
- Public source is self-contained: no private workspace dependencies, labels or credentials.
- Development happens in the canonical internal repository. Outside code pull requests follow [CONTRIBUTING.md](CONTRIBUTING.md); issues and reproductions are welcome.
- Generated files, release tags and assets are immutable inputs. Use their owning generator; never hand-edit changelogs.

## Writing

Describe what things do. No marketing-speak, emoji, invented vocabulary,
or em dashes. Comments explain why; task and PR history belongs in review
and commit messages. State limitations and link to the owning specification.

Keep this file to repository-wide rules and routing; product invariants
belong in the package guide.
