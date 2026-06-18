import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AppConfigService } from '../config/app-config.service';
import {
  LLM_PROVIDER,
  type LlmProvider,
} from '../llm/llm-provider.interface';
import { LOCK_SERVICE, type LockService } from '../lock/lock.interface';
import {
  CONTEXT_THRESHOLD_EVENT,
  type ContextThresholdEvent,
} from './memory-store.interface';
import { RedisMemoryStore } from './redis-memory.store';
import { SessionRepository } from './session.repository';

/**
 * Async background summarization worker (Phase 1, REAL).
 *
 * Trigger: `context.threshold` event, emitted when the hot window crosses 80% of
 * the model's context limit (RedisMemoryStore).
 *
 * Strategy: summarize the OLDEST evictable HALF of the window via an LlmProvider
 * call, persist the summary to Mongo (durable), then replace those messages in
 * the Redis window with a single pinned summary and recompute the token count.
 *
 * Concurrency/idempotency: guarded by the Redis LOCK_SERVICE keyed
 * `summarize:{sessionId}`. Concurrent threshold events for the same session no-op
 * if the lock is held (treated as already-in-progress). The lock is the SAME
 * primitive used for Phase 2 SQS idempotency.
 *
 * SEAM: this is invoked in-process now. To run it as an SQS-driven worker, point
 * the @OnEvent emit (in RedisMemoryStore) at SQS and have a consumer call
 * `summarizeSession(sessionId)` — the body below is transport-agnostic.
 */
@Injectable()
export class SummarizationWorker {
  private readonly logger = new Logger(SummarizationWorker.name);

  constructor(
    private readonly store: RedisMemoryStore,
    private readonly repo: SessionRepository,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(LOCK_SERVICE) private readonly lock: LockService,
    private readonly config: AppConfigService,
  ) {}

  @OnEvent(CONTEXT_THRESHOLD_EVENT, { async: true, promisify: true })
  async handleThreshold(event: ContextThresholdEvent): Promise<void> {
    if (this.config.isSummarizationSqs) {
      // SQS mode: SummarizationPublisher forwards this to the queue, and the SQS
      // consumer calls summarizeSession. Don't also run it in-process.
      return;
    }
    await this.summarizeSession(event.sessionId);
  }

  /**
   * Summarize the oldest evictable half of a session's window. Safe to call
   * concurrently — the lock ensures only one summarization runs per session.
   */
  async summarizeSession(sessionId: string): Promise<void> {
    const lockKey = `summarize:${sessionId}`;
    const handle = await this.lock.acquire(lockKey, this.config.lockTtlMs);
    if (!handle) {
      // Already summarizing this session — idempotent no-op.
      this.logger.debug(`Summarization already in progress for ${sessionId}`);
      return;
    }

    try {
      const ctx = await this.store.getActiveContext(sessionId);
      const evictable = ctx.messages.filter(
        (m) => !m.pinned && !m.isSummary && m.role !== 'system',
      );
      if (evictable.length < 2) {
        // Nothing meaningful to compact.
        return;
      }

      const half = Math.max(1, Math.floor(evictable.length / 2));
      const toSummarize = evictable.slice(0, half);

      // Include any existing running summary so the new one subsumes it (keeps the
      // "single pinned summary" invariant — see RedisMemoryStore).
      const existingSummary = ctx.messages.find((m) => m.isSummary);

      const transcript = [
        existingSummary
          ? `Prior summary:\n${existingSummary.content}\n`
          : '',
        'Conversation to summarize:',
        ...toSummarize.map((m) => `${m.role}: ${m.content}`),
      ].join('\n');

      const response = await this.llm.complete({
        // The "SUMMARIZER" marker lets the FakeLlmProvider produce a summary-shaped
        // response deterministically; real providers just read it as instructions.
        system:
          'SUMMARIZER: Produce a concise summary of the conversation below, ' +
          'preserving facts, decisions, and open questions. Output only the summary.',
        messages: [{ role: 'user', content: transcript }],
        maxOutputTokens: this.config.llmMaxOutputTokens,
        timeoutMs: this.config.llmTimeoutMs,
      });

      const summaryText = response.text.trim() || '(summary unavailable)';

      // Persist durably to Mongo (source of truth) before mutating the hot cache.
      await this.repo.appendSummary(sessionId, {
        content: summaryText,
        tokenCount: response.usage.outputTokens,
        replacedCount: toSummarize.length,
        ts: Date.now(),
      });

      // Replace the oldest half in the Redis window with the single pinned summary.
      const newTotal = await this.store.replaceOldestWithSummary(
        sessionId,
        half,
        summaryText,
      );

      this.logger.log(
        `Summarized ${half} messages for ${sessionId}; window now ${newTotal} tokens`,
      );
    } catch (err) {
      // No silent catch — log with context. Window is unchanged on failure, so a
      // later threshold event will retry.
      this.logger.error(
        `Summarization failed for ${sessionId}: ${(err as Error).message}`,
      );
    } finally {
      await this.lock.release(handle);
    }
  }
}
