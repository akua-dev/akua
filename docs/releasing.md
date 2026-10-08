# Releasing Akuapkg

Akuapkg publishes the standalone `akuapkg` binary from `akua-dev/akuapkg`. The Akua platform CLI is a separate artifact named `akua`.

The canonical distribution coordinates are:

- Source and releases: `https://github.com/akua-dev/akuapkg`
- Homebrew formula: `akua-dev/tap/akuapkg`

The writable source of truth is the canonical repository's `tools/akuapkg/source` subtree. The public repository is its fixed Josh projection. Public CI remains advisory. The existing documentation workflow publishes its documentation site separately. Neither workflow creates release tags or distribution assets.

## Normal releases

Review and merge a version bump in `Cargo.toml` with the intended code changes. The canonical Main pipeline builds the five native archives with Bazel and records their exact source SHA. Its public writer publishes only those admitted bytes and the matching projected source commit, without rebuilding at the public boundary.

Each release contains five archives, their five checksum sidecars, `checksums.txt`, `akuapkg-v<version>-manifest.json`, and `akuapkg-v<version>-homebrew.json`. The release consumer verifies all thirteen assets before dispatching the existing tap workflow. That workflow proposes a reviewed formula update in `akua-dev/tap`.

No new npm or container publication is part of this pipeline. The canonical repository consumes the source SDK and native build outputs directly; existing npm versions remain available.

## Recovery

Tags and published assets are immutable. Never delete or move a tag, replace an asset, or upload artifacts by hand. A retry may fill missing assets in a draft only when the admitted source, projection, and asset digests are unchanged. An existing published release is accepted only after every asset is verified. Correct a changed release by reviewing a new version bump.
