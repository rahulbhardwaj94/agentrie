import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { TailSamplingSpanProcessor } from './tail-sampling';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

/**
 * OpenTelemetry bootstrap. Started in main.ts BEFORE Nest so the SDK installs the
 * W3C trace context propagator (used by events/propagation.ts to carry traceparent
 * across SNS->SQS) and registers exporters before any span/metric/log is created.
 *
 * Three OTLP-HTTP signal pipelines share one collector endpoint:
 *  - traces  : OTLPTraceExporter (always, when enabled)
 *  - metrics : PeriodicExportingMetricReader + OTLPMetricExporter (toggle)
 *  - logs    : BatchLogRecordProcessor + OTLPLogExporter (toggle)
 *
 * Sampling is ParentBased so an upstream sampling decision in `traceparent` is
 * always honored (distributed traces stay whole across workers). The ROOT sampler
 * is config-driven via `samplerRatio` — see buildSampler.
 *
 * Returns a handle so main.ts can flush + shut it down on graceful exit.
 */
export interface OtelHandle {
  shutdown(): Promise<void>;
}

export interface StartOtelOptions {
  serviceName: string;
  endpoint: string;
  enabled: boolean;
  metricsEnabled: boolean;
  logsEnabled: boolean;
  /** Root-span sampling ratio in [0,1]. 1 => AlwaysOn; <1 => TraceIdRatioBased. */
  samplerRatio: number;
  metricExportIntervalMs: number;
  /**
   * Defer the keep/drop decision to trace END (always keep error/slow traces,
   * sample the rest at `samplerRatio`). Forces the head sampler to AlwaysOn.
   */
  tailSamplingEnabled: boolean;
  /** Under tail sampling, always keep a trace whose root lasts >= this (ms). 0 off. */
  tailLatencyMs: number;
}

/**
 * Build the trace sampler from a root-span ratio. Pure + exported so it can be
 * unit-tested without standing up the SDK.
 *
 * ratio >= 1 keeps the historical ParentBased(AlwaysOn). ratio <= 0 drops every
 * root (children still follow a sampled parent). In between, the root decision is
 * TraceIdRatioBased — deterministic per trace id, so a trace is sampled whole or
 * not at all. ParentBased always defers to an upstream traceparent decision.
 */
export function buildSampler(ratio: number): Sampler {
  const root =
    ratio >= 1 ? new AlwaysOnSampler() : new TraceIdRatioBasedSampler(ratio);
  return new ParentBasedSampler({ root });
}

/** Normalize an OTLP base endpoint into the per-signal path. */
function signalUrl(endpoint: string, signal: 'traces' | 'metrics' | 'logs'): string {
  return `${endpoint.replace(/\/$/, '')}/v1/${signal}`;
}

export function startOtel(opts: StartOtelOptions): OtelHandle {
  if (!opts.enabled) {
    return { shutdown: async () => undefined };
  }

  if (process.env.OTEL_DEBUG === 'true') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: '0.1.0',
  });

  const metricReader = opts.metricsEnabled
    ? new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: signalUrl(opts.endpoint, 'metrics'),
        }),
        exportIntervalMillis: opts.metricExportIntervalMs,
      })
    : undefined;

  const logRecordProcessors = opts.logsEnabled
    ? [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({ url: signalUrl(opts.endpoint, 'logs') }),
        ),
      ]
    : undefined;

  // OTLP HTTP trace exporter -> Jaeger/Tempo/Honeycomb-compatible collector.
  const traceExporter = new OTLPTraceExporter({
    url: signalUrl(opts.endpoint, 'traces'),
  });

  // Tail sampling wraps the real batch exporter in a buffering processor and forces
  // the head sampler to AlwaysOn (record everything so the tail can decide). Head
  // sampling keeps the simple traceExporter + ratio sampler path.
  const tailProcessor: SpanProcessor | undefined = opts.tailSamplingEnabled
    ? new TailSamplingSpanProcessor(new BatchSpanProcessor(traceExporter), {
        ratio: opts.samplerRatio,
        latencyThresholdMs: opts.tailLatencyMs,
      })
    : undefined;

  const sdk = new NodeSDK({
    resource,
    sampler: tailProcessor ? buildSampler(1) : buildSampler(opts.samplerRatio),
    ...(tailProcessor
      ? { spanProcessors: [tailProcessor] }
      : { traceExporter }),
    ...(metricReader ? { metricReader } : {}),
    ...(logRecordProcessors ? { logRecordProcessors } : {}),
  });

  sdk.start();
  return {
    shutdown: () => sdk.shutdown(),
  };
}
