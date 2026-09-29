import type { CheckResult } from "./CheckResult";
/**
 * Output shape for `akua check --json`. The `status` field is
 * `"ok"` iff every entry in `checks` has `ok == true`.
 */
export type CheckOutput = {
    status: string;
    checks: Array<CheckResult>;
};
