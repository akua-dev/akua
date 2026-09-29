# Releasing Akuapkg

Akuapkg publishes the standalone `akuapkg` binary from `akua-dev/akuapkg`. The Akua platform CLI is a separate artifact named `akua`; do not publish or document a platform CLI release from this repository.

The canonical distribution coordinates are:

- Repository: `https://github.com/akua-dev/akuapkg`
- GitHub releases: `https://github.com/akua-dev/akuapkg/releases`
- Homebrew formula: `akua-dev/tap/akuapkg`
- Container: `ghcr.io/akua-dev/akuapkg`

As of August 14, 2026, `v0.9.3` is a source tag without a GitHub Release. Do not describe that version as published or installable from release assets until the release workflow succeeds.

`.github/workflows/release.yml` is the only release workflow. It builds the immutable tag, creates the GitHub Release, and pushes the container. There is no separate npm publish workflow (akua-dev/cnap#2348): `@akua-dev/sdk` is consumed directly inside the `akua-dev/cnap` monorepo via its Bun workspace, and the napi-based `@akua-dev/native*` packages existed only to feed that npm publish step. Existing versions already on the npm registry are left in place (not unpublished), but no new versions are published there.

Homebrew is explicitly outside the release workflow. Formula ownership belongs to `akua-dev/cli` and the dedicated `akua-dev/homebrew-tap` lane; Akuapkg does not write, dispatch, or claim ownership of that formula.

## Normal releases

Land and verify release changes on `main`, batch them, and push one immutable
`v<semver>` tag only when a human explicitly requests the release. The tag triggers
the build workflow, which derives the workspace and package version from the tag;
the committed `Cargo.toml` version remains a development placeholder. Stable tags
update the container's `latest` tag. Prerelease tags mark the GitHub Release as a
prerelease and do not update the container's `latest` tag.

Do not delete and re-push a release tag. If a tagged run fails, use the SHA-bound
recovery path below after correcting and reviewing the workflow on `main`.

## Recovering a failure before GitHub Release creation

If a tag run fails before `github-release`, first correct and review the workflow on
`main`. Do not move the tag, upload assets by hand, or rerun the outdated tagged
workflow. Dispatch the corrected workflow from its exact reviewed commit. Bind the
run to both the immutable tag commit and the reviewed workflow commit, and explicitly
authorize creation of the still-missing Release:

```sh
reviewed_workflow_commit=$(gh api repos/akua-dev/akuapkg/commits/main --jq '.sha')

gh workflow run release.yml \
  --repo akua-dev/akuapkg \
  --ref main \
  -f tag=v0.9.5 \
  -f expected-source-commit=be62c125e9816aa1a440de9afecb4b6fc9a8d487 \
  -f expected-workflow-commit="$reviewed_workflow_commit" \
  -f create-missing-release=true \
  -f dry-run=false
```

The dispatch rebuilds every artifact from the tag. It creates the Release only if it
is still absent; if a Release already exists, it verifies it and never uploads or
replaces assets. Keep `create-missing-release` false for ordinary recovery of an
existing immutable Release.
