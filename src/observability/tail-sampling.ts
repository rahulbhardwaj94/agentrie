import { SpanStatusCode, trace, type Context } from '@opentelemetry/api';
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/**
 * In-SDK TAIL-based trace sampling.
 *
 * The head sampler (`buildSampler` in otel.ts) decides at root-span *start*, before
 * the trace's fate is known — so a low ratio drops the very traces you most want
 * (errors, slow runs). Tail sampling defers the keep/drop decision to trace *end*,
 * once every span is in hand: it always keeps a trace that errored or ran slow, and
 * samples the boring remainder at a baseline ratio. The cost is buffering a trace's
 * spans in memory until its local root ends.
 *
 * SCOPE: this is the single-process tail sampler. The canonical place for tail
 * sampling in a fleet is the OpenTelemetry Collector's `tail_sampling` processor
 * (it sees spans from every replica); this in-SDK version needs no collector config
 * and is exact for a single process — which is what each worker/api instance is.
 * When tail sampling is on, the head sampler is forced to AlwaysOn so the processor
 * sees every span to decide on.
 */
export interface TailSamplingPolicy {
  /** Baseline keep probability for ordinary (non-error, non-slow) traces, in [0,1]. */
  ratio: number;
  /**
   * Keep any trace whose local-root span lasts at least this long (ms). 0 disables
   * the latency policy (error-keep + ratio still apply).
   */
  latencyThresholdMs: number;
}

/** HrTime `[seconds, nanos]` -> milliseconds. */
function durationMs(span: ReadableSpan): number {
  return span.duration[0] * 1_000 + span.duration[1] / 1_000_000;
}

/**
 * Deterministic value in [0,1) from a trace id, so a trace is sampled whole or not
 * at all (same input -> same decision across spans/processes). Mirrors how
 * TraceIdRatioBasedSampler derives its probability from the id's low bytes.
 */
export function traceIdUnitInterval(traceId: string): number {
  const tail = traceId.slice(-8);
  const n = Number.parseInt(tail, 16);
  return Number.isNaN(n) ? 0 : n / 0x1_0000_0000;
}

/**
 * Pure tail policy: given all buffered spans of one trace plus its local-root span,
 * decide whether to KEEP (export) the trace. Exported so the policy is unit-tested
 * without standing up the SDK.
 */
export function tailDecision(
  spans: ReadableSpan[],
  root: ReadableSpan,
  policy: TailSamplingPolicy,
): boolean {
  // 1. Always keep a trace that contains an error — the whole point of tail sampling.
  if (spans.some((s) => s.status.code === SpanStatusCode.ERROR)) return true;
  // 2. Always keep a slow trace (local-root duration over the threshold).
  if (
    policy.latencyThresholdMs > 0 &&
    durationMs(root) >= policy.latencyThresholdMs
  ) {
    return true;
  }
  // 3. Otherwise sample at the baseline ratio, deterministically per trace id.
  if (policy.ratio >= 1) return true;
  if (policy.ratio <= 0) return false;
  return traceIdUnitInterval(root.spanContext().traceId) < policy.ratio;
}

/**
 * A {@link SpanProcessor} that buffers spans per trace and, when the trace's
 * local-root span ends, applies {@link tailDecision} and forwards the whole trace
 * to `delegate` (a real exporting processor, e.g. BatchSpanProcessor) only if kept.
 *
 * "Local root" = a span with no in-process parent: either no `parentSpanId`, or a
 * parent that lives in another process (a remote `traceparent`, e.g. across
 * SNS->SQS). Remoteness is captured at `onStart` from the parent context, so a
 * continued distributed trace still flushes at this process's boundary.
 *
 * Memory is bounded: abandoned traces (whose root never ends) are evicted oldest-
 * first past `maxTraces` and dropped (they were never decided, so dropping is the
 * safe default). forceFlush/shutdown decide and drain whatever is still buffered.
 */
export class TailSamplingSpanProcessor implements SpanProcessor {
  private readonly buffers = new Map<string, ReadableSpan[]>();
  /** Insertion order of trace ids, for bounded-memory eviction. */
  private readonly order: string[] = [];
  /** Span ids that are a local root (no parent, or a remote parent). */
  private readonly localRoots = new Set<string>();

  constructor(
    private readonly delegate: SpanProcessor,
    private readonly policy: TailSamplingPolicy,
    private readonly maxTraces = 10_000,
  ) {}

  onStart(span: Span, parentContext: Context): void {
    const parent = trace.getSpanContext(parentContext);
    // No parent, or a parent that came in over the wire -> this span roots the
    // trace as far as THIS process is concerned.
    if (!parent || parent.isRemote) {
      this.localRoots.add(span.spanContext().spanId);
    }
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    let buf = this.buffers.get(traceId);
    if (!buf) {
      buf = [];
      this.buffers.set(traceId, buf);
      this.order.push(traceId);
      this.evictIfNeeded();
    }
    buf.push(span);

    if (!span.parentSpanId || this.localRoots.has(span.spanContext().spanId)) {
      this.flush(traceId, span);
    }
  }

  forceFlush(): Promise<void> {
    // Decide and drain every still-buffered trace using its best-known root.
    for (const traceId of [...this.order]) {
      const buf = this.buffers.get(traceId);
      if (buf) this.flush(traceId, this.rootOf(buf));
    }
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    for (const traceId of [...this.order]) {
      const buf = this.buffers.get(traceId);
      if (buf) this.flush(traceId, this.rootOf(buf));
    }
    return this.delegate.shutdown();
  }

  /** Best-effort local root: an explicit root span if buffered, else the longest. */
  private rootOf(buf: ReadableSpan[]): ReadableSpan {
    const explicit = buf.find(
      (s) => !s.parentSpanId || this.localRoots.has(s.spanContext().spanId),
    );
    if (explicit) return explicit;
    return buf.reduce((a, b) => (durationMs(b) > durationMs(a) ? b : a));
  }

  private flush(traceId: string, root: ReadableSpan): void {
    const buf = this.buffers.get(traceId);
    if (!buf) return;
    this.buffers.delete(traceId);
    const i = this.order.indexOf(traceId);
    if (i >= 0) this.order.splice(i, 1);
    for (const s of buf) this.localRoots.delete(s.spanContext().spanId);

    if (tailDecision(buf, root, this.policy)) {
      for (const s of buf) this.delegate.onEnd(s);
    }
  }

  private evictIfNeeded(): void {
    while (this.order.length > this.maxTraces) {
      const evicted = this.order.shift();
      if (evicted === undefined) break;
      const buf = this.buffers.get(evicted);
      this.buffers.delete(evicted);
      // Undecided trace -> drop it, but free its local-root markers.
      for (const s of buf ?? []) this.localRoots.delete(s.spanContext().spanId);
    }
  }
}
