import { Effect, Option, Path } from "effect"
import { Command, Flag } from "effect/cli"
import { ExitCode, ExitWith, fail } from "../contract"
import type { LintIssue } from "../schemas"
import type { VerbContext } from "./context"
import { lintWithDependencies, missingPackage, readOptional } from "./files"
import { reportable, verb } from "./report"
import { emit, universal } from "./universal"

const location = (issue: LintIssue) =>
  issue.file === undefined
    ? ""
    : issue.line === undefined
    ? issue.file
    : issue.column === undefined
    ? `${issue.file}:${issue.line}`
    : `${issue.file}:${issue.line}:${issue.column}`

const text = (issues: ReadonlyArray<LintIssue>) =>
  issues.length === 0
    ? "ok: no lint issues"
    : [
      `fail: ${issues.length} issue(s)`,
      ...issues.map((issue) => {
        const at = location(issue)
        return `  [${issue.level}] ${issue.code}: ${issue.message}${at === "" ? "" : `  at ${at}`}`
      })
    ].join("\n")

/** Parse-only: syntax and imports (resolved against the Package's dependencies, offline). */
export const lint = (context: VerbContext) =>
  Command.make(
    "lint",
    {
      ...universal,
      packagePath: Flag.String("package").pipe(Flag.withDefault("./package.k"), Flag.withDescription("Path to the `package.k` file"))
    },
    verb(
      "akuapkg.lint",
      Effect.fnUntraced(function*(flags, mode) {
        const path = yield* Path.Path
        const source = yield* readOptional(flags.packagePath)
        if (Option.isNone(source)) return yield* missingPackage(flags.packagePath)
        const issues = yield* lintWithDependencies({
          workspace: path.dirname(path.resolve(flags.packagePath)),
          packagePath: flags.packagePath,
          source: source.value
        }).pipe(
          Effect.catchTag("RenderError", (error) => Effect.fail(fail("E_LINT_FAIL", error.message, ExitCode.userError))),
          Effect.provide(context.services),
          Effect.mapError((error) => error._tag === "CliFailure" ? error : reportable(error))
        )
        yield* emit(mode, { status: issues.length === 0 ? "ok" : "fail", issues }, () => text(issues))
        if (issues.length > 0) return yield* new ExitWith({ exitCode: ExitCode.userError })
      })
    )
  ).pipe(Command.withDescription("Parse-only check of a `package.k` (KCL syntax + imports)"))
