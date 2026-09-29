# @akua-dev/sdk -- Akua Package SDK

Programmatic access to Akua package/render/export/check/lint/verify behavior from Node-compatible runtimes.

This is the Akua Package SDK, not the Akua Cloud REST SDK. It works without an Akua Cloud account and does not call hosted Akua APIs.

---

## Install

Akuapkg no longer publishes new SDK versions to npm (akua-dev/cnap#2348); `@akua-dev/sdk` on npm is frozen at its last published version and receives no further updates. To use the current SDK, build it from source:

```sh
git clone https://github.com/akua-dev/akuapkg
cd akuapkg
mise exec -- task sdk:build
```

`package.json`'s `exports` resolve to the built `dist/`, not `src/`: a Node.js consumer cannot type-strip a `.ts` file under `node_modules`, so `dist/` (both `*.js` and `*.d.ts`) stays the package's public contract. Workspace consumers (e.g. `akua-dev/cnap`) build `dist/` hermetically via Bazel and commit the result as a drift-checked artifact.

The actively maintained distribution channel for Akuapkg is the `akuapkg` CLI binary, installed via the [install script](https://cli.akua.dev/install) or [GitHub Releases](https://github.com/akua-dev/akuapkg/releases).

ESM-only. The package supports Node 22+ and Bun 1.3+ today. Browser support is deferred because this package depends on the host-side `@akua-dev/native` NAPI addon.

---

## Quickstart

```ts
import { Akua } from '@akua-dev/sdk';

const akua = new Akua();

const summary = await akua.render({
  package: './package.k',
  out: './deploy',
});

console.log(summary.manifests, summary.hash);

const inputSchema = await akua.export({
  package: './package.k',
  format: 'openapi',
});

console.log(inputSchema.openapi);
```

---

## Runtime Contract

`@akua-dev/sdk` dispatches every method through `@akua-dev/native`, the per-platform NAPI addon. The SDK does not spawn the `akua` binary, does not look for an `akua` executable on `$PATH`, and does not expose a binary-path option on `new Akua()`.

The native addon embeds the same Rust core used by the CLI, plus the render worker and engine WebAssembly modules needed for supported package operations.

```
Akua method -> @akua-dev/native (NAPI) -> akua core / render worker / engine modules
```

`AkuaOptions` is currently reserved for future configuration. Construct the client with `new Akua()`.

---

## Shipped API

The package currently exports the `Akua` class, SDK error classes, validation helpers, and generated TypeScript types. Higher-level namespace clients for deploy, policy, audit, hosted documents, or Akua Cloud REST APIs are not part of `@akua-dev/sdk`.

Embedders that only need the package command dispatcher can import the synchronous `execute` function from `@akua-dev/sdk/execute`. That entry point omits the full schema-validation client and accepts `binName` so nested help can render an invocation such as `akua pkg`.

| Method | Returns | Notes |
|---|---|---|
| `execute(args, options?)` | `number` | Runs any package CLI command in-process. Set `options.binName` to the parent command path, such as `akua pkg`, so help and usage text match the embedding CLI. |
| `version()` | `VersionOutput` | SDK and native version information. |
| `whoami()` | `WhoamiOutput` | Mirrors `akuapkg whoami`. |
| `render(opts)` | `RenderSummary` | Executes an on-disk Package and writes rendered YAML files to `out`. |
| `renderSource(opts)` | `string` | Executes Package source or a Package file and returns raw rendered YAML. |
| `export(opts)` | `Record<string, unknown>` | Returns the Package `Input` schema as JSON Schema or OpenAPI. |
| `check(opts)` | `CheckOutput` | Syntax, type, dependency, and lockfile checks. |
| `lint(opts)` | `LintOutput` | KCL and package linting. |
| `fmt(opts)` | `FmtOutput` | Formats KCL sources, or reports changes with `check: true`. |
| `inspect(opts)` | `InspectOutput` | Package metadata and option information. |
| `inspectOciPackage(opts)` | `OciPackageInspectOutput` | Pulls a published Akua Package through the native addon and returns verified digests, package metadata, and input schema without extracting to disk. |
| `tree(opts)` | `TreeOutput` | Dependency tree from `akua.toml` and `akua.lock`. |
| `diff(before, after)` | `DirDiff` | Structural diff between two rendered manifest directories. |
| `add(name, opts)` | `AddOutput` | Adds a dependency to `akua.toml`. |
| `vendorAdd(name, opts)` | `VendorAddOutput` | Materializes a declared dependency into `.akua/vendor/<name>`. |
| `vendorCheck(opts)` | `VendorCheckOutput` | Checks vendor-tree drift. |
| `vendorList(opts)` | `VendorListOutput` | Lists vendored dependencies and orphaned entries. |
| `verify(opts)` | `VerifyOutput` | Verifies workspace lockfile integrity and configured signing metadata. |

Verbs that do not have SDK methods yet remain CLI-only. Use the `akua` binary directly for those workflows until NAPI bindings and SDK methods ship.

---

## Render And Export

`render(opts)` runs the Package program. It invokes supported engines through the native addon, writes deploy-ready YAML files to `opts.out` unless `dryRun` is set, and returns a compact `RenderSummary`:

```ts
const summary = await akua.render({
  package: './package.k',
  inputs: './inputs.yaml',
  out: './deploy',
  dryRun: false,
});

console.log(summary.files);
```

`renderSource(opts)` also runs the Package program, but returns raw multi-document YAML as a string. Pass either `source` for in-memory KCL or `package` for a file path:

```ts
const yaml = await akua.renderSource({
  source: `
schema Input:
    name: str = "demo"

resources = []
`,
  inputs: { name: 'checkout' },
});
```

`export(opts)` does not render resources. It reads the Package `Input` schema and returns either JSON Schema 2020-12 or an OpenAPI 3.1 document:

```ts
const jsonSchema = await akua.export({
  package: './package.k',
  format: 'json-schema',
});

const openapi = await akua.export({
  package: './package.k',
  format: 'openapi',
});
```

Use `render` or `renderSource` when you need rendered Kubernetes resources. Use `export` when you need the input contract for forms, validation, or documentation.

---

## Inspect published packages

`inspectOciPackage(opts)` fetches a published Akua Package artifact from an OCI registry, verifies the layer digest declared by the manifest, and inspects the package tarball in memory. Use it from backend services that need package metadata before creating an import, install, or validation record.

```ts
const published = await akua.inspectOciPackage({
  ociRef: 'oci://ghcr.io/acme/packages/codezero',
  tag: '1.2.3',
  auth: {
    'ghcr.io': { token: process.env.GHCR_TOKEN! },
  },
});

console.log(published.layer_digest);
console.log(published.input_schema);
```

The method returns `OciPackageInspectOutput`, including `manifest_digest`, `layer_digest`, package name and version metadata from `akua.toml`, and the JSON Schema for the package `Input`. It does not extract the package to disk and does not spawn the `akua` CLI.

For private registries, pass credentials explicitly in `auth`, keyed by registry host. Omit `auth` for anonymous public-registry inspection. The SDK method does not read `$XDG_CONFIG_HOME/akua/auth.toml`, `~/.docker/config.json`, or other ambient credential files.

---

## Credentials

Akua keeps credentials explicit at the SDK boundary. Methods that fetch private remotes accept an `auth` map at the call site.
For `vendorAdd`, key credentials by URL prefix:

```ts
await akua.vendorAdd('upstream', {
  auth: {
    'git.example.com/team-a': {
      username: 'team-a',
      password: process.env.GIT_TOKEN!,
    },
  },
});
```

For `inspectOciPackage`, key credentials by registry host:

```ts
await akua.inspectOciPackage({
  ociRef: 'oci://ghcr.io/acme/packages/codezero',
  tag: '1.2.3',
  auth: {
    'ghcr.io': { token: process.env.GHCR_TOKEN! },
  },
});
```

The SDK does not read ambient credential files such as `~/.netrc`, `$XDG_CONFIG_HOME/akua/auth.toml`, or `~/.docker/config.json`.

That explicit credential rule is separate from HTTPS trust configuration. Native Git fetches preserve the process's configured CA bundle from `GIT_SSL_CAINFO` or Git's `http.sslCAInfo` for both initial clones and cached-repository refreshes. Certificate verification is always forced on despite `GIT_SSL_NO_VERIFY` or `http.sslVerify=false`, and other ambient Git HTTP options such as extra headers and proxy credentials are not copied into the fetch connection.

---

## Errors

SDK methods throw `AkuaError` subclasses built from the structured error emitted by the native layer. User errors, rate limits, timeouts, and system failures keep their stable Akua error codes so callers can branch without parsing prose.

```ts
import { AkuaRateLimitedError, AkuaUserError } from '@akua-dev/sdk';

try {
  await akua.render({ package: './package.k', out: './deploy' });
} catch (err) {
  if (err instanceof AkuaRateLimitedError) {
    // retry later
  } else if (err instanceof AkuaUserError) {
    console.error(err.structured?.code);
  } else {
    throw err;
  }
}
```

---

## Related References

- [CLI reference](cli.md)
- [CLI contract](cli-contract.md)
- [Package format](package-format.md)
- [Security model](security-model.md)
