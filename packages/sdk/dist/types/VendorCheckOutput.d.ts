import type { VendorCheckEntry } from "./VendorCheckEntry";
export type VendorCheckOutput = {
    drift: boolean;
    entries: Array<VendorCheckEntry>;
    orphaned: Array<string>;
    missing: Array<string>;
};
