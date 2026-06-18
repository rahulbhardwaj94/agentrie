import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import {
  LLM_PROVIDER,
  type LlmMessage,
  type LlmProvider,
} from '../llm/llm-provider.interface';
import { AppConfigService } from '../config/app-config.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  CONTEXT_THRESHOLD_EVENT,
  type ActiveContext,
  type ContextThresholdEvent,
  type MemoryStore,
  type StoredMessage,
} from './memory-store.interface';
import { SessionRepository } from './session.repository';

/**
 * Token-aware sliding-window cache for active LLM context (Phase 1, REAL).
 *
 * DATA STRUCTURE — Redis LIST at key `ctx:{sessionId}`, each element a
 * JSON-serialized StoredMessage.
 *   Why a LIST and not a sorted set: the window is an *ordered append log* with
 *   FIFO eviction from the head. RPUSH (append), LRANGE (read all), and a
 *   DEL+RPUSH rewrite map directly onto that. A ZSET's score-ordering buys nothing
 *   here — order is already insertion order — and would complicate the atomic
 *   rewrite we do during eviction/summarization. Token counts are carried on each
 *   element (no separate score needed).
 *
 * TOKEN-AWARENESS — counts come from `LlmProvider.countTokens()` (the provider
 * owns the tokenizer; nothing here hardcodes one). The window is bounded by
 * `LlmProvider.getContextLimit()`.
 *
 * PINNING — the system prompt and the single running summary are `pinned` and
 * never evicted. Eviction removes the oldest NON-pinned message first.
 *
 * SOURCE OF TRUTH — every appended message is also written to Mongo via
 * SessionRepository. Redis is the hot cache; Mongo is durable.
 */
