import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import type { AppConfigService } from '../src/config/app-config.service';
import type { LockService } from '../src/lock/lock.interface';
import { backoffWithJitter, heartbeatExtensionSec, isPoisonPill } from '../src/events/dlq';
import { SqsConsumer } from '../src/events/sqs.consumer';
import type { MetricsService } from '../src/observability/metrics.service';
import type { CodeReviewerWorker } from '../src/workers/code-reviewer.worker';
import type { SummarizationWorker } from '../src/memory/summarization.worker';
import { FakeRedis } from './helpers/fake-redis';

const config = {
  sqsQueueUrl: 'http://localhost:4566/000000000000/agent-tasks',
  sqsDlqUrl: 'http://localhost:4566/000000000000/agent-tasks-dlq',
  sqsMaxReceiveCount: 5,
  sqsWaitTimeSeconds: 20,
  sqsVisibilityTimeoutSec: 150,
  agentTimeoutMs: 60_000,
  lockTtlMs: 5_000,
  sqsRetryBaseMs: 1000,
  sqsRetryCapMs: 30_000,
} as AppConfigService;

function makeConsumer(opts: {
  send: jest.Mock;
  lockResult: Awaited<ReturnType<LockService['acquire']>>;
  review?: jest.Mock;
  summarize?: jest.Mock;
  redis?: FakeRedis;
}) {
  const sqs = { send: opts.send } as never;
  const lock: LockService = {
    acquire: jest.fn().mockResolvedValue(opts.lockResult),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const review = opts.review ?? jest.fn().mockResolvedValue(undefined);
  const worker = { review } as unknown as CodeReviewerWorker;
  const summarize = opts.summarize ?? jest.fn().mockResolvedValue(undefined);
  const summarizer = { summarizeSession: summarize } as unknown as SummarizationWorker;
  const redis = opts.redis ?? new FakeRedis();
  const metrics = {
    recordSqsOutcome: jest.fn(),
    recordSqsBackoff: jest.fn(),
  } as unknown as MetricsService;
  const consumer = new SqsConsumer(
    sqs,
    lock,
    config,
    worker,
    summarizer,
    redis as unknown as never,
    metrics,
  );
  return { consumer, lock, review, summarize, redis, metrics };
}

/** Drive the private processMessage as the unit under test. */
function processMessage(consumer: SqsConsumer, m: Message): Promise<void> {
  return (
    consumer as never as { processMessage(m: Message): Promise<void> }
  ).processMessage(m);
}

function lastCommands(send: jest.Mock): string[] {
  return send.mock.calls.map((c) => c[0]?.constructor?.name);
}

describe('SQS poison-pill -> DLQ path (REQUIRED)', () => {
  it('leaves a maxReceiveCount-exceeded message for the DLQ (no delete)', async () => {
    const send = jest.fn().mockResolvedValue({});
    const { consumer, metrics } = makeConsumer({
      send,
      lockResult: { key: 'k', token: 't' },
    });

    const poison: Message = {
      MessageId: 'm-poison',
      ReceiptHandle: 'rh',
      Body: '{}',
      Attributes: { ApproximateReceiveCount: '5' }, // == maxReceiveCount
    };

    // processMessage is the unit under test (private; invoked directly).
    await (consumer as never as { processMessage(m: Message): Promise<void> }).processMessage(
      poison,
    );

    // Must NOT delete — leaving it un-acked lets SQS redrive it to the DLQ.
    expect(lastCommands(send)).not.toContain('DeleteMessageCommand');
    expect(metrics.recordSqsOutcome).toHaveBeenCalledWith('poison_pill');
  });

  it('acks (deletes) a normal message after successful handling', async () => {
    const send = jest.fn().mockResolvedValue({});
    const { consumer, metrics } = makeConsumer({
      send,
      lockResult: { key: 'k', token: 't' },
    });

    const ok: Message = {
      MessageId: 'm-ok',
      ReceiptHandle: 'rh-ok',
      Body: '{}',
      Attributes: { ApproximateReceiveCount: '1' },
      MessageAttributes: { dedupeId: { DataType: 'String', StringValue: 'd1' } },
    };

    await (consumer as never as { processMessage(m: Message): Promise<void> }).processMessage(
      ok,
    );

    const cmds = lastCommands(send);
    expect(cmds).toContain('DeleteMessageCommand');
    expect(metrics.recordSqsOutcome).toHaveBeenCalledWith('success');
    const del = send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof DeleteMessageCommand) as DeleteMessageCommand;
    expect(del.input.ReceiptHandle).toBe('rh-ok');
  });

  it('acks duplicates without reprocessing (idempotency lock already held)', async () => {
    const send = jest.fn().mockResolvedValue({});
    const { consumer, lock, metrics } = makeConsumer({
      send,
      lockResult: null, // lock already held => duplicate
    });

    const dup: Message = {
      MessageId: 'm-dup',
      ReceiptHandle: 'rh-dup',
      Body: '{}',
      Attributes: { ApproximateReceiveCount: '1' },
      MessageAttributes: { dedupeId: { DataType: 'String', StringValue: 'd9' } },
    };

    await (consumer as never as { processMessage(m: Message): Promise<void> }).processMessage(
      dup,
    );

    expect(lock.acquire).toHaveBeenCalledWith('sqs:dedupe:d9', config.lockTtlMs);
    // Duplicate is acked (deleted) and not handled again.
    expect(lastCommands(send)).toContain('DeleteMessageCommand');
    expect(metrics.recordSqsOutcome).toHaveBeenCalledWith('duplicate');
  });
});

