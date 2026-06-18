import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentRunner } from '../agent/agent-runner.service';
import { EVENT_BUS, type EventBus } from '../events/event-bus.interface';
import { TracingService } from '../observability/tracing.service';
import type { AgentTaskMessage } from './worker.types';

/**
 * Specialized worker: a Code Reviewer agent (Phase 2, REAL).
 *
 * Given a parsed task message it drives the unmodified {@link AgentRunner} with a
 * code-review system prompt, then publishes the structured outcome back onto the
 * bus as an `agent.completion` event.
 *
 * Trace context: the caller ({@link SqsConsumer}) has already re-attached the
 * producer's W3C trace context as the *active* context, so the `worker.code_review`
 * span and everything under it (agent.run, llm.complete, tool calls) join the
 * producer's distributed trace. The completion event we publish re-injects that
 * same context into its message attributes, keeping the trace whole end-to-end.
 */
@Injectable()
export class CodeReviewerWorker {
  private readonly logger = new Logger(CodeReviewerWorker.name);

  private static readonly SYSTEM_PROMPT =
    'You are a meticulous senior code reviewer. Review the provided code for ' +
    'correctness bugs, security issues, and clarity. Be specific and concise; ' +
    'cite the exact lines or constructs you are concerned about.';

  constructor(
    private readonly runner: AgentRunner,
    private readonly tracing: TracingService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  /**
   * Run the review and publish the result. `dedupeId` flows through to the
   * completion event so downstream consumers get the same idempotency key.
   * Throws are intentionally allowed to propagate so the consumer leaves the
   * message un-acked (SQS retries -> DLQ via the redrive policy).
   */
  async review(task: AgentTaskMessage, dedupeId: string): Promise<void> {
    const sessionId = task.sessionId ?? `review-${dedupeId}`;

    const result = await this.tracing.withSpan(
      'worker.code_review',
      () =>
        this.runner.run({
          sessionId,
          prompt: task.prompt,
          system: task.system ?? CodeReviewerWorker.SYSTEM_PROMPT,
        }),
      { 'worker.task': task.task, 'agent.session_id': sessionId },
    );

    this.logger.log(
      `Code review ${sessionId}: status=${result.status} ` +
        `iterations=${result.iterations} toolCalls=${result.toolCalls}`,
    );

    // Publish the outcome back onto the bus (domain payload only; trace context
    // travels in message attributes via the publisher).
    await this.events.publish({
      type: 'agent.completion',
      sessionId,
      status: result.status,
      dedupeId,
      payload: {
        task: task.task,
        answer: result.answer,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        ...(result.error ? { error: result.error } : {}),
      },
    });
  }
}
