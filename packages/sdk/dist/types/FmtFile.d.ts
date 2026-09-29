export type FmtFile = {
    path: string;
    /**
     * True when the file's contents differ from the formatter's
     * output. Under `--check`, this flips the exit code to
     * [`ExitCode::UserError`]; without `--check`, the file is
     * rewritten in place.
     */
    changed: boolean;
};
