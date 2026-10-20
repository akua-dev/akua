# Akua Cloud CLI Architecture

Status: local authentication and executable generated public API commands.

## Decisions And Non-Goals

- Binary: `akua`.
- Runtime: Bun and TypeScript.
- Repository: the `packages/cli/` workspace of `akua-dev/akua` (canonical history in the Akua monorepo at `oss/akua/packages/cli`), released on the package toolchain's version in one `v<version>` release with it.
- Packaging: Bun self-contained executable via `bun build --compile`.
- API source of truth: the Akua monorepo's `docs/openapi-public.json` (Bazel-generated; committed here as `src/generated/openapi-public.json`; no production fetch).
- First release: local auth/config plus a provider-neutral public API command
  surface generated from OpenAPI.
- Compatibility: no `cnap` binary, Go module, config path, env var, or command
  compatibility unless a later captain decision changes this.
- No live infrastructure mutation is required for development or tests.
  OpenAPI generation is hermetic from the committed public spec.

## Current Repo Boundary

The old Go/CNAP implementation is removed from the active build surface. The
new repository shape is:

```text
src/generated/openapi-public.json  public OpenAPI copy (generator input)
scripts/generate-contract.ts     OpenAPI to request-contract generator
scripts/release.ts               release target, packaging, and manifest contract
src/bin/akua.ts                  executable entrypoint
src/cli/                         the effect/cli command tree: auth, workspaces, discovery, API commands
src/api/                         contract types, flag derivation, request validation, HTTP executor
src/runtime/                     output, errors, exit codes, config, live services
src/generated/contract.gen.ts    generated public API request contract
docs/architecture.md             this spec
test/                            Bun tests for CLI, generation, and release contracts
```

## OpenAPI And Command Generation

The CLI is operationId-driven. Every public OpenAPI operation becomes a command
when all of these are true:

- `x-platform-visibility` is `PUBLIC`;
- `operationId` is present;
- HTTP method and path are present;
- tags, summary, operation-level auth requirement, and parameters are copied
  into the command model when present.

The initial command derivation is mechanical:

```text
operationId: workspaces.list
command:     akua workspaces list

operationId: customDomains.delete
command:     akua custom-domains delete

operationId: health
command:     akua health get
```

An operationId segment before the first dot becomes the resource, the next
segment becomes the action, and single-segment operationIds fall back to the
HTTP method as the action. The generator assumes OpenAPI operationIds are
unique; it does not currently enforce uniqueness itself.

`src/generated/contract.gen.ts` is the request side of the public contract as
data: every operation's method, path template, parameters (shared between
operations, not repeated), request body JSON Schema, and whether the success
response is a Server-Sent Events stream, plus the component schemas those
reference (`$ref` into `definitions`). It carries no response schemas: the CLI
renders the JSON the API returns and has no use for decoding it, which keeps
the generated file and the binary small. The generator fails on anything the
CLI cannot represent: a non-JSON request or error body, an unknown stream
format, a request schema Effect cannot import, or two inputs mapping to one
flag.

From that contract the CLI derives, with the same pure functions the generator
verifies (`src/api/inputs.ts`):

- one command per operation, `akua <resource> <action>`;
- a positional argument per path parameter, in template order;
- a typed flag per query parameter, header (except `akua-context`), and
  top-level request body field, across every branch of a union body. Strings,
  numbers, booleans, and enums parse as such; objects, arrays, and mixed unions
  take a JSON value. A flag that would shadow a global flag or another input is
  prefixed with its location (`--query-workspace`);
- the `akua-context` header from `--workspace`, `AKUA_WORKSPACE`, or the saved
  workspace (in that order) for every operation that declares it.

`--input -` or `--input <file>` still takes the whole request as a JSON object
with `path`, `query`, `headers`, and `body` partitions; arguments and flags
override its fields. One generic executor (`src/api/client.ts`) validates the
envelope against the operation's JSON Schema, imported with Effect's
`SchemaRepresentation.fromJsonSchemaDocument`, rejects unknown fields, builds
the request, and sends it. Request values are never included in diagnostics.
Do not add resource- or provider-specific overlays.

Generation tasks:

```sh
bun run generate                         # regenerate contract.gen.ts from the committed copy
bun run generate:check                   # fails on drift
```

Any public OpenAPI update in the canonical monorepo must regenerate and review
CLI artifacts through its owning Bazel generator before it is accepted; its
CI enforces generated-artifact drift checks.

## API, Auth, And Config Model

Default API base URL:

```text
https://api.akua.dev/v1
```

Authentication:

- Browser/device login starts with `akua auth login`. It prints the verification
  URL and user code, attempts to open the browser, and stores the resulting
  access token only after authorization completes.
