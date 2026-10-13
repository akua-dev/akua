# `@akua-dev/sdk`

`@akua-dev/sdk` is the akuapkg host itself (`host/` in this repository): the
TypeScript package that the `akuapkg` executable and the `akua` CLI are
built from. Embed it when your own Bun program needs to render Packages or
read their schemas. It is written with [Effect](https://effect.website) and
runs on Bun 1.3 or later.

This is not a client for any hosted API; it works offline on local files.

## Getting it

New versions are not published to npm. The `@akua-dev/sdk` versions on npm
are frozen, come from an earlier implementation and do not match this page.
Use the package from source:

- inside a Bun workspace that contains this repository, depend on it as
  `"@akua-dev/sdk": "workspace:*"`, as `cli/` does;
- or copy `host/` into your workspace at the release tag you want.

`package.json` exports point at the TypeScript sources, which Bun loads
directly. Rendering in-process needs the Wasmtime addon and the precompiled
engines, which Bazel builds (see [building.md](building.md)); rendering
through a child process needs only an `akuapkg` executable.

## Entry points

| Import | Use it for |
|---|---|
| `@akua-dev/sdk/process` | Running the `akuapkg` executable in a child process from a long-lived service: `renderWithExecutable`, `checkWithExecutable`, `exportWithExecutable`, `treeWithExecutable`, `inspectOciWithExecutable`, `vendorAddWithExecutable` |
| `@akua-dev/sdk/contract` | The output contract as Effect `Schema`s: `RenderSummary`, `CheckOutput`, `ExportOutput`, `TreeOutput`, `StructuredError`, and the exit codes |
| `@akua-dev/sdk/render` | `renderPackage`, the in-process render pipeline (needs the sandbox services) |
| `@akua-dev/sdk/cli` | The command tree: `runAkuapkg`, and `runAkuapkgWith`, which the `akua` CLI uses to serve `akua pkg` in-process |

## Rendering untrusted Packages from a service

Prefer `@akua-dev/sdk/process` in a service. The child process holds the
render's CPU and memory, a host-side bug cannot take your process down, and
`timeout` is a wall-clock deadline that kills the child. `command` is the
argument vector that starts the executable, so you can wrap it in an OS
sandbox:

```ts
import { renderWithExecutable } from "@akua-dev/sdk/process"

const render = renderWithExecutable({
  command: ["/usr/local/bin/akuapkg"],
  timeout: "60 seconds",
  packagePath: "./package.k",
  inputsPath: "./inputs.yaml",
  out: "./deploy",
  strict: true
})
```

`render` is an `Effect` that succeeds with the `RenderSummary` and needs the
platform's `FileSystem`, `Path` and `ChildProcessSpawner` services; on Bun,
provide them with `BunServices.layer` from `@effect/platform-bun`.

A failure the executable reports arrives as `AkuapkgFailure`, carrying the
structured error (`code`, `message`, `path`, `suggestion`, `docs`) and the
exit code from the [CLI contract](cli-contract.md). Anything else, such as a
missing executable or output that does not decode, is
`AkuapkgProcessError`.

## Related topics

- [CLI contract](cli-contract.md): the JSON output and error shapes
- [Security model](security-model.md): why a child process for services
- [Architecture](architecture.md)
