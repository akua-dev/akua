import { AkuaError } from './errors';
import type { StructuredError } from './types/StructuredError';
export interface NapiStructuredError extends StructuredError {
    exit_code?: number;
}
/**
 * Parse a thrown error from the napi addon and rebuild it as the
 * matching SDK `AkuaError` subclass. Returns `undefined` when the
 * thrown error isn't shaped like a napi structured error (e.g. it
 * was thrown by JS code outside the addon, or napi failed to
 * serialize the structured error at all).
 */
export declare function parseNapiError(err: unknown): AkuaError | undefined;
