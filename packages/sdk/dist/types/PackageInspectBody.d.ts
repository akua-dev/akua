import type { OptionInfo } from "./OptionInfo";
export type PackageInspectBody = {
    path: string;
    options: Array<OptionInfo>;
};
