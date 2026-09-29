/**
 * Which env var triggered agent detection. Recorded in `akua whoami`
 * output for introspection and in debug-level logs for post-hoc diagnosis.
 */
export type AgentSource = "agent" | "claude_code" | "gemini_cli" | "cursor_cli" | "akua_agent";
