import type { ToolScope } from '../tools/tool.interface';

/** Input to a single agent run. */
export interface AgentRunInput {
  sessionId: string;
  /** The user's prompt for this turn. */
  prompt: string;
  /** Optional system prompt; pinned in the window if provided. */
  system?: string;
  /** Per-run guardrail overrides (otherwise config defaults apply). */
  guardrails?: Partial<AgentGuardrails>;
  /**
   * Per-run narrowing of the exposed tool set, on top of the registry allowlist.
   * Omit for the full registry. Gates both what the model is shown and what it can
   * execute.
   */
  tools?: ToolScope;
}

/** Hard-stop guardrails. On trip, the runner returns a terminal result. */
export interface AgentGuardrails {
  maxIterations: number;
  maxToolCalls: number;
  /** Wall-clock budget for the whole run. */
  timeoutMs: number;
}

export type AgentTerminalStatus =
  | 'completed' // model produced a final answer
  | 'max_iterations' // hit the iteration ceiling
  | 'max_tool_calls' // hit the tool-call ceiling
  | 'timeout' // wall-clock budget exceeded
  | 'error'; // unrecoverable error (captured, not thrown)

/** Structured terminal result — the runner NEVER throws into the void. */
export interface AgentTerminalResult {
  status: AgentTerminalStatus;
  sessionId: string;
  /** Final assistant text (best-effort; may be partial on a guardrail trip). */
  answer: string;
  iterations: number;
  toolCalls: number;
  /** Set when status === 'error'. */
  error?: string;
}
