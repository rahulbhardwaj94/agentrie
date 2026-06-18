import { Injectable, Logger } from '@nestjs/common';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { CapturedSpan } from './eval.types';

/**
 * SpanCollector — turns the spans the agent ALREADY emits into a first-class
 * scoring input.
 *
 * It does NOT introduce a second tracing path: it registers an in-memory OTel
 * tracer provider (with the Node async-hooks context manager, so parent/child
 * nesting across `await` is preserved) as the process-global provider. From then
 * on every `TracingService.withSpan` call in `AgentRunner` records into memory,
 * and we can pull back the exact span tree for a given run by its trace id.
 *
 * Intended for the eval process (the CLI / tests), which does NOT start the OTLP
 * NodeSDK — so there is exactly one global provider and no exporter contention.
 * In the long-running server the OTLP SDK stays the global provider untouched.
 */
@Injectable()
export class SpanCollector {
  private readonly logger = new Logger(SpanCollector.name);
  private exporter?: InMemorySpanExporter;
  private provider?: NodeTracerProvider;
  private registered = false;

  /**
   * Install the in-memory provider as the global OTel provider. Idempotent — safe
   * to call from a module init and again defensively from the runner.
   */
  register(): void {
    if (this.registered) return;
    this.exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(this.exporter));
    // Reset any prior global (e.g. a no-op provider) so ours wins deterministically.
    trace.disable();
    provider.register();
    this.provider = provider;
    this.registered = true;
    this.logger.log('In-memory span collector registered as global tracer provider');
  }

  /** True once `register()` has installed the in-memory provider. */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Build the span tree for a single run, identified by its trace id. Returns the
   * root spans (normally a single `agent.run`) with children nested, plus the
   * flat list. Spans for other (concurrent) runs are filtered out by trace id, so
   * this is safe under bounded concurrency.
   */
  collectByTrace(traceId: string): { tree: CapturedSpan[]; flat: CapturedSpan[] } {
    if (!this.exporter) return { tree: [], flat: [] };
    const spans = this.exporter
      .getFinishedSpans()
      .filter((s) => s.spanContext().traceId === traceId);
    return this.buildTree(spans);
  }

  /** Drop captured spans for a trace once scored, to bound memory across a run. */
  release(traceId: string): void {
    if (!this.exporter) return;
    // InMemorySpanExporter has no selective delete; rebuild the buffer without it.
    const keep = this.exporter
      .getFinishedSpans()
      .filter((s) => s.spanContext().traceId !== traceId);
    this.exporter.reset();
    for (const s of keep) {
      // Re-export retained spans; SimpleSpanProcessor pushes straight through.
      this.exporter.export([s], () => undefined);
    }
  }

  /** Flush + tear down (called on CLI/app shutdown). */
  async shutdown(): Promise<void> {
    if (this.provider) {
      await this.provider.shutdown();
    }
  }

  private buildTree(spans: ReadableSpan[]): {
    tree: CapturedSpan[];
    flat: CapturedSpan[];
  } {
    const byId = new Map<string, CapturedSpan>();
    for (const s of spans) {
      const ctx = s.spanContext();
      byId.set(ctx.spanId, {
        spanId: ctx.spanId,
        parentSpanId: s.parentSpanId,
        traceId: ctx.traceId,
        name: s.name,
        status: this.mapStatus(s.status.code),
        statusMessage: s.status.message,
        attributes: this.normalizeAttributes(s.attributes),
        durationMs: this.hrToMs(s.duration),
        children: [],
      });
    }
    const roots: CapturedSpan[] = [];
    for (const span of byId.values()) {
      const parent = span.parentSpanId
        ? byId.get(span.parentSpanId)
        : undefined;
      if (parent) {
        parent.children.push(span);
      } else {
        roots.push(span);
      }
    }
    // Stable ordering: by start (duration is a poor key; use insertion via name+id).
    const flat = [...byId.values()];
    return { tree: roots, flat };
  }

  private mapStatus(code: SpanStatusCode): CapturedSpan['status'] {
    if (code === SpanStatusCode.OK) return 'ok';
    if (code === SpanStatusCode.ERROR) return 'error';
    return 'unset';
  }

  private hrToMs(hr: [number, number]): number {
    return hr[0] * 1000 + hr[1] / 1e6;
  }

  private normalizeAttributes(
    attrs: Record<string, unknown>,
  ): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean'
      ) {
        out[k] = v;
      } else if (v !== undefined && v !== null) {
        out[k] = String(v);
      }
    }
    return out;
  }
}
