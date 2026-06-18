import { AgentRunner } from '../../src/agent/agent-runner.service';
import type { AppConfigService } from '../../src/config/app-config.service';
import { FakeLlmProvider } from '../../src/llm/fake.provider';
import type {
  LlmMessage,
  LlmProvider,
} from '../../src/llm/llm-provider.interface';
import type {
  ActiveContext,
  MemoryStore,
  StoredMessage,
} from '../../src/memory/memory-store.interface';
import { MetricsService } from '../../src/observability/metrics.service';
import { TracingService } from '../../src/observability/tracing.service';
import { ToolRegistryService } from '../../src/tools/tool-registry.service';
import { EchoTool } from '../../src/tools/tools/echo.tool';
import { EvalCompareService } from '../../src/eval/eval-compare.service';
import { EvalRunnerService } from '../../src/eval/eval-runner.service';
import type { EvalRunRecord } from '../../src/eval/eval.types';
import { JudgeScorer } from '../../src/eval/scoring/judge.scorer';
import {
  ContainsScorer,
  ExactMatchScorer,
  NumericToleranceScorer,
  StatusScorer,
} from '../../src/eval/scoring/outcome.scorers';
import { ScorerRegistry } from '../../src/eval/scoring/scorer-registry.service';
import type { Scorer } from '../../src/eval/scoring/scorer.interface';
import {
  ForbiddenToolScorer,
  IterationBudgetScorer,
  NoErrorSpansScorer,
  TokenBudgetScorer,
  ToolCallBudgetScorer,
} from '../../src/eval/scoring/trace.scorers';
import { SpanCollector } from '../../src/eval/span-collector.service';
import type { EvalRunStore } from '../../src/eval/store/eval-run-store.interface';

/**
 * Per-session in-memory MemoryStore. Unlike the trivial agent-runner.spec store,
 * this keys by sessionId so the eval runner can run isolated cases (each gets its
 * own session) without cross-contamination under concurrency.
 */
export class InMemoryMemoryStore implements MemoryStore {
  private sessions = new Map<string, StoredMessage[]>();
  private seq = 0;

  private get(sessionId: string): StoredMessage[] {
    let msgs = this.sessions.get(sessionId);
    if (!msgs) {
      msgs = [];
      this.sessions.set(sessionId, msgs);
    }
    return msgs;
  }

  async append(sessionId: string, m: LlmMessage): Promise<StoredMessage> {
    const stored: StoredMessage = {
      ...m,
      id: `m${this.seq++}`,
      tokenCount: 1,
      ts: Date.now(),
    };
    this.get(sessionId).push(stored);
    return stored;
  }
  async getActiveContext(sessionId: string): Promise<ActiveContext> {
    const messages = this.get(sessionId);
    return { sessionId, messages, totalTokens: messages.length };
  }
  async getTokenCount(sessionId: string): Promise<number> {
    return this.get(sessionId).length;
  }
  async replaceOldestWithSummary(sessionId: string): Promise<number> {
    return this.get(sessionId).length;
  }
  async setSystemPrompt(sessionId: string, content: string): Promise<void> {
    this.get(sessionId).unshift({
      id: `sys-${this.seq++}`,
      role: 'system',
      content,
      tokenCount: 1,
      ts: Date.now(),
      pinned: true,
    });
  }
}

/** In-memory EvalRunStore so tests never touch Mongo. */
export class InMemoryEvalRunStore implements EvalRunStore {
  readonly records: EvalRunRecord[] = [];
  async save(record: EvalRunRecord): Promise<void> {
    this.records.push(record);
  }
  async getById(runId: string): Promise<EvalRunRecord | null> {
    return this.records.find((r) => r.runId === runId) ?? null;
  }
  async findLatest(datasetId: string): Promise<EvalRunRecord | null> {
    const matches = this.records.filter((r) => r.datasetId === datasetId);
    return matches.length ? matches[matches.length - 1] : null;
  }
}

export interface EvalHarness {
  runner: EvalRunnerService;
  compare: EvalCompareService;
  store: InMemoryEvalRunStore;
  registry: ScorerRegistry;
  spans: SpanCollector;
  llm: LlmProvider;
}

/** Build the full eval stack on the keyless FakeLlmProvider — no DI, no infra. */
export function buildEvalHarness(
  overrides: Partial<Record<string, unknown>> = {},
): EvalHarness {
  const config = {
    llmModel: 'opus-test',
    llmContextLimit: 100_000,
    llmMaxOutputTokens: 100,
    llmTimeoutMs: 5_000,
    agentMaxIterations: 10,
    agentMaxToolCalls: 20,
    agentTimeoutMs: 30_000,
    evalWeights: {},
    evalConcurrency: 4,
    evalJudgeEnabled: false,
    evalReportDir: 'evals/reports',
    ...overrides,
  } as unknown as AppConfigService;

  const llm = new FakeLlmProvider(config);
  const memory = new InMemoryMemoryStore();
  const tools = new ToolRegistryService();
  tools.register(new EchoTool());
  const tracing = new TracingService();
  const spans = new SpanCollector();
  spans.register();

  const scorerList: Scorer[] = [
    new ExactMatchScorer(),
    new ContainsScorer(),
    new NumericToleranceScorer(),
    new StatusScorer(),
    new ToolCallBudgetScorer(),
    new ForbiddenToolScorer(),
    new IterationBudgetScorer(),
    new TokenBudgetScorer(),
    new NoErrorSpansScorer(),
    new JudgeScorer(llm, config),
  ];
  const registry = new ScorerRegistry(scorerList, config);

  const agent = new AgentRunner(llm, memory, tools, tracing, new MetricsService(), config);
  const store = new InMemoryEvalRunStore();
  const runner = new EvalRunnerService(
    agent,
    tracing,
    spans,
    registry,
    tools,
    llm,
    store,
    config,
  );
  const compare = new EvalCompareService(runner, store);

  return { runner, compare, store, registry, spans, llm };
}
