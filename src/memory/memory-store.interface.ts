import type { LlmMessage } from '../llm/llm-provider.interface';

/**
 * A message as held in the hot window / audit log. Extends the neutral LlmMessage
 * with bookkeeping: a stable id, its token count (from LlmProvider.countTokens),
 * a timestamp, and pinning flags.
 */
export interface StoredMessage extends LlmMessage {
  id: string;
  tokenCount: number;
  ts: number;
  /**
   * Pinned messages are never evicted from the window: the system prompt and the
   * running summary. Everything else is evictable oldest-first.
   */
  pinned?: boolean;
  /** Marks the single running-summary message (also pinned). */
  isSummary?: boolean;
}

/** The active context the agent operates on, assembled from the hot window. */
export interface ActiveContext {
  sessionId: string;
  messages: StoredMessage[];
  totalTokens: number;
}

/** Event emitted when the window crosses the summarization threshold. */
export interface ContextThresholdEvent {
  sessionId: string;
  totalTokens: number;
  contextLimit: number;
}

/** Internal event name for the in-process summarization trigger (Phase 1). */
export const CONTEXT_THRESHOLD_EVENT = 'context.threshold';

export interface MemoryStore {
  /** Append a message to the hot window AND durably to Mongo (source of truth). */
  append(sessionId: string, message: LlmMessage): Promise<StoredMessage>;

  /** Read the current active context (pinned + evictable messages, in order). */
  getActiveContext(sessionId: string): Promise<ActiveContext>;

  /** Current token total of the hot window. */
  getTokenCount(sessionId: string): Promise<number>;

  /**
   * Replace a contiguous run of the OLDEST evictable messages with a single
   * pinned summary message. Used by the summarization worker. Returns the new
   * total token count. Idempotent at the call level (guarded by a lock upstream).
   */
  replaceOldestWithSummary(
    sessionId: string,
    countToReplace: number,
    summaryText: string,
  ): Promise<number>;

  /** Set/replace the pinned system prompt for a session (never evicted). */
  setSystemPrompt(sessionId: string, content: string): Promise<void>;
}

export const MEMORY_STORE = Symbol('MEMORY_STORE');
