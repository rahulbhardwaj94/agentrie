import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Typed, injectable wrapper over Nest's ConfigService.
 *
 * Everything has already passed Zod validation at boot, so accessors here return
 * non-optional, correctly-typed values — no `?? default` noise at call sites.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.get('NODE_ENV');
  }
  get isProd(): boolean {
    return this.nodeEnv === 'production';
  }
  get port(): number {
    return this.get('PORT');
  }

  // LLM
  get anthropicApiKey(): string {
    return this.get('ANTHROPIC_API_KEY');
  }
  get hasAnthropicKey(): boolean {
    return this.anthropicApiKey.trim().length > 0;
  }
  get llmModel(): string {
    return this.get('LLM_MODEL');
  }
  get llmContextLimit(): number {
    return this.get('LLM_CONTEXT_LIMIT');
  }
  get llmMaxOutputTokens(): number {
    return this.get('LLM_MAX_OUTPUT_TOKENS');
  }
  get llmTimeoutMs(): number {
    return this.get('LLM_TIMEOUT_MS');
  }

  // Redis
  get redisUrl(): string {
    return this.get('REDIS_URL');
  }
  /** Redlock masters: explicit REDIS_NODES, or a single-node fallback on REDIS_URL. */
  get redisLockNodes(): string[] {
    const nodes = this.get('REDIS_NODES');
    return nodes.length > 0 ? nodes : [this.redisUrl];
  }

  // Mongo
  get mongoUri(): string {
    return this.get('MONGO_URI');
  }
  get sessionArchiveTtlSeconds(): number {
    return this.get('SESSION_ARCHIVE_TTL_DAYS') * 24 * 60 * 60;
  }

  // Agent guardrails
  get agentMaxIterations(): number {
    return this.get('AGENT_MAX_ITERATIONS');
  }
  get agentMaxToolCalls(): number {
    return this.get('AGENT_MAX_TOOL_CALLS');
  }
  get agentTimeoutMs(): number {
    return this.get('AGENT_TIMEOUT_MS');
  }

  // Locks
  get lockTtlMs(): number {
    return this.get('LOCK_TTL_MS');
  }
  get lockDriftFactor(): number {
    return this.get('LOCK_DRIFT_FACTOR');
  }

  // Summarization transport
  get summarizationTransport(): Env['SUMMARIZATION_TRANSPORT'] {
    return this.get('SUMMARIZATION_TRANSPORT');
  }
  get isSummarizationSqs(): boolean {
    return this.summarizationTransport === 'sqs';
  }
  get summarizeCooldownMs(): number {
    return this.get('SUMMARIZE_COOLDOWN_MS');
  }

  // AWS / LocalStack
  get awsRegion(): string {
    return this.get('AWS_REGION');
  }
  get awsAccessKeyId(): string {
    return this.get('AWS_ACCESS_KEY_ID');
  }
  get awsSecretAccessKey(): string {
    return this.get('AWS_SECRET_ACCESS_KEY');
  }
  get awsEndpointUrl(): string {
    return this.get('AWS_ENDPOINT_URL');
  }
  get sqsQueueUrl(): string {
    return this.get('SQS_QUEUE_URL');
  }
  get sqsDlqUrl(): string {
    return this.get('SQS_DLQ_URL');
  }
  get snsTopicArn(): string {
    return this.get('SNS_TOPIC_ARN');
  }
  get sqsVisibilityTimeoutSec(): number {
    return this.get('SQS_VISIBILITY_TIMEOUT_SEC');
  }
  get sqsWaitTimeSeconds(): number {
    return this.get('SQS_WAIT_TIME_SECONDS');
  }
  get sqsMaxReceiveCount(): number {
    return this.get('SQS_MAX_RECEIVE_COUNT');
  }
  get sqsRetryBaseMs(): number {
    return this.get('SQS_RETRY_BASE_MS');
  }
  get sqsRetryCapMs(): number {
    return this.get('SQS_RETRY_CAP_MS');
  }

  // Observability
  get otelEnabled(): boolean {
    return this.get('OTEL_ENABLED');
  }
  get otelServiceName(): string {
    return this.get('OTEL_SERVICE_NAME');
  }
  get otelEndpoint(): string {
    return this.get('OTEL_EXPORTER_OTLP_ENDPOINT');
  }
  get otelMetricsEnabled(): boolean {
    return this.get('OTEL_METRICS_ENABLED');
  }
  get otelLogsEnabled(): boolean {
    return this.get('OTEL_LOGS_ENABLED');
  }
  get otelMetricExportIntervalMs(): number {
    return this.get('OTEL_METRIC_EXPORT_INTERVAL_MS');
  }
  get otelTracesSamplerRatio(): number {
    return this.get('OTEL_TRACES_SAMPLER_RATIO');
  }
  get otelTracesTailSamplingEnabled(): boolean {
    return this.get('OTEL_TRACES_TAIL_SAMPLING_ENABLED');
  }
  get otelTracesTailLatencyMs(): number {
    return this.get('OTEL_TRACES_TAIL_LATENCY_MS');
  }

  // Tools
  get toolWorkspaceRoot(): string {
    return this.get('TOOL_WORKSPACE_ROOT');
  }

  // Eval / scoring layer
  get evalConcurrency(): number {
    return this.get('EVAL_CONCURRENCY');
  }
  get evalJudgeEnabled(): boolean {
    return this.get('EVAL_JUDGE_ENABLED');
  }
  get evalWeights(): Record<string, number> {
    return this.get('EVAL_WEIGHTS');
  }
  get evalReportDir(): string {
    return this.get('EVAL_REPORT_DIR');
  }
}
