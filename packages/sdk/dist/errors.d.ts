import type { ExitCode } from './types/ExitCode';
import type { StructuredError } from './types/StructuredError';
export interface AkuaErrorInit {
    structured?: StructuredError;
    exitCode?: ExitCode;
    rawExitCode?: number | null;
    cause?: unknown;
}
export declare class AkuaError extends Error {
    readonly structured: StructuredError | undefined;
    readonly exitCode: ExitCode | undefined;
    readonly rawExitCode: number | null;
    constructor(message: string, init?: AkuaErrorInit);
}
export declare class AkuaTransportError extends AkuaError {
    constructor(message: string, init?: AkuaErrorInit);
}
export type AkuaErrorSubclass = new (message: string, init?: Omit<AkuaErrorInit, 'exitCode'>) => AkuaError;
export declare const AkuaUserError: AkuaErrorSubclass;
export declare const AkuaSystemError: AkuaErrorSubclass;
export declare const AkuaPolicyDenyError: AkuaErrorSubclass;
export declare const AkuaRateLimitedError: AkuaErrorSubclass;
export declare const AkuaNeedsApprovalError: AkuaErrorSubclass;
export declare const AkuaTimeoutError: AkuaErrorSubclass;
/**
 * Shared exit-code → typed-subclass router. Used by both the
 * shell-out path (`classifyCliError`) and the napi path
 * (`parseNapiError`) so the same numeric code routes to the same
 * subclass regardless of transport.
 */
export declare function classifyByExitCode(rawExitCode: number): AkuaErrorSubclass | undefined;
/**
 * Shape predicate for the structured-error envelope CLI verbs emit.
 * Returns true iff `parsed` carries the load-bearing `code` +
 * `message` string fields. Used by both `parseStructuredError`
 * (multi-line stderr scan) and `parseNapiError` (single-message JSON).
 */
export declare function isStructuredErrorShape(parsed: unknown): parsed is StructuredError;
export declare function parseStructuredError(stderr: string | undefined): StructuredError | undefined;
export declare function classifyCliError(input: {
    rawExitCode: number | null;
    stderr: string | undefined;
    cause?: unknown;
}): AkuaError;
