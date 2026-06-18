import {
  context as otelContext,
  propagation,
  trace,
  type Context,
} from '@opentelemetry/api';

/**
 * REAL W3C trace-context propagation across SNS -> SQS.
 *
 * Trace context travels in **message attributes** (the W3C `traceparent` key),
 * NEVER in the message body — so consumers can extract it without parsing/trusting
 * the payload, and the body stays a pure domain event. This wiring is real even
 * though the Phase 2 worker bodies are stubbed: a published event carries the
 * traceparent and the consumer re-attaches it, keeping distributed traces whole.
 *
 * Shape note: SNS PublishCommand `MessageAttributes` and SQS message attributes
 * share the `{ DataType, StringValue }` shape, so one injector serves both.
 */

export interface MessageAttribute {
  DataType: string;
  StringValue: string;
}
export type MessageAttributeMap = Record<string, MessageAttribute>;

/**
 * Loose, read-only shape for INCOMING attributes (SQS/SNS message attributes carry
 * optional fields). Used by extractTraceContext so the AWS SDK's
 * `Record<string, MessageAttributeValue>` is structurally assignable.
 */
export type ReadableAttributeMap = Record<
  string,
  { StringValue?: string } | undefined
>;

/** Inject the active (or given) context as message attributes. */
export function injectTraceContext(
  ctx: Context = otelContext.active(),
): MessageAttributeMap {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  const attrs: MessageAttributeMap = {};
  for (const [k, v] of Object.entries(carrier)) {
    attrs[k] = { DataType: 'String', StringValue: v };
  }
  return attrs;
}

/**
 * Extract a parent Context from received SQS message attributes. Returns a
 * Context the consumer can activate so its spans become children of the producer.
 */
export function extractTraceContext(
  attrs: ReadableAttributeMap | undefined,
): Context {
  if (!attrs) return otelContext.active();
  const carrier: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v?.StringValue) carrier[k] = v.StringValue;
  }
  return propagation.extract(otelContext.active(), carrier);
}

/** Convenience: read the current traceparent string (for logging/debug). */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(otelContext.active(), carrier);
  return carrier['traceparent'];
}

/** True when there is a valid active span context to propagate. */
export function hasActiveSpan(): boolean {
  return trace.getSpanContext(otelContext.active()) !== undefined;
}
