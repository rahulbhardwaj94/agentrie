import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { startOtel } from './observability/otel';
import { OtelLoggerService } from './observability/otel-logger.service';

/** Read a boolean-ish env var, mirroring env.schema's coercion, with a default. */
function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

/** Read a bounded float env var with a default (for the pre-Nest OTel bootstrap). */
function envFloat(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) ? n : fallback;
}

/**
 * Bootstrap order matters:
 *  1. Start the OTel SDK FIRST (before Nest) so the W3C propagator + OTLP exporter
 *     are installed before any span is created.
 *  2. Create the Nest app; ConfigModule's Zod `validate` fails fast here on bad env.
 *  3. enableShutdownHooks() so OnApplicationShutdown drains the SQS consumer.
 *  4. On exit, flush in-flight OTel spans (sdk.shutdown()).
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // OTel reads env directly here (before Nest config is available). Mirrors
  // env.schema defaults; the validated config is used everywhere else.
  const otelEnabled = envFlag(process.env.OTEL_ENABLED, true);
  const logsEnabled = envFlag(process.env.OTEL_LOGS_ENABLED, true);
  const otel = startOtel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'agentrie',
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
    enabled: otelEnabled,
    metricsEnabled: envFlag(process.env.OTEL_METRICS_ENABLED, true),
    logsEnabled: otelEnabled && logsEnabled,
    samplerRatio: envFloat(process.env.OTEL_TRACES_SAMPLER_RATIO, 1),
    metricExportIntervalMs: Math.trunc(
      envFloat(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS, 60_000),
    ),
    tailSamplingEnabled: envFlag(
      process.env.OTEL_TRACES_TAIL_SAMPLING_ENABLED,
      false,
    ),
    tailLatencyMs: Math.trunc(
      envFloat(process.env.OTEL_TRACES_TAIL_LATENCY_MS, 0),
    ),
  });

  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
    // Bridge Nest logs into the OTel logs pipeline (trace-correlated) once the SDK
    // and its LoggerProvider are installed. Console output is preserved.
    ...(otelEnabled && logsEnabled ? { logger: new OtelLoggerService() } : {}),
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.enableShutdownHooks();

  // Flush spans on shutdown — runs alongside Nest's OnApplicationShutdown hooks.
  const flush = async () => {
    try {
      await otel.shutdown();
    } catch (err) {
      logger.warn(`OTel shutdown error: ${(err as Error).message}`);
    }
  };
  process.once('SIGTERM', flush);
  process.once('SIGINT', flush);

  const config = app.get(AppConfigService);
  await app.listen(config.port);
  logger.log(`agentrie listening on :${config.port} (env=${config.nodeEnv})`);
  logger.log(
    `LLM provider: ${config.hasAnthropicKey ? 'anthropic' : 'fake (no API key)'}`,
  );
}

void bootstrap();
