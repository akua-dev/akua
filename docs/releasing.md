# Releasing

`akua-dev/akua` releases the package toolchain `akuapkg` and the `akua` CLI together, on one version:

- **Version.** `Cargo.toml` `[workspace.package].version` is the source of truth. `host/package.json`, `cli/package.json` (and its `@akua-dev/sdk` dependency) and `cli/src/bin/akua.ts` carry the same version; the CLI unit suite (`cli/test/version.test.ts`) fails when they differ, and the release packaging refuses a CLI whose version differs from the akuapkg it embeds. `akuapkg --version`, `akua --version` and `akua pkg version` all print it.
- **Tag.** One lightweight `v<version>` tag per version.
- **Release.** One GitHub Release per version, marked latest (the install scripts resolve `/releases/latest`), carrying both products' assets:

| Product    | Assets                                                                                                                                                                                                                                                                                                                     | Install                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `akuapkg`  | `akuapkg-v<version>-<triple>.{tar.gz,zip}` for `aarch64-apple-darwin`, `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`, each with a `.sha256` sidecar; `akuapkg-v<version>-checksums.txt`, `akuapkg-v<version>-manifest.json`, `akuapkg-v<version>-homebrew.json` | `https://cli.akua.dev/install`, `akua-dev/tap/akuapkg` |
| `akua` CLI | `akua-v<version>-<target>.{tar.gz,zip}` for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-x64`, each with a `.sha256` sidecar; `akua-v<version>-checksums.txt`, `akua-v<version>-manifest.json`, `akua-v<version>-homebrew.json`                                                                      | `akua-dev/tap/akua`                                    |

The CLI manifest's provenance records the embedded akuapkg version, which equals the CLI version.

The writable source of truth is the canonical repository's `oss/akua` subtree. The public repository is its fixed Josh projection. Public CI remains advisory. The documentation workflow publishes cli.akua.dev separately. Neither workflow creates release tags or distribution assets.

## Normal releases

Review and merge a version bump (`Cargo.toml`, `host/package.json`, `cli/package.json` and `cli/src/bin/akua.ts`, plus the regenerated lockfiles) with the intended code changes. The canonical Main pipeline builds both products' native archives with Bazel, from this repository's `//bazel:release_archives` and `//bazel:cli_release_archive`, and records their exact source SHA. One public writer then fast-forwards `main` to the matching projected commit, creates the `v<version>` tag and draft Release, uploads all twenty-six admitted assets, and publishes the Release as latest, without rebuilding at the public boundary.

The release consumer downloads and verifies every asset of the published Release before it dispatches the existing tap workflow once per formula: `akuapkg-release-published` for `akuapkg` and `akua-cli-release-published` for `akua`, each with `{version, tag, release_url, homebrew_manifest_url}` pointing at this Release. That workflow proposes a reviewed formula update in `akua-dev/homebrew-tap`.

No new npm or container publication is part of this pipeline. The canonical repository consumes the source SDK and native build outputs directly; existing npm versions remain available.

## Recovery

Tags and published assets are immutable. Never delete or move a tag, replace an asset, or upload artifacts by hand. A retry may fill missing assets in a draft only when the admitted source, projection, and asset digests are unchanged. An existing published release is accepted only after every asset is verified. Correct a changed release by reviewing a new version bump.
