import { type PlatformError, Schema } from "effect"

export class WasmLoadError extends Schema.TaggedError<WasmLoadError>()("WasmLoadError", {
  module: Schema.String,
  cause: Schema.Defect()
}) {}

export class EngineError extends Schema.TaggedError<EngineError>()("EngineError", {
  engine: Schema.String,
  message: Schema.String,
  /** CLI contract code when the failure has a specific one (a sandbox budget). */
  code: Schema.optional(Schema.String)
}) {}

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  plugin: Schema.String,
  message: Schema.String,
  /** CLI contract code when the failure has a specific one (e.g. `E_STRICT_UNTYPED_CHART`). */
  code: Schema.optional(Schema.String)
}) {}

export class RenderError extends Schema.TaggedError<RenderError>()("RenderError", {
  message: Schema.String
}) {}

/** A Package program whose top level is not a mapping with a `resources` sequence. */
export class ProgramShape extends Schema.TaggedError<ProgramShape>()("ProgramShape", {
  problem: Schema.Literals(["NotAMapping", "NoResources", "ResourcesNotASequence"]),
  /** What the top level, or `resources`, is instead (`sequence`, `string`, ...). */
  got: Schema.String
}) {
  override get message() {
    switch (this.problem) {
      case "NotAMapping":
        return `rendered Package must be a top-level mapping; got ${this.got}`
      case "NoResources":
        return "rendered Package must set top-level `resources`; got no such key"
      case "ResourcesNotASequence":
        return `\`resources\` must be a sequence; got ${this.got}`
    }
  }
}

/** A guest stopped by the sandbox (limit hit) or by a trap. */
export class GuestFailure extends Schema.TaggedError<GuestFailure>()("GuestFailure", {
  module: Schema.String,
  reason: Schema.Literals(["OutOfFuel", "MemoryLimit", "Trap"]),
  detail: Schema.String
}) {
  /** What happened, without the module name. */
  get summary() {
    const what = { OutOfFuel: "fuel exhausted", MemoryLimit: "memory cap exceeded", Trap: "trapped" }[this.reason]
    return `${what}${this.detail ? `: ${this.detail}` : ""}`
  }
  /** The CLI contract code of a budget failure. */
  get budgetCode() {
    return this.reason === "OutOfFuel"
      ? "E_RENDER_BUDGET_DEADLINE"
      : this.reason === "MemoryLimit"
      ? "E_RENDER_BUDGET_MEMORY"
      : undefined
  }
  override get message() {
    return `${this.module}: ${this.summary}`
  }
}

/** A Package entry whose real path lies outside the Package (symlink escape). */
export class PathEscape extends Schema.TaggedError<PathEscape>()("PathEscape", {
  path: Schema.String
}) {
  override get message() {
    return `E_PATH_ESCAPE: \`${this.path}\` resolves outside the Package`
  }
}

/** No Package file at `path`. */
export class PackageMissing extends Schema.TaggedError<PackageMissing>()("PackageMissing", {
  path: Schema.String
}) {
  override get message() {
    return `no package file at ${this.path}`
  }
}

/** The inputs file at `path` is not JSON or YAML. */
export class InputsParseError extends Schema.TaggedError<InputsParseError>()("InputsParseError", {
  path: Schema.String,
  message: Schema.String
}) {}

/** `akua.toml` is not a valid manifest; `code` is the contract code (`E_MANIFEST_*`). */
export class ManifestInvalid extends Schema.TaggedError<ManifestInvalid>()("ManifestInvalid", {
  path: Schema.String,
  code: Schema.String,
  message: Schema.String
}) {}

/** `akua.lock` is not a valid lockfile. */
export class LockInvalid extends Schema.TaggedError<LockInvalid>()("LockInvalid", {
  path: Schema.String,
  message: Schema.String
}) {}

/**
 * A dependency could not be resolved. `code` is `E_DEP_RESOLVE`, or a more
 * specific contract code (`E_PATH_ESCAPE`, `E_COSIGN_VERIFY`, ...).
 */
export class DependencyUnresolved extends Schema.TaggedError<DependencyUnresolved>()("DependencyUnresolved", {
  dependency: Schema.String,
  code: Schema.String,
  message: Schema.String,
  /** An OCI registry served other bytes than `akua.lock` pins. */
  drift: Schema.optionalKey(Schema.Boolean)
}) {}

/** A host file the render needed could not be read or written. */
export class IoError extends Schema.TaggedError<IoError>()("IoError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

const HostErrorReason = Schema.Union([
  PackageMissing,
  InputsParseError,
  ManifestInvalid,
  LockInvalid,
  DependencyUnresolved,
  PathEscape,
  RenderError,
  ProgramShape,
  GuestFailure,
  PluginError,
  WasmLoadError,
  IoError
])

/** Everything a render fails with, by `reason`. */
export class HostError extends Schema.TaggedError<HostError>()("HostError", {
  reason: HostErrorReason
}) {
  override get message() {
    return this.reason.message
  }

  /** A render failure as a `HostError`; file-system failures become `IoError`. */
  static from(error: HostError | typeof HostErrorReason.Type | PlatformError.PlatformError): HostError {
    switch (error._tag) {
      case "HostError":
        return error
      case "PlatformError":
        return new HostError({ reason: new IoError({ message: error.message, cause: error }) })
      default:
        return new HostError({ reason: error })
    }
  }
}

/**
 * A file-system failure in the operating system's words, as the previous
 * release printed them (`No such file or directory (os error 2)`); any other
 * error keeps its message.
 */
export const osMessage = (error: { readonly message: string; readonly reason?: { readonly _tag: string } }) => {
  switch (error.reason?._tag) {
    case "NotFound":
      return "No such file or directory (os error 2)"
    case "PermissionDenied":
      return "Permission denied (os error 13)"
    case "AlreadyExists":
      return "File exists (os error 17)"
    default:
      return error.message
  }
}
