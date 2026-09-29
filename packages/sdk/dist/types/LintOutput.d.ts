import type { LintIssue } from "./LintIssue";
export type LintOutput = {
    /**
     * `"ok"` when no issues reported; `"fail"` otherwise.
     */
    status: string;
    issues: Array<LintIssue>;
};
