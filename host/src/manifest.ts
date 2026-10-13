import { Effect, Option, Schema } from "effect"
import * as TOML from "smol-toml"
import { ManifestInvalid } from "./errors"
import { table, toToml } from "./toml-write"

/**
 * `akua.toml`, the human-edited manifest (docs/lockfile-format.md). Pure
 * parsing and validation: the rules and messages of the previous release's
 * `akua_core::mod_file`.
 */

const Dependency = Schema.Struct({
  oci: Schema.optionalKey(Schema.String),
  git: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  /** HTTPS Helm repository; pairs with `chart`. */
  repo: Schema.optionalKey(Schema.String),
  chart: Schema.optionalKey(Schema.String),
  /** HTTPS URL of one manifest file; only with `crds`. */
  url: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  tag: Schema.optionalKey(Schema.String),
  rev: Schema.optionalKey(Schema.String),
  /**
   * Typed schemas from the CustomResourceDefinitions in the source, imported
   * as `crds.<name>.<group>.<version>`: `true` for the whole source, or a
   * file or directory inside it.
   */
  crds: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
  /** Local fork of an `oci` / `git` dependency, still locked by its canonical source. */
  replace: Schema.optionalKey(Schema.Struct({ path: Schema.String }))
})
export type Dependency = typeof Dependency.Type

const Manifest = Schema.Struct({
  package: Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    edition: Schema.String,
    strict_signing: Schema.optionalKey(Schema.Boolean)
  }),
  workspace: Schema.optionalKey(Schema.Struct({ members: Schema.optionalKey(Schema.Array(Schema.String)) })),
  signing: Schema.optionalKey(
    Schema.Struct({
      cosign_public_key: Schema.optionalKey(Schema.String),
      cosign_private_key: Schema.optionalKey(Schema.String)
    })
  ),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Dependency))
})
export type Manifest = typeof Manifest.Type

/** A dependency by source, after validation. */
export type DependencySpec =
  | { readonly _tag: "Path"; readonly path: string }
  | { readonly _tag: "Oci"; readonly oci: string; readonly version: string }
  | { readonly _tag: "Git"; readonly git: string; readonly tag: Option.Option<string>; readonly rev: Option.Option<string> }
  | { readonly _tag: "Helm"; readonly repo: string; readonly chart: string; readonly version: string }
  | { readonly _tag: "Url"; readonly url: string }

const decodeManifest = Schema.decodeUnknownEffect(Manifest)

/** Parse and validate `akua.toml` text; `path` names the file in errors. */
export const parseManifest = Effect.fn("parseManifest")(function*(text: string, path: string) {
  const invalid = (message: string, code = "E_MANIFEST_PARSE") => new ManifestInvalid({ path, code, message })
  const raw = yield* Effect.try({
    try: (): unknown => TOML.parse(text),
    catch: (cause) => invalid(`toml parse error: ${cause instanceof Error ? cause.message : String(cause)}`)
  })
  const manifest = yield* decodeManifest(raw).pipe(
    Effect.mapError((error) => invalid(`toml parse error: ${error.message}`))
  )
  if (!manifest.package.edition.startsWith("akua.dev/")) {
    return yield* invalid(`[package].edition must start with \`akua.dev/\`, got \`${manifest.package.edition}\``)
  }
  if (!isValidPackageName(manifest.package.name)) {
    return yield* invalid(`[package].name must be a valid KCL identifier, got \`${manifest.package.name}\``)
  }
  for (const [name, dependency] of dependencies(manifest)) {
    const problem = validateDependency(name, dependency)
    if (problem !== undefined) return yield* invalid(problem.message, problem.code)
  }
  return manifest
})

/** Dependencies in canonical (alphabetical) order. */
export const dependencies = (manifest: Manifest): ReadonlyArray<readonly [string, Dependency]> =>
  Object.entries(manifest.dependencies ?? {}).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

/**
 * The file or directory a CRD dependency's schemas come from, relative to
 * its source (`.` for all of it); none for other dependencies.
 */
export const crdSelector = (dependency: Dependency) =>
  dependency.crds === undefined || dependency.crds === false
    ? undefined
    : dependency.crds === true
    ? "."
    : dependency.crds

/** The dependency's source; call only on a validated manifest. */
export const dependencySpec = (dependency: Dependency): DependencySpec => {
  if (dependency.path !== undefined) return { _tag: "Path", path: dependency.path }
  if (dependency.url !== undefined) return { _tag: "Url", url: dependency.url }
  if (dependency.oci !== undefined) return { _tag: "Oci", oci: dependency.oci, version: dependency.version ?? "" }
  if (dependency.git !== undefined) {
    return {
      _tag: "Git",
      git: dependency.git,
      tag: Option.fromUndefinedOr(dependency.tag),
      rev: Option.fromUndefinedOr(dependency.rev)
    }
  }
  return {
    _tag: "Helm",
    repo: dependency.repo ?? "",
    chart: dependency.chart ?? "",
    version: dependency.version ?? ""
  }
}

