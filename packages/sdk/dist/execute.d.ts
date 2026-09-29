export interface ExecuteOptions {
    /** Invocation rendered by command help, usage, and parser errors. */
    binName?: string;
}
/** Run an Akuapkg command synchronously through the native dispatcher. */
export declare function execute(args: readonly string[], options?: ExecuteOptions): number;
