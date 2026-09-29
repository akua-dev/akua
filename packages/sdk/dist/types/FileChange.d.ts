export type FileChange = {
    path: string;
    /**
     * `sha256:<hex>` of the `before` file's contents.
     */
    before: string;
    /**
     * `sha256:<hex>` of the `after` file's contents.
     */
    after: string;
};
