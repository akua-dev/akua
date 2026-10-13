import { Effect, FileSystem, Option, Path } from "effect"
import { Command, Flag } from "effect/cli"
import { ExitCode, ExitWith } from "../contract"
import { HostError } from "../errors"
import { renderPackage } from "../render.effect"
import { loadSnapshot } from "../snapshot.effect"
import { collectFiles } from "../walk.effect"
import { bareTree, programResources, RenderWorker } from "../worker.effect"
import type { VerbContext } from "./context"
import { joinPath } from "./files"
import { reportable, verb } from "./report"
import { emit, universal } from "./universal"

const encoder = new TextEncoder()

type Status = "ok" | "fail" | "empty" | "updated"

interface TestOutcome {
  readonly file: string
  readonly status: "pass" | "fail"
  readonly message?: string
}

interface TestReport {
  readonly status: Status
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly tests: ReadonlyArray<TestOutcome>
}

interface GoldenOutcome {
  readonly package: string
  /** The inputs file, relative to the workspace; `""` when the Package has none. */
  readonly inputs: string
  readonly status: "pass" | "fail" | "updated"
  readonly diff_summary?: string
}

type Verdict = Pick<GoldenOutcome, "status" | "diff_summary">

interface GoldenReport {
  readonly status: Status
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly updated: boolean
  readonly cases: ReadonlyArray<GoldenOutcome>
}

/** `test_*.k` or `*_test.k`. */
const isTestFile = (name: string) =>
  name.endsWith(".k") && (name.startsWith("test_") || name.slice(0, -2).endsWith("_test"))

const isInputsFile = (name: string) => name.startsWith("inputs") && /\.(yaml|yml|json)$/.test(name)

const parentOf = (relative: string) => relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : ""

/**
 * A test file passes when its program evaluates: KCL's `assert` and `check:`
 * blocks fail the evaluation. A test needs no `resources`; it is evaluated
 * without the Package's dependencies.
 */
const runTest = Effect.fnUntraced(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const worker = yield* RenderWorker
  const source = yield* fs.readFileString(file).pipe(Effect.mapError((error) => error.message))
  const filename = path.basename(file)
  const yaml = yield* worker.evaluate({
    tree: bareTree(filename, new Map([[filename, encoder.encode(source)]])),
    // Diagnostics name the absolute path, as before.
    filename: path.resolve(file),
    inputs: {}
  }).pipe(Effect.mapError((error) => error.message))
  yield* programResources(yaml).pipe(
    Effect.catchTag("ProgramShape", (error) => error.problem === "NoResources" ? Effect.succeed([]) : Effect.fail(error)),
    Effect.mapError((error) => error.message)
  )
})

const assertions = Effect.fnUntraced(function*(workspace: string) {
  const tests: Array<TestOutcome> = []
  for (const file of yield* collectFiles(workspace, isTestFile)) {
    const failure = yield* runTest(joinPath(workspace, file)).pipe(Effect.flip, Effect.option)
    tests.push(
      Option.isNone(failure)
        ? { file, status: "pass" }
        : failure.value === ""
        ? { file, status: "fail" }
        : { file, status: "fail", message: failure.value }
    )
  }
  const failed = tests.filter((test) => test.status === "fail").length
  return {
    status: tests.length === 0 ? "empty" : failed === 0 ? "ok" : "fail",
    total: tests.length,
    passed: tests.length - failed,
    failed,
    tests
  } satisfies TestReport
})

/** `N added, N removed, N changed` between a snapshot and a fresh render. */
const diffSummary = (snapshot: ReadonlyMap<string, Uint8Array>, rendered: ReadonlyMap<string, Uint8Array>) => {
  const added = Array.from(rendered.keys()).filter((name) => !snapshot.has(name)).length
  const removed = Array.from(snapshot.keys()).filter((name) => !rendered.has(name)).length
  const changed = Array.from(rendered).filter(([name, bytes]) => {
    const before = snapshot.get(name)
    return before !== undefined && (before.length !== bytes.length || before.some((byte, index) => byte !== bytes[index]))
  }).length
  return [[added, "added"], [removed, "removed"], [changed, "changed"]]
    .filter(([count]) => count !== 0)
    .map(([count, what]) => `${count} ${what}`)
    .join(", ")
}

/** Render `packageFile` against `inputsFile` and compare with, or rewrite, `snapshotDir`. */
const goldenCase = Effect.fnUntraced(function*(
  packageFile: string,
  inputsFile: Option.Option<string>,
  snapshotDir: string,
  update: boolean
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { documents } = yield* renderPackage({
    packagePath: packageFile,
    inputsPath: inputsFile,
    out: snapshotDir,
    dryRun: true,
    strict: false,
    offline: false
  })
  if (update) {
    if (yield* fs.exists(snapshotDir)) yield* fs.remove(snapshotDir, { recursive: true })
    yield* fs.makeDirectory(snapshotDir, { recursive: true })
    for (const [name, yaml] of documents) yield* fs.writeFileString(path.join(snapshotDir, name), yaml)
    const updated: Verdict = { status: "updated" }
    return updated
  }
  const isDirectory = yield* fs.stat(snapshotDir).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false)
  )
  if (!isDirectory) {
    const missing: Verdict = {
      status: "fail",
      diff_summary: `no baseline at ${snapshotDir} - run with --update-snapshots to establish`
    }
    return missing
  }
  const summary = diffSummary(
    yield* loadSnapshot(snapshotDir),
    new Map(documents.map(([name, yaml]) => [name, encoder.encode(yaml)]))
  )
  const compared: Verdict = summary === "" ? { status: "pass" } : { status: "fail", diff_summary: summary }
  return compared
})

