import type { LockMetrics, LockOutcome } from '../src/observability/metrics.service';
import { RedlockService } from '../src/lock/redlock.service';
import { FakeRedis } from './helpers/fake-redis';

/**
 * REQUIRED TEST — idempotency path. The whole SQS-dedupe and summarizer
 * concurrency design rests on this: a second acquire of a held key fails, and the
 * caller treats that as "already processed".
 *
 * RedlockService is the LOCK_SERVICE implementation. With one master it degrades
 * to the previous single-node SET NX PX behavior (quorum = 1); the second block
 * exercises true multi-master quorum semantics.
 */
describe('RedlockService — single-node degrade (idempotency primitive)', () => {
  let redis: FakeRedis;
  let lock: RedlockService;

  beforeEach(() => {
    redis = new FakeRedis();
    // FakeRedis implements the subset of ioredis the service uses.
    lock = new RedlockService([redis as unknown as never]);
  });

  it('grants the lock once and rejects a concurrent acquire of the same key', async () => {
    const first = await lock.acquire('job:123', 60_000);
    const second = await lock.acquire('job:123', 60_000);

    expect(first).not.toBeNull();
    // Second acquisition fails -> caller treats the message as already-processed.
    expect(second).toBeNull();
  });

  it('allows re-acquisition after the holder releases', async () => {
    const first = await lock.acquire('job:abc', 60_000);
    expect(first).not.toBeNull();

    await lock.release(first!);

    const again = await lock.acquire('job:abc', 60_000);
    expect(again).not.toBeNull();
  });

  it("release only deletes the holder's own token (compare-and-delete)", async () => {
    const handle = await lock.acquire('job:xyz', 60_000);
    expect(handle).not.toBeNull();

    // A stale handle with the wrong token must NOT free someone else's lock.
    await lock.release({ key: 'job:xyz', token: 'not-the-real-token' });
    const stillHeld = await lock.acquire('job:xyz', 60_000);
    expect(stillHeld).toBeNull();

    // The real holder can still release it.
    await lock.release(handle!);
    const free = await lock.acquire('job:xyz', 60_000);
    expect(free).not.toBeNull();
  });
});

/**
 * Multi-master quorum semantics — the reason for swapping to Redlock. With N
 * masters a lock is granted only if a majority (⌊N/2⌋+1) agree, and a failed
 * acquisition rolls back its partial holds so a minority can't wedge the key.
 */