@Injectable()
export class RedisMemoryStore implements MemoryStore {
  private readonly logger = new Logger(RedisMemoryStore.name);
  /** Summarization fires when the window crosses this fraction of the limit. */
  private static readonly SUMMARIZE_THRESHOLD = 0.8;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly repo: SessionRepository,
    private readonly events: EventEmitter2,
    private readonly config: AppConfigService,
  ) {}

  private key(sessionId: string): string {
    return `ctx:${sessionId}`;
  }

  /** Debounce latch key: present == a threshold event already fired for this session. */
  private latchKey(sessionId: string): string {
    return `ctx:summarize-latch:${sessionId}`;
  }

  // --- low-level list helpers ------------------------------------------------

  private async loadAll(sessionId: string): Promise<StoredMessage[]> {
    const raw = await this.redis.lrange(this.key(sessionId), 0, -1);
    return raw.map((s) => JSON.parse(s) as StoredMessage);
  }

  /** Atomically replace the whole list (DEL + RPUSH in a MULTI). */
  private async rewrite(
    sessionId: string,
    messages: StoredMessage[],
  ): Promise<void> {
    const key = this.key(sessionId);
    const tx = this.redis.multi();
    tx.del(key);
    if (messages.length > 0) {
      tx.rpush(key, ...messages.map((m) => JSON.stringify(m)));
    }
    await tx.exec();
  }

  private total(messages: StoredMessage[]): number {
    return messages.reduce((sum, m) => sum + m.tokenCount, 0);
  }

  /** Serialize a message for token counting (content + any tool payloads). */
  private serializeForTokens(message: LlmMessage): string {
    let s = message.content ?? '';
    if (message.toolCalls?.length) s += JSON.stringify(message.toolCalls);
    if (message.toolResults?.length) s += JSON.stringify(message.toolResults);
    return s;
  }

  // --- MemoryStore API -------------------------------------------------------

  async setSystemPrompt(sessionId: string, content: string): Promise<void> {
    await this.repo.ensureSession(sessionId);
    const messages = await this.loadAll(sessionId);
    const tokenCount = await this.llm.countTokens(content);
    const systemMsg: StoredMessage = {
      id: randomUUID(),
      role: 'system',
      content,
      tokenCount,
      ts: Date.now(),
      pinned: true,
    };
    // Drop any existing system prompt; keep summary + the rest in order.
    const rest = messages.filter((m) => m.role !== 'system');
    await this.rewrite(sessionId, [systemMsg, ...rest]);
  }

  async append(
    sessionId: string,
    message: LlmMessage,
  ): Promise<StoredMessage> {
    await this.repo.ensureSession(sessionId);

    const tokenCount = await this.llm.countTokens(
      this.serializeForTokens(message),
    );
    const stored: StoredMessage = {
      ...message,
      id: randomUUID(),
      tokenCount,
      ts: Date.now(),
    };

    // Mongo is the source of truth — write it durably first.
    await this.repo.appendMessage(sessionId, stored);

    // Then push into the hot window.
    await this.redis.rpush(this.key(sessionId), JSON.stringify(stored));

    // Enforce the hard context bound: evict oldest evictable until under limit.
    await this.enforceWindowBound(sessionId);

    // Soft trigger: if still above 80%, fire the summarization event.
    await this.maybeTriggerSummarization(sessionId);

    return stored;
  }

  async getActiveContext(sessionId: string): Promise<ActiveContext> {
    const messages = await this.loadAll(sessionId);
    return { sessionId, messages, totalTokens: this.total(messages) };
  }

  async getTokenCount(sessionId: string): Promise<number> {
    return this.total(await this.loadAll(sessionId));
  }

  async replaceOldestWithSummary(
    sessionId: string,
    countToReplace: number,
    summaryText: string,
  ): Promise<number> {
    const messages = await this.loadAll(sessionId);

    const system = messages.filter((m) => m.role === 'system' && m.pinned);
    const evictable = messages.filter(
      (m) => !(m.role === 'system' && m.pinned) && !m.isSummary,
    );
    const remaining = evictable.slice(countToReplace);

    const tokenCount = await this.llm.countTokens(summaryText);
    const summaryMsg: StoredMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: summaryText,
      tokenCount,
      ts: Date.now(),
      pinned: true,
      isSummary: true,
    };

    // Single pinned summary placed right after the system prompt.
    const next = [...system, summaryMsg, ...remaining];
    await this.rewrite(sessionId, next);
    return this.total(next);
  }

  // --- internals -------------------------------------------------------------

  /**
   * Hard bound: while total tokens exceed the model's context limit, drop the
   * oldest evictable (non-pinned, non-summary) message. Evicted messages remain
   * in Mongo (source of truth) — only the hot cache shrinks.
   */
  private async enforceWindowBound(sessionId: string): Promise<void> {
    const limit = this.llm.getContextLimit();
    let messages = await this.loadAll(sessionId);
    let changed = false;

    while (this.total(messages) > limit) {
      const idx = messages.findIndex(
        (m) => !m.pinned && !m.isSummary && m.role !== 'system',
      );
      if (idx === -1) break; // only pinned content left; cannot evict further
      messages.splice(idx, 1);
      changed = true;
    }

    if (changed) {
      this.logger.warn(
        `Session ${sessionId}: window exceeded ${limit} tokens; evicted oldest messages`,
      );
      await this.rewrite(sessionId, messages);
    }
  }

  /**
   * Emit the in-process threshold event when tokens cross 80% of the limit.
   *
   * SEAM (implemented): the store always emits this in-process event. Which
   * listener acts is selected by SUMMARIZATION_TRANSPORT — `inprocess` runs the
   * SummarizationWorker directly; `sqs` has SummarizationPublisher forward it to
   * SNS so the SQS consumer drives the (transport-agnostic) worker. The store
   * stays decoupled from the transport, so no module cycle.
   *
   * DEBOUNCE: every append while the window sits above 80% would otherwise emit a
   * fresh event (the dedupeId carries totalTokens, which moves per append, so
   * transport dedup can't collapse them). A Redis latch with a cooldown TTL gates
   * the emit to once per crossing: `SET NX` wins only for the first append over the
   * line, and the latch is cleared the moment the window drops back under threshold
   * so the next genuine crossing re-fires immediately. The TTL self-heals a session
   * that stays stuck above threshold (slow/failed summarizer) by re-firing after the
   * cooldown.
   */
  private async maybeTriggerSummarization(sessionId: string): Promise<void> {
    const limit = this.llm.getContextLimit();
    const total = await this.getTokenCount(sessionId);

    if (total < limit * RedisMemoryStore.SUMMARIZE_THRESHOLD) {
      // Below threshold — re-arm so the next crossing fires immediately.
      await this.redis.del(this.latchKey(sessionId));
      return;
    }

    // Above threshold — emit only if we win the latch (first append over the line,
    // or the first after the cooldown TTL lapsed).
    const acquired = await this.redis.set(
      this.latchKey(sessionId),
      String(Date.now()),
      'PX',
      this.config.summarizeCooldownMs,
      'NX',
    );
    if (acquired !== 'OK') return; // a recent event already covers this crossing

    const payload: ContextThresholdEvent = {
      sessionId,
      totalTokens: total,
      contextLimit: limit,
    };
    this.events.emit(CONTEXT_THRESHOLD_EVENT, payload);
  }
}