/**
 * Every `package.k` rendered against each sibling `inputs*.{yaml,yml,json}`
 * (or none), compared with `snapshots/<package dir>/<inputs stem>/`.
 */
const golden = Effect.fnUntraced(function*(workspace: string, update: boolean) {
  const fs = yield* FileSystem.FileSystem
  const cases: Array<GoldenOutcome> = []
  for (const pkg of yield* collectFiles(workspace, (name) => name === "package.k")) {
    const directory = parentOf(pkg)
    const siblings = yield* fs.readDirectory(directory === "" ? workspace : joinPath(workspace, directory))
    const inputs: Array<string> = []
    for (const name of siblings.filter(isInputsFile).toSorted()) {
      const file = joinPath(directory === "" ? workspace : joinPath(workspace, directory), name)
      const info = yield* fs.stat(file).pipe(Effect.option)
      if (Option.isSome(info) && info.value.type === "File") inputs.push(name)
    }
    for (const name of inputs.length === 0 ? [undefined] : inputs) {
      const inputsRelative = name === undefined ? "" : directory === "" ? name : `${directory}/${name}`
      const stem = name === undefined ? "default" : name.slice(0, name.lastIndexOf("."))
      const snapshotDir = joinPath(joinPath(joinPath(workspace, "snapshots"), directory), stem)
      const outcome = yield* goldenCase(
        joinPath(workspace, pkg),
        name === undefined ? Option.none() : Option.some(joinPath(workspace, inputsRelative)),
        snapshotDir,
        update
      ).pipe(
        Effect.catch((error) => {
          const failed: Verdict = { status: "fail", diff_summary: HostError.from(error).message }
          return Effect.succeed(failed)
        })
      )
      cases.push({ package: pkg, inputs: inputsRelative, ...outcome })
    }
  }
  const failed = cases.filter((outcome) => outcome.status === "fail").length
  return {
    status: cases.length === 0 ? "empty" : failed > 0 ? "fail" : update ? "updated" : "ok",
    total: cases.length,
    passed: cases.length - failed,
    failed,
    updated: update,
    cases
  } satisfies GoldenReport
})

/** Any failure fails; then a snapshot update; `empty` only when nothing ran. */
const combinedStatus = (report: TestReport, goldenReport: GoldenReport | undefined): Status =>
  report.status === "fail" || goldenReport?.status === "fail"
    ? "fail"
    : goldenReport?.status === "updated"
    ? "updated"
    : report.status === "empty" && (goldenReport === undefined || goldenReport.status === "empty")
    ? "empty"
    : "ok"

const indented = (message: string) => message.split("\n").map((line) => `      ${line}`)

const assertionsText = (report: TestReport) =>
  report.status === "empty"
    ? ["assert: no tests found (*test*.k)"]
    : [
      report.status === "ok"
        ? `assert: ${report.total} passed`
        : `assert: ${report.passed} passed, ${report.failed} failed of ${report.total}`,
      ...report.tests.flatMap((test) => [
        `  ${test.status === "pass" ? "ok" : "FAIL"} ${test.file}`,
        ...(test.message === undefined ? [] : indented(test.message.replace(/\n$/, "")))
      ])
    ]

const goldenText = (report: GoldenReport) =>
  report.status === "empty"
    ? ["golden: no package.k found"]
    : [
      report.status === "updated"
        ? `golden: ${report.total} snapshot(s) updated`
        : report.status === "ok"
        ? `golden: ${report.total} passed`
        : `golden: ${report.passed} passed, ${report.failed} failed of ${report.total}`,
      ...report.cases.flatMap((outcome) => [
        `  ${outcome.status === "pass" ? "ok" : outcome.status === "updated" ? "~~" : "FAIL"} ${outcome.package} [${
          outcome.inputs === "" ? "(default)" : outcome.inputs
        }]`,
        ...(outcome.diff_summary === undefined ? [] : [`      ${outcome.diff_summary}`])
      ])
    ]

export const test = (context: VerbContext) =>
  Command.make(
    "test",
    {
      ...universal,
      workspace: Flag.String("workspace").pipe(Flag.withDefault("."), Flag.withDescription("Workspace root")),
      golden: Flag.Boolean("golden").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Run golden snapshot tests in addition to assertion tests")
      ),
      updateSnapshots: Flag.Boolean("update-snapshots").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Rewrite snapshot files rather than diff. Implies --golden")
      )
    },
    verb(
      "akuapkg.test",
      Effect.fnUntraced(function*(flags, mode) {
        const run = Effect.gen(function*() {
          const report = yield* assertions(flags.workspace)
          const goldenReport = flags.golden || flags.updateSnapshots
            ? yield* golden(flags.workspace, flags.updateSnapshots)
            : undefined
          return { report, goldenReport }
        })
        const { goldenReport, report } = yield* run.pipe(
          Effect.provide(context.services),
          Effect.mapError((error) => reportable(HostError.from(error)))
        )
        const status = combinedStatus(report, goldenReport)
        yield* emit(
          mode,
          { status, assertions: report, ...(goldenReport === undefined ? {} : { golden: goldenReport }) },
          () => [...assertionsText(report), ...(goldenReport === undefined ? [] : ["", ...goldenText(goldenReport)])].join("\n")
        )
        if (status === "fail") return yield* new ExitWith({ exitCode: ExitCode.userError })
      })
    )
  ).pipe(Command.withDescription("Run KCL tests (`test_*.k`, `*_test.k`) and, with --golden, snapshot tests"))
