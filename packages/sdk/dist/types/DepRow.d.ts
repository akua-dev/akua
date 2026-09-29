import type { LockedInfo } from "./LockedInfo";
export type DepRow = {
    name: string;
    /**
     * `"oci"` / `"git"` / `"path"` / `"unknown"`.
     */
    source: string;
    /**
     * The actual ref recorded in `akua.toml`.
     */
    source_ref: string;
    version?: string | null;
    /**
     * Lockfile row, present only when `akua.lock` exists and
     * contains a matching entry.
     */
    locked?: LockedInfo | null;
};
