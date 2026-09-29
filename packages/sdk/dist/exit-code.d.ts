import type { ExitCode } from './types/ExitCode';
/** Map `child.exitCode` → the typed name, or `undefined` for unknown codes. */
export declare function exitCodeFromNumber(n: number | null): ExitCode | undefined;
