import { z } from 'zod';

/**
 * Wire contract for a task message delivered via SNS -> SQS (the message Body is
 * JSON; trace context travels separately in message attributes, never here).
 *
 * Validated with Zod on the consumer side: a structurally-invalid task is a
 * client error we reject, distinct from an unparseable body (poison -> DLQ).
 */
export const AgentTaskMessageSchema = z.object({
  /**
   * Discriminator. Optional for forward-compat with un-typed producers, but when
   * present it must be exactly this — lets the consumer cheaply tell a *task* from
   * a completion event echoed back onto the same topic.
   */
  type: z.literal('agent.task').optional(),
  /** Which specialized worker should handle it (only `code_review` today). */
  task: z.string().min(1),
  /** Reuse an existing session window if given; otherwise the worker derives one. */
  sessionId: z.string().min(1).optional(),
  /** Task prompt. For `code_review`: the code or diff to review. */
  prompt: z.string().min(1),
  /** Optional system-prompt override (otherwise the worker's default applies). */
  system: z.string().optional(),
});

export type AgentTaskMessage = z.infer<typeof AgentTaskMessageSchema>;

/**
 * Wire contract for a `summarize.session` request (the SQS-driven counterpart of
 * the in-process `context.threshold` event). The consumer drives
 * `SummarizationWorker.summarizeSession(sessionId)`.
 */
export const SummarizeMessageSchema = z.object({
  type: z.literal('summarize.session'),
  sessionId: z.string().min(1),
});

export type SummarizeMessage = z.infer<typeof SummarizeMessageSchema>;
