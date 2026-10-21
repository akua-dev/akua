/**
 * Every structured error code akuapkg reports, with what it means. The CLI
 * reference generator renders one page per entry (`docs/akua/errors/<code>`),
 * which is where each error's `docs` link points, so an entry is required
 * for every code a verb can return.
 */

export interface ErrorCatalogEntry {
  readonly code: string
  readonly section: string
  readonly summary: string
  /** How to resolve it, as Markdown, when that is not obvious from the summary. */
  readonly fix?: string
}

export const ERROR_CATALOG: ReadonlyArray<ErrorCatalogEntry> = [
  // Manifest and lockfile
  {
    code: "E_MANIFEST_MISSING",
    section: "Manifest and lockfile",
    summary:
      "The workspace has no `akua.toml`. Run the command from the Package directory, pass `--workspace`, or create one with `akua pkg init`."
  },
  {
    code: "E_MANIFEST_PARSE",
    section: "Manifest and lockfile",
    summary:
      "`akua.toml` is not valid TOML or does not match the manifest format: an unknown or missing field, an invalid package name, or a dependency with more than one source."
  },
  {
    code: "E_MANIFEST_GIT_USERINFO",
    section: "Manifest and lockfile",
    summary:
      "A `git` dependency URL embeds credentials (a `user:password@` part before the host). It is rejected so the secret never reaches the lockfile or git history; pass credentials with `--auth` or `--auth-file` instead.",
    fix: [
      "Strip the credentials from the URL in `akua.toml`:",
      "",
      "```toml",
      "[dependencies]",
      "upstream = { git = \"https://github.com/myco/private\", tag = \"v1\" }",
      "```",
      "",
      "Then pass them at the call site, keyed by URL prefix (the longest matching prefix wins):",
      "",
      "```sh",
      "akua pkg vendor add upstream --auth github.com/myco=alice:$GH_TOKEN",
      "```"
    ].join("\n")
  },
  {
    code: "E_MANIFEST_HELM_MISSING_CHART",
    section: "Manifest and lockfile",
    summary: "A `repo` (HTTPS Helm repository) dependency is missing the required `chart` field."
  },
  {
    code: "E_MANIFEST_HELM_MISSING_VERSION",
    section: "Manifest and lockfile",
    summary:
      "A `repo` dependency is missing the required `version` field. A version constraint is mandatory so renders stay reproducible."
  },
  {
    code: "E_MANIFEST_HELM_USERINFO",
    section: "Manifest and lockfile",
    summary:
      "A `repo` dependency URL embeds credentials. It is rejected so the secret never reaches the lockfile or git history; pass credentials with `--auth` or `--auth-file` instead."
  },
  {
    code: "E_MANIFEST_HELM_CHART_INVALID",
    section: "Manifest and lockfile",
    summary:
      "A `repo` dependency's `chart` contains a path separator or `..`. A chart name must be a single plain name, which keeps the chart cache free of path confusion."
  },
  {
    code: "E_MANIFEST_OCI_USERINFO",
    section: "Manifest and lockfile",
    summary:
      "An `oci` dependency URL embeds credentials (a `user:password@` part before the host). Pass credentials with `--auth`, `--auth-file` or `auth.toml` instead."
  },
  {
    code: "E_MANIFEST_CRDS_INVALID",
    section: "Manifest and lockfile",
    summary:
      "A CRD dependency is declared wrong: a `url` source without `crds = true`, a `url` that is not `https://` or that sets `version`, `tag` or `rev`, or a `crds` path that is absolute or climbs out of the source with `..`.",
    fix: [
      "A `url` dependency is one CRD manifest file, pinned by digest in `akua.lock`; a `crds` path is relative to the source:",
      "",
      "```toml",
      "[dependencies]",
      "cert-manager = { url = \"https://github.com/cert-manager/cert-manager/releases/download/v1.16.0/cert-manager.crds.yaml\", crds = true }",
      "prometheus = { git = \"https://github.com/prometheus-operator/prometheus-operator\", tag = \"v0.80.0\", crds = \"example/prometheus-operator-crd\" }",
      "```"
    ].join("\n")
  },
  {
    code: "E_LOCK_MISSING",
    section: "Manifest and lockfile",
    summary: "The workspace has no `akua.lock`. Run `akua pkg lock` to create it."
  },
  {
    code: "E_LOCK_PARSE",
    section: "Manifest and lockfile",
    summary: "`akua.lock` is not valid TOML or does not match the lockfile format. Regenerate it with `akua pkg lock`."
  },
  {
    code: "E_LOCK_DRIFT",
    section: "Manifest and lockfile",
    summary:
      "`akua lock --check` found `akua.lock` out of sync with `akua.toml`. Run `akua pkg lock` without `--check` to refresh it."
  },
  {
    code: "E_DEP_KIND_MISMATCH",
    section: "Manifest and lockfile",
    summary:
      "`package.k` imports a dependency alias whose kind KCL cannot import, typically a Helm chart alias used as `import <alias>`. Charts are reached through `charts.<alias>`."
  },
  {
    code: "E_DEP_RESOLVE",
    section: "Manifest and lockfile",
    summary:
      "A dependency in `akua.toml` failed to resolve: a missing path, a path outside the workspace, an OCI, Helm or git fetch failure, or a digest that disagrees with `akua.lock`."
  },
  {
    code: "E_CRDS_INVALID",
    section: "Manifest and lockfile",
    summary:
      "A CRD dependency yields no typed schemas: its `crds` path names nothing in the source, the files under it hold no `CustomResourceDefinition`, a CRD is malformed, or two files define the same kind and version differently.",
    fix:
      "Point `crds` at the directory or file that holds the CRDs (for a Helm chart, `crds = true` reads `crds/` and the templates), and narrow it when the source carries several copies of the same CRD."
  },
  {
    code: "E_CRDS_STALE",
    section: "Manifest and lockfile",
    summary:
      "The generated schemas under `.akua/crds/<name>/` were made from another source, version, `crds` path or digest than `akua.toml` and `akua.lock` declare now, typically after editing `akua.toml` by hand, or their files no longer match the `crds_digest` `akua.lock` records (an edited schema, or a lock written before that field). Rendering refuses them instead of typing resources against the wrong schemas; `akua pkg lock --check` also reports a directory that is missing or differs from what `lock` would write.",
    fix: "Run `akua pkg lock` to resolve the dependency again and regenerate `.akua/crds/`, then commit both."
  },
  {
    code: "E_AUTH_PARSE",
    section: "Manifest and lockfile",
    summary:
      "An `--auth <prefix>=<user>:<password>` value or an `--auth-file` TOML payload did not parse. Distinct from `E_INVALID_FLAG` so callers can branch on credential input specifically.",
    fix: [
      "Each `--auth` value is one credential, keyed by URL prefix; repeat the flag for more hosts:",
      "",
      "```sh",
      "akua pkg vendor add upstream --auth github.com/myco=alice:$GH_TOKEN",
      "```",
      "",
      "An `--auth-file` holds the same credentials under an `[auth]` table. Flag values override file entries for the same prefix:",
      "",
      "```toml",
      "[auth]",
      "\"github.com/myco\" = { username = \"alice\", password = \"<token>\" }",
      "```"
    ].join("\n")
  },
  // Rendering
  {
    code: "E_PACKAGE_MISSING",
    section: "Rendering",
    summary:
      "The Package file (default `./package.k`) or a directory the command needs does not exist. Pass the path explicitly or run from the Package directory."
  },
  {
    code: "E_PACKAGE_PARSE",
    section: "Rendering",
    summary:
      "`package.k` does not have the shape a Package needs, for example no top-level `resources` list or an `Input` schema KCL cannot load."
  },
  {
    code: "E_INPUTS_MISSING",
    section: "Rendering",
    summary:
      "The inputs file passed with `--inputs` does not exist or cannot be read. The message carries the operating system's reason."
  },
  {
    code: "E_INPUTS_PARSE",
    section: "Rendering",
    summary: "The inputs file passed with `--inputs` (or found next to the Package) is not valid JSON or YAML."
  },
  {
    code: "E_INVALID_FLAG",
    section: "Rendering",
    summary:
      "A command-line flag or argument did not parse: an unknown flag, a missing value, or a value of the wrong shape. Distinct from `E_INPUTS_PARSE`, which is about the inputs file."
  },
  {
    code: "E_RENDER_KCL",
    section: "Rendering",
    summary:
      "The Package's KCL failed: a syntax or type error, a failed `check:` block, or an engine call (Helm, Kustomize, `pkg.render`) that returned an error."
  },
  {
    code: "E_PATH_ESCAPE",
    section: "Rendering",
    summary:
      "A path an engine call received resolved outside the Package directory, through `..` or a symlink. The sandbox refuses it; reference files inside the Package or through a typed dependency.",
    fix: [
      "Declare what the Package needs in `akua.toml` and reach it by its alias; Package code never writes a filesystem path:",
      "",
      "```toml",
      "[dependencies]",
      "upstream = { path = \"./vendor/upstream\" }",
      "webapp = { oci = \"oci://ghcr.io/acme/webapp\", version = \"1.2.0\" }",
      "```",
      "",
      "`path` dependencies must stay inside the workspace. Symlinks do not get around the check: paths are resolved before they are compared."
    ].join("\n")
  },
  {
    code: "E_RENDER_CYCLE",
    section: "Rendering",
    summary:
      "`pkg.render` re-entered a Package that is already being rendered: a composition cycle. It is caught before the inner Package loads."
  },
  {
    code: "E_RENDER_BUDGET_DEPTH",
    section: "Rendering",
    summary:
      "Nested `pkg.render` calls exceeded the render-stack depth cap. Hitting it usually means runaway composition rather than a deep but legitimate tree."
  },
  {
    code: "E_RENDER_BUDGET_DEADLINE",
    section: "Rendering",
    summary:
      "The render ran out of its CPU budget before finishing: the Package's own KCL, or its Helm and Kustomize calls, which share one budget per render however many there are. The command exits 6, the timeout exit code."
  },
  {
    code: "E_RENDER_BUDGET_MEMORY",
    section: "Rendering",
    summary:
      "The render's sandbox reached its memory cap and was stopped, or a Helm or Kustomize call returned more than the host accepts from an engine (64 MiB)."
  },
  {
    code: "E_STRICT_UNTYPED_CHART",
    section: "Rendering",
    summary:
      "`akua pkg render --strict` found an engine call given a raw chart path instead of a typed `charts.<alias>` dependency. Declare the chart in `akua.toml` and reference it through its alias."
  },
  {
    code: "E_COSIGN_VERIFY",
    section: "Rendering",
    summary:
      "A cosign signature failed verification, or its payload disagrees with the fetched digest. Treat it as tampering until proven otherwise."
  },
  {
    code: "E_COSIGN_SIG_MISSING",
    section: "Rendering",
    summary:
      "A cosign public key is configured but the registry has no `.sig` sidecar for the artifact, or it is malformed: the publisher has not signed this version. Offline, it also means `akua.lock` does not record the configured key for a cached dependency; run `akua pkg lock` online to verify and record it."
  },
  // Commands
  {
    code: "E_INIT_EXISTS",
    section: "Commands",
    summary:
      "`akua pkg init` would overwrite `akua.toml`, `package.k` or `inputs.example.yaml`. Pass `--force` to overwrite, or choose another directory."
  },
  {
    code: "E_INIT_EMPTY_NAME",
    section: "Commands",
    summary:
      "`akua pkg init` could not derive a package name: the directory name has no usable characters. Pass a name explicitly."
  },
  {
    code: "E_FMT_KCL",
    section: "Commands",
    summary: "`akua pkg fmt` could not parse the file it was asked to format."
  },
  {
    code: "E_LINT_FAIL",
    section: "Commands",
    summary: "`akua pkg lint` found the Package's KCL does not parse or imports something that does not resolve."
  },
  {
    code: "E_INSPECT_FAIL",
    section: "Commands",
    summary:
      "`akua pkg inspect` could not read the Package's input surface: the KCL does not load, a tarball has no `package.k`, or the exported schema is not an object."
  },
  {
    code: "E_DIFF_NOT_DIR",
    section: "Commands",
    summary: "An argument to `akua pkg diff` is a file or a symlink, not a directory."
  },
  {
    code: "E_ADD_DEP_EXISTS",
    section: "Commands",
    summary: "`akua pkg add` was given an alias `akua.toml` already declares. Remove it first or pick another alias."
  },
  {
    code: "E_ADD_INVALID_DEP",
    section: "Commands",
    summary:
      "`akua pkg add` or `akua pkg update` was given a dependency that is not valid: no source, more than one source, or a field the source kind does not allow."
  },
  {
    code: "E_REMOVE_NOT_FOUND",
    section: "Commands",
    summary: "`akua pkg remove` was given an alias `akua.toml` does not declare. Pass `--ignore-missing` to make that a no-op."
  },
  {
    code: "E_VENDOR_DEP_MISSING",
    section: "Commands",
    summary: "`akua pkg vendor add` was given an alias `akua.toml` does not declare."
  },
  {
    code: "E_VENDOR_DRIFT",
    section: "Commands",
    summary:
      "`akua pkg vendor check` found a vendored tree under `.akua/vendor/` whose contents no longer match the digest `akua.lock` pins. Re-run `akua pkg vendor add`."
  },
  // Distribution
  {
    code: "E_PUBLISH_FAILED",
    section: "Distribution",
    summary:
      "`akua pkg publish` or `akua pkg push` could not upload the artifact: the registry rejected authentication, an upload request failed, or the manifest was refused."
  },
  {
    code: "E_PULL_FAILED",
    section: "Distribution",
    summary: "`akua pkg pull` or `akua pkg inspect --oci` could not retrieve or unpack the requested artifact."
  },
  // General
  {
    code: "E_IO",
    section: "General",
    summary:
      "A file or directory could not be read or written. The message carries the operating system's reason, such as a permission denial."
  }
]
