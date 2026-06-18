import { metrics } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { buildSampler } from '../src/observability/otel';
import { MetricsService } from '../src/observability/metrics.service';
import { OtelLoggerService } from '../src/observability/otel-logger.service';

/**
 * Phase 3 observability depth — the metrics + logs pipelines and the config-driven
 * sampler. Mirrors the eval SpanCollector pattern: install an in-memory OTel
 * provider as the global, drive the production code, and assert what it emitted.
 */
describe('buildSampler — config-driven root sampling', () => {
  it('uses an always-on root at ratio 1 (historical behavior)', () => {
    expect(buildSampler(1).toString()).toContain('AlwaysOnSampler');
  });

  it('uses a TraceIdRatioBased root below 1 (prod cost control)', () => {
    const desc = buildSampler(0.25).toString();
    expect(desc).toContain('TraceIdRatioBased');
    // Still ParentBased so an upstream traceparent decision is honored.
    expect(desc).toContain('ParentBased');
  });
});

describe('MetricsService — metrics pipeline', () => {
  let exporter: InMemoryMetricExporter;
  let provider: MeterProvider;
  let svc: MetricsService;

  beforeEach(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 24 * 60 * 60 * 1000, // never fires on its own; we flush manually
    });
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    svc = new MetricsService();
  });

  afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
  });

  /** Flush the reader and return a flat name->summed-value map across data points. */
  async function collect(): Promise<Map<string, number>> {
    await provider.forceFlush();
    const out = new Map<string, number>();
    for (const rm of exporter.getMetrics() as ResourceMetrics[]) {
      for (const scope of rm.scopeMetrics) {
        for (const m of scope.metrics) {
          let sum = 0;
          for (const dp of m.dataPoints) {
            const v = dp.value as unknown;
            sum +=
              typeof v === 'number'
                ? v
                : (v as { sum?: number; count?: number }).sum ??
                  (v as { count?: number }).count ??
                  0;
          }
          out.set(m.descriptor.name, (out.get(m.descriptor.name) ?? 0) + sum);
        }
      }
    }
    return out;
  }

  it('records agent runs, tool calls, and LLM latency/tokens', async () => {
    svc.recordAgentRun('completed', 3);
    svc.recordToolCall('read_file', false);
    svc.recordToolCall('read_file', true);
    svc.recordLlmCall({
      model: 'fake',
      system: 'fake',
      durationMs: 12,
      inputTokens: 100,
      outputTokens: 20,
    });

    const m = await collect();

    expect(m.get('agent.runs')).toBe(1);
    expect(m.get('agent.iterations')).toBe(3); // histogram sum
    expect(m.get('agent.tool_calls')).toBe(2); // two executions
    expect(m.get('llm.request.duration')).toBe(12); // histogram sum
    expect(m.get('llm.tokens')).toBe(120); // input + output
  });

  it('is a safe no-op when no MeterProvider is installed', () => {
    metrics.disable();
    const orphan = new MetricsService();
    // Must not throw against the global no-op meter.
    expect(() => orphan.recordAgentRun('error', 0)).not.toThrow();
  });
});

describe('OtelLoggerService — logs pipeline bridge', () => {
  let exporter: InMemoryLogRecordExporter;
  let provider: LoggerProvider;

  beforeEach(() => {
    exporter = new InMemoryLogRecordExporter();
    provider = new LoggerProvider();
    provider.addLogRecordProcessor(new SimpleLogRecordProcessor(exporter));
    logs.setGlobalLoggerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    logs.disable();
  });

  it('emits an OTel LogRecord mirroring a Nest log call', () => {
    const logger = new OtelLoggerService();
    logger.warn('disk almost full', 'HealthCheck');

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0].body).toBe('disk almost full');
    expect(records[0].severityNumber).toBe(SeverityNumber.WARN);
    expect(records[0].attributes?.['log.context']).toBe('HealthCheck');
  });
});
