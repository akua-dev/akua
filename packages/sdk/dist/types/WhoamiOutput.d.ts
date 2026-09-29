import type { AgentContext } from "./AgentContext";
/**
 * Whoami response shape. Part of the stability contract — new fields
 * may be added (backward-compatible); existing field semantics never
 * change.
 */
export type WhoamiOutput = {
    /**
     * Agent-context detection result per cli-contract §1.5.
     */
    agent_context: AgentContext;
    /**
     * akua binary version (same as `akua --version`).
     */
    version: string;
};
