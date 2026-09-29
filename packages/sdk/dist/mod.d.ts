import { type ExecuteOptions } from './execute';
import type { CheckOutput } from './types/CheckOutput';
import type { CheckResult } from './types/CheckResult';
import type { DirDiff } from './types/DirDiff';
import type { FileChange } from './types/FileChange';
import type { FmtFile } from './types/FmtFile';
import type { FmtOutput } from './types/FmtOutput';
import type { InspectOutput } from './types/InspectOutput';
import type { LintIssue } from './types/LintIssue';
import type { LintOutput } from './types/LintOutput';
import type { OciPackageInspectBody } from './types/OciPackageInspectBody';
import type { OptionInfo } from './types/OptionInfo';
import type { RenderSummary } from './types/RenderSummary';
import type { TreeOutput } from './types/TreeOutput';
import type { VendorAddOutput } from './types/VendorAddOutput';
import type { VendorCheckOutput } from './types/VendorCheckOutput';
import type { VendorListOutput } from './types/VendorListOutput';
import type { VerifyOutput } from './types/VerifyOutput';
import type { VersionOutput } from './types/VersionOutput';
import type { WhoamiOutput } from './types/WhoamiOutput';
export * from './errors';
export { configureNapi } from './napi';
export { execute } from './execute';
export type { ExecuteOptions } from './execute';
export type { NapiAddon } from './napi';
export { AkuaContractError, standardSchemaFor, validateAs } from './validate';
export type { SchemaName } from './validate';
export type { CheckOutput, CheckResult, DirDiff, FileChange, FmtFile, FmtOutput, InspectOutput, LintIssue, LintOutput, OciPackageInspectBody, OptionInfo, RenderSummary, TreeOutput, VendorAddOutput, VendorCheckOutput, VendorListOutput, VerifyOutput, VersionOutput, WhoamiOutput, };
export type { ExitCode } from './types/ExitCode';
export type { StructuredError } from './types/StructuredError';
export type { Level } from './types/Level';
export type { AgentContext } from './types/AgentContext';
export type { AgentSource } from './types/AgentSource';
export interface AkuaOptions {
}
export interface InspectOptions {
    /** Path to the `package.k` file. Default: `./package.k`. Mutually exclusive with `tarball`. */
    package?: string;
    /** Path to a `.tar.gz` Package artifact. Mutually exclusive with `package`. */
    tarball?: string;
}
export interface InspectOciPackageOptions {
    /** OCI repository ref without tag, for example `oci://ghcr.io/acme/packages/demo`. */
    ociRef: string;
    /** Published package tag/version to inspect. */
    tag: string;
    /**
     * Explicit OCI registry credentials, keyed by registry host
     * (`ghcr.io`, `registry.example.com:5000`). Omit for anonymous pulls.
     * The SDK does not read ambient Docker or Akua credential files.
     */
    auth?: Record<string, OciRegistryAuth>;
}
export type OciPackageInspectOutput = {
    kind: 'oci_package';
} & OciPackageInspectBody;
export type OciRegistryAuth = BasicAuth | BearerAuth;
export interface TreeOptions {
    /** Workspace root (dir containing `akua.toml`). Default: `.`. */
    workspace?: string;
}
/**
 * HTTP basic-auth credential pair. Sent as `Authorization: Basic
 * <base64(user:pass)>` to the matching private git remote during
 * vendor. For OCI registry inspection, Akua sends the credential to
 * the registry's bearer-token realm during token exchange.
 */
