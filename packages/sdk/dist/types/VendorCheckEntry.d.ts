export type VendorCheckEntry = {
    name: string;
    path: string;
    source_kind: string | null;
    source_ref: string | null;
    expected_digest: string | null;
    actual_digest: string | null;
    orphan: boolean;
    missing_vendor: boolean;
    missing_source: boolean;
};
