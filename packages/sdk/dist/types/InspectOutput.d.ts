import type { OciPackageInspectBody } from "./OciPackageInspectBody";
import type { PackageInspectBody } from "./PackageInspectBody";
import type { TarballInspectBody } from "./TarballInspectBody";
/**
 * Discriminated JSON shape. `kind: "package"|"tarball"|"oci_package"`
 * carries the variant; consumers parse one body and branch.
 */
export type InspectOutput = {
    "kind": "package";
} & PackageInspectBody | {
    "kind": "tarball";
} & TarballInspectBody | {
    "kind": "oci_package";
} & OciPackageInspectBody;
