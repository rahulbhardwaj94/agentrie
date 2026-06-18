import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AppConfigService } from '../src/config/app-config.service';
import {
  CONTEXT_THRESHOLD_EVENT,
  type ContextThresholdEvent,
} from '../src/memory/memory-store.interface';
import { RedisMemoryStore } from '../src/memory/redis-memory.store';
import type { SessionRepository } from '../src/memory/session.repository';
import { FakeRedis } from './helpers/fake-redis';
import { TestLlmProvider, makeRepoStub } from './helpers/fakes';

describe('RedisMemoryStore (token-aware sliding window)', () => {
  let redis: FakeRedis;
  let llm: TestLlmProvider;
  let repo: ReturnType<typeof makeRepoStub>;
  let emitter: EventEmitter2;
  let store: RedisMemoryStore;

  const SESSION = 's1';
  const CONTEXT_LIMIT = 20; // tokens (1 token == 1 word in TestLlmProvider)
  const config = { summarizeCooldownMs: 30_000 } as AppConfigService;

  beforeEach(() => {
    redis = new FakeRedis();
    llm = new TestLlmProvider(CONTEXT_LIMIT);
    repo = makeRepoStub();
    emitter = new EventEmitter2();
    store = new RedisMemoryStore(
      redis as unknown as never,
      llm,
      repo as unknown as SessionRepository,
      emitter,
      config,
    );
  });

  it('pins the system prompt and never evicts it', async () => {
    await store.setSystemPrompt(SESSION, 'you are a tutor'); // 4 tokens, pinned

    // Append messages well past the 20-token limit to force eviction.
    for (let i = 0; i < 10; i++) {
      await store.append(SESSION, {
        role: 'user',
        content: 'one two three four five', // 5 tokens each
      });
    }

    const ctx = await store.getActiveContext(SESSION);
    const system = ctx.messages.filter((m) => m.role === 'system');
    expect(system).toHaveLength(1);
    expect(system[0].pinned).toBe(true);
    // Window must be bounded by the context limit.
    expect(ctx.totalTokens).toBeLessThanOrEqual(CONTEXT_LIMIT);
  });

  it('evicts the OLDEST evictable message first', async () => {
    await store.append(SESSION, { role: 'user', content: 'aaa bbb ccc ddd eee' }); // m1
    await store.append(SESSION, { role: 'user', content: 'fff ggg hhh iii jjj' }); // m2
    await store.append(SESSION, { role: 'user', content: 'kkk lll mmm nnn ooo' }); // m3
    await store.append(SESSION, { role: 'user', content: 'ppp qqq rrr sss ttt' }); // m4
    // 4 * 5 = 20 ok; one more (25) forces eviction of m1.

    await store.append(SESSION, { role: 'user', content: 'uuu vvv www xxx yyy' }); // m5

    const ctx = await store.getActiveContext(SESSION);
    const contents = ctx.messages.map((m) => m.content);
    expect(contents).not.toContain('aaa bbb ccc ddd eee'); // oldest evicted
    expect(contents).toContain('uuu vvv www xxx yyy'); // newest kept
    expect(ctx.totalTokens).toBeLessThanOrEqual(CONTEXT_LIMIT);
  });

  it('writes every appended message through to Mongo (source of truth)', async () => {
    await store.append(SESSION, { role: 'user', content: 'hello world' });
    expect(repo.appendMessage).toHaveBeenCalledTimes(1);
  });

  describe('summarization trigger (debounced)', () => {
    /** Collect every threshold event the store emits during the test. */
    function captureThresholdEvents(): ContextThresholdEvent[] {
      const events: ContextThresholdEvent[] = [];
      emitter.on(CONTEXT_THRESHOLD_EVENT, (e: ContextThresholdEvent) =>
        events.push(e),
      );
      return events;
    }

    /** Append `n` single-token messages (1 word == 1 token). */
    async function appendTokens(n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        await store.append(SESSION, { role: 'user', content: `w${i}` });
      }
    }

    it('emits exactly once while the window stays above 80%', async () => {
      const events = captureThresholdEvents();

      // Threshold is 80% of 20 == 16 tokens. Cross it, then keep appending while
      // it sits over the line (eviction holds the window at the 20-token bound).
      await appendTokens(20);

      // Pre-debounce, every over-threshold append (16..20) emitted — five events.
      // With the latch, the crossing produces a single event.
      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe(SESSION);
      expect(events[0].totalTokens).toBeGreaterThanOrEqual(16);
    });

    it('re-arms after the window drops back below threshold', async () => {
      const events = captureThresholdEvents();

      await appendTokens(16); // crosses 16 -> emit #1
      expect(events).toHaveLength(1);

      // Summarize the window down to a single pinned summary (well under threshold).
      await store.replaceOldestWithSummary(SESSION, 16, 'summary');

      // Next append sees the window below threshold and clears the latch (re-arm),
      // then we climb back over 16 to fire a second, genuine crossing.
      await appendTokens(16);
      expect(events).toHaveLength(2);
    });

    it('does not fire below threshold', async () => {
      const events = captureThresholdEvents();
      await appendTokens(15); // 15 < 16
      expect(events).toHaveLength(0);
    });
  });
});
