---
name: test-and-lint
description: Set up and run akuapkg's checks for a Package - check, lint, fmt, assertion tests, golden snapshot tests, lockfile and signature verification - locally and in CI. Use when bootstrapping CI for a Package repository, adding tests to an untested Package, configuring a pre-commit hook, or when asked to "add tests" or "set up CI gates".
license: Apache-2.0
---

# Tests and checks for a Package

## The commands

| Command | Catches |
|---|---|
| `akuapkg fmt --check` | unformatted `package.k` |
| `akuapkg lint` | KCL syntax and import errors |
| `akuapkg check` | `akua.toml`, `akua.lock` and `package.k` problems |
| `akuapkg lock --check` | `akua.lock` or `.akua/crds/` out of date with `akua.toml` |
| `akuapkg verify` | undeclared or unlocked dependencies, path drift, missing signatures under strict signing |
| `akuapkg test` | failing `assert` or `check:` in `test_*.k` / `*_test.k` |
| `akuapkg test --golden` | rendered output that differs from `snapshots/` |

All are embedded in akuapkg; nothing else needs installing.

## Steps

1. Add assertion tests. A test file is a standalone KCL program; it does not
   see the Package's dependencies:

   ```kcl
   # test_naming.k
   _name = "hello"
   assert len(_name) <= 63, "names fit a DNS label"
   ```

2. Add golden tests. Put one or more `inputs*.yaml` files next to
   `package.k` (for example `inputs.example.yaml`, `inputs.prod.yaml`), then
   record the snapshots and commit `snapshots/`:

   ```sh
   akuapkg test --update-snapshots
   ```

3. Run everything as CI would:

   ```sh
   akuapkg fmt --check
   akuapkg check
   akuapkg lock --check
   akuapkg verify
   akuapkg test --golden
   ```

   Each exits non-zero on failure; with `--json` each prints one JSON
   result.

4. When a golden test fails, render the same inputs and compare with the
   snapshot, then decide whether the change is intended:

   ```sh
   akuapkg render --inputs inputs.example.yaml --out /tmp/render
   akuapkg diff snapshots/inputs.example /tmp/render
   ```

   If it is, run `akuapkg test --update-snapshots` and commit the new
   snapshots with the change that caused them.

## Notes

- A chart that uses Helm's `randAlphaNum` or `genCA` renders differently
  every time; golden tests cannot pin it.
- Type errors in `package.k` fail `render` and the golden tests; they are
  the cheapest test you have, so type resources instead of writing dicts.

## References

- [docs/package-format.md](../../../../docs/package-format.md#tests)
- [docs/cli-contract.md](../../../../docs/cli-contract.md)
