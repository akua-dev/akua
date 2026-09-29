import type { Summary } from "./Summary";
import type { Violation } from "./Violation";
/**
 * Verify verdict JSON shape. Stable across releases.
 */
export type VerifyOutput = {
    /**
     * `"ok"` when everything checks out; `"fail"` otherwise. Derived
     * from `violations.is_empty()`.
     */
    status: string;
    summary: Summary;
    /**
     * Structured violations. Empty when `status == "ok"`.
     */
    violations: Array<Violation>;
};
