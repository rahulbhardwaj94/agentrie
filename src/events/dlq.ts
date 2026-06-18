/**
 * Reliability helpers for the SQS consumer (Phase 2).
 *
 * Poison-pill handling: SQS itself moves a message to the DLQ once its receive
 * count exceeds `maxReceiveCount` (the redrive policy is set on the queue at
 * provisioning time — see scripts/localstack-init.sh). The helpers below cover
 * the application-side concerns the queue can't: backoff timing and deciding when
 * a message has exhausted its attempts.
 */

/**
 * Marks a message failure as PERMANENT — retrying it can never succeed (e.g. an
 * unparseable body or a schema-invalid payload). The consumer routes these
 * straight to the DLQ instead of burning the whole redrive budget (and logging
 * the same error N times) on pointless retries. Anything NOT wrapped in this is
 * treated as transient and left for SQS to redeliver.
 */
export class PermanentMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentMessageError';
  }
}

/**
 * Exponential backoff with full jitter, bounded.
 *   delay = random(0, min(cap, base * 2^attempt))
 * Full jitter avoids thundering-herd retries across many consumers.
 */
export function backoffWithJitter(
  attempt: number,
  baseMs = 1000,
  capMs = 30_000,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

/**
 * Decide whether a message has exhausted its redrive budget. SQS exposes the
 * delivery count via the `ApproximateReceiveCount` system attribute. When it
 * reaches maxReceiveCount, SQS will route the message to the DLQ on the next
 * failed delete — so the consumer should stop retrying and let that happen.
 */
export function isPoisonPill(
  approximateReceiveCount: number,
  maxReceiveCount: number,
): boolean {
  return approximateReceiveCount >= maxReceiveCount;
}

/**
 * Compute a safe visibility-timeout extension (heartbeat) for a long-running
 * handler. Visibility timeout MUST exceed max agent execution time; if a single
 * run can exceed the queue's configured ceiling, extend visibility periodically
 * so the message isn't redelivered mid-execution. Returns seconds to extend by.
 *
 * Wired into the consumer's per-message heartbeat loop (SqsConsumer
 * .withVisibilityHeartbeat) via ChangeMessageVisibilityCommand.
 */
export function heartbeatExtensionSec(
  remainingExecMs: number,
  minSec = 30,
): number {
  return Math.max(minSec, Math.ceil(remainingExecMs / 1000) + minSec);
}