describe('RedlockService — multi-master quorum', () => {
  const QUORUM_KEY = 'redlock:job';

  // A master that always rejects (down/unreachable). allSettled => no vote.
  const downNode = () =>
    ({
      set: async () => {
        throw new Error('node down');
      },
      eval: async () => 0,
    }) as unknown as never;

  it('acquires when a quorum of masters agree even if one is down', async () => {
    const a = new FakeRedis();
    const b = new FakeRedis();
    const lock = new RedlockService([
      a as unknown as never,
      b as unknown as never,
      downNode(), // 3 nodes, quorum = 2
    ]);

    const handle = await lock.acquire(QUORUM_KEY, 60_000);
    // 2 of 3 votes >= quorum of 2 -> granted.
    expect(handle).not.toBeNull();
    expect(await a.get(QUORUM_KEY)).toBe(handle!.token);
    expect(await b.get(QUORUM_KEY)).toBe(handle!.token);
  });

  it('rejects a concurrent acquire while the lock is held across the quorum', async () => {
    const nodes = [new FakeRedis(), new FakeRedis(), new FakeRedis()];
    const lock = new RedlockService(nodes.map((n) => n as unknown as never));

    const first = await lock.acquire(QUORUM_KEY, 60_000);
    const second = await lock.acquire(QUORUM_KEY, 60_000);

    expect(first).not.toBeNull();
    // Every master already holds first's token -> second gets 0 votes.
    expect(second).toBeNull();
  });

  it('fails to acquire without quorum and rolls back its partial holds', async () => {
    const a = new FakeRedis();
    const b = new FakeRedis();
    const c = new FakeRedis();
    const lock = new RedlockService([
      a as unknown as never,
      b as unknown as never,
      c as unknown as never,
    ]);

    // Foreign holder already owns a majority (a, b). Only c is free.
    await a.set(QUORUM_KEY, 'foreign', 'PX', 60_000, 'NX');
    await b.set(QUORUM_KEY, 'foreign', 'PX', 60_000, 'NX');

    const handle = await lock.acquire(QUORUM_KEY, 60_000);
    // 1 of 3 votes < quorum of 2 -> not granted.
    expect(handle).toBeNull();
    // Rolled back: the lone vote on c was released, so it isn't left wedged.
    expect(await c.get(QUORUM_KEY)).toBeNull();
    // Foreign holder's grip on the majority is untouched (fenced by token).
    expect(await a.get(QUORUM_KEY)).toBe('foreign');
    expect(await b.get(QUORUM_KEY)).toBe('foreign');
  });

  it('release frees the key on every master so it can be re-acquired', async () => {
    const nodes = [new FakeRedis(), new FakeRedis(), new FakeRedis()];
    const lock = new RedlockService(nodes.map((n) => n as unknown as never));

    const handle = await lock.acquire(QUORUM_KEY, 60_000);
    expect(handle).not.toBeNull();

    await lock.release(handle!);
    for (const n of nodes) {
      expect(await n.get(QUORUM_KEY)).toBeNull();
    }

    const again = await lock.acquire(QUORUM_KEY, 60_000);
    expect(again).not.toBeNull();
  });

  it('treats negligible remaining validity as a failed acquire', async () => {
    const nodes = [new FakeRedis(), new FakeRedis(), new FakeRedis()];
    const lock = new RedlockService(nodes.map((n) => n as unknown as never));

    // ttl smaller than the drift constant (2ms) -> validity <= 0 even with quorum.
    const handle = await lock.acquire(QUORUM_KEY, 1);
    expect(handle).toBeNull();
    // And the partial holds were rolled back.
    for (const n of nodes) {
      expect(await n.get(QUORUM_KEY)).toBeNull();
    }
  });
});

/**
 * Contention telemetry — each acquire round reports its outcome through the
 * optional LockMetrics seam, so the metrics pipeline exposes a contention rate.
 */
describe('RedlockService — acquire-outcome metrics', () => {
  const KEY = 'metered:job';

  function recorder(): { metrics: LockMetrics; outcomes: LockOutcome[] } {
    const outcomes: LockOutcome[] = [];
    return { metrics: { recordLockAcquire: (o) => outcomes.push(o) }, outcomes };
  }

  it('records `acquired` on a granted lock', async () => {
    const { metrics, outcomes } = recorder();
    const lock = new RedlockService([new FakeRedis() as unknown as never], {}, metrics);

    expect(await lock.acquire(KEY, 60_000)).not.toBeNull();
    expect(outcomes).toEqual(['acquired']);
  });

  it('records `contended` when a competitor holds the quorum', async () => {
    const { metrics, outcomes } = recorder();
    const a = new FakeRedis();
    const b = new FakeRedis();
    const c = new FakeRedis();
    const lock = new RedlockService(
      [a, b, c].map((n) => n as unknown as never),
      {},
      metrics,
    );
    // Foreign holder owns the majority (a, b) -> only 1 vote, below quorum of 2.
    await a.set(KEY, 'foreign', 'PX', 60_000, 'NX');
    await b.set(KEY, 'foreign', 'PX', 60_000, 'NX');

    expect(await lock.acquire(KEY, 60_000)).toBeNull();
    expect(outcomes).toEqual(['contended']);
  });

  it('records `expired` when quorum is reached but validity is burned', async () => {
    const { metrics, outcomes } = recorder();
    const lock = new RedlockService(
      [new FakeRedis(), new FakeRedis(), new FakeRedis()].map(
        (n) => n as unknown as never,
      ),
      {},
      metrics,
    );

    // ttl below the drift constant -> quorum met but validity <= 0.
    expect(await lock.acquire(KEY, 1)).toBeNull();
    expect(outcomes).toEqual(['expired']);
  });
});
