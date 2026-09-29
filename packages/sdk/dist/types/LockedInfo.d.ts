export type LockedInfo = {
    digest: string;
    signature?: string | null;
    /**
     * Local fork override active for this dep. When set, the dep's
     * canonical source is whatever the manifest declared, but build-
     * time resolution reads files from `replaced_by`.
     */
    replaced_by?: string | null;
};
