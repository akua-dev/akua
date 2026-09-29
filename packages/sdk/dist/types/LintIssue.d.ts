/**
 * Structured issue reported by [`lint_kcl`]. Mirrors KCL's own
 * `Error.messages[*]` shape, flattened one-row-per-message so
 * consumers don't need to walk a two-level tree.
 */
export type LintIssue = {
    /**
     * `"Error"` or `"Warning"` as reported by KCL.
     */
    level: string;
    /**
     * KCL error code (e.g. `"E1001"`). Empty string when KCL emits no
     * code — preserved verbatim.
     */
    code: string;
    message: string;
    file: string | null;
    line: bigint | null;
    column: bigint | null;
};
