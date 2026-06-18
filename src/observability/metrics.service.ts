import { Injectable } from '@nestjs/common';
import {
  metrics,
  ValueType,
  type Counter,
  type Histogram,
  type Meter,
} from '@opentelemetry/api';

const METER_NAME = 'agentrie';

/**
 * Application metrics, mirroring the GenAI span set so the platform exposes the
 * same telemetry through the metrics pipeline (counts/latency distributions) that
 * traces give per-request.
 *
 * Instruments are created lazily off the GLOBAL Meter from `@opentelemetry/api`.
 * When no MeterProvider is installed (unit tests that don't start the SDK) the API
 * returns no-op instruments, so callers never need to null-check — recording is
 * always safe and cheap. The eval path and tests can install an in-memory
 * MeterProvider to assert recorded values.
 */
@Injectable()
export class MetricsService {
  private get meter(): Meter {
    // Resolved per access so a MeterProvider registered AFTER construction (the
    // SDK starts before Nest, but tests register late) is still picked up.
    return metrics.getMeter(METER_NAME);
  }

  private _agentRuns?: Counter;
  private _agentIterations?: Histogram;
  private _toolCalls?: Counter;
  private _llmDuration?: Histogram;
  private _llmTokens?: Counter;
  private _sqsMessages?: Counter;
  private _sqsBackoff?: Histogram;
  private _lockAcquire?: Counter;

  private get agentRuns(): Counter {
    return (this._agentRuns ??= this.meter.createCounter('agent.runs', {
      description: 'Completed agent runs, by terminal status.',
    }));
  }

  private get agentIterations(): Histogram {
    return (this._agentIterations ??= this.meter.createHistogram(
      'agent.iterations',
      {
        description: 'Loop iterations per agent run.',
        valueType: ValueType.INT,
      },
    ));
  }

  private get toolCalls(): Counter {
    return (this._toolCalls ??= this.meter.createCounter('agent.tool_calls', {
      description: 'Tool executions, by tool name and outcome (ok|error).',
    }));
  }

  private get llmDuration(): Histogram {
    return (this._llmDuration ??= this.meter.createHistogram(
      'llm.request.duration',
      {
        description: 'LLM completion latency.',
        unit: 'ms',
        valueType: ValueType.DOUBLE,
      },
    ));
  }

  private get llmTokens(): Counter {
    return (this._llmTokens ??= this.meter.createCounter('llm.tokens', {
      description: 'LLM token usage, by direction (input|output).',
      valueType: ValueType.INT,
    }));
  }

  private get sqsMessages(): Counter {
    return (this._sqsMessages ??= this.meter.createCounter('sqs.messages', {
      description:
        'SQS messages handled, by terminal outcome ' +
        '(success|duplicate|poison_pill|permanent_dlq|transient_dlq|retry).',
    }));
  }

  private get sqsBackoff(): Histogram {
    return (this._sqsBackoff ??= this.meter.createHistogram(
      'sqs.retry.backoff',
      {
        description: 'Backoff delay applied to a transiently-failed message.',
        unit: 'ms',
        valueType: ValueType.DOUBLE,
      },
    ));
  }

  private get lockAcquire(): Counter {
    return (this._lockAcquire ??= this.meter.createCounter('lock.acquire', {
      description:
        'Redlock acquisition attempts, by outcome ' +
        '(acquired|contended|expired). Contention rate derives from this.',
    }));
  }

  /** Record a terminal agent run: its status and how many iterations it took. */
  recordAgentRun(status: string, iterations: number): void {
    this.agentRuns.add(1, { status });
    this.agentIterations.record(iterations, { status });
  }

  /** Record a single tool execution outcome. */
  recordToolCall(tool: string, isError: boolean): void {
    this.toolCalls.add(1, { tool, outcome: isError ? 'error' : 'ok' });
  }

  /** Record one LLM completion: latency plus input/output token usage. */
  recordLlmCall(attrs: {
    model: string;
    system: string;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
  }): void {
    const dims = { model: attrs.model, system: attrs.system };
    this.llmDuration.record(attrs.durationMs, dims);
    if (attrs.inputTokens !== undefined) {
      this.llmTokens.add(attrs.inputTokens, { ...dims, direction: 'input' });
    }
    if (attrs.outputTokens !== undefined) {
      this.llmTokens.add(attrs.outputTokens, { ...dims, direction: 'output' });
    }
  }

  /** Record how an SQS message was disposed of (one terminal outcome per message). */
  recordSqsOutcome(outcome: SqsOutcome): void {
    this.sqsMessages.add(1, { outcome });
  }

  /** Record the backoff delay applied before a transient retry. */
  recordSqsBackoff(delayMs: number): void {
    this.sqsBackoff.record(delayMs);
  }

  /** Record a Redlock acquisition attempt's outcome (drives the contention rate). */
  recordLockAcquire(outcome: LockOutcome): void {
    this.lockAcquire.add(1, { outcome });
  }
}

/** Terminal disposition of a single SQS message. */
export type SqsOutcome =
  | 'success'
  | 'duplicate'
  | 'poison_pill'
  | 'permanent_dlq'
  | 'transient_dlq'
  | 'retry';

/** Outcome of a single Redlock acquire round. */
export type LockOutcome = 'acquired' | 'contended' | 'expired';

/**
 * Structural seam the lock layer records through, so `RedlockService` stays
 * decoupled from the observability module (and its many keyless test constructors
 * keep working with metrics omitted). `MetricsService` satisfies it.
 */
export interface LockMetrics {
  recordLockAcquire(outcome: LockOutcome): void;
}
