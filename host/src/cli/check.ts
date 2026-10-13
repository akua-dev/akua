import { Effect, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { ExitCode, ExitWith } from "../contract"
import { parseLock } from "../lockfile"
import { parseManifest } from "../manifest"
import type { LintIssue } from "../schemas"
import type { VerbContext } from "./context"
import { joinPath, lintWithDependencies, readOptional } from "./files"
import { reportable, verb } from "./report"
import { emit, universal } from "./universal"

interface CheckResult {
  readonly name: "manifest" | "lockfile" | "package"
  readonly ok: boolean
  readonly error?: string
  readonly issues?: ReadonlyArray<LintIssue>
}

const passed = (name: CheckResult["name"]): CheckResult => ({ name, ok: true })
const failed = (name: CheckResult["name"], error: string, issues?: ReadonlyArray<LintIssue>): CheckResult => ({
  name,
  ok: false,
  error,
  ...(issues === undefined || issues.length === 0 ? {} : { issues })
})

const text = (status: string, checks: ReadonlyArray<CheckResult>) =>
  [
    ...checks.flatMap((check) => [
      `  ${check.ok ? "✓" : "✗"} ${check.name}${check.error === undefined ? "" : `: ${check.error}`}`,
      ...(check.issues ?? []).map((issue) => `      [${issue.level}] ${issue.code}: ${issue.message}`)
    ]),
    status
  ].join("\n")

/**
 * The manifest, the lockfile and the Package, without running anything.
 * Unlike the previous release, the Package's imports resolve against its
 * dependencies (offline), so `import charts.<name>` no longer fails a check.
 */
export const check = (context: VerbContext) =>
  Command.make(
    "check",
    {
      ...universal,
      workspace: Flag.String("workspace").pipe(Flag.withDefault("."), Flag.withDescription("Workspace root")),
      packagePath: Flag.String("package").pipe(
        Flag.withDefault("./package.k"),
        Flag.withDescription("The Package.k, relative to the workspace")
      )
    },
    verb(
      "akuapkg.check",
      Effect.fnUntraced(function*(flags, mode) {
        const manifestPath = joinPath(flags.workspace, "akua.toml")
        const lockPath = joinPath(flags.workspace, "akua.lock")
        const packagePath = joinPath(flags.workspace, flags.packagePath)
        const manifest = yield* readOptional(manifestPath)
        const lock = yield* readOptional(lockPath)
        const source = yield* readOptional(packagePath)
        const checks: Array<CheckResult> = []
        if (Option.isSome(manifest)) {
          checks.push(
            yield* parseManifest(manifest.value, manifestPath).pipe(
              Effect.as(passed("manifest")),
              Effect.catchTag("ManifestInvalid", (error) => Effect.succeed(failed("manifest", error.message)))
            )
          )
        } else {
          checks.push(failed("manifest", `${manifestPath} not found`))
        }
        if (Option.isSome(lock)) {
          checks.push(
            yield* parseLock(lock.value, lockPath).pipe(
              Effect.as(passed("lockfile")),
              Effect.catchTag("LockInvalid", (error) => Effect.succeed(failed("lockfile", error.message)))
            )
          )
        }
        if (Option.isSome(source)) {
          checks.push(
            yield* lintWithDependencies({ workspace: flags.workspace, packagePath, source: source.value }).pipe(
              Effect.map((issues) =>
                issues.length === 0 ? passed("package") : failed("package", `${issues.length} lint issue(s)`, issues)
              ),
              Effect.catchTag("RenderError", (error) => Effect.succeed(failed("package", error.message))),
              Effect.provide(context.services),
              Effect.mapError(reportable)
            )
          )
        } else {
          checks.push(failed("package", `${packagePath} not found`))
        }
        const status = checks.every((check) => check.ok) ? "ok" : "fail"
        yield* emit(mode, { status, checks }, () => text(status, checks))
        if (status === "fail") return yield* new ExitWith({ exitCode: ExitCode.userError })
      })
    )
  ).pipe(Command.withDescription("Fast workspace check (parse + lint)"))