describe('SQS message routing (Phase 2)', () => {
  it('dispatches a well-formed task to the worker and acks', async () => {
    const send = jest.fn().mockResolvedValue({});
    const review = jest.fn().mockResolvedValue(undefined);
    const { consumer } = makeConsumer({
      send,
      lockResult: { key: 'k', token: 't' },
      review,
    });

    const task: Message = {
      MessageId: 'm-task',
      ReceiptHandle: 'rh-task',
      Body: JSON.stringify({ task: 'code_review', prompt: 'review this code' }),
      Attributes: { ApproximateReceiveCount: '1' },
      MessageAttributes: { dedupeId: { DataType: 'String', StringValue: 'dt' } },
    };

    await processMessage(consumer, task);

    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'code_review', prompt: 'review this code' }),
      'dt',
    );
    expect(lastCommands(send)).toContain('DeleteMessageCommand');
  });

  it('dispatches a summarize.session message to the summarization worker and acks', async () => {
    const send = jest.fn().mockResolvedValue({});
    const summarize = jest.fn().mockResolvedValue(undefined);
    const review = jest.fn();
    const { consumer } = makeConsumer({
      send,
      lockResult: { key: 'k', token: 't' },
      review,
      summarize,
    });

    const msg: Message = {
      MessageId: 'm-summ',
      ReceiptHandle: 'rh-summ',
      Body: JSON.stringify({ type: 'summarize.session', sessionId: 'sess-42' }),
      Attributes: { ApproximateReceiveCount: '1' },
      MessageAttributes: { dedupeId: { DataType: 'String', StringValue: 'ds' } },
    };

    await processMessage(consumer, msg);

    expect(summarize).toHaveBeenCalledWith('sess-42');
    expect(review).not.toHaveBeenCalled();
    expect(lastCommands(send)).toContain('DeleteMessageCommand');
  });

  it('skips our own completion events (no work, still acked) to avoid a loop', async () => {
    const send = jest.fn().mockResolvedValue({});
    const review = jest.fn().mockResolvedValue(undefined);
    const { consumer } = makeConsumer({
      send,
      lockResult: { key: 'k', token: 't' },
      review,
    });

    const completion: Message = {
      MessageId: 'm-done',
      ReceiptHandle: 'rh-done',
      Body: JSON.stringify({ type: 'agent.completion', status: 'completed' }),
      Attributes: { ApproximateReceiveCount: '1' },
      MessageAttributes: { dedupeId: { DataType: 'String', StringValue: 'dd' } },
    };

    await processMessage(consumer, completion);

    expect(review).not.toHaveBeenCalled();
    expect(lastCommands(send)).toContain('DeleteMessageCommand');
  });

  it('routes an unparseable body straight to the DLQ (no retry churn)', async () => {
    const send = jest.fn().mockResolvedValue({});
    const review = jest.fn().mockResolvedValue(undefined);
    const { consumer, metrics } = makeConsumer({
      send,
      lockResult: { key: 'k', token: 't' },
      review,
    });

    const garbage: Message = {
      MessageId: 'm-bad',
      ReceiptHandle: 'rh-bad',
      Body: 'not-json{',
      Attributes: { ApproximateReceiveCount: '1' },
      MessageAttributes: { dedupeId: { DataType: 'String', StringValue: 'db' } },
    };

    await processMessage(consumer, garbage);

    expect(review).not.toHaveBeenCalled();
    const cmds = lastCommands(send);
    // Permanent failure -> forwarded to the DLQ now and removed from the source
    // queue, instead of being retried 5x via the redrive policy.
    expect(cmds).toContain('SendMessageCommand');
    expect(cmds).toContain('DeleteMessageCommand');
    expect(metrics.recordSqsOutcome).toHaveBeenCalledWith('permanent_dlq');
    const sent = send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof SendMessageCommand) as SendMessageCommand;
    expect(sent.input.QueueUrl).toBe(config.sqsDlqUrl);
  });
});

