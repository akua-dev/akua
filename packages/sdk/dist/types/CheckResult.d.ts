import type { LintIssue } from "./LintIssue";
/**
 * One structural gate's verdict. `name` is the gate label:
 * `"manifest"`, `"lockfile"`, `"package"`.
 */
export type CheckResult = {
    name: string;
    ok: boolean;
    /**
     * One-line error from the failing check. `#[serde(default)]` is
     * load-bearing — schemars uses it to mark the field optional.
     */
    error?: string | null;
    /**
     * Per-file KCL lint issues — only the `"package"` check
     * populates this; the other gates leave it empty.
     */
    issues?: Array<LintIssue>;
};
