import type { AgentTerminalResult } from '../agent/agent.types';
import type { ToolScope } from '../tools/tool.interface';

/**
 * Eval layer core types.
 *
 * The product question this layer answers: "is this agent good?" and "did my
 * change help?". Everything here is provider-agnostic — the default keyless
 * FakeLlmProvider drives the whole suite deterministically.
 */

/** How the agent should be invoked for a case. Mirrors AgentRunInput minus the
 * sessionId (the runner generates an isolated session per case/run). */
export interface EvalRunRequest {
  prompt: string;
  system?: string;
  guardrails?: {
    maxIterations?: number;
    maxToolCalls?: number;
    timeoutMs?: number;
  };
}

/**
 * The "known-good" outcome for a case. Flexible by design:
 *  - `equals`     — exact string match against the agent answer.
 *  - `contains`   — answer must contain every listed substring.
 *  - `numeric`    — parse a number from the answer; compare within tolerance.
 *  - `rubric`     — natural-language criteria handed to the LLM-as-judge scorer.
 * A case may set several; each maps to a scorer. At least one is required.
 */
export interface EvalExpected {
  equals?: string;
  contains?: string[];
  numeric?: { value: number; tolerance: number };
  rubric?: string;
  /** Expected terminal status (defaults to 'completed' when omitted). */
  status?: AgentTerminalResult['status'];
}

/** Hard budget/safety constraints, checked by trace-derived scorers. */
export interface EvalConstraints {
  /** Tools the agent must never call. Firing one fails the case. */
  mustNotCallTools?: string[];
  /** Max tool calls allowed (from the span tree, not just the result counter). */
  maxToolCalls?: number;
  /** Max agent iterations allowed. */
  maxIterations?: number;
  /** Max total tokens (input+output) summed across LLM spans. */
  maxTokens?: number;
}

/** A single evaluation case. */
export interface EvalCase {
  id: string;
  input: EvalRunRequest;
  expected: EvalExpected;
  tags?: string[];
  constraints?: EvalConstraints;
  /**
   * Names of scorers REQUIRED to pass for the case to pass. When omitted, every
   * scorer that produced a result for the case is required. Lets a case opt into
   * a subset (e.g. a budget case that only cares about `tool-call-budget`).
   */
  requiredScorers?: string[];
}

/** A versioned, named collection of cases (loaded + validated from disk). */
export interface Dataset {
  id: string;
  version: string;
  description?: string;
  cases: EvalCase[];
}

/** A normalized OTel span used by trace-derived scorers and the report. */
export interface CapturedSpan {
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  name: string;
  /** 'ok' | 'error' | 'unset' — derived from SpanStatus. */
  status: 'ok' | 'error' | 'unset';
  statusMessage?: string;
  attributes: Record<string, string | number | boolean>;
  durationMs: number;
  children: CapturedSpan[];
}

/** The raw inputs a scorer reasons over for one case. */
export interface ScoreContext {
  case: EvalCase;
  result: AgentTerminalResult;
  /** Flattened spans for this run (root-first). */
  spans: CapturedSpan[];
  /** The span tree roots for this run (usually a single `agent.run`). */
  spanTree: CapturedSpan[];
}

/** A single scorer's verdict for a case. */
export interface ScoreResult {
  name: string;
  /** 0..1; 1 = perfect. */
  score: number;
  pass: boolean;
  detail: string;
  /** Set when the scorer could not run (e.g. judge with no key): not a failure. */
  unavailable?: boolean;
}

/** Per-case aggregate after all scorers ran. */
export interface CaseResult {
  caseId: string;
  tags: string[];
  status: AgentTerminalResult['status'];
  answer: string;
  /** Weighted mean of scorer scores (0..1). */
  score: number;
  /** AND of all REQUIRED, available scorers. */
  pass: boolean;
  scores: ScoreResult[];
  /** Error message when the case itself crashed (still recorded, scores 0). */
  error?: string;
  /** The captured span tree, persisted so the report can render it offline. */
  spanTree: CapturedSpan[];
}

/** Fingerprint of the configuration under test — what compare mode diffs by. */
export interface ConfigFingerprint {
  /** Provider system name, e.g. 'fake' / 'anthropic'. */
  provider: string;
  model: string;
  /** Sha256 (first 12 hex) of the dataset-wide system prompt override, if any. */
  promptHash: string;
  /** Sorted registered tool names. */
  tools: string[];
  /** Free-form label so a human can tell baseline from candidate. */
  label: string;
}

/** A full run of a dataset under one config — persisted to Mongo. */
export interface EvalRunRecord {
  runId: string;
  datasetId: string;
  datasetVersion: string;
  config: ConfigFingerprint;
  /** Mean of per-case scores. */
  aggregateScore: number;
  /** Fraction of cases that passed (0..1). */
  passRate: number;
  caseResults: CaseResult[];
  createdAt: string;
}

/** How a single scorer moved between baseline and candidate for one case. */
export interface ScorerMove {
  name: string;
  baselineScore: number;
  candidateScore: number;
  baselinePass: boolean;
  candidatePass: boolean;
}

/** Per-case baseline→candidate delta. */
export interface CaseDiff {
  caseId: string;
  baselinePass: boolean;
  candidatePass: boolean;
  baselineScore: number;
  candidateScore: number;
  scoreDelta: number;
  /**
   * regression  — passed baseline, fails candidate (the headline).
   * improvement — failed baseline, passes candidate.
   * score-up/down — pass state unchanged but the score moved.
   * unchanged   — identical pass + score.
   */
  classification:
    | 'regression'
    | 'improvement'
    | 'score-up'
    | 'score-down'
    | 'unchanged';
  /** Scorers whose pass or score changed. */
  scorerMoves: ScorerMove[];
}

/** A side of a comparison (baseline or candidate). */
export interface CompareSide {
  runId: string;
  label: string;
  aggregateScore: number;
  passRate: number;
}

/** Full baseline-vs-candidate comparison — the "did my change help?" artifact. */
export interface CompareResult {
  datasetId: string;
  datasetVersion: string;
  baseline: CompareSide;
  candidate: CompareSide;
  aggregateDelta: number;
  passRateDelta: number;
  regressions: CaseDiff[];
  improvements: CaseDiff[];
  /** Cases whose pass state held but score moved. */
  scoreChanges: CaseDiff[];
  /** Every case, in dataset order. */
  cases: CaseDiff[];
}

/**
 * Config applied on top of the dataset for a whole run (compare mode's
 * baseline/candidate). Every knob here flows through `AgentRunInput` into the
 * unmodified `AgentRunner` — no forking. Note: with the keyless FakeLlmProvider,
 * `systemPrompt` changes the config fingerprint but not the (system-agnostic) fake
 * output; against a real provider it changes behaviour too.
 */
export interface AgentConfigOverride {
  /** Replaces every case's system prompt (the classic "did my prompt help?"). */
  systemPrompt?: string;
  /** Caps agent iterations across all cases (tighter loop budget). */
  maxIterations?: number;
  /** Caps tool calls across all cases (tighter tool budget). */
  maxToolCalls?: number;
  /**
   * Narrows the exposed tool set for every case in the run (allow/deny on top of
   * the registry). The classic "does the agent still pass with fewer tools?" — and
   * the fingerprint records the EFFECTIVE set so compare diffs by it.
   */
  tools?: ToolScope;
  /** Human label for the report/CLI/persistence. */
  label?: string;
}
