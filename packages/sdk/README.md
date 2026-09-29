# @akua-dev/sdk

TypeScript SDK for [Akuapkg](https://github.com/akua-dev/akuapkg). Every verb runs in-process via a bundled native addon (napi-rs) — same `akua-core` the CLI uses, no `akuapkg` binary on `$PATH` required.

## Install

npm publishing is discontinued (akua-dev/cnap#2348); `@akua-dev/sdk` on npm is frozen at its last published version. Build it from source instead:

```sh
git clone https://github.com/akua-dev/akuapkg
cd akuapkg
mise exec -- task sdk:build
```

`package.json`'s `exports` resolve to the built `dist/` (not `src/`): a Node.js consumer cannot type-strip a `.ts` file under `node_modules`, so `dist/` (both `*.js` and `*.d.ts`) stays the package's public contract. Workspace consumers (e.g. `akua-dev/cnap`) build `dist/` hermetically via Bazel and commit the result as a drift-checked artifact.

Node 22+ / Bun 1.3+. Browser support is deferred because the napi addon is host-side; a `wasm32-unknown-unknown` bundle is the path forward. See [docs/spikes/engines-on-wasm32-unknown-unknown.md](../../docs/spikes/engines-on-wasm32-unknown-unknown.md).

`bun add` resolves the right per-platform binary via `optionalDependencies` on `@akua-dev/native-{darwin,linux,win32}-*`. The meta package is `@akua-dev/native`; the SDK depends on it transitively.

## Usage

```ts
import { Akua, AkuaUserError, AkuaRateLimitedError } from '@akua-dev/sdk';

const akua = new Akua();

// Embedders can make package help use their own command path.
await akua.execute(['render', '--help'], { binName: 'akua pkg' });

const yaml = await akua.renderSource({
  packageFilename: 'package.k',
  source: PACKAGE_K_SOURCE,
  inputs: { replicas: 3 },
});
const lint = await akua.lint({ package: './package.k' });
const tree = await akua.tree({ workspace: '.' });
const summary = await akua.render({ package: './package.k', out: './deploy' });
const published = await akua.inspectOciPackage({
  ociRef: 'oci://ghcr.io/acme/packages/demo',
  tag: '1.2.3',
  auth: { 'ghcr.io': { token: process.env.GHCR_TOKEN! } },
});
```

Embedding only the command dispatcher does not require the full validation client:

```ts
import { execute } from '@akua-dev/sdk/execute';

const exitCode = execute(['render', '--help'], { binName: 'akua pkg' });
```

Object-returning methods use typed results, and most validate their result against JSON Schema generated from the same Rust `serde` types the CLI emits. Methods without schema validation still keep explicit contracts: `renderSource()` returns raw rendered YAML as a string, and `add()` returns the native add result.

`inspectOciPackage()` is the SDK-first path for inspecting a published Akua Package artifact. It returns verified OCI digests, package metadata, and the Package `Input` schema without extracting the artifact to disk, spawning the CLI, or reading ambient Docker/Akua credential files.

```ts
try {
  await akua.render({ package: './package.k', out: './deploy' });
} catch (err) {
  if (err instanceof AkuaRateLimitedError) backoff();
  else if (err instanceof AkuaUserError) console.error(err.structured?.code);
  else throw err;
}
```

## Examples

Runnable recipes in [`examples/`](examples/):

```sh
bun run packages/sdk/examples/01-render-source.ts
bun run packages/sdk/examples/02-lint-package.ts
bun run packages/sdk/examples/06-diff-renders.ts
```

## Types + schema are derived, not hand-written

- `src/types/*.ts` — per-type TS from `ts-rs` derives on Rust serde types in `akua-core` + `akuapkg-cli`.
- `src/schemas/akua.json` — a single bundled JSON Schema from `schemars`. Polyglot consumers (Python, Go, agents) validate against the same shape.

Drift is guarded by `task sdk:check` — regenerate + `git diff --exit-code`.

## Repo tasks

```sh
task sdk:gen             # regenerate types + schema from Rust
task sdk:check           # regenerate + diff-check (wired into `task ci`)
task sdk:build           # bun bundle + tsc declarations → packages/sdk/dist/
task sdk:test            # bun test (uses the bundled native addon)
```

## Release flow

SDK versions track the release tag. See [`docs/releasing.md`](../../docs/releasing.md)
for the authoritative release and recovery contract.

## Still coming

- Browser support — bundler-build path requires `helm-engine-wasm` / `kustomize-engine-wasm` to compile to `wasm32-unknown-unknown` (currently `wasm32-wasip1` only). See [docs/spikes/engines-on-wasm32-unknown-unknown.md](../../docs/spikes/engines-on-wasm32-unknown-unknown.md).
