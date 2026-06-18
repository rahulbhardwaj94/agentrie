import { z } from 'zod';

/**
 * Single source of truth for environment configuration.
 *
 * The `validate` hook on ConfigModule (see config.module.ts) runs this schema at
 * boot. If anything is missing or malformed the process exits before Nest finishes
 * wiring — "fail fast on boot" per the cross-cutting requirements.
 */

// Coerce helpers: env vars are always strings.
const boolish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // --- LLM ---
  // Empty string => no key => FakeLlmProvider is selected (keyless local default).
  ANTHROPIC_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('claude-opus-4-8'),
  LLM_CONTEXT_LIMIT: z.coerce.number().int().positive().default(200_000),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1024),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  // --- Redis ---
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  // Comma-separated list of independent Redis masters for the Redlock distributed
  // lock (LOCK_SERVICE). Empty => single-node degrade using REDIS_URL. Each entry
  // is validated as a URL so a typo fails fast at boot.
  REDIS_NODES: z
    .string()
    .default('')
    .transform((s, ctx) => {
      const urls = s
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean);
      for (const url of urls) {
        if (!z.string().url().safeParse(url).success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `REDIS_NODES contains an invalid URL: ${url}`,
          });
          return z.NEVER;
        }
      }
      return urls;
    }),

  // --- MongoDB ---
  MONGO_URI: z.string().default('mongodb://localhost:27017/agentrie'),
  SESSION_ARCHIVE_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // --- Agent guardrails ---
  AGENT_MAX_ITERATIONS: z.coerce.number().int().positive().default(10),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(20),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  // --- Locks ---
  LOCK_TTL_MS: z.coerce.number().int().positive().default(150_000),
  // Redlock clock-drift factor: fraction of TTL reserved as a safety margin so a
  // lock isn't treated as valid right up to its expiry across drifting masters.
  LOCK_DRIFT_FACTOR: z.coerce.number().min(0).max(1).default(0.01),

  // --- Summarization transport ---
  // Where the 80%-threshold trigger is handled:
  //   inprocess - the in-process SummarizationWorker runs it (keyless/no-AWS default).
  //   sqs       - publish a summarize.session event to SNS; the SQS consumer drives
  //               SummarizationWorker.summarizeSession (requires CONSUMER_ENABLED=true).
  SUMMARIZATION_TRANSPORT: z.enum(['inprocess', 'sqs']).default('inprocess'),
  // Debounce: once the window crosses 80%, suppress repeat threshold events for
  // this long. Without it, every append while the window sits over the line emits
  // a fresh summarize.session (the dedupeId carries totalTokens, which changes per
  // append, so transport dedup can't collapse them). The latch re-arms instantly
  // when the window drops back under threshold; the TTL is a self-healing fallback
  // if a stuck/slow summarizer never brings it down.
  SUMMARIZE_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),

  // --- AWS / LocalStack ---
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  AWS_ENDPOINT_URL: z.string().default('http://localhost:4566'),
  SQS_QUEUE_URL: z
    .string()
    .default('http://localhost:4566/000000000000/agent-tasks'),
  SQS_DLQ_URL: z
    .string()
    .default('http://localhost:4566/000000000000/agent-tasks-dlq'),
  SNS_TOPIC_ARN: z
    .string()
    .default('arn:aws:sns:us-east-1:000000000000:agent-events'),
  SQS_VISIBILITY_TIMEOUT_SEC: z.coerce.number().int().positive().default(150),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().positive().default(5),
  // Per-message retry backoff (exponential + full jitter) applied on a TRANSIENT
  // handler failure by shrinking/extending the message's visibility timeout, so a
  // failing message isn't redelivered on the fixed visibility window. base * 2^attempt
  // capped at SQS_RETRY_CAP_MS; attempt comes from the app-side attempt counter.
  SQS_RETRY_BASE_MS: z.coerce.number().int().positive().default(1000),
  SQS_RETRY_CAP_MS: z.coerce.number().int().positive().default(30_000),

  // --- Observability ---
  OTEL_ENABLED: boolish.default('true'),
  OTEL_SERVICE_NAME: z.string().default('agentrie'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .url()
    .default('http://localhost:4318'),
  // Metrics + logs pipelines ride the same OTLP endpoint as traces. Independently
  // toggleable so a deployment can run traces-only (the historical behavior) or
  // light up the full signal set. Both default on alongside OTEL_ENABLED.
  OTEL_METRICS_ENABLED: boolish.default('true'),
  OTEL_LOGS_ENABLED: boolish.default('true'),
  // Periodic metric export cadence (PeriodicExportingMetricReader).
  OTEL_METRIC_EXPORT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  // Root-span sampling ratio for prod cost control. 1.0 keeps the historical
  // ParentBased(AlwaysOn) behavior; <1 swaps the root sampler to TraceIdRatioBased
  // while still honoring an upstream traceparent decision so distributed traces
  // stay whole. Bounded [0,1]; fails fast at boot if out of range.
  OTEL_TRACES_SAMPLER_RATIO: z.coerce.number().min(0).max(1).default(1),
  // Tail-based sampling: when on, the keep/drop decision is deferred to trace END
  // so error/slow traces are always kept and only the boring remainder is sampled
  // (at OTEL_TRACES_SAMPLER_RATIO). The head sampler is forced to AlwaysOn so the
  // tail processor sees every span. Off by default — the head ratio sampler stays.
  OTEL_TRACES_TAIL_SAMPLING_ENABLED: boolish.default('false'),
  // Under tail sampling, always keep a trace whose root span lasts at least this
  // long (ms). 0 disables the latency policy (error-keep + ratio still apply).
  OTEL_TRACES_TAIL_LATENCY_MS: z.coerce.number().int().nonnegative().default(0),

  // --- Tools ---
  TOOL_WORKSPACE_ROOT: z.string().default('./workspace'),

  // --- Eval / scoring layer ---
  // Bounded concurrency for running dataset cases against the AgentRunner.
  EVAL_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // LLM-as-judge is opt-in; keyless runs use a deterministic stub judge instead.
  EVAL_JUDGE_ENABLED: boolish.default('false'),
  // Per-scorer weights (JSON object name->weight) for the weighted-mean aggregate.
  // Unlisted scorers fall back to their own defaultWeight.
  EVAL_WEIGHTS: z
    .string()
    .default('{}')
    .transform((s, ctx) => {
      try {
        const obj = JSON.parse(s) as unknown;
        if (
          typeof obj !== 'object' ||
          obj === null ||
          Object.values(obj).some((v) => typeof v !== 'number')
        ) {
          throw new Error('expected a JSON object of name->number');
        }
        return obj as Record<string, number>;
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `EVAL_WEIGHTS must be a JSON object of scorer->weight: ${(err as Error).message}`,
        });
        return z.NEVER;
      }
    }),
  // Output directory for generated HTML/JSON eval reports.
  EVAL_REPORT_DIR: z.string().default('evals/reports'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * ConfigModule `validate` callback. Throwing here aborts boot.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration. Fix the following and restart:\n${issues}`,
    );
  }

  // Cross-field invariant: SQS visibility timeout must exceed max agent exec time,
  // otherwise a long agent run releases its message back to the queue mid-flight
  // and gets reprocessed. Documented in events/sqs.consumer.ts.
  const visibilityMs = parsed.data.SQS_VISIBILITY_TIMEOUT_SEC * 1000;
  if (visibilityMs <= parsed.data.AGENT_TIMEOUT_MS) {
    throw new Error(
      `SQS_VISIBILITY_TIMEOUT_SEC (${parsed.data.SQS_VISIBILITY_TIMEOUT_SEC}s = ${visibilityMs}ms) ` +
        `must exceed AGENT_TIMEOUT_MS (${parsed.data.AGENT_TIMEOUT_MS}ms). ` +
        `Otherwise SQS redelivers in-flight messages mid-execution.`,
    );
  }

  return parsed.data;
}
