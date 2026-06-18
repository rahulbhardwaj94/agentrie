import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { LockMetrics } from '../observability/metrics.service';
import type { LockHandle, LockService } from './lock.interface';

export interface RedlockOptions {
  /**
   * Fraction of the TTL subtracted from a lock's validity to cover clock drift
   * between masters (Redlock's `clock_drift_factor`). The algorithm only treats
   * a lock as acquired if, after reaching quorum, enough validity remains.
   */
  driftFactor?: number;
  /**
   * Fixed ms added on top of the proportional drift allowance — covers Redis's
   * millisecond-resolution expiry rounding regardless of TTL size.
   */
  driftConstantMs?: number;
}

/**
 * Distributed lock via the Redlock algorithm across N independent Redis masters.
 *
 * Acquire sets `key=token NX PX ttl` on every master in parallel and only grants
 * the lock if it reached a quorum (⌊N/2⌋+1) AND enough validity remains after
 * accounting for the time spent acquiring plus clock drift. This survives the
 * single-node failure mode the old implementation could not: under failover a
 * lock granted on a dying master is not enough — a majority must agree.
 *
 * Release is fenced: a compare-and-delete Lua script runs on every master and
 * deletes the key only when the stored token is ours, so an expired-then-
 * re-acquired lock is never freed by the previous holder.
 *
 * Degrades cleanly: with a single master, quorum is 1 and this is exactly the
 * previous single-node `SET NX PX` + compare-and-delete behavior.
 *
 * Non-blocking by contract (matching `LockService`): `acquire` makes one round
 * and returns `null` on failure; callers decide whether to skip or retry.
 */
@Injectable()
export class RedlockService implements LockService {
  // KEYS[1]=lock key, ARGV[1]=token. Delete only if the stored token is ours.
  private static readonly RELEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  private readonly quorum: number;
  private readonly driftFactor: number;
  private readonly driftConstantMs: number;

  constructor(
    private readonly nodes: Redis[],
    options: RedlockOptions = {},
    // Optional so the keyless unit constructors (`new RedlockService([redis])`)
    // keep working; when present, every acquire round reports its outcome.
    private readonly metrics?: LockMetrics,
  ) {
    if (nodes.length === 0) {
      throw new Error('Redlock requires at least one Redis master');
    }
    this.quorum = Math.floor(nodes.length / 2) + 1;
    this.driftFactor = options.driftFactor ?? 0.01;
    this.driftConstantMs = options.driftConstantMs ?? 2;
  }

  async acquire(key: string, ttlMs: number): Promise<LockHandle | null> {
    const token = randomUUID();
    const start = Date.now();

    // Set on every master concurrently. A node being unreachable is a no-vote,
    // not a crash — allSettled keeps the quorum math honest.
    const results = await Promise.allSettled(
      this.nodes.map((node) => node.set(key, token, 'PX', ttlMs, 'NX')),
    );
    const votes = results.filter(
      (r) => r.status === 'fulfilled' && r.value === 'OK',
    ).length;

    // Validity = TTL minus time spent acquiring minus the clock-drift safety
    // margin. If acquisition was slow enough that little/no validity remains,
    // treat it as a failure even with quorum — the lock could expire mid-work.
    const drift = Math.floor(this.driftFactor * ttlMs) + this.driftConstantMs;
    const validity = ttlMs - (Date.now() - start) - drift;

    if (votes >= this.quorum && validity > 0) {
      this.metrics?.recordLockAcquire('acquired');
      return { key, token };
    }

    // Distinguish the two failure modes for ops: `contended` (a competitor holds
    // the key, so we missed quorum) vs `expired` (we had quorum but acquisition
    // burned the validity window). The latter signals slow/overloaded masters.
    this.metrics?.recordLockAcquire(
      votes >= this.quorum ? 'expired' : 'contended',
    );

    // Quorum missed (or burned too much time): release the partial holds so a
    // minority of masters don't keep the key locked until TTL. Fenced by token,
    // so this never frees a competitor's lock.
    await this.release({ key, token });
    return null;
  }

  async release(handle: LockHandle): Promise<void> {
    await Promise.allSettled(
      this.nodes.map((node) =>
        node.eval(RedlockService.RELEASE_SCRIPT, 1, handle.key, handle.token),
      ),
    );
  }
}
