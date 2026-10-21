import { Config, Duration, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  CheckOutput,
  type CliFailure,
  ExitCode,
  ExportOutput,
  packageMissing,
  type RenderSummary,
  RenderSummaryJson,
  StructuredError,
  TreeOutput
} from "./contract"
import { table, toToml } from "./toml-write"

/**
 * Run the compiled `akuapkg` executable in a child process.
 *
 * Use this from a long-lived process, or from a runtime other than Bun: the
 * work's CPU and memory, and any host-side bug, stay in the child, and
 * `timeout` is a wall-clock deadline that kills it. `command` is the argv
 * prefix that runs the executable, so callers can wrap it in an OS sandbox
 * (`["mise", "x", "--deny-all", ..., "--", "/bin/akuapkg"]`).
 */
export interface ExecutableOptions {
  readonly command: readonly [string, ...Array<string>]
  readonly timeout: Duration.Input
}

export interface RenderProcessOptions extends ExecutableOptions {
  readonly packagePath: string
  readonly inputsPath?: string
  readonly out: string
  readonly strict?: boolean
}

/** The executable reported a contract failure (its structured error and exit code). */
export class AkuapkgFailure extends Schema.TaggedError<AkuapkgFailure>()("AkuapkgFailure", {
  error: StructuredError,
  exitCode: Schema.Number
}) {
  override get message() {
    return `${this.error.code}: ${this.error.message}`
  }

  /** The failure the executable reports for `failure`. */
  static fromCli({ error, exitCode }: CliFailure) {
    return new AkuapkgFailure({ error, exitCode })
  }
}

/** The executable could not be run, or ended without the contract's output. */
export class AkuapkgProcessError extends Schema.TaggedError<AkuapkgProcessError>()("AkuapkgProcessError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(StructuredError))

/**
 * One verb in `cwd`, in JSON mode: its stdout and exit code. A structured
 * error on stderr fails as `AkuapkgFailure`; a verb that reports its verdict
 * on stdout (a failed `check`) returns with its non-zero exit code.
 */
const runVerb = Effect.fnUntraced(function*(
  options: ExecutableOptions,
  verb: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>> = {}
) {
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [executable, ...prefix] = options.command
  // The child runs elsewhere, so a relative TMPDIR is resolved here; Bun
  // extracts the executable's Wasmtime addon there before it can render.
  const tmpdir = yield* Config.option(Config.String("TMPDIR")).pipe(Effect.orElseSucceed(() => Option.none()))
  const command = ChildProcess.make(executable, [...prefix, verb, ...args, "--json"], {
    cwd,
    extendEnv: true,
    env: {
      ...Option.match(tmpdir, { onNone: () => ({}), onSome: (dir) => ({ TMPDIR: path.resolve(dir) }) }),
      ...env
    },
    stdin: "ignore",
    // A render blocks the child's JS thread inside wasm, so a SIGTERM handler
    // would only run once the guest yields; nothing needs a graceful exit.
    // The spawner signals the process group, reaching a sandbox wrapper's child.
    killSignal: "SIGKILL"
  })

  const run = Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(command)
    const [stdout, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { stdout, stderr, exitCode: Number(exitCode) }
  })).pipe(
    Effect.mapError((cause) => new AkuapkgProcessError({ message: `could not run ${executable}`, cause }))
  )

  const result = yield* run.pipe(
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () =>
        Effect.fail(
          new AkuapkgFailure({
            error: {
              level: "error",
              code: "E_RENDER_BUDGET_DEADLINE",
              message: `${verb} exceeded its ${Duration.format(Duration.fromInputUnsafe(options.timeout))} deadline`
            },
            exitCode: ExitCode.timeout
          })
        )
    })
  )
  if (result.exitCode === ExitCode.success) return result
  const lastLine = result.stderr.trim().split("\n").at(-1) ?? ""
  return yield* Option.match(decodeError(lastLine), {
    onNone: () =>
      result.stdout.trim() === ""
        ? Effect.fail(
          new AkuapkgProcessError({
            message: `${executable} exited ${result.exitCode} without a structured error: ${result.stderr.trim()}`
          })
        )
        : Effect.succeed(result),
    onSome: (error) => Effect.fail(new AkuapkgFailure({ error, exitCode: result.exitCode }))
  })
})