export interface BasicAuth {
    username: string;
    password: string;
}
export interface BearerAuth {
    token: string;
}
export interface VendorAddOptions {
    /** Workspace root (dir containing `akua.toml`). Default: `.`. */
    workspace?: string;
    /** Preview the add without writing the vendor tree. */
    plan?: boolean;
    /**
     * Credentials for private git remotes, keyed by URL prefix
     * (longest match wins — same rule as git's credential helper /
     * `.npmrc`). Akua never reads ambient credential files (`~/.netrc`,
     * `~/.docker/config.json`, env vars) — multi-tenant SDK consumers
     * require explicit auth.
     *
     * Examples:
     * ```ts
     * // Single host:
     * await akua.vendorAdd('upstream', {
     *   auth: {
     *     'akua-git.cnap.tech': { username: orgId, password: token }
     *   }
     * });
     *
     * // Per-org scoping (longest-prefix wins):
     * await akua.vendorAdd('upstream', {
     *   auth: {
     *     'akua-git.cnap.tech/org-A': { username: 'org-A', password: tokenA },
     *     'akua-git.cnap.tech/org-B': { username: 'org-B', password: tokenB }
     *   }
     * });
     * ```
     */
    auth?: Record<string, BasicAuth>;
}
export interface VendorWorkspaceOptions {
    /** Workspace root (dir containing `akua.toml`). Default: `.`. */
    workspace?: string;
}
export interface VerifyOptions {
    /** Workspace root. Default: `.`. */
    workspace?: string;
    /** Path to a `.tar.gz` Package artifact for offline verify. */
    tarball?: string;
    /** Override the cosign public key path from `akua.toml [signing]`. */
    publicKey?: string;
}
export interface AddOutput {
    name: string;
    source: string;
    source_ref: string;
    version?: string;
    replaced: boolean;
}
export interface AddOptions {
    /** Workspace root (dir containing `akua.toml`). Default: `.`. */
    workspace?: string;
    /** OCI source URL (e.g. `oci://ghcr.io/foo/charts/bar`). */
    oci?: string;
    /** Git source URL. */
    git?: string;
    /** Local filesystem path. */
    path?: string;
    /** HTTPS Helm-repo URL (pairs with `chart`). */
    repo?: string;
    /** Chart name within the Helm repo (required with `repo`). */
    chart?: string;
    /** Version constraint. Required for OCI and Helm-repo deps. */
    version?: string;
    /** Git tag (alternative to `rev`). */
    tag?: string;
    /** Git commit SHA (alternative to `tag`). */
    rev?: string;
    /** Overwrite an existing entry under `name` instead of erroring. */
    force?: boolean;
}
export interface CheckOptions {
    /** Workspace root (dir containing `akua.toml` + `akua.lock`). Default: `.`. */
    workspace?: string;
    /** Path to the `package.k` file. Default: `./package.k`. */
    package?: string;
}
export interface LintOptions {
    /** Path to the `package.k` file. Default: `./package.k`. */
    package?: string;
}
export interface ExportOptions {
    /** Path to the `package.k` file. Default: `./package.k`. */
    package?: string;
    /**
     * Output format. `json-schema` (default) emits raw JSON Schema 2020-12;
     * `openapi` wraps it as an OpenAPI 3.1 doc with the `Input` schema
     * under `components.schemas.Input`.
     */
    format?: 'json-schema' | 'openapi';
}
export interface FmtOptions {
    /** Path to the `package.k` file. Default: `./package.k`. */
    package?: string;
    /** Fail with user-error exit if any file needs reformatting. */
    check?: boolean;
    /** Print formatted output to stdout instead of writing in place. */
    stdout?: boolean;
}
export interface RenderOptions {
    /** Path to the `package.k` file. Default: `./package.k`. */
    package?: string;
    /** Inputs file (JSON or YAML). */
    inputs?: string;
    /** Root directory where rendered YAML files land. Default: `./deploy`. */
    out?: string;
    dryRun?: boolean;
    /** Reject raw-string plugin paths — every chart must come from a typed `charts.*` import. */
    strict?: boolean;
    /** Forbid network access during resolve; OCI deps must cache-hit. */
    offline?: boolean;
    /**
     * Wall-clock cap on the render. Go duration string —
     * `30s`, `5m`, `1h`, `250ms`. Mirrors the universal
     * `--timeout` flag; nested `pkg.render` calls inherit it.
     */
    timeout?: string;
    /**
     * Hard cap on `pkg.render` composition depth (default 16).
     * Hitting the cap surfaces `E_RENDER_BUDGET_DEPTH`. Pair with
     * `timeout` to harden CI / agent renders against runaways.
     */
    maxDepth?: number;
}
export interface RenderSourceOptions {
    /**
     * Raw KCL Package source. Mutually exclusive with `package`.
     */
    source?: string;
    /** Path to the Package.k on disk. */
    package?: string;
    /**
     * Diagnostic filename — only used when `source` is provided
     * directly (KCL surfaces it in error spans). Default `package.k`.
     */
    packageFilename?: string;
    /**
     * Workspace directory for resolving relative `helm.template` /
     * `kustomize.build` paths. Defaults to `dirname(package)` when
     * `package` is provided; required if the source uses either
     * plugin and `source` is given directly.
     */
    packageDir?: string;
    /**
     * Inputs to inject as KCL's `option("input")`. Pass any
     * JSON-serializable value, or omit for an empty mapping.
     */
    inputs?: unknown;
    /**
     * Wall-clock cap (Go duration). Same semantics as
     * [`RenderOptions.timeout`].
     */
    timeout?: string;
    /**
     * `pkg.render` composition depth cap. See
     * [`RenderOptions.maxDepth`].
     */
    maxDepth?: number;
}
/**
 * In-process akua client. Each method calls the `@akua-dev/native` napi
 * addon and returns a value typed by the ts-rs generated types. No
 * `akua` binary required, no subprocess. Failures throw the right
 * `AkuaError` subclass based on the parsed StructuredError.
 */
