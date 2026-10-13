import { Config, Effect, Layer } from "effect"
import { CliError, Command } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { add } from "./cli/add"
import { cache } from "./cli/cache"
import { check } from "./cli/check"
import type { VerbContext } from "./cli/context"
import { diff } from "./cli/diff"
import { exportSchema } from "./cli/export"
import { fmt } from "./cli/fmt"
import { init } from "./cli/init"
import { inspect } from "./cli/inspect"
import { lint } from "./cli/lint"
import { lock } from "./cli/lock"
import { pack } from "./cli/pack"
import { publish } from "./cli/publish"
import { pull } from "./cli/pull"
import { push } from "./cli/push"
import { remove } from "./cli/remove"
import { render } from "./cli/render"
import { repl } from "./cli/repl"
import { sign } from "./cli/sign"
import { reportUsage } from "./cli/report"
import { test } from "./cli/test"
import { tree } from "./cli/tree"
import { update } from "./cli/update"
import { vendor } from "./cli/vendor"
import { verify } from "./cli/verify"
import { versionVerb } from "./cli/version"
import { CliName } from "./cli-name"
import { ExitCode } from "./contract"
import { HelmEngine, KustomizeEngine } from "./engines.effect"
import { GitRemote } from "./git.effect"
import { HelmRepository } from "./helm-repository.effect"
import { Artifacts } from "./host"
import { NativeWasmHost, type SandboxLimits } from "./host-native.effect"
import { NativeSandbox } from "./native"
import { OciRegistry } from "./oci.effect"
import { KclPlugins } from "./plugins.effect"
import { UrlSource } from "./url-source.effect"
import { RenderWorker } from "./worker.effect"

/** What an executable embeds for the host: the wasm modules and stdlib, and its Wasmtime addon. */
export interface HostAssets {
  readonly artifacts: Artifacts["Service"]
  /** Runs only when a render starts: loading an embedded `.node` file makes Bun write it to TMPDIR first. */
  readonly loadAddon: () => NativeSandbox["Service"]
}

/** The dependency fetchers (OCI registries, Helm repositories, git remotes, URLs): no sandbox, no addon. */
export const fetchLayer = Layer.mergeAll(
  Layer.mergeAll(OciRegistry.layer, HelmRepository.layer, UrlSource.layer).pipe(Layer.provide(FetchHttpClient.layer)),
  GitRemote.layer
)

export type FetchServices = typeof fetchLayer

/** Everything a verb that runs KCL needs: the engines, the dependency fetchers and the worker in the Wasmtime sandbox. */
export const renderLayer = (assets: HostAssets, limits?: SandboxLimits) =>
  RenderWorker.layer.pipe(
    Layer.provide(KclPlugins.layer),
    Layer.provide(Layer.mergeAll(HelmEngine.layer, KustomizeEngine.layer)),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Artifacts, assets.artifacts),
      NativeWasmHost(limits),
      fetchLayer
    )),
    Layer.provide(NativeSandbox.layer(assets.loadAddon))
  )

export type RenderServices = ReturnType<typeof renderLayer>

/** The command tree, presented as `name` in help and errors. */
export const akuapkgCommand = (name: string, version: string, assets: HostAssets) => {
  const context: VerbContext = { name, version, services: renderLayer(assets), fetchers: fetchLayer }
  return Command.make(name).pipe(
    Command.withDescription("Build, test, and publish cloud-native application packages"),
    Command.withSubcommands([
      render(context),
      check(context),
      lint(context),
      fmt(context),
      exportSchema(context),
      inspect(context),
      test(context),
      repl(context),
      add(context),
      remove(context),
      tree(),
      lock(context),
      update(context),
      vendor(context),
      pack(context),
      pull(context),
      push(context),
      sign(context),
      publish(context),
      verify(context),
      init(context),
      diff(),
      versionVerb(context),
      cache()
    ])
  )
}

/**
 * The name the CLI presents itself under: `akuapkg`, or `akua pkg` when
 * the akua CLI runs this executable for its `pkg` command.
 */
const programName = Config.String("AKUAPKG_PROGRAM_NAME").pipe(Config.withDefault("akuapkg"))

/** Run the akuapkg executable over the process arguments. */
export const runAkuapkg = (version: string, assets: HostAssets) =>
  programName.pipe(
    Effect.orElseSucceed(() => "akuapkg"),
    Effect.flatMap((name) =>
      akuapkgCommand(name, version, assets).pipe(
        Command.run({ version: version, renderErrors: false }),
        Effect.provideService(CliName, name)
      )
    ),
    Effect.catchIf(CliError.isCliError, reportUsage)
  )

/**
 * Run akuapkg over `args` inside another program's process and return its
 * exit code: the akua CLI's `akua pkg`. Failures are already reported on
 * stderr when this returns.
 */
export const runAkuapkgWith = (
  args: ReadonlyArray<string>,
  options: { readonly name: string; readonly version: string; readonly assets: HostAssets }
) =>
  Command.runWith(akuapkgCommand(options.name, options.version, options.assets), {
    version: options.version,
    renderErrors: false
  })(args).pipe(
    Effect.provideService(CliName, options.name),
    Effect.catchIf(CliError.isCliError, reportUsage),
    Effect.as<number>(ExitCode.success),
    Effect.catchTags({
      CliFailure: (failure) => Effect.succeed(failure.exitCode),
      ExitWith: (exit) => Effect.succeed(exit.exitCode)
    })
  )