/** `stdout` as `schema`, from a verb that must have succeeded. */
const decodeOutput = <S extends Schema.Codec<unknown, string>>(verb: string, schema: S) =>
(result: { readonly stdout: string; readonly exitCode: number }) =>
  result.exitCode === ExitCode.success
    ? Schema.decodeUnknownEffect(schema)(result.stdout).pipe(
      Effect.mapError((cause) => new AkuapkgProcessError({ message: `${verb} printed no ${verb} output`, cause }))
    )
    : Effect.fail(new AkuapkgProcessError({ message: `${verb} exited ${result.exitCode}: ${result.stdout.trim()}` }))

export const renderWithExecutable = Effect.fn("renderWithExecutable")(function*(options: RenderProcessOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  // The child starts in the Package directory, so a missing Package is
  // reported here, as the executable would.
  const packageExists = yield* fs.exists(options.packagePath).pipe(
    Effect.mapError((cause) => new AkuapkgProcessError({ message: `could not inspect ${options.packagePath}`, cause }))
  )
  if (!packageExists) return yield* AkuapkgFailure.fromCli(packageMissing(options.packagePath))
  // Absolute: the child's working directory is the Package directory.
  const args = [
    "--package",
    path.resolve(options.packagePath),
    ...(options.inputsPath === undefined ? [] : ["--inputs", path.resolve(options.inputsPath)]),
    "--out",
    path.resolve(options.out),
    ...(options.strict === true ? ["--strict"] : [])
  ]
  const result = yield* runVerb(options, "render", args, path.dirname(path.resolve(options.packagePath)))
  const summary = yield* decodeOutput("render", Schema.fromJsonString(RenderSummaryJson))(result)
  return { ...summary, files: summary.files ?? [] } satisfies RenderSummary
})

/**
 * `check` of the workspace's manifest, lockfile and `package.k`: the verdict,
 * whether it passed or not (`status`, and `ok` per check).
 */
export const checkWithExecutable = Effect.fn("checkWithExecutable")(function*(
  options: ExecutableOptions & { readonly workspace: string }
) {
  const path = yield* Path.Path
  const workspace = path.resolve(options.workspace)
  const result = yield* runVerb(options, "check", ["--workspace", workspace], workspace)
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CheckOutput))(result.stdout).pipe(
    Effect.mapError((cause) =>
      new AkuapkgProcessError({ message: `check exited ${result.exitCode} without a verdict`, cause })
    )
  )
})

/** The `Input` schema of a Package (`export`), as JSON Schema or OpenAPI. */
export const exportWithExecutable = Effect.fn("exportWithExecutable")(function*(
  options: ExecutableOptions & { readonly packagePath: string; readonly format?: "json-schema" | "openapi" }
) {
  const path = yield* Path.Path
  const packagePath = path.resolve(options.packagePath)
  const result = yield* runVerb(
    options,
    "export",
    ["--package", packagePath, "--format", options.format ?? "json-schema"],
    path.dirname(packagePath)
  )
  return (yield* decodeOutput("export", Schema.fromJsonString(ExportOutput))(result)).schema
})

/** The workspace's package metadata and declared dependencies (`tree`). */
export const treeWithExecutable = Effect.fn("treeWithExecutable")(function*(
  options: ExecutableOptions & { readonly workspace: string }
) {
  const path = yield* Path.Path
  const workspace = path.resolve(options.workspace)
  const result = yield* runVerb(options, "tree", ["--workspace", workspace], workspace)
  return yield* decodeOutput("tree", Schema.fromJsonString(TreeOutput))(result)
})

/** Registry credentials by registry host (`ghcr.io`, `localhost:5000`). */
export type RegistryCredentials = Readonly<
  Record<string, { readonly username: string; readonly password: string } | { readonly token: string }>
>

/**
 * A private configuration directory for one child: `akua/auth.toml` holds
 * `registries`, read through `XDG_CONFIG_HOME`, so secrets never reach argv.
 * Removed with the scope.
 */
const privateConfig = Effect.fnUntraced(function*(registries: RegistryCredentials | undefined) {
  const env: Record<string, string> = {}
  if (registries === undefined || Object.keys(registries).length === 0) return env
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "akuapkg-config-" })
  yield* fs.makeDirectory(path.join(home, "akua"), { mode: 0o700 })
  yield* fs.writeFileString(
    path.join(home, "akua", "auth.toml"),
    toToml(table([[
      "registries",
      table(Object.entries(registries).map(([host, credential]) => [
        host,
        table("token" in credential
          ? [["token", credential.token]]
          : [["username", credential.username], ["password", credential.password]])
      ]))
    ]])),
    { mode: 0o600 }
  )
  env.XDG_CONFIG_HOME = home
  return env
})

