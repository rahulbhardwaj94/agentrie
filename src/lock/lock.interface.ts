/**
 * LockService — mutual-exclusion primitive.
 *
 * Used by the Phase 1 summarization worker (concurrency safety per session) AND
 * the Phase 2 SQS idempotency path (dedupe on message id). Same primitive, two
 * call sites — exactly as the spec requires.
 */
export interface LockHandle {
  key: string;
  /** Opaque fencing token; only the holder that set it may release. */
  token: string;
}

export interface LockService {
  /**
   * Try to acquire `key` for `ttlMs`. Returns a handle on success, or null if
   * already held. Non-blocking — callers decide whether to skip or retry.
   */
  acquire(key: string, ttlMs: number): Promise<LockHandle | null>;

  /**
   * Release a held lock. No-op if the token no longer matches (someone else's
   * lock or it already expired) — prevents releasing a lock you don't own.
   */
  release(handle: LockHandle): Promise<void>;
}

export const LOCK_SERVICE = Symbol('LOCK_SERVICE');
