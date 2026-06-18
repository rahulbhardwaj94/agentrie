import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentRunner } from '../agent/agent-runner.service';
import type { AgentRunInput } from '../agent/agent.types';
import { AppConfigService } from '../config/app-config.service';
import {
  LLM_PROVIDER,
  type LlmProvider,
} from '../llm/llm-provider.interface';
import { TracingService } from '../observability/tracing.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import type {
  AgentConfigOverride,
  CaseResult,
  ConfigFingerprint,
  Dataset,
  EvalCase,
  EvalRunRecord,
} from './eval.types';
import { ScorerRegistry } from './scoring/scorer-registry.service';
import { SpanCollector } from './span-collector.service';
import {
  EVAL_RUN_STORE,
  type EvalRunStore,
} from './store/eval-run-store.interface';

/**
 * EvalRunnerService — the spine. Runs the (unmodified) AgentRunner against every
 * case in a dataset with bounded concurrency, captures BOTH the structured result
 * and the exact span tree for each run, scores them, and persists the run for
 * compare mode to diff against.
 *
 * Robustness: a single case throwing scores 0 and is recorded — it never aborts
 * the suite (matches the runner's own "never throw into the void" posture).
 */
@Injectable()
export class EvalRunnerService {
  private readonly logger = new Logger(EvalRunnerService.name);

  constructor(
    private readonly agent: AgentRunner,
    private readonly tracing: TracingService,
    private readonly spans: SpanCollector,
    private readonly scorers: ScorerRegistry,
    private readonly tools: ToolRegistryService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(EVAL_RUN_STORE) private readonly store: EvalRunStore,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Run a dataset under one config, persist the record, and return it.
   * `override` is the compare-mode candidate/baseline config (omit for a plain run).
   */
  async run(
    dataset: Dataset,
    override: AgentConfigOverride = {},
  ): Promise<EvalRunRecord> {
    this.spans.register();
    const runId = `${dataset.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const fingerprint = this.fingerprint(override);
    this.logger.log(
      `Eval run ${runId} — dataset ${dataset.id} v${dataset.version}, ` +
        `${dataset.cases.length} cases, config '${fingerprint.label}', ` +
        `concurrency ${this.config.evalConcurrency}`,
    );

    const caseResults = await this.mapWithConcurrency(
      dataset.cases,
      this.config.evalConcurrency,
      (c) => this.runCase(runId, c, override),
    );

    const aggregateScore = mean(caseResults.map((r) => r.score));
    const passRate =
      caseResults.length === 0
        ? 0
        : caseResults.filter((r) => r.pass).length / caseResults.length;

    const record: EvalRunRecord = {
      runId,
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      config: fingerprint,
      aggregateScore,
      passRate,
      caseResults,
      createdAt: new Date().toISOString(),
    };

    try {
      await this.store.save(record);
    } catch (err) {
      // Persistence failure must not lose the in-memory result; warn and continue.
      this.logger.warn(`Failed to persist run ${runId}: ${(err as Error).message}`);
    }

    this.logger.log(
      `Eval run ${runId} done — aggregate ${aggregateScore.toFixed(3)}, ` +
        `pass rate ${(passRate * 100).toFixed(1)}%`,
    );
    return record;
  }

  /** Run + score a single case. Never throws — a crash is recorded as score 0. */
  private async runCase(
    runId: string,
    evalCase: EvalCase,
    override: AgentConfigOverride,
  ): Promise<CaseResult> {
    const sessionId = `${runId}:${evalCase.id}`;
    const input = this.buildInput(sessionId, evalCase, override);

    try {
      // Wrap the run in an `eval.case` span purely to mint/read ONE trace id; all
      // of AgentRunner's spans nest under it and share that id (reusing the
      // existing tracing context — we don't invent a second correlation scheme).
      const { result, traceId } = await this.tracing.withSpan(
        'eval.case',
        async (span) => {
          const tid = span.spanContext().traceId;
          const res = await this.agent.run(input);
          return { result: res, traceId: tid };
        },
        { 'eval.case_id': evalCase.id, 'eval.run_id': runId },
      );

      const { tree, flat } = this.spans.collectByTrace(traceId);
      const scoring = await this.scorers.scoreCase({
        case: evalCase,
        result,
        spans: flat,
        spanTree: tree,
      });
      this.spans.release(traceId);

      return {
        caseId: evalCase.id,
        tags: evalCase.tags ?? [],
        status: result.status,
        answer: result.answer,
        score: scoring.score,
        pass: scoring.pass,
        scores: scoring.scores,
        error: result.status === 'error' ? result.error : undefined,
        spanTree: tree,
      };
    } catch (err) {
      // A genuine crash (not a guardrail trip — those return a result). Record it.
      this.logger.error(
        `Case ${evalCase.id} crashed: ${(err as Error).message}`,
      );
      return {
        caseId: evalCase.id,
        tags: evalCase.tags ?? [],
        status: 'error',
        answer: '',
        score: 0,
        pass: false,
        scores: [],
        error: (err as Error).message,
        spanTree: [],
      };
    }
  }

  private buildInput(
    sessionId: string,
    evalCase: EvalCase,
    override: AgentConfigOverride,
  ): AgentRunInput {
    const g = evalCase.input.guardrails;
    return {
      sessionId,
      prompt: evalCase.input.prompt,
      system: override.systemPrompt ?? evalCase.input.system,
      guardrails: {
        maxIterations: override.maxIterations ?? g?.maxIterations,
        maxToolCalls: override.maxToolCalls ?? g?.maxToolCalls,
        timeoutMs: g?.timeoutMs,
      },
      // Vary the exposed tool set per run (compare candidate vs. baseline).
      tools: override.tools,
    };
  }

  private fingerprint(override: AgentConfigOverride): ConfigFingerprint {
    const promptHash = createHash('sha256')
      .update(override.systemPrompt ?? '')
      .digest('hex')
      .slice(0, 12);
    return {
      provider: this.llm.getSystemName(),
      model: this.llm.getModel(),
      promptHash,
      // The EFFECTIVE exposed set under this run's scope — so compare attributes a
      // score delta to the tool change.
      tools: this.tools.names(override.tools),
      label: override.label ?? this.defaultLabel(override),
    };
  }

  private defaultLabel(override: AgentConfigOverride): string {
    const parts: string[] = [];
    if (override.systemPrompt) parts.push('custom-prompt');
    if (override.maxIterations !== undefined)
      parts.push(`maxIter=${override.maxIterations}`);
    if (override.maxToolCalls !== undefined)
      parts.push(`maxTool=${override.maxToolCalls}`);
    if (override.tools?.allow)
      parts.push(`tools=${override.tools.allow.join('+') || 'none'}`);
    if (override.tools?.deny)
      parts.push(`-tools=${override.tools.deny.join('+')}`);
    return parts.length ? parts.join(',') : 'default';
  }

  /** Bounded-concurrency map preserving input order in the output array. */
  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(Math.max(1, limit), items.length || 1) },
      async () => {
        while (true) {
          const i = next++;
          if (i >= items.length) return;
          results[i] = await fn(items[i]);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
