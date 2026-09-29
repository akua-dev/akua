export type OciPackageInspectBody = {
    oci_ref: string;
    tag: string;
    manifest_digest: string;
    layer_digest: string;
    compressed_size_bytes: bigint;
    uncompressed_size_bytes: bigint;
    file_count: number;
    package_name: string | null;
    package_version: string | null;
    package_edition: string | null;
    vendored_deps: Array<string>;
    input_schema: {
        type: "object";
    } & Record<string, unknown>;
};
