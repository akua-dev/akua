import { Schema } from "effect"

/** Render request the worker reads from stdin (`akua-render-worker` protocol). */
export const WorkerRequest = Schema.Struct({
  kind: Schema.Literal("render"),
  package_filename: Schema.String,
  source: Schema.String,
  inputs: Schema.Unknown,
  /** Guest path of the generated `charts` package (`import charts.<name>`). */
  charts_pkg_path: Schema.optionalKey(Schema.String),
  /** KCL-module dependencies: import name to guest path. */
  kcl_pkgs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Guest path of the generated `pkgs` package (`import pkgs.<name>`). */
  pkgs_pkg_path: Schema.optionalKey(Schema.String)
})

/** Response the worker writes to stdout. */
export const WorkerResponse = Schema.Struct({
  kind: Schema.Literal("render"),
  status: Schema.Literals(["ok", "fail"]),
  yaml: Schema.String,
  message: Schema.optionalKey(Schema.String)
})

/** `kcl_plugin.helm.template(opts)` positional args, as `akua.helm.Template`. */
export const HelmTemplateArgs = Schema.Tuple([
  Schema.Struct({
    chart: Schema.String,
    values: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
    release: Schema.optionalKey(
      Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,52}$/, { message: "invalid Helm release name" }))
    ),
    namespace: Schema.optionalKey(
      Schema.String.check(
        Schema.isPattern(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, { message: "namespace must be a DNS-1123 label" })
      )
    )
  })
])

/** `kcl_plugin.pkg.render(opts)` positional args, as `akua.pkg.Render`. */
export const PkgRenderArgs = Schema.Tuple([
  Schema.Struct({
    package: Schema.optionalKey(Schema.String),
    inputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
  })
])

/** `kcl_plugin.kustomize.build(opts)` positional args, as `akua.kustomize.Build`. */
export const KustomizeBuildArgs = Schema.Tuple([Schema.Struct({ path: Schema.String })])

export const HelmEngineResponse = Schema.Struct({
  manifests: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  error: Schema.optionalKey(Schema.String)
})

export const KustomizeEngineResponse = Schema.Struct({
  yaml: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String)
})

/** One KCL parse or import issue (`akua_core::LintIssue`), in its field order. */
export const LintIssue = Schema.Struct({
  level: Schema.String,
  code: Schema.String,
  message: Schema.String,
  file: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Number),
  column: Schema.optionalKey(Schema.Number)
})
export type LintIssue = typeof LintIssue.Type

export const LintResponse = Schema.Struct({
  kind: Schema.Literal("lint"),
  status: Schema.Literals(["ok", "fail"]),
  issues: Schema.Array(LintIssue),
  message: Schema.optionalKey(Schema.String)
})

export const FormatResponse = Schema.Struct({
  kind: Schema.Literal("format"),
  status: Schema.Literals(["ok", "fail"]),
  formatted: Schema.String,
  message: Schema.optionalKey(Schema.String)
})

export const ExportResponse = Schema.Struct({
  kind: Schema.Literal("export"),
  status: Schema.Literals(["ok", "fail"]),
  schema: Schema.Unknown,
  message: Schema.optionalKey(Schema.String)
})

/** One `option(...)` call site (`akua_core::OptionInfo`), in its field order. */
export const OptionInfo = Schema.Struct({
  name: Schema.String,
  type: Schema.optionalKey(Schema.String),
  required: Schema.Boolean,
  default: Schema.optionalKey(Schema.String),
  help: Schema.optionalKey(Schema.String)
})
export type OptionInfo = typeof OptionInfo.Type

export const OptionsResponse = Schema.Struct({
  kind: Schema.Literal("options"),
  status: Schema.Literals(["ok", "fail"]),
  options: Schema.Array(OptionInfo),
  message: Schema.optionalKey(Schema.String)
})
