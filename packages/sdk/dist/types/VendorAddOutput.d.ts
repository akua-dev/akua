export type VendorAddOutput = {
    name: string;
    source_kind: string;
    source_ref: string;
    path: string;
    digest: string;
    size_bytes: bigint;
    wrote: boolean;
    replaced: boolean;
};
