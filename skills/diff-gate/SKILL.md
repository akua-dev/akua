---
name: diff-gate
description: Show exactly what a change does to a Package's rendered Kubernetes output and gate it in CI - dependency upgrades, Kubernetes version switches, CRD updates, input changes. Use when reviewing a Renovate or Dependabot bump of a chart or CRD, adding a CI check that surfaces manifest changes, or answering "what does this upgrade change?"
license: Apache-2.0
---

# Diff-gate a change

`akuapkg diff BEFORE AFTER` compares two rendered directories and exits 1
when they differ. Typed resources catch breaking schema changes before the
diff: a dependency bump that removes a field or an API fails the render.

## Steps

1. Render the base revision:

   ```sh
   git worktree add /tmp/base origin/main
   (cd /tmp/base && akuapkg render --out /tmp/before)
   ```

2. Render the change:

   ```sh
   akuapkg render --out /tmp/after
   ```

   A failure here is the first finding. For a `k8s` or CRD bump, a type
   error means the Package uses something the new version removed.

3. Compare:

   ```sh
   akuapkg diff /tmp/before /tmp/after
   akuapkg diff /tmp/before /tmp/after --json
   ```

   The JSON lists `added`, `removed`, `changed` (with before and after
   digests) and `unchanged` files.

4. In CI, fail or request review when the diff is non-empty, and attach the
   text output to the pull request. Also run `akuapkg lock --check` and
   `akuapkg verify`, so a bump that forgot to re-lock fails.

## Notes

- Charts that use Helm's random functions (`randAlphaNum`, `genCA`) differ
  on every render; exclude their generated files or review them by kind.
- Keep the inputs fixed between the two renders; pass the same `--inputs`.

## References

- [docs/typed-resources.md](../../docs/typed-resources.md)
- [docs/cli-contract.md](../../docs/cli-contract.md#2-exit-codes)