/** What `inspect --oci` prints: a published Package's metadata and input schema. */
export const OciPackageInspection = Schema.Struct({
  kind: Schema.Literal("oci_package"),
  oci_ref: Schema.String,
  tag: Schema.String,
  manifest_digest: Schema.String,
  layer_digest: Schema.String,
  compressed_size_bytes: Schema.Number,
  uncompressed_size_bytes: Schema.Number,
  file_count: Schema.Number,
  package_name: Schema.NullOr(Schema.String),
  package_version: Schema.NullOr(Schema.String),
  package_edition: Schema.NullOr(Schema.String),
  vendored_deps: Schema.Array(Schema.String),
  input_schema: Schema.Record(Schema.String, Schema.Unknown)
})
export type OciPackageInspection = typeof OciPackageInspection.Type

/** A published Package's metadata and exported input schema (`inspect --oci`). */
export const inspectOciWithExecutable = Effect.fn("inspectOciWithExecutable")(function*(
  options: ExecutableOptions & {
    readonly reference: string
    readonly tag: string
    readonly registries?: RegistryCredentials
  }
) {
  const fs = yield* FileSystem.FileSystem
  return yield* Effect.scoped(Effect.gen(function*() {
    const env = yield* privateConfig(options.registries).pipe(
      Effect.mapError((cause) => new AkuapkgProcessError({ message: "could not write registry credentials", cause }))
    )
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "akuapkg-inspect-" }).pipe(
      Effect.mapError((cause) => new AkuapkgProcessError({ message: "could not create a working directory", cause }))
    )
    const result = yield* runVerb(options, "inspect", ["--oci", options.reference, "--tag", options.tag], cwd, env)
    return yield* decodeOutput("inspect", Schema.fromJsonString(OciPackageInspection))(result)
  }))
})

/** What `vendor add` prints. */
export const VendorAddOutput = Schema.Struct({
  name: Schema.String,
  source_kind: Schema.String,
  source_ref: Schema.String,
  path: Schema.String,
  digest: Schema.String,
  size_bytes: Schema.Number,
  wrote: Schema.Boolean,
  replaced: Schema.Boolean
})

/**
 * Copy dependency `name` of the workspace into `.akua/vendor/<name>/` and pin
 * it (`vendor add`). `gitCredentials` (by URL prefix) reach the child as an
 * `--auth-file` in a private directory, never as arguments.
 */
export const vendorAddWithExecutable = Effect.fn("vendorAddWithExecutable")(function*(
  options: ExecutableOptions & {
    readonly workspace: string
    readonly name: string
    readonly gitCredentials?: Readonly<Record<string, { readonly username: string; readonly password: string }>>
    readonly registries?: RegistryCredentials
  }
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const workspace = path.resolve(options.workspace)
  return yield* Effect.scoped(Effect.gen(function*() {
    const credentialsFailed = (cause: unknown) =>
      new AkuapkgProcessError({ message: "could not write credentials", cause })
    const env = yield* privateConfig(options.registries).pipe(Effect.mapError(credentialsFailed))
    const authArgs: Array<string> = []
    if (options.gitCredentials !== undefined && Object.keys(options.gitCredentials).length > 0) {
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akuapkg-auth-" }).pipe(Effect.mapError(credentialsFailed))
      const file = path.join(directory, "auth.toml")
      yield* fs.writeFileString(
        file,
        toToml(table([[
          "auth",
          table(Object.entries(options.gitCredentials).map(([prefix, credential]) => [
            prefix,
            table([["username", credential.username], ["password", credential.password]])
          ]))
        ]])),
        { mode: 0o600 }
      ).pipe(Effect.mapError(credentialsFailed))
      authArgs.push("--auth-file", file)
    }
    const result = yield* runVerb(
      options,
      "vendor",
      ["add", options.name, "--workspace", workspace, ...authArgs],
      workspace,
      env
    )
    return yield* decodeOutput("vendor add", Schema.fromJsonString(VendorAddOutput))(result)
  }))
})