describe('SQS retry backoff + attempt accounting (Phase 2)', () => {
  const taskBody = JSON.stringify({ task: 'code_review', prompt: 'p' });

  function transientTask(dedupeId: string): Message {
    return {
      MessageId: `m-${dedupeId}`,
      ReceiptHandle: `rh-${dedupeId}`,
      Body: taskBody,
      Attributes: { ApproximateReceiveCount: '1' },
      MessageAttributes: {
        dedupeId: { DataType: 'String', StringValue: dedupeId },
      },
    };
  }

  it('backs off (ChangeMessageVisibility) on a transient failure without acking', async () => {
    const send = jest.fn().mockResolvedValue({});
    const review = jest.fn().mockRejectedValue(new Error('boom'));
    const { consumer, redis, metrics } = makeConsumer({
      send,
      lockResult: { key: 'k', token: 't' },
      review,
    });

    await processMessage(consumer, transientTask('dr'));

    const cmds = lastCommands(send);
    // Backoff applied; message NOT deleted -> redelivered after the backoff window.
    expect(cmds).toContain('ChangeMessageVisibilityCommand');
    expect(cmds).not.toContain('DeleteMessageCommand');
    expect(metrics.recordSqsOutcome).toHaveBeenCalledWith('retry');
    expect(metrics.recordSqsBackoff).toHaveBeenCalledTimes(1);

    const vis = send.mock.calls
      .map((c) => c[0])
      .find(
        (c) => c instanceof ChangeMessageVisibilityCommand,
      ) as ChangeMessageVisibilityCommand;
    expect(vis.input.ReceiptHandle).toBe('rh-dr');
    // Bounded to [1s, cap]; cap is SQS_RETRY_CAP_MS (30s) -> 30s.
    expect(vis.input.VisibilityTimeout).toBeGreaterThanOrEqual(1);
    expect(vis.input.VisibilityTimeout).toBeLessThanOrEqual(30);

    // App-side attempt counter incremented exactly once for this delivery.
    expect(await redis.get('sqs:attempts:dr')).toBe('1');
  });

  it('proactively DLQs once the app-side attempt budget is exhausted', async () => {
    const send = jest.fn().mockResolvedValue({});
    const review = jest.fn().mockRejectedValue(new Error('boom'));
    const redis = new FakeRedis();
    // Already failed maxReceiveCount-1 (=4) times; this delivery hits the budget.
    await redis.set('sqs:attempts:dr2', '4');
    const { consumer, metrics } = makeConsumer({
      send,
      lockResult: { key: 'k', token: 't' },
      review,
      redis,
    });

    await processMessage(consumer, transientTask('dr2'));

    const cmds = lastCommands(send);
    // Routed to the DLQ now (backpressure) instead of backing off again.
    expect(cmds).toContain('SendMessageCommand');
    expect(cmds).toContain('DeleteMessageCommand');
    expect(cmds).not.toContain('ChangeMessageVisibilityCommand');
    expect(metrics.recordSqsOutcome).toHaveBeenCalledWith('transient_dlq');
    const sent = send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof SendMessageCommand) as SendMessageCommand;
    expect(sent.input.QueueUrl).toBe(config.sqsDlqUrl);
    // Counter cleared so a resubmission starts fresh.
    expect(await redis.get('sqs:attempts:dr2')).toBeNull();
  });

  it('clears the attempt counter after a successful handle', async () => {
    const send = jest.fn().mockResolvedValue({});
    const redis = new FakeRedis();
    await redis.set('sqs:attempts:dr3', '2'); // had failed before, now succeeds
    const { consumer } = makeConsumer({
      send,
      lockResult: { key: 'k', token: 't' },
      redis,
    });

    await processMessage(consumer, transientTask('dr3'));

    expect(lastCommands(send)).toContain('DeleteMessageCommand');
    expect(await redis.get('sqs:attempts:dr3')).toBeNull();
  });
});

describe('reliability helpers', () => {
  it('isPoisonPill flips at maxReceiveCount', () => {
    expect(isPoisonPill(4, 5)).toBe(false);
    expect(isPoisonPill(5, 5)).toBe(true);
    expect(isPoisonPill(6, 5)).toBe(true);
  });

  it('backoffWithJitter stays within the exponential cap', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const d = backoffWithJitter(attempt, 1000, 30_000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  it('heartbeatExtensionSec respects the minimum', () => {
    expect(heartbeatExtensionSec(0, 30)).toBe(30);
    expect(heartbeatExtensionSec(60_000, 30)).toBe(90);
  });
});
