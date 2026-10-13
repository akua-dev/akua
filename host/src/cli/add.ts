import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ExitCode, fail, usageFailure } from "../contract"
import { emptyLock, mergeIntoLock } from "../lockfile"
import { type Dependency, validateDependency } from "../manifest"
import type { VerbContext } from "./context"
import { readOptional } from "./files"
import { K8S_TYPES_OCI } from "./init"
import { verb } from "./report"
import { emit, universal } from "./universal"
import {
  generateCrds,
  loadLock,
  loadManifest,
  lockUpdates,
  manifestFailure,
  manifestPath,
  resolveForLock,
  restoreManifest,
  saveLock,
  saveManifest,
  syncGeneratedCrds
} from "./workspace"

type SourceKind = "oci" | "git" | "path" | "repo" | "url" | "k8s"

const optional = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.optional, Flag.withDescription(description))

/**
 * Declare a dependency in `akua.toml` and lock it: the workspace is resolved
 * online and `akua.lock` rewritten. The verb is atomic: when the workspace
 * does not resolve (an unknown version, an unreachable source, OCI digest
 * drift or a bad signature), it fails with that error and `akua.toml` stays
 * as it was. (The previous release declared an unresolvable dependency anyway
 * and reported success, leaving a manifest that every render then rejected.)
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
      url: optional("url", "HTTPS URL of one CustomResourceDefinition manifest file; sets `crds = true`"),
      k8s: optional(
        "k8s",
        `Kubernetes version of the typed core schemas (\`${K8S_TYPES_OCI}\` at that tag), e.g. \`1.35\``
      ),
      crds: optional(
        "crds",
        "Generate typed schemas from the CustomResourceDefinitions in the source: a file or directory in it, `.` for all"
      ),
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
          ["repo", flags.repo],
          ["url", flags.url],
          ["k8s", flags.k8s]
        ]
        const sources = candidates.flatMap(([label, value]) =>
          Option.match(value, { onNone: () => [], onSome: (ref): Array<readonly [SourceKind, string]> => [[label, ref]] })
        )
        const chosen = sources[0]
        if (chosen === undefined || sources.length > 1) {
          return yield* usageFailure("exactly one of --oci, --git, --path, --repo, --url or --k8s is required")
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
        if (kind === "k8s" && (Option.isSome(flags.version) || Option.isSome(flags.crds))) {
          return yield* usageFailure("--k8s takes the Kubernetes version itself; drop --version / --crds")
        }
        // `--crds .` (or a bare url source) is the whole source: `crds = true`.
        const crds = Option.orElse(flags.crds, () => kind === "url" ? Option.some(".") : Option.none<string>())
        const dependency: Dependency = {
          ...(kind === "oci" ? { oci: sourceRef } : {}),
          ...(kind === "k8s" ? { oci: K8S_TYPES_OCI, version: sourceRef } : {}),
          ...(kind === "git" ? { git: sourceRef } : {}),
          ...(kind === "path" ? { path: sourceRef } : {}),
          ...(kind === "repo" ? { repo: sourceRef, chart: Option.getOrElse(flags.chart, () => "") } : {}),
          ...(kind === "url" ? { url: sourceRef } : {}),
          ...Option.match(flags.version, { onNone: () => ({}), onSome: (version) => ({ version }) }),
          ...Option.match(flags.tag, { onNone: () => ({}), onSome: (tag) => ({ tag }) }),
          ...Option.match(flags.rev, { onNone: () => ({}), onSome: (rev) => ({ rev }) }),
          ...Option.match(crds, {
            onNone: () => ({}),
            onSome: (selector) => ({ crds: selector === "." || selector === "true" ? true : selector })
          })
        }
        const problem = validateDependency(flags.name, dependency)
        if (problem !== undefined) return yield* fail("E_ADD_INVALID_DEP", problem.message, ExitCode.userError)
        const prior = Option.getOrElse(yield* loadLock(flags.workspace), () => emptyLock)
        const original = yield* readOptional(manifestPath(flags.workspace))
        yield* saveManifest(flags.workspace, {
          ...manifest,
          dependencies: { ...manifest.dependencies, [flags.name]: dependency }
        })
        const resolved = yield* resolveForLock(flags.workspace, "oci", context.fetchers).pipe(
          Effect.tapError(() =>
            Option.match(original, {
              onNone: () => Effect.void,
              onSome: (text) => restoreManifest(flags.workspace, text).pipe(Effect.ignore)
            })
          )
        )
        const generation = yield* generateCrds(resolved.dependencies)
        yield* saveLock(flags.workspace, mergeIntoLock(prior, lockUpdates(resolved.dependencies, generation)), context.name)
        const generated = yield* syncGeneratedCrds(flags.workspace, generation)
        const schemas = generated.find((summary) => summary.name === flags.name)

        const output = {
          name: flags.name,
          source: kind === "repo" ? "helm" : kind === "k8s" ? "oci" : kind,
          source_ref: kind === "k8s" ? K8S_TYPES_OCI : sourceRef,
          ...(kind === "k8s" ? { version: sourceRef } : {}),
          ...Option.match(flags.version, { onNone: () => ({}), onSome: (version) => ({ version }) }),
          replaced,
          ...(schemas === undefined ? {} : { crds: { path: schemas.path, modules: schemas.modules } })
        }
        yield* emit(
          mode,
          output,
          () =>
            [
              `${replaced ? "replaced" : "added"} ${flags.name}${output.version === undefined ? "" : `@${output.version}`} (${output.source}: ${output.source_ref})`,
              ...(schemas === undefined ? [] : [
                `  typed CRD schemas in ${schemas.path}:`,
                ...schemas.modules.map((module) => `    import ${module.module}  (${module.kinds.join(", ")})`)
              ])
            ].join("\n")
        )
      })
    )
  ).pipe(Command.withDescription("Add a dependency to akua.toml and lock it"))
