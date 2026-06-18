import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { context as otelContext } from '@opentelemetry/api';
import type Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { LOCK_SERVICE, type LockService } from '../lock/lock.interface';
import { MetricsService } from '../observability/metrics.service';
import { extractTraceContext } from '../observability/propagation';
import { SummarizationWorker } from '../memory/summarization.worker';
import { REDIS_CLIENT } from '../redis/redis.module';
import { CodeReviewerWorker } from '../workers/code-reviewer.worker';
import {
  AgentTaskMessageSchema,
  SummarizeMessageSchema,
} from '../workers/worker.types';
import { SQS_CLIENT } from './aws';
import {
  backoffWithJitter,
  heartbeatExtensionSec,
  isPoisonPill,
  PermanentMessageError,
} from './dlq';

/**
 * Long-polling SQS consumer for specialized workers (Phase 2, REAL).
 *
 * What's REAL here:
 *  - the long-poll receive loop (20s WaitTimeSeconds) with graceful shutdown,
 *  - W3C trace-context EXTRACTION from message attributes so worker spans join
 *    the producer's distributed trace,
 *  - Redlock IDEMPOTENCY keyed on the message dedupe id,
 *  - poison-pill detection (maxReceiveCount -> DLQ via the queue's redrive policy),
 *  - per-message attempt accounting (app-side Redis counter) with exponential
 *    backoff + jitter on transient failure, and proactive DLQ once the attempt
 *    budget is exhausted (backpressure alongside the queue's redrive).
 *
 * Reliability invariants (config-driven):
 *  - SQS_VISIBILITY_TIMEOUT_SEC MUST exceed AGENT_TIMEOUT_MS (enforced in
 *    env.schema.ts) so a long agent run doesn't get its message redelivered
 *    mid-flight. For runs that can exceed the ceiling, visibility is extended via
 *    a heartbeat (see withVisibilityHeartbeat / dlq.ts heartbeatExtensionSec).
 *  - A transient failure shortens the message's visibility to a jittered backoff
 *    (backoffWithJitter) so retries don't all land on the fixed visibility window.
 *  - The queue has a redrive policy (maxReceiveCount -> DLQ) set at provisioning.
 */