/** The previous release's rules for one dependency entry; its message and contract code, or nothing. */
export const validateDependency = (
  name: string,
  dependency: Dependency
): { readonly message: string; readonly code: string } | undefined => {
  const fail = (message: string, code = "E_MANIFEST_PARSE") => ({ message: `dependency \`${name}\`: ${message}`, code })
  const credentials = "must not embed credentials (`user:pass@`). " +
    "Pass credentials via the SDK `auth` parameter or the CLI `--auth` flag."
  const sources = [dependency.oci, dependency.git, dependency.path, dependency.repo, dependency.url].filter((source) =>
    source !== undefined
  ).length
  if (sources !== 1) return fail(`exactly one of oci / git / path / repo / url must be set, got ${sources}`)
  if (dependency.oci !== undefined) {
    if (dependency.version === undefined) return fail("oci dep requires a version")
    if (hasUserInfo(dependency.oci)) return fail(`oci URL ${credentials}`, "E_MANIFEST_OCI_USERINFO")
  }
  if (dependency.git !== undefined) {
    if (dependency.tag === undefined && dependency.rev === undefined) return fail("git dep requires either tag or rev")
    if (hasUserInfo(dependency.git)) return fail(`git URL ${credentials}`, "E_MANIFEST_GIT_USERINFO")
  }
  if (dependency.path !== undefined) {
    if (dependency.version !== undefined || dependency.tag !== undefined || dependency.rev !== undefined) {
      return fail("path dep must not set version / tag / rev")
    }
  }
  if (dependency.url !== undefined) {
    if (dependency.crds === undefined || dependency.crds === false) {
      return fail("url dep is a CRD source: set `crds = true`", "E_MANIFEST_CRDS_INVALID")
    }
    if (!dependency.url.startsWith("https://")) return fail("url dep must be an https:// URL", "E_MANIFEST_CRDS_INVALID")
    if (dependency.version !== undefined || dependency.tag !== undefined || dependency.rev !== undefined) {
      return fail("url dep must not set version / tag / rev: akua.lock pins the file by digest", "E_MANIFEST_CRDS_INVALID")
    }
    if (hasUserInfo(dependency.url)) return fail(`url ${credentials}`, "E_MANIFEST_CRDS_INVALID")
  }
  if (typeof dependency.crds === "string") {
    const selector = dependency.crds
    if (selector === "" || selector.startsWith("/") || selector.startsWith("\\") || selector.split(/[/\\]/).includes("..")) {
      return fail(
        `\`crds\` value \`${selector}\` must be a relative path inside the source (no leading \`/\`, no \`..\`)`,
        "E_MANIFEST_CRDS_INVALID"
      )
    }
  }
  if (dependency.repo !== undefined) {
    if (dependency.chart === undefined) return fail("helm-repo dep requires a `chart`", "E_MANIFEST_HELM_MISSING_CHART")
    if (dependency.version === undefined) {
      return fail("helm-repo dep requires a `version`", "E_MANIFEST_HELM_MISSING_VERSION")
    }
    if (hasUserInfo(dependency.repo)) return fail(`repo URL ${credentials}`, "E_MANIFEST_HELM_USERINFO")
    if (/[/\\]|\.\./.test(dependency.chart)) {
      return fail(
        `\`chart\` value \`${dependency.chart}\` must be a plain chart name (no path separators or \`..\`)`,
        "E_MANIFEST_HELM_CHART_INVALID"
      )
    }
  }
  return undefined
}

/** An `@` in the authority (`user[:pass]@host`, scp-style `git@host:`): credentials belong in auth configuration. */
const hasUserInfo = (url: string) => {
  const afterScheme = url.includes("://") ? url.slice(url.indexOf("://") + 3) : url
  const authority = afterScheme.split("/", 1)[0] ?? ""
  return authority.includes("@")
}

/** ASCII alphanumerics, `-` and `_`, not starting with `-` (digit-leading names are allowed). */
export const isValidPackageName = (name: string) => /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)

/**
 * The KCL identifier a dependency key imports as: every character outside
 * `[A-Za-z0-9_]` becomes `_`, and a leading digit gets a `_` prefix.
 */
export const kclIdent = (name: string) => {
  const ident = name.replace(/[^A-Za-z0-9_]/g, "_")
  return /^[0-9]/.test(ident) ? `_${ident}` : ident
}

/**
 * `akua.toml` as the previous release rewrote it: known fields only, in
 * field order, dependencies alphabetical, comments and unknown keys dropped.
 */
export const formatManifest = (manifest: Manifest) =>
  toToml(table([
    [
      "package",
      table([
        ["name", manifest.package.name],
        ["version", manifest.package.version],
        ["edition", manifest.package.edition],
        // Written only when set: the default depends on `[signing]`.
        ["strict_signing", manifest.package.strict_signing]
      ])
    ],
    ["workspace", manifest.workspace && table([["members", manifest.workspace.members ?? []]])],
    [
      "signing",
      manifest.signing && table([
        ["cosign_public_key", manifest.signing.cosign_public_key],
        ["cosign_private_key", manifest.signing.cosign_private_key]
      ])
    ],
    [
      "dependencies",
      table(dependencies(manifest).map(([name, dependency]) => [
        name,
        table([
          ["oci", dependency.oci],
          ["git", dependency.git],
          ["path", dependency.path],
          ["repo", dependency.repo],
          ["chart", dependency.chart],
          ["url", dependency.url],
          ["version", dependency.version],
          ["tag", dependency.tag],
          ["rev", dependency.rev],
          ["crds", dependency.crds],
          ["replace", dependency.replace && table([["path", dependency.replace.path]])]
        ])
      ]))
    ]
  ]))
