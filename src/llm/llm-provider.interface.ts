/**
 * LlmProvider — the single seam through which ALL model interaction flows.
 *
 * Per the spec, the provider OWNS the tokenizer and model limits: token counting
 * and the context window are never hardcoded elsewhere. Drop in a second provider
 * by implementing this interface and registering it in llm.module.ts.
 */

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

/** A tool invocation requested by the model. */
export interface LlmToolCall {
  /** Provider-assigned id, echoed back when returning the result. */
  id: string;
  name: string;
  /** Already-parsed JSON arguments. Validation happens in the ToolRegistry. */
  input: Record<string, unknown>;
}

/** The result of executing a tool, fed back to the model on the next turn. */
export interface LlmToolResult {
  toolCallId: string;
  /** Text/JSON the model will read. Tool errors are surfaced here, not thrown. */
  content: string;
  isError?: boolean;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: LlmToolCall[];
  /** Present on tool-role messages carrying execution output. */
  toolResults?: LlmToolResult[];
}

/** A tool definition advertised to the model (name + JSON schema). */
export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object (we derive it from the tool's Zod schema). */
  inputSchema: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export type LlmStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence';

export interface LlmResponse {
  /** Final/assistant text (may be empty when the turn is purely tool calls). */
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  model: string;
}

export interface LlmCompleteOptions {
  system?: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  maxOutputTokens?: number;
  /** Per-call wall-clock budget; provider throws LlmTimeoutError on exceed. */
  timeoutMs?: number;
}

export interface LlmProvider {
  /** e.g. "anthropic" / "fake" — emitted as the `gen_ai.system` span attribute. */
  getSystemName(): string;
  /** Active model id — emitted as `gen_ai.request.model`. */
  getModel(): string;
  /** Max context window in tokens. Bounds the Redis sliding window. */
  getContextLimit(): number;
  /**
   * Token count for arbitrary text using the ACTIVE model's tokenizer.
   * Async because some providers (Anthropic) expose a remote count endpoint.
   */
  countTokens(text: string): Promise<number>;
  /** One model turn. Throws typed errors (timeout / rate-limit) on failure. */
  complete(options: LlmCompleteOptions): Promise<LlmResponse>;
}

/** DI token for the active LlmProvider. */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

// --- Typed errors (no silent catches; callers branch on these) ---------------

export class LlmTimeoutError extends Error {
  constructor(message = 'LLM request timed out') {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

export class LlmRateLimitError extends Error {
  /** Seconds to wait before retrying, if the provider supplied Retry-After. */
  readonly retryAfterMs?: number;
  constructor(message = 'LLM rate limited (429)', retryAfterMs?: number) {
    super(message);
    this.name = 'LlmRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}