export declare class Akua {
    constructor(_opts?: AkuaOptions);
    version(): Promise<VersionOutput>;
    /**
     * Run any `akuapkg` command through the native package dispatcher.
     *
     * Pass command arguments only, for example
     * `['render', '--package', 'package.k']`. Output is streamed
     * directly by the native command, exactly as when invoking `akuapkg` in a
     * terminal; the resolved value is its documented numeric exit code. Set
     * `options.binName` when embedding it under another command path, such as
     * `akua pkg`, so generated help and usage text name that invocation.
     */
    execute(args: readonly string[], options?: ExecuteOptions): Promise<number>;
    whoami(): Promise<WhoamiOutput>;
    /**
     * Evaluate a Package against optional inputs and return the
     * rendered top-level YAML. Runs in-process via the napi addon.
     * Helm + Kustomize engine callouts (`helm.template`,
     * `kustomize.build`) resolve against the package's directory.
     */
    renderSource(opts: RenderSourceOptions): Promise<string>;
    /**
     * Insert a dependency into `akua.toml`. Mirrors `akuapkg add --<source>`.
     * Pass exactly one of `oci`, `git`, `path`, or `repo` (the latter
     * requires `chart` too). The manifest edit runs in-process via the
     * napi addon; the resolver best-effortly updates `akua.lock`.
     */
    add(name: string, opts?: AddOptions): Promise<AddOutput>;
    /**
     * Fast syntax / type / dep check over the workspace. Runs
     * in-process via the napi addon. Mirrors `akuapkg check`.
     */
    check(opts?: CheckOptions): Promise<CheckOutput>;
    /**
     * Run the KCL linter against the Package. In-process via the
     * napi addon. Mirrors `akuapkg lint`.
     */
    lint(opts?: LintOptions): Promise<LintOutput>;
    /**
     * Emit the Package's `Input` schema as JSON Schema 2020-12 (default)
     * or OpenAPI 3.1. In-process via WASM — no binary required. Returns
     * the parsed schema document; consumers feed it to UI form renderers
     * (rjsf, JSONForms), API doc tools, or admission-webhook validators.
     *
     * Field-level docstrings become `description`; `@ui(...)` decorators
     * become OpenAPI-3.1-compliant `x-ui` extensions. See
     * [`docs/cli.md`](https://github.com/akua-dev/akuapkg/blob/main/docs/cli.md#akuapkg-export)
     * for the full schema contract.
     */
    export(opts?: ExportOptions): Promise<Record<string, unknown>>;
    /**
     * Format KCL sources. In-process via the napi addon.
     * With `check=true`, reports which files would change without
     * touching disk. Without `check`, the formatted text is written
     * back to the file (mirroring `akuapkg fmt`'s in-place behavior).
     *
     * `opts.stdout` is honored by reading the (now-formatted) file
     * and writing it to `process.stdout`. The file write happens
     * either way because napi's fmt verb performs the write before
     * returning; restoring the original on stdout-mode would race
     * with concurrent readers.
     */
    fmt(opts?: FmtOptions): Promise<FmtOutput>;
    /**
     * Introspect a Package or a packed tarball — surfaces the option
     * set, dependency tree, signing metadata. Pass `{ package }` for
     * an on-disk Package or `{ tarball }` for a `.tar.gz` artifact
     * (e.g. from `akuapkg pack`).
     */
    inspect(opts?: InspectOptions): Promise<InspectOutput>;
    /**
     * Inspect a published Akua Package in an OCI registry without
     * extracting it to disk. Returns verified artifact digests,
     * package metadata, and the JSON Schema for the Package `Input`.
     */
    inspectOciPackage(opts: InspectOciPackageOptions): Promise<OciPackageInspectOutput>;
    /**
     * Print the workspace's declared deps + lockfile entries.
     * In-process via the napi addon.
     */
    tree(opts?: TreeOptions): Promise<TreeOutput>;
    /**
     * Materialize a declared dependency into `.akua/vendor/<name>/`.
     * With `plan=true`, computes the same output without mutating the
     * workspace.
     */
    vendorAdd(name: string, opts?: VendorAddOptions): Promise<VendorAddOutput>;
    /**
     * Compare the on-disk vendor tree against the manifest + lockfile
     * declaration. Returns a drift report; drift still yields a
     * structured output, not an exception.
     */
    vendorCheck(opts?: VendorWorkspaceOptions): Promise<VendorCheckOutput>;
    /**
     * Enumerate the vendor tree, including orphaned on-disk entries
     * that no manifest/lock entry currently references.
     */
    vendorList(opts?: VendorWorkspaceOptions): Promise<VendorListOutput>;
    /**
     * Verify `akua.toml` ↔ `akua.lock` integrity + cosign signatures +
     * SLSA attestations. Exit `1` signals at least one violation in
     * `out.violations`; the SDK returns the typed output either way.
     */
    verify(opts?: VerifyOptions): Promise<VerifyOutput>;
    /**
     * Structural diff between two directory trees of rendered
     * manifests. The napi addon walks both trees server-side and
     * compares hashes; no JS-side hashing.
     */
    diff(before: string, after: string): Promise<DirDiff>;
    render(opts?: RenderOptions): Promise<RenderSummary>;
}
