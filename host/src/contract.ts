import { Runtime, Schema } from "effect"
import type { HostError } from "./errors"

/**
 * The CLI contract (docs/cli-contract.md): typed exit codes and one
 * structured error shape on stderr. Codes are the stable identifiers callers
 * match on; messages are for humans.
 */
export const ExitCode = {
  success: 0,
  userError: 1,
  systemError: 2,
  policyDeny: 3,
  rateLimited: 4,
  needsApproval: 5,
  timeout: 6
} as const

export const StructuredError = Schema.Struct({
  level: Schema.Literals(["error", "warn"]),
  code: Schema.String,
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
  suggestion: Schema.optionalKey(Schema.String),
  docs: Schema.optionalKey(Schema.String)
})
export type StructuredError = typeof StructuredError.Type

/** What `render --json` prints: identical shape and hash to the previous akuapkg release. */
export const RenderSummary = Schema.Struct({
  format: Schema.Literal("raw-manifests"),
  target: Schema.String,
  manifests: Schema.Number,
  hash: Schema.String,
  files: Schema.Array(Schema.String)
})
export type RenderSummary = typeof RenderSummary.Type

/** `RenderSummary` as printed: an empty `files` is left out, as the previous release did. */
export const RenderSummaryJson = Schema.Struct({
  ...RenderSummary.fields,
  files: Schema.optionalKey(Schema.Array(Schema.String))
})

export const renderSummaryJson = ({ files, ...summary }: RenderSummary) =>
  files.length === 0 ? summary : { ...summary, files }

/** What `check --json` prints; a failed check exits 1 with this on stdout. */
export const CheckOutput = Schema.Struct({
  status: Schema.Literals(["ok", "fail"]),
  checks: Schema.Array(Schema.Struct({
    name: Schema.String,
    ok: Schema.Boolean,
    error: Schema.optionalKey(Schema.String),
    issues: Schema.optionalKey(Schema.Array(Schema.Struct({
      level: Schema.String,
      code: Schema.String,
      message: Schema.String,
      file: Schema.optionalKey(Schema.String),
      line: Schema.optionalKey(Schema.Number),
      column: Schema.optionalKey(Schema.Number)
    })))
  }))
})
export type CheckOutput = typeof CheckOutput.Type

/** What `export --json` prints: the Package's `Input` schema. */
export const ExportOutput = Schema.Struct({
  format: Schema.Literals(["json-schema", "openapi"]),
  schema: Schema.Record(Schema.String, Schema.Unknown)
})
export type ExportOutput = typeof ExportOutput.Type

/** What `tree --json` prints. */
export const TreeOutput = Schema.Struct({
  package: Schema.Struct({ name: Schema.String, version: Schema.String, edition: Schema.String }),
  dependencies: Schema.Array(Schema.Struct({
    name: Schema.String,
    source: Schema.String,
    source_ref: Schema.String,
    version: Schema.optionalKey(Schema.String),
    locked: Schema.optionalKey(Schema.Struct({
      digest: Schema.String,
      signature: Schema.optionalKey(Schema.String),
      replaced_by: Schema.optionalKey(Schema.String)
    }))
  }))
})
export type TreeOutput = typeof TreeOutput.Type

/**
 * A failure the CLI reports: the structured error plus its exit code. The CLI
 * prints the structured error itself, so the runtime only applies the exit
 * code and does not log again.
 */
export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  error: StructuredError,
  exitCode: Schema.Number
}) {
  override get message() {
    return `${this.error.code}: ${this.error.message}`
  }
  override get [Runtime.errorExitCode]() {
    return this.exitCode
  }
  override get [Runtime.errorReported]() {
    return false
  }
}

/**
 * A verb that reported its own verdict on stdout and ends with `code`:
 * `check` finding issues, `fmt --check` finding changes. Nothing more is
 * printed on stderr.
 */
export class ExitWith extends Schema.TaggedError<ExitWith>()("ExitWith", {
  exitCode: Schema.Number
}) {
  override get [Runtime.errorExitCode]() {
    return this.exitCode
  }
  override get [Runtime.errorReported]() {
    return false
  }
}

export const fail = (code: string, message: string, exitCode: number, path?: string, suggestion?: string) =>
  new CliFailure({
    error: {
      level: "error",
      code,
      message,
      ...(path === undefined ? {} : { path }),
      ...(suggestion === undefined ? {} : { suggestion }),
      docs: `https://cli.akua.dev/errors/${code}`
    },
    exitCode
  })

export const usageFailure = (message: string) => fail("E_INVALID_FLAG", message, ExitCode.userError)
export const packageMissing = (path: string) =>
  fail(
    "E_PACKAGE_MISSING",
    "Package.k not found",
    ExitCode.userError,
    path,
    "pass the Package.k path explicitly or cd to its directory"
  )
const ioFailure = (message: string) => fail("E_IO", message, ExitCode.systemError)

/** A render failure under `code`: running out of the CPU budget is a timeout. */
const budgetFailure = (code: string, message: string) =>
  fail(code, message, code === "E_RENDER_BUDGET_DEADLINE" ? ExitCode.timeout : ExitCode.userError)

/** Map a host failure onto the contract's codes and exit codes. */
export const toCliFailure = ({ reason: error }: HostError): CliFailure => {
  switch (error._tag) {
    case "PathEscape":
      return fail("E_PATH_ESCAPE", error.message, ExitCode.userError, error.path)
    case "GuestFailure":
      return budgetFailure(error.budgetCode ?? "E_RENDER_KCL", error.message)
    case "PluginError":
      return budgetFailure(error.code ?? "E_RENDER_KCL", `${error.plugin}: ${error.message}`)
    case "RenderError":
      return fail("E_RENDER_KCL", error.message, ExitCode.userError)
    case "ProgramShape":
      return fail("E_PACKAGE_PARSE", error.message, ExitCode.userError)
    case "PackageMissing":
      return packageMissing(error.path)
    case "InputsParseError":
      return fail("E_INPUTS_PARSE", error.message, ExitCode.userError, error.path)
    case "ManifestInvalid":
      return fail(error.code, error.message, ExitCode.userError, error.path)
    case "LockInvalid":
      return fail("E_LOCK_PARSE", error.message, ExitCode.userError, error.path)
    case "DependencyUnresolved":
      return fail(error.code, error.message, ExitCode.userError)
    case "WasmLoadError":
      // Bun loads an embedded addon from a copy in TMPDIR; its own error
      // names only the embedded path.
      return ioFailure(
        error.module === "wasm-sandbox"
          ? `cannot load the sandbox addon; is TMPDIR a writable directory? ${String(error.cause)}`
          : `cannot load ${error.module}: ${String(error.cause)}`
      )
    case "IoError":
      return ioFailure(error.message)
  }
}
