# Repository guidance

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## Release contract

- `scripts/release.ts` is the source of truth for target IDs, Bun targets,
  archive names, executable names, SHA-256 files, and release manifests.
- Every target must produce an archive containing only the `akua` executable
  (the package toolchain is embedded in it), an adjacent `.sha256`, an entry in
  `akua-v<version>-checksums.txt`, and a native install smoke covering both
  cloud commands and a
  real `akua pkg init` → `check` → `render` → `inspect` flow.
- Keep the tested matrix aligned across the script and workflows: macOS
  arm64/x64, glibc Linux arm64/x64, and Windows x64. Use baseline Bun targets
  for Linux x64 and Windows x64.
- Release assets are immutable. Never add clobber/force upload behavior; the tap
  handoff runs only after published assets are downloaded and re-verified.

## Ownership boundaries

- This CLI repository owns the canonical `akua` executable and release artifacts.
- `skills/effect-v4/SKILL.md` is the only repository-local skill; it governs
  production CLI and script changes.
- Homebrew rendering, formula verification, and publication belong to the
  canonical Main publisher. See [../../docs/releasing.md](../../docs/releasing.md);
  the public tap is a source view, never an independent writer.

## Validation

Run `bun run check` and `bun run generate:check` for every change that touches the public API surface. Release
changes also require the focused release/workflow tests and a current-host
compiled archive smoke through `bun run release:smoke`.

## Public API command contract

- The API producer's OpenAPI document is the source of truth for public routes,
  request/response schemas, operation IDs, authentication, and error shapes.
  Its committed snapshot is `src/generated/openapi-public.json`; the canonical
  monorepo owns regeneration and drift checks. Do not duplicate
  endpoint definitions, request types, or status-error maps in handwritten CLI
  code.
- Generate the request contract (`src/generated/contract.gen.ts`) from that
  document; commands, arguments, and flags are derived from it at runtime by
  the same functions the generator verifies (`src/api/inputs.ts`). Keep
  handwritten code limited to generic command parsing, request assembly,
  authentication and workspace context, rendering, and terminal wiring.
- Public commands remain provider-neutral. Do not add commands, flags, file
  readers, environment variables, or credential loaders for a particular cloud
  provider, cluster vendor, or product integration. Users pass provider-specific
  data only through the public API's generated request body, for example via
  `akua secrets create --input -`.
- The generic executor accepts only generated path, query, header, and body
  inputs. It must reject unknown fields before sending a request, redact
  sensitive input in diagnostics, and pass API error bodies through unchanged
  in JSON output.
- Generation must be deterministic and fail on skipped public operations,
  unrepresented request bodies, non-JSON error bodies, unknown stream formats,
  or flag collisions. Add support to
  the OpenAPI producer or generator; never hide a contract gap with a manual
  endpoint implementation.

## Effect v4 production code

Before changing production CLI code in `src/` or `scripts/`, load
`skills/effect-v4/SKILL.md`. Keep command flow on the audited Effect v4
services/layers and tagged-failure model; only the binary terminal owns the
runtime/fiber handoff. Before handoff, run the skill's source scan, focused Bun
tests, and `bun run check`; inspect each source scan hit rather than treating
the command as a cosmetic check.

- All production control flow and recoverable failure paths use
  `Effect.Effect` with a typed error channel. Do not use raw `throw`, native
  Promise control flow, `async`, `await`, or untyped failure helpers in `src/`
  or `scripts/`.
- Pure immutable data, types, and constants may remain plain TypeScript. Do not
  add Effect imports to a module that cannot perform work or fail.
- Keep direct host I/O inside named live service adapters. Only minimal
  executable `import.meta.main` guards may own runtime/fiber handoff.
- Preserve the structural invariant tests whenever this boundary changes. A
  source scan is a review aid, not a substitute for the invariant test.

## Maintaining this file

Keep this file concise and durable. Add only repository-wide rules that are not
obvious from the code, and prefer pointers to authoritative files and commands
over duplicated implementation detail.