@Injectable()
export class SqsConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SqsConsumer.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(LOCK_SERVICE) private readonly lock: LockService,
    private readonly config: AppConfigService,
    private readonly codeReviewer: CodeReviewerWorker,
    private readonly summarizer: SummarizationWorker,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    // Disabled by default in local/dev so `npm run start` doesn't require a live
    // queue. Flip CONSUMER_ENABLED=true (or run the dedicated worker) to start it.
    if (process.env.CONSUMER_ENABLED !== 'true') {
      this.logger.log('SQS consumer disabled (set CONSUMER_ENABLED=true to run)');
      return;
    }
    this.running = true;
    this.loopPromise = this.pollLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    // Graceful drain: stop the loop and wait for the in-flight receive to finish.
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }
    this.logger.log('SQS consumer drained');
  }

  private async pollLoop(): Promise<void> {
    this.logger.log('SQS consumer started (long polling 20s)');
    while (this.running) {
      try {
        const res = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.sqsQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.sqsWaitTimeSeconds, // long polling (20s)
            VisibilityTimeout: this.config.sqsVisibilityTimeoutSec,
            MessageAttributeNames: ['All'],
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );
        for (const message of res.Messages ?? []) {
          await this.processMessage(message);
        }
      } catch (err) {
        // Don't crash the loop on transient receive errors; back off briefly.
        this.logger.error(`Receive failed: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async processMessage(message: Message): Promise<void> {
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? '1',
    );

    // Poison pill: let SQS route it to the DLQ (don't delete, don't keep retrying
    // in a hot loop). Returning without delete lets the redrive policy take over.
    if (isPoisonPill(receiveCount, this.config.sqsMaxReceiveCount)) {
      this.logger.warn(
        `Message ${message.MessageId} hit maxReceiveCount; leaving for DLQ`,
      );
      this.metrics.recordSqsOutcome('poison_pill');
      return;
    }

    // Idempotency: acquire a Redis lock on the dedupe id. If held, this message
    // is already being / was processed -> ack (delete) and move on.
    const dedupeId =
      message.MessageAttributes?.dedupeId?.StringValue ??
      message.MessageId ??
      'unknown';
    const handle = await this.lock.acquire(
      `sqs:dedupe:${dedupeId}`,
      this.config.lockTtlMs,
    );
    if (!handle) {
      this.logger.debug(`Duplicate ${dedupeId}; acking without reprocessing`);
      this.metrics.recordSqsOutcome('duplicate');
      await this.ack(message);
      return;
    }

    try {
      // Re-attach the distributed trace (REAL): extract traceparent from message
      // attributes and run the handler inside that context so its spans are
      // children of the producer's span.
      const parentCtx = extractTraceContext(message.MessageAttributes);
      await otelContext.with(parentCtx, () => this.handleMessage(message));
      await this.ack(message);
      this.metrics.recordSqsOutcome('success');
      // Succeeded -> drop the app-side attempt counter so a future message reusing
      // the same dedupe id starts fresh.
      await this.clearAttempts(dedupeId);
    } catch (err) {
      if (err instanceof PermanentMessageError) {
        // Non-retryable (malformed / un-actionable): forward to the DLQ NOW and
        // ack, instead of churning through the full redrive budget logging the
        // same error each time. Retrying could never make it parse.
        this.logger.warn(
          `Permanent failure for ${dedupeId} (${err.message}); routing to DLQ`,
        );
        this.metrics.recordSqsOutcome('permanent_dlq');
        await this.deadLetter(message);
        await this.clearAttempts(dedupeId);
      } else {
        // Transient: count the failed attempt (app-side, exact — alongside SQS's
        // approximate ApproximateReceiveCount) and decide what to do next.
        const attempts = await this.recordAttempt(dedupeId);
        this.logger.error(
          `Handler failed for ${dedupeId} (attempt ${attempts}): ` +
            (err as Error).message,
        );
        if (attempts >= this.config.sqsMaxReceiveCount) {
          // Exhausted the app-side budget: proactively DLQ instead of waiting for
          // SQS's redrive to notice. Backpressure — stop hammering a doomed message.
          this.logger.warn(
            `Attempt budget exhausted for ${dedupeId} (${attempts}); routing to DLQ`,
          );
          this.metrics.recordSqsOutcome('transient_dlq');
          await this.deadLetter(message);
          await this.clearAttempts(dedupeId);
        } else {
          this.metrics.recordSqsOutcome('retry');
          // Apply exponential backoff with jitter by shortening the message's
          // visibility timeout to the backoff delay, so it's redelivered after the
          // backoff rather than the fixed visibility window. Do NOT ack.
          await this.scheduleRetry(message, attempts);
        }
      }
    } finally {
      await this.lock.release(handle);
    }
  }

  /**
   * App-side, exact per-message attempt counter in Redis, kept alongside SQS's
   * approximate `ApproximateReceiveCount`. Drives the retry backoff exponent and
   * the proactive-DLQ threshold. Self-expires so an abandoned message's counter
   * doesn't linger forever.
   */
  private async recordAttempt(dedupeId: string): Promise<number> {
    const key = `sqs:attempts:${dedupeId}`;
    const count = await this.redis.incr(key);
    // Outlive the whole retry sequence (cap * budget) then clean itself up.
    const ttlMs =
      this.config.sqsRetryCapMs * (this.config.sqsMaxReceiveCount + 2);
    await this.redis.pexpire(key, ttlMs);
    return count;
  }

  private async clearAttempts(dedupeId: string): Promise<void> {
    await this.redis.del(`sqs:attempts:${dedupeId}`);
  }

  /**
   * Delay the next redelivery of a transiently-failed message by an exponential
   * backoff with full jitter (via ChangeMessageVisibility). If the call fails the
   * message simply falls back to the queue's default visibility timeout — still
   * retried, just without the backoff.
   */
  private async scheduleRetry(message: Message, attempt: number): Promise<void> {
    if (!message.ReceiptHandle) return;
    const backoffMs = backoffWithJitter(
      attempt,
      this.config.sqsRetryBaseMs,
      this.config.sqsRetryCapMs,
    );
    this.metrics.recordSqsBackoff(backoffMs);
    // SQS visibility is in seconds; floor at 1s and clamp to SQS's 12h ceiling.
    const backoffSec = Math.min(43_200, Math.max(1, Math.ceil(backoffMs / 1000)));
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.config.sqsQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: backoffSec,
        }),
      );
      this.logger.debug(
        `Backing off ${message.MessageId} for ${backoffSec}s (attempt ${attempt})`,
      );
    } catch (err) {
      this.logger.warn(
        `Backoff visibility change failed for ${message.MessageId}: ${(err as Error).message}`,
      );
    }
  }

  private async ack(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.config.sqsQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  /**
   * Route a received message to the right specialized worker (Phase 2, REAL).
   *
   * The producer's trace context is already the active context here (the caller
   * activated it), so any spans the worker opens join the distributed trace.
   *
   * Routing rules:
   *  - `agent.completion` events (our own results, echoed back because the queue
   *    is subscribed to the same topic we publish to) are skipped — ack and move
   *    on, so we never loop or DLQ our own output.
   *  - A well-formed {@link AgentTaskMessage} is dispatched to its worker, wrapped
   *    in a visibility heartbeat so a long run isn't redelivered mid-flight.
   *  - A JSON object that isn't a task is ignored (ack-skip) — unrelated traffic
   *    shouldn't be retried into the DLQ.
   *  - An unparseable body throws -> left un-acked -> SQS redrives it to the DLQ.
   */
  private async handleMessage(message: Message): Promise<void> {
    const body = this.parseBody(message); // throws on unparseable -> DLQ

    if (body['type'] === 'agent.completion') {
      this.logger.debug(`Skipping completion event ${message.MessageId}`);
      return;
    }

    // Summarization request (Phase 1 worker promoted to SQS). Malformed -> DLQ.
    if (body['type'] === 'summarize.session') {
      const summarize = SummarizeMessageSchema.safeParse(body);
      if (!summarize.success) {
        throw new PermanentMessageError(
          `invalid summarize.session message: ${summarize.error.issues
            .map((i) => i.message)
            .join('; ')}`,
        );
      }
      await this.withVisibilityHeartbeat(message, () =>
        this.summarizer.summarizeSession(summarize.data.sessionId),
      );
      return;
    }

    const parsed = AgentTaskMessageSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn(
        `Ignoring non-task message ${message.MessageId}: ` +
          parsed.error.issues.map((i) => i.message).join('; '),
      );
      return;
    }

    const dedupeId =
      message.MessageAttributes?.dedupeId?.StringValue ??
      message.MessageId ??
      'unknown';

    // Only one specialized worker today; `task` is the routing key for more.
    await this.withVisibilityHeartbeat(message, () =>
      this.codeReviewer.review(parsed.data, dedupeId),
    );
  }

  /**
   * Parse the JSON body into an object. A bad body is a PERMANENT failure (it
   * can never become valid on retry), so we throw {@link PermanentMessageError}
   * to route it straight to the DLQ rather than retrying it to death.
   */
  private parseBody(message: Message): Record<string, unknown> {
    if (!message.Body) {
      throw new PermanentMessageError('empty message body');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.Body);
    } catch (err) {
      throw new PermanentMessageError(
        `unparseable message body: ${(err as Error).message}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new PermanentMessageError('message body is not a JSON object');
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * Forward a permanently-failed message to the DLQ and remove it from the source
   * queue. If forwarding itself fails, fall back to leaving it un-acked so SQS's
   * redrive policy still eventually moves it — we never lose the message.
   */
  private async deadLetter(message: Message): Promise<void> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.config.sqsDlqUrl,
          MessageBody: message.Body ?? '',
          MessageAttributes: message.MessageAttributes,
        }),
      );
      await this.ack(message);
    } catch (err) {
      this.logger.error(
        `Failed to route ${message.MessageId} to DLQ (leaving for redrive): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Run `fn` while periodically extending the message's visibility timeout, so a
   * run that outlasts the base SQS_VISIBILITY_TIMEOUT_SEC isn't redelivered
   * mid-execution. Heartbeat failures are swallowed (worst case: redelivery,
   * which the idempotency lock guards against). The timer is unref'd so it never
   * keeps the process alive on shutdown.
   */
  private async withVisibilityHeartbeat<T>(
    message: Message,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!message.ReceiptHandle) {
      return fn();
    }
    const extensionSec = heartbeatExtensionSec(this.config.agentTimeoutMs);
    // Re-extend at half the base window so visibility never lapses between ticks.
    const intervalMs = Math.max(
      1_000,
      Math.floor((this.config.sqsVisibilityTimeoutSec * 1000) / 2),
    );
    const timer = setInterval(() => {
      void this.extendVisibility(message, extensionSec);
    }, intervalMs);
    timer.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(timer);
    }
  }

  private async extendVisibility(
    message: Message,
    visibilitySec: number,
  ): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.config.sqsQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: visibilitySec,
        }),
      );
      this.logger.debug(
        `Extended visibility for ${message.MessageId} by ${visibilitySec}s`,
      );
    } catch (err) {
      this.logger.warn(
        `Visibility heartbeat failed for ${message.MessageId}: ${(err as Error).message}`,
      );
    }
  }
}
