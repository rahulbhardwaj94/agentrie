import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AppConfigService } from '../src/config/app-config.service';
import { RedlockService } from '../src/lock/redlock.service';
import {
  CONTEXT_THRESHOLD_EVENT,
  type ContextThresholdEvent,
} from '../src/memory/memory-store.interface';
import { RedisMemoryStore } from '../src/memory/redis-memory.store';
import type { SessionRepository } from '../src/memory/session.repository';
import { SummarizationWorker } from '../src/memory/summarization.worker';
import { FakeRedis } from './helpers/fake-redis';
import { TestLlmProvider, makeRepoStub } from './helpers/fakes';

const configStub = {
  lockTtlMs: 5_000,
  llmMaxOutputTokens: 100,
  llmTimeoutMs: 1_000,
  summarizeCooldownMs: 30_000,
} as AppConfigService;

describe('Summarization (Phase 1 trigger + worker)', () => {
  const SESSION = 'summ-1';
  const CONTEXT_LIMIT = 20; // 80% threshold = 16 tokens

  let redis: FakeRedis;
  let llm: TestLlmProvider;
  let repo: ReturnType<typeof makeRepoStub>;
  let emitter: EventEmitter2;
  let store: RedisMemoryStore;

  beforeEach(() => {
    redis = new FakeRedis();
    llm = new TestLlmProvider(CONTEXT_LIMIT, async () => ({
      text: 'CONDENSED SUMMARY',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 2 },
      model: 'test-model',
    }));
    repo = makeRepoStub();
    emitter = new EventEmitter2();
    store = new RedisMemoryStore(
      redis as unknown as never,
      llm,
      repo as unknown as SessionRepository,
      emitter,
      configStub,
    );
  });

  it('emits context.threshold when the window crosses 80% of the limit', async () => {
    const events: ContextThresholdEvent[] = [];
    emitter.on(CONTEXT_THRESHOLD_EVENT, (e: ContextThresholdEvent) =>
      events.push(e),
    );

    // 3 messages * 5 tokens = 15 (<16): no trigger yet.
    await store.append(SESSION, { role: 'user', content: 'a b c d e' });
    await store.append(SESSION, { role: 'user', content: 'f g h i j' });
    await store.append(SESSION, { role: 'user', content: 'k l m n o' });
    expect(events).toHaveLength(0);

    // 4th message -> 20 tokens (>=16): trigger fires.
    await store.append(SESSION, { role: 'user', content: 'p q r s t' });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1].sessionId).toBe(SESSION);
  });

  it('summarizes the oldest half and replaces it with a single pinned summary', async () => {
    const lock = new RedlockService([redis as unknown as never]);
    const worker = new SummarizationWorker(store, repo as never, llm, lock, configStub);

    for (let i = 0; i < 6; i++) {
      await store.append(SESSION, { role: 'user', content: `m${i} x y` }); // 3 tokens
    }

    await worker.summarizeSession(SESSION);

    const ctx = await store.getActiveContext(SESSION);
    const summaries = ctx.messages.filter((m) => m.isSummary);
    expect(summaries).toHaveLength(1); // single pinned summary
    expect(summaries[0].pinned).toBe(true);
    expect(summaries[0].content).toBe('CONDENSED SUMMARY');
    // Oldest 3 of 6 were folded into the summary; 3 newest remain + 1 summary.
    expect(ctx.messages.filter((m) => !m.isSummary)).toHaveLength(3);
    // Summary persisted durably to Mongo.
    expect(repo.appendSummary).toHaveBeenCalledTimes(1);
  });

  it('is idempotent under a held lock (concurrent trigger is a no-op)', async () => {
    const lock = new RedlockService([redis as unknown as never]);
    const worker = new SummarizationWorker(store, repo as never, llm, lock, configStub);

    for (let i = 0; i < 6; i++) {
      await store.append(SESSION, { role: 'user', content: `m${i} x y` });
    }

    // Simulate another summarization already in progress for this session.
    const held = await lock.acquire(`summarize:${SESSION}`, 5_000);
    expect(held).not.toBeNull();

    await worker.summarizeSession(SESSION);
    expect(repo.appendSummary).not.toHaveBeenCalled(); // skipped — lock held

    // Once released, summarization proceeds.
    await lock.release(held!);
    await worker.summarizeSession(SESSION);
    expect(repo.appendSummary).toHaveBeenCalledTimes(1);
  });
});