- `akua auth login --no-browser` prints the same verification instructions
  without attempting to open a browser.
- `akua auth login --token <token>` stores a supplied token without a browser
  flow.
- `AKUA_API_TOKEN` is the noninteractive credential environment variable and
  takes precedence over a stored token.

Configuration defaults to the Akua namespace:

```text
~/.config/akua/config.json
```

`AKUA_CONFIG_DIR` selects a separate config directory; otherwise
`XDG_CONFIG_HOME` replaces `$HOME/.config`. Empty values count as unset.
See [Keep separate logins](../README.md#keep-separate-logins) for precedence
and examples. Only the selected file is read, even if it doesn't exist.

The implemented config file is JSON. It stores a `token` string and the
`workspace` (`{ "id", "name" }`) saved by `akua workspaces use`, while
preserving unrelated keys. Writes create the selected directory with
user-only `0700` permissions and `config.json` with user-only `0600`
permissions.

The implemented local auth/config surface is:

```sh
akua auth login                  # browser/device login
akua auth login --no-browser     # device login without launching a browser
akua auth login --token <token>  # save a token in the selected config file
akua auth status                 # show the auth source and selected config path
akua auth logout                 # remove only the stored config token
```

`auth login` requires `AKUA_CONFIG_DIR`, `XDG_CONFIG_HOME`, or `HOME` to locate
the config file. `auth status` shows the selected path in human output and
`data.config_path` in JSON output. It honors `AKUA_API_TOKEN` even when
`HOME` is unset, and otherwise reads the
stored token. `auth logout` leaves `AKUA_API_TOKEN` untouched and reports env
auth as still active when that variable is set.

## Output And UX Modes

The default output mode is adaptive:

- `human`: interactive TTY without automation or coding-agent signals;
- `agent`: `AGENT` names/flags, known coding-agent env vars, CI env vars, or
  non-TTY stdout;
- `json`: explicit `--json`, `--output json`, `-o json`, or
  `AKUA_OUTPUT=json`;
- `quiet`: explicit `--quiet`, `-q`, `--output quiet`, `-o quiet`, or
  `AKUA_OUTPUT=quiet`.

`--output`/`-o` and `AKUA_OUTPUT` accept only `human`, `agent`, `json`, and
`quiet`. `--json` and `--quiet` take precedence over other output mode signals.

Agent mode follows AXI patterns studied from `https://axi.md/` and the public
`gh-axi` example:

- compact structured output, currently TOON-like text;
- small list schemas by default;
- explicit empty states;
- contextual `next_steps`;
- stdout for success data and structured errors;
- stderr for progress, debug logs, and warnings;
- no spinners or prompts in agent, JSON, quiet, CI, or non-TTY modes;
- unknown routed commands and flags must fail loudly.

Every mode parses with the same effect/cli command tree; only rendering
differs. effect/cli's own output (help, version, completions) is captured so a
usage error in agent or JSON mode is one structured error document, never a
help page followed by an error. A no-args `akua` invocation lists
authentication, discovery, and every generated public resource group;
`akua <resource> --help` lists that resource's actions and
`akua <resource> <action> --help` documents its arguments, flags, and examples
(the flag form first, the `--input` form second). It does not fetch live API
state.

Human output renders list responses as tables (identity, kind, and state
columns first, one timestamp, at most six columns), objects as aligned
key/value lines, timestamps as UTC dates, and log streams as their content
lines. JSON and agent output keep the API body untouched.

The implemented command surface includes generated public operations:

```sh
akua                                      # complete Effect CLI command tree
akua auth login                           # browser/device login
akua auth login --no-browser              # do not launch a browser
akua auth login --token <token>           # save a local API token
akua auth status                          # show effective auth source
akua auth logout                          # remove the saved local API token
akua commands                            # first 20 generated public commands
akua commands --resource workspaces      # resource filter
akua commands --operation-id workspaces.list
akua commands --limit 5                  # positive integer limit
akua workspaces use my-team              # save the workspace (alias: akua workspace switch)
akua workspaces current                  # active workspace and its source
akua clusters create --name demo --region-id reg_123
akua clusters get clu_123                # path parameters are arguments
akua workspaces list --input -           # stdin JSON request
akua machines create --input request.json # file JSON request
akua --help                              # also -h
akua --version                           # also -v or -V
```

## Structured Errors

Errors preserve API envelope details instead of collapsing them into strings:

```json
{
	"error": {
		"type": "validation_error",
		"code": "INVALID_ARGUMENT",
		"status": 400,
		"message": "workspace_id is required",
		"path": ["body", "workspace_id"],
		"request_id": "req_123",
		"next_steps": [{ "command": "akua workspaces list --fields id,name" }]
	}
}
```

The same payload shape is used in JSON and agent modes. Human mode can render a
readable summary, but should include request IDs and next steps.

## Exit Codes

Initial contract:

- `0`: success, including idempotent no-op success;
- `1`: runtime or API error;
- `2`: local usage error, unknown command, unknown flag, invalid local args;
- `3`: authentication/session required;
- `4`: confirmation required or unsafe noninteractive mutation refused;
- `5`: conflict/precondition failure, including `If-Match` mismatch;
- `6`: retryable upstream failure or rate limit.

This can be simplified later, but it must remain deterministic and tested.

## Public-Only First Release

The generated contract contains only operations marked
`x-platform-visibility: PUBLIC`. Internal, admin, preview, trusted-partner, and
private operations must be absent unless a separate build target is deliberately
added later. The CLI has no provider-specific command, flag, credential loader,
or environment variable. Provider-specific values belong to a generated public
API request body.

## Mutations And Safety

For create/update/delete commands:

- destructive actions require explicit resource IDs;
- noninteractive destructive actions require `--yes` or `--force`;
- `Idempotency-Key` is required when the API supports it, generated if omitted,
  and included in structured output;
- `If-Match` must be supported for resources with `etag`;
- `--dry-run`, `--wait`, `--watch`, and structured streaming should be added only
  where the API contract supports them;
- prompts are forbidden in automation modes.

## Packaging

`scripts/release.ts` owns the release matrix and packaging contract. The
published targets are:

- `bun-darwin-arm64` and `bun-darwin-x64`;
- `bun-linux-arm64` and `bun-linux-x64-baseline` (glibc);
- `bun-windows-x64-baseline`.

Each archive contains the single executable `akua` (`akua.exe` on Windows).
Release builds (Bazel, `//bazel:cli_release_archive`) embed the package toolchain (`@akua-dev/sdk` with
the target's Wasmtime addon and precompiled engines), so `akua pkg` runs in
process; a source build runs `akuapkg` from PATH for `akua pkg`. The release
manifest records the embedded toolchain's version. Unix executables have mode
`0755`. Stable names have the form
`akua-v<version>-<os>-<arch>.<archive>`. Every archive has an adjacent
`.sha256`, appears in `akua-v<version>-checksums.txt`, and is described in the release manifest.
The generated Homebrew manifest maps the four macOS/Linux formula selectors to
exact release URLs and SHA-256 digests.

`bun run build:binary` remains the fast host-only developer build. `bun run
release:package` cross-compiles and verifies the whole release directory, while
`bun run release:smoke` extracts and executes the current host archive. CI
builds the candidate once, then macOS arm64/x64, Linux arm64/x64, and Windows x64
hosted runners exercise the cloud CLI and a real `akua pkg init` → `check` →
`render` → `inspect` flow from their extracted archive.

Releases are cut by the Akua monorepo's Main pipeline, never by a workflow
here: it builds the five archives with Bazel, fast-forwards akua-dev/akua's
`main` to the admitted projected commit, creates the immutable `v<version>`
tag and the one release of that version (marked latest) with the package
toolchain's assets, uploads the CLI's thirteen assets beside them, downloads and
re-verifies every asset, then renders both Homebrew formulas from those verified
manifests and non-force publishes the canonical tap source to
`akua-dev/homebrew-tap`. Formula audits and install tests run in the canonical
CI pipeline; the public tap has no workflows or independent writer. The Release
Please files remain as version metadata only. See
[../../../docs/releasing.md](../../../docs/releasing.md).

## Testing Strategy

Current tests cover:

- CLI routing and usage validation for the scaffold commands;
- local token and browser/device login, status, and logout behavior, env
  credential precedence, config preservation, malformed config handling, and
  user-only config permissions;
- output mode detection;
- agent and JSON rendering;
- structured error payloads;
- OpenAPI fetch guard and document shape validation;
- public-only, deterministic operationId collection and typed Effect API
  generation;
- one shared version across `../../Cargo.toml`, the package manifests and the CLI version marker;
- release target naming, archive contents/modes, manifests, checksums, and
  tamper rejection;
- native install-smoke and workflow ordering/permission contracts;
- public install/auth/output/codegen documentation and source-skill ownership.

The canonical monorepo also checks drift across all generated API artifacts.

Future execution slices should add:

- golden command output by mode;
- mocked API calls for workspace, list/get, and operation flows;
- destructive command refusal tests in CI/non-TTY/agent modes;
- broader API-backed generated command integration tests.

## Migration Boundary

This is not a compatibility migration. The old `cnap` CLI can remain available
through historical releases until product documentation points users at the new
`akua` binary. New code should not import or preserve old CNAP module paths,
config paths, env vars, token prefixes, release metadata, or Homebrew formulas.
