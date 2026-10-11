import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ExitCode, fail, usageFailure } from "../contract"
import { resolvePackage } from "../dependencies.effect"
import { emptyLock, mergeIntoLock } from "../lockfile"
import { type Dependency, validateDependency } from "../manifest"
import type { VerbContext } from "./context"
import { verb } from "./report"
import { emit, universal } from "./universal"
import { loadLock, loadManifest, lockUpdates, manifestFailure, saveLock, saveManifest } from "./workspace"

type SourceKind = "oci" | "git" | "path" | "repo"

const optional = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.optional, Flag.withDescription(description))

/**
 * Declare a dependency in `akua.toml`, then lock it: the workspace is
 * resolved online and `akua.lock` rewritten. A dependency that does not
 * resolve yet is still declared; only OCI digest drift against the lock
 * fails the verb.
 */
export const add = (context: VerbContext) =>
  Command.make(
    "add",
    {
      ...universal,
      name: Argument.String("name").pipe(Argument.withDescription("Local alias: the key in `[dependencies]`")),
      oci: optional("oci", "OCI reference (`oci://registry/repo`)"),
      git: optional("git", "Git repository URL"),
      path: optional("path", "Local path, relative to the workspace"),
      repo: optional("repo", "HTTPS Helm repository URL (with --chart)"),
      chart: optional("chart", "Chart name within the Helm repo (required with --repo)"),
      version: optional("version", "Version (OCI) or semver requirement (Helm)"),
      tag: optional("tag", "Git tag"),
      rev: optional("rev", "Git commit (full SHA)"),
      force: Flag.Boolean("force").pipe(Flag.withDefault(false), Flag.withDescription("Replace an existing entry under `name`")),
      workspace: Flag.String("workspace").pipe(Flag.withDefault("."), Flag.withDescription("Workspace root containing akua.toml"))
    },
    verb(
      "akuapkg.add",
      Effect.fnUntraced(function*(flags, mode) {
        const candidates: ReadonlyArray<readonly [SourceKind, Option.Option<string>]> = [
          ["oci", flags.oci],
          ["git", flags.git],
          ["path", flags.path],
          ["repo", flags.repo]
        ]
        const sources = candidates.flatMap(([label, value]) =>
          Option.match(value, { onNone: () => [], onSome: (ref): Array<readonly [SourceKind, string]> => [[label, ref]] })
        )
        const chosen = sources[0]
        if (chosen === undefined || sources.length > 1) {
          return yield* usageFailure("exactly one of --oci, --git, --path or --repo is required")
        }
        const [kind, sourceRef] = chosen
        const manifest = yield* loadManifest(flags.workspace).pipe(
          Effect.catchTags({
            ManifestMissing: (missing) => Effect.fail(manifestFailure(missing, "run `akuapkg init` first")),
            ManifestInvalid: (invalid) => Effect.fail(manifestFailure(invalid))
          })
        )
        const replaced = manifest.dependencies?.[flags.name] !== undefined
        if (replaced && !flags.force) {
          return yield* fail(
            "E_ADD_DEP_EXISTS",
            `dep \`${flags.name}\` already declared in akua.toml; pass --force to replace`,
            ExitCode.userError,
            undefined,
            "pass --force to replace the existing entry"
          )
        }
        if (kind === "repo" && Option.isNone(flags.chart)) {
          return yield* fail(
            "E_ADD_INVALID_DEP",
            `dependency \`${flags.name}\`: helm-repo dep requires a \`chart\``,
            ExitCode.userError
          )
        }
        const dependency: Dependency = {
          ...(kind === "oci" ? { oci: sourceRef } : {}),
          ...(kind === "git" ? { git: sourceRef } : {}),
          ...(kind === "path" ? { path: sourceRef } : {}),
          ...(kind === "repo" ? { repo: sourceRef, chart: Option.getOrElse(flags.chart, () => "") } : {}),
          ...Option.match(flags.version, { onNone: () => ({}), onSome: (version) => ({ version }) }),
          ...Option.match(flags.tag, { onNone: () => ({}), onSome: (tag) => ({ tag }) }),
          ...Option.match(flags.rev, { onNone: () => ({}), onSome: (rev) => ({ rev }) })
        }
        const problem = validateDependency(flags.name, dependency)
        if (problem !== undefined) return yield* fail("E_ADD_INVALID_DEP", problem.message, ExitCode.userError)
        yield* saveManifest(flags.workspace, {
          ...manifest,
          dependencies: { ...manifest.dependencies, [flags.name]: dependency }
        })

        const prior = Option.getOrElse(yield* loadLock(flags.workspace), () => emptyLock)
        const resolved = yield* resolvePackage(flags.workspace, { offline: false, verifySignatures: false, pins: "oci" }).pipe(
          Effect.map(Option.some),
          // Locking is best effort, except when a registry serves other bytes than the lock pins.
          Effect.catch((error) =>
            error._tag === "DependencyUnresolved" && error.drift === true
              ? Effect.fail(fail(error.code, error.message, ExitCode.userError))
              : Effect.succeedNone
          ),
          Effect.provide(context.fetchers)
        )
        if (Option.isSome(resolved)) {
          yield* saveLock(flags.workspace, mergeIntoLock(prior, lockUpdates(resolved.value.dependencies)))
        }

        const output = {
          name: flags.name,
          source: kind === "repo" ? "helm" : kind,
          source_ref: sourceRef,
          ...Option.match(flags.version, { onNone: () => ({}), onSome: (version) => ({ version }) }),
          replaced
        }
        yield* emit(
          mode,
          output,
          () =>
            `${replaced ? "replaced" : "added"} ${flags.name}${
              Option.match(flags.version, { onNone: () => "", onSome: (version) => `@${version}` })
            } (${output.source}: ${sourceRef})`
        )
      })
    )
  ).pipe(Command.withDescription("Add a dependency to akua.toml and lock it"))
