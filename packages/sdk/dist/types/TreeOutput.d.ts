import type { DepRow } from "./DepRow";
import type { PackageInfo } from "./PackageInfo";
/**
 * Output shape for `akua tree --json`.
 */
export type TreeOutput = {
    package: PackageInfo;
    dependencies: Array<DepRow>;
};
