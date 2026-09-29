import { type NapiStructuredError } from './napi-error';
/**
 * Mirror of the typed shape `crates/akua-napi/index.d.ts` exports.
 * Keep the field set in sync with the Rust `Napi*Args` structs;
 * unfortunately we can't import the generated `index.d.ts` directly
 * because it's auto-generated and may not exist at SDK type-check
 * time before the addon has been built.
 */
export interface NapiAddon {
    /** Runs the complete package CLI parser/dispatcher in-process. */
    execute(args: string[], options?: {
        binName?: string;
    }): number;
    version(): unknown;
    render(args: {
        package: string;
        inputs?: string;
        out: string;
        dryRun?: boolean;
        strict?: boolean;
        offline?: boolean;
        timeout?: string;
        maxDepth?: number;
    }): unknown;
    renderToYaml(args: {
        package: string;
        inputs?: string;
        out: string;
        dryRun?: boolean;
        strict?: boolean;
        offline?: boolean;
        timeout?: string;
        maxDepth?: number;
    }): string;
    add(args: {
        workspace: string;
        name: string;
        oci?: string;
        git?: string;
        path?: string;
        repo?: string;
        chart?: string;
        version?: string;
        tag?: string;
        rev?: string;
        force?: boolean;
    }): unknown;
    lint(args: {
        package: string;
    }): unknown;
    fmt(args: {
        package: string;
        check?: boolean;
        stdout?: boolean;
    }): unknown;
    check(args: {
        workspace: string;
        package?: string;
    }): unknown;
    tree(args: {
        workspace: string;
    }): unknown;
    diff(args: {
        before: string;
        after: string;
    }): unknown;
    export(args: {
        package: string;
        format?: 'json-schema' | 'openapi';
        out?: string;
    }): unknown;
    verify(args: {
        workspace: string;
    }): unknown;
    whoami(): unknown;
    inspect(args: {
        package?: string;
        tarball?: string;
    }): unknown;
    inspectOciPackage(args: {
        ociRef: string;
        tag: string;
        auth?: Record<string, {
            username?: string;
            password?: string;
            token?: string;
        }>;
    }): unknown;
    vendorAdd(args: {
        workspace: string;
        name: string;
        plan?: boolean;
        auth?: Record<string, {
            username: string;
            password: string;
        }>;
    }): unknown;
    vendorCheck(args: {
        workspace: string;
    }): unknown;
    vendorList(args: {
        workspace: string;
    }): unknown;
}
/**
 * Configure the native addon before the first SDK call.
 *
 * This is for embedders that ship one known platform binding inside their
 * executable. Normal SDK consumers should not call it: `loadNapi()` resolves
 * `@akua-dev/native` and its platform package automatically.
 */
export declare function configureNapi(addon: NapiAddon): void;
/**
 * Lazy-load and cache the napi addon for the host platform.
 * Resolution order matches what `@napi-rs/cli`'s generated stub does
 * (env override → co-located → scoped per-platform package), with a
 * dev-mode fallback to the workspace's `crates/akua-napi/index.js`.
 */
export declare function loadNapi(): NapiAddon;
/**
 * Wrap a napi addon call so the structured-error JSON the Rust side
 * embeds in the thrown error's message gets parsed and re-thrown as
 * the typed SDK error subclass — preserving the `code` /
 * `E_PACKAGE_MISSING`-style routing the CLI shell-out path used to
 * provide via stderr.
 */
export declare function callNapi<T>(invoke: () => unknown): T;
export type { NapiStructuredError };
