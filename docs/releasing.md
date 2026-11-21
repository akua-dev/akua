# Releasing

`akua-dev/akua` releases the package toolchain `akuapkg` and the `akua` CLI together, on one version:

- **Version.** `version.bzl` `AKUA_VERSION` is the release source of truth. Bazel generates executable entries and distribution npm, Cargo and plugin manifests from it (`//bazel:release_manifests`). Source workspace manifests and locks keep the fixed internal version `0.0.0-dev`; they do not change on a release. Released `akuapkg --version`, `akua --version` and `akua pkg version` all print the release version. Running the CLI directly from source reports the internal version.
- **Tag.** One lightweight `v<version>` tag per version.
- **Release.** One GitHub Release per version, marked latest (the install scripts resolve `/releases/latest`), carrying both products' assets:

| Product    | Assets                                                                                                                                                                                                                                                                                                                     | Install                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `akuapkg`  | `akuapkg-v<version>-<triple>.{tar.gz,zip}` for `aarch64-apple-darwin`, `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`, each with a `.sha256` sidecar; `akuapkg-v<version>-checksums.txt`, `akuapkg-v<version>-manifest.json`, `akuapkg-v<version>-homebrew.json` | `https://akua.dev/install`, `akua-dev/tap/akuapkg` |
| `akua` CLI | `akua-v<version>-<target>.{tar.gz,zip}` for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-x64`, each with a `.sha256` sidecar; `akua-v<version>-checksums.txt`, `akua-v<version>-manifest.json`, `akua-v<version>-homebrew.json`                                                                      | `akua-dev/tap/akua`                                    |

For new releases, both manifests bind the canonical source SHA, projected commit SHA, fixed Josh filter, pinned Josh image and every archive's SHA-256. After projection, a hermetic Bazel producer adds the projection identity before admitting the immutable release input; publication rejects missing provenance. The CLI manifest also records the embedded akuapkg version, which equals the CLI version.

The writable source of truth is the canonical repository's `oss/akua` subtree. The public repository is its fixed Josh projection. Public CI remains advisory and does not create release tags or distribution assets. CLI documentation lives at [docs.akua.dev/akua/cli](https://docs.akua.dev/akua/cli). The website's installer endpoints redirect to the public `scripts/install.sh` and `scripts/install.ps1` sources.

## Normal releases

Review and merge a one-line `version.bzl` bump with the intended code changes. Do not bump workspace manifests or regenerate locks for a release. The canonical Main pipeline builds both products' native archives with Bazel, from this repository's `//bazel:release_archives` and `//bazel:cli_release_archive`, and records their exact source SHA. One public writer then fast-forwards `main` to the matching projected commit, creates the `v<version>` tag and draft Release, uploads all twenty-six admitted assets, and publishes the Release as latest, without rebuilding at the public boundary.

The cluster agent and its embedded apply engine have their own OCI release version. A public CLI release does not change that image's readiness identity or consumer pins.

Canonical automation opens a patch-version-only change daily when public source changed since the published release and Main's own CI check is successful. On-demand releases use the same change and landing path. A pending train change is reused; the train never updates Main or publishes a release directly.

The release consumer downloads and verifies every published asset, renders the `akuapkg` and `akua` formulas from the verified Homebrew manifests, and non-force publishes the canonical tap source plus those formulas to `akua-dev/homebrew-tap`. Formula audits and install tests belong to canonical Bazel CI; the public tap does not run GitHub Actions or accept direct source changes.

A required Main verification stage then checks the public tag, all twenty-six downloaded assets and hashes, both manifests' version, source and fixed projection provenance, and both formulas at the exact published tap commit. It installs and smokes the native CLI archive, including a real `akua pkg init`, `check`, `render` and `inspect` flow with pinned offline dependencies. A mismatch fails Main before delivery; verification is not a manual release step.

No new npm or container publication is part of this pipeline. The canonical repository consumes the source SDK and native build outputs directly; existing npm versions remain available.

## Recovery

Tags and published assets are immutable. Never delete or move a tag, replace an asset, or upload artifacts by hand. A retry may fill missing assets in a draft only when the admitted source, projection, and asset digests are unchanged. An existing published release is accepted only after every asset is verified.

Fix forward, never roll back: fix a bad release in a new patch version through the normal reviewed release path. Old immutable versions stay installable with their original tags and bytes. The v0.13.9 to v0.13.10 forward fix (`f1339574ce`) restored the contract-diagnostic module missing from compiled releases, without moving the old tag or replacing its assets.
