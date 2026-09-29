/**
 * Disposable scratch Package dir. Caller writes `package.k` via
 * `writeFileSync(join(pkg.dir, 'package.k'), ...)`, runs the render,
 * and relies on automatic cleanup via TC39 `using`:
 *
 * ```ts
 * using pkg = scratchPackage('akua-sdk-render-');
 * writeFileSync(join(pkg.dir, 'package.k'), PACKAGE_K);
 * await akua.render({ package: join(pkg.dir, 'package.k') });
 * // rmSync runs on scope exit.
 * ```
 */
export declare function scratchPackage(prefix?: string): {
    dir: string;
} & Disposable;
/**
 * Convenience: same as [`scratchPackage`] but pre-writes a
 * `package.k` with the given KCL source. Test + fixture in one
 * line.
 */
export declare function scratchPackageWith(packageK: string, prefix?: string): {
    dir: string;
} & Disposable;
/**
 * Minimal pure-KCL Package emitting one ConfigMap whose `data.count`
 * echoes `input.replicas` (default 2). Reused by every in-process
 * render test that doesn't need engine callouts.
 */
export declare const MINIMAL_PACKAGE_K = "\nschema Input:\n    replicas: int = 2\n\ninput: Input = option(\"input\") or Input {}\n\nresources = [{\n    apiVersion: \"v1\"\n    kind: \"ConfigMap\"\n    metadata.name: \"smoke\"\n    data.count: str(input.replicas)\n}]\n";
export declare function minimalAkuaToml(name?: string): string;
export declare const MINIMAL_AKUA_TOML: string;
export declare function largeCrdPackageK(count?: number, descriptionBytes?: number): string;
