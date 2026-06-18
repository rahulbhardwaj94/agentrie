/**
 * EventBus — decoupling seam for cross-worker events. The internal
 * @nestjs/event-emitter handles in-process events (Phase 1); this interface is
 * the SNS/SQS-backed contract for distributed events (Phase 2).
 */

/** A domain event broadcast when an agent completes a run. */
export interface AgentCompletionEvent {
  type: 'agent.completion';
  sessionId: string;
  status: string;
  /** Dedupe id — used as the idempotency lock key on the consumer side. */
  dedupeId: string;
  /** Domain payload only — NEVER trace context (that travels in attributes). */
  payload: Record<string, unknown>;
}

/**
 * Request to summarize a session's hot window — emitted when it crosses the 80%
 * context threshold and SUMMARIZATION_TRANSPORT=sqs. The consumer drives
 * SummarizationWorker.summarizeSession; the work itself is transport-agnostic.
 */
export interface SummarizationRequestedEvent {
  type: 'summarize.session';
  sessionId: string;
  /** Dedupe id — idempotency lock key on the consumer side. */
  dedupeId: string;
  totalTokens: number;
  contextLimit: number;
}

/** Everything publishable on the bus. All variants carry `type` + `dedupeId`. */
export type BusEvent = AgentCompletionEvent | SummarizationRequestedEvent;

export interface EventBus {
  /**
   * Publish an event. Implementations MUST carry trace context in transport
   * message attributes (W3C traceparent), never in the body.
   */
  publish(event: BusEvent): Promise<void>;
}

export const EVENT_BUS = Symbol('EVENT_BUS');
