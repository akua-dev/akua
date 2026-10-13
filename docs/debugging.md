# Debugging a render

When `akuapkg render` fails or produces something unexpected, start from the
error code: every failure has one, and each code has a page at
[docs.akua.dev/akua/errors](https://docs.akua.dev/akua/errors) with causes
and fixes.

## Narrow it down

```sh
akuapkg check                        # akua.toml, akua.lock and package.k parse and resolve
akuapkg lint                         # KCL syntax and imports only
akuapkg render --dry-run             # evaluate everything, write nothing
akuapkg render --stdout              # print the manifests instead of writing files
akuapkg render --json --debug        # add the resources before YAML normalization
```

`--debug` puts the raw evaluation result in the JSON output
(`evalResult`), which helps when a value looks different in the YAML than in
KCL.

## Common failures

| Code | Usually means | Next step |
|---|---|---|
| `E_RENDER_KCL` | a type error, a failed `check:` or `assert`, or an error from Helm or Kustomize | read the `File package.k:LINE:COL` line; for engine errors the message names `helm` or `kustomize-engine` |
| `E_DEP_RESOLVE` | a dependency could not be fetched, or its bytes do not match `akua.lock` | check the version exists; run `akuapkg update --dep NAME` if the change is intended |
| `E_LOCK_DRIFT`, `E_CRDS_STALE` | `akua.toml`, `akua.lock` or `.akua/crds/` disagree | run `akuapkg lock` and commit the result |
| `E_RENDER_BUDGET_DEADLINE` | the render ran out of CPU budget (exit 6) | look for a runaway comprehension, or an unusually large chart or overlay |
| `E_RENDER_BUDGET_MEMORY` | a sandbox hit its memory cap, or an engine returned more than 64 MiB | reduce what one call renders |
| `E_PATH_ESCAPE` | a symlink or path leaves the Package directory | replace the symlink with the file, or declare the content as a dependency |

## Engine errors

Helm and Kustomize errors are passed through with their original text,
prefixed with the engine:

```text
error[E_RENDER_KCL]: kustomize-engine: kustomize build: accumulating resources: ...
```

Remember what the engines cannot do inside the sandbox (see
[embedded-engines.md](embedded-engines.md)): no remote Kustomize bases, no
Helm `lookup` against a cluster, no plugins. An error mentioning `git`,
`dial tcp` or a DNS lookup means the overlay or chart tried to reach the
network.

## Reproducing a failure

A failing render depends only on the Package directory, the inputs file,
`akua.lock` and the akuapkg version (`akuapkg version`). To report or bisect
a failure, copy those and render with `--offline` after one online run, so
the cache holds every dependency. When you open an issue, include the
command, the full error and the akuapkg version.

## Wasm traps

A message starting `trapped: error while executing at wasm backtrace` means
a guest stopped abnormally instead of reporting an error. This is a bug in
akuapkg, not in your Package, even when your Package triggered it. Please
report it with the Package (or a reduced copy) that reproduces it.
