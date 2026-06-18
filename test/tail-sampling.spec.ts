import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  TailSamplingSpanProcessor,
  tailDecision,
  traceIdUnitInterval,
  type TailSamplingPolicy,
} from '../src/observability/tail-sampling';

/** Fabricate just enough of a ReadableSpan for the tail policy/processor. */
function span(opts: {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  error?: boolean;
  durationMs?: number;
}): ReadableSpan {
  const ms = opts.durationMs ?? 1;
  return {
    spanContext: () => ({
      traceId: opts.traceId,
      spanId: opts.spanId,
      traceFlags: 1,
    }),
    parentSpanId: opts.parentSpanId,
    status: { code: opts.error ? SpanStatusCode.ERROR : SpanStatusCode.OK },
    duration: [Math.floor(ms / 1000), (ms % 1000) * 1_000_000],
  } as unknown as ReadableSpan;
}

const LOW = '0'.repeat(32); // traceIdUnitInterval -> 0   (kept by any ratio > 0)
const HIGH = 'f'.repeat(32); // traceIdUnitInterval -> ~1  (dropped below ratio 1)

const keepAll: TailSamplingPolicy = { ratio: 1, latencyThresholdMs: 0 };
const dropOrdinary: TailSamplingPolicy = { ratio: 0, latencyThresholdMs: 0 };

describe('tailDecision — policy', () => {
  it('always keeps a trace containing an error span (even at ratio 0)', () => {
    const root = span({ traceId: HIGH, spanId: 'r' });
    const child = span({ traceId: HIGH, spanId: 'c', parentSpanId: 'r', error: true });
    expect(tailDecision([root, child], root, dropOrdinary)).toBe(true);
  });

  it('always keeps a slow trace (root over the latency threshold)', () => {
    const root = span({ traceId: HIGH, spanId: 'r', durationMs: 500 });
    expect(
      tailDecision([root], root, { ratio: 0, latencyThresholdMs: 200 }),
    ).toBe(true);
    // Under the threshold, the ordinary-ratio policy applies (drops at ratio 0).
    const fast = span({ traceId: HIGH, spanId: 'r', durationMs: 50 });
    expect(
      tailDecision([fast], fast, { ratio: 0, latencyThresholdMs: 200 }),
    ).toBe(false);
  });

  it('samples ordinary traces deterministically by trace id', () => {
    const low = span({ traceId: LOW, spanId: 'r' });
    const high = span({ traceId: HIGH, spanId: 'r' });
    // ratio 0.5: low id (~0) kept, high id (~1) dropped — and stable across calls.
    const policy: TailSamplingPolicy = { ratio: 0.5, latencyThresholdMs: 0 };
    expect(tailDecision([low], low, policy)).toBe(true);
    expect(tailDecision([low], low, policy)).toBe(true);
    expect(tailDecision([high], high, policy)).toBe(false);
  });

  it('ratio 1 keeps everything; ratio 0 drops the ordinary', () => {
    const s = span({ traceId: HIGH, spanId: 'r' });
    expect(tailDecision([s], s, keepAll)).toBe(true);
    expect(tailDecision([s], s, dropOrdinary)).toBe(false);
  });
});

describe('traceIdUnitInterval', () => {
  it('maps low/high trace ids to the [0,1) extremes', () => {
    expect(traceIdUnitInterval(LOW)).toBe(0);
    expect(traceIdUnitInterval(HIGH)).toBeGreaterThan(0.99);
  });
});

describe('TailSamplingSpanProcessor', () => {
  function collector(): { delegate: SpanProcessor; exported: ReadableSpan[] } {
    const exported: ReadableSpan[] = [];
    const delegate: SpanProcessor = {
      onStart: () => undefined,
      onEnd: (s) => exported.push(s),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
    return { delegate, exported };
  }

  /** A Span-shaped object for onStart (only spanContext() is read). */
  function startable(traceId: string, spanId: string): Span {
    return {
      spanContext: () => ({ traceId, spanId, traceFlags: 1 }),
    } as unknown as Span;
  }

  it('exports the whole trace once the no-parent root ends (error keeps it)', () => {
    const { delegate, exported } = collector();
    const proc = new TailSamplingSpanProcessor(delegate, dropOrdinary);

    const child = span({ traceId: HIGH, spanId: 'c', parentSpanId: 'r', error: true });
    const root = span({ traceId: HIGH, spanId: 'r' });
    proc.onEnd(child); // child first — buffered, trace not yet complete
    expect(exported).toHaveLength(0);
    proc.onEnd(root); // root ends -> decide; error => keep all
    expect(exported.map((s) => s.spanContext().spanId).sort()).toEqual(['c', 'r']);
  });

  it('drops an ordinary trace at ratio 0 when its root ends', () => {
    const { delegate, exported } = collector();
    const proc = new TailSamplingSpanProcessor(delegate, dropOrdinary);

    proc.onEnd(span({ traceId: HIGH, spanId: 'c', parentSpanId: 'r' }));
    proc.onEnd(span({ traceId: HIGH, spanId: 'r' }));
    expect(exported).toHaveLength(0);
  });

  it('treats a span with a REMOTE parent as the local root and flushes', () => {
    const { delegate, exported } = collector();
    const proc = new TailSamplingSpanProcessor(delegate, keepAll);

    // Continued distributed trace: top local span has a remote parent (e.g. SQS).
    const remoteParent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: HIGH,
      spanId: 'remote',
      traceFlags: 1,
      isRemote: true,
    });
    proc.onStart(startable(HIGH, 'local'), remoteParent);
    // Its end completes the trace for THIS process even though parentSpanId is set.
    proc.onEnd(span({ traceId: HIGH, spanId: 'local', parentSpanId: 'remote' }));
    expect(exported.map((s) => s.spanContext().spanId)).toEqual(['local']);
  });

  it('forceFlush drains a still-incomplete buffered trace', async () => {
    const { delegate, exported } = collector();
    const proc = new TailSamplingSpanProcessor(delegate, keepAll);

    // Only a child ended; the root never did, so nothing flushed yet.
    proc.onEnd(span({ traceId: LOW, spanId: 'c', parentSpanId: 'r' }));
    expect(exported).toHaveLength(0);

    await proc.forceFlush();
    expect(exported.map((s) => s.spanContext().spanId)).toEqual(['c']);
  });
});
