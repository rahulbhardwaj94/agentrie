import type { CompareResult, EvalRunRecord } from './eval.types';

/**
 * CI gating — pure pass/fail policy over an eval run or comparison.
 *
 * Kept separate from the CLI (which needs Mongo/Redis to produce a record) so the
 * gate decision is unit-testable in isolation. The CLI parses flags into these
 * gates, runs the eval, and exits with the returned code.
 *
 * Exit-code contract (so a pipeline can branch on the reason):
 *   0  gates passed (or none configured)
 *   1  operational/usage error (set by the CLI, not here)
 *   2  COMPARE gate failed — a regression, or an aggregate/pass-rate drop over budget
 *   3  RUN gate failed — aggregate score or pass rate under the floor
 */
export const EXIT_OK = 0;
export const EXIT_COMPARE_GATE = 2;
export const EXIT_RUN_GATE = 3;

/** Floors a single run must clear. Thresholds are fractions in [0,1]. */
export interface RunGates {
  minScore?: number;
  minPassRate?: number;
}

/** Budgets a candidate must stay within vs. its baseline. */
export interface CompareGates {
  /** Fail if the aggregate score dropped by more than this (fraction). */
  maxAggregateDrop?: number;
  /** Fail if the pass rate dropped by more than this (fraction). */
  maxPassRateDrop?: number;
  /** When false (default), ANY per-case regression fails the gate. */
  allowRegressions?: boolean;
}

export interface GateVerdict {
  passed: boolean;
  /** 0 when passed, else the signal exit code for this gate kind. */
  exitCode: number;
  /** Human-readable reasons, one per failed condition. */
  failures: string[];
}

/**
 * Parse a threshold string into a [0,1] fraction. Accepts a fraction (`0.85`) or a
 * percentage (`85`) for ergonomics — anything > 1 is read as a percent. Throws on a
 * non-finite or negative value so a typo'd gate fails the build loudly.
 */
export function parseThreshold(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid threshold '${raw}' (want a fraction 0..1 or a percent)`);
  }
  return n > 1 ? n / 100 : n;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function pp(n: number): string {
  return `${(n * 100).toFixed(1)}pp`;
}

function verdict(failures: string[], gateExit: number): GateVerdict {
  return {
    passed: failures.length === 0,
    exitCode: failures.length === 0 ? EXIT_OK : gateExit,
    failures,
  };
}

/** Gate a single run against absolute floors. */
export function evaluateRunGates(
  record: Pick<EvalRunRecord, 'aggregateScore' | 'passRate'>,
  gates: RunGates,
): GateVerdict {
  const failures: string[] = [];
  if (gates.minScore !== undefined && record.aggregateScore < gates.minScore) {
    failures.push(
      `aggregate score ${pct(record.aggregateScore)} below floor ${pct(gates.minScore)}`,
    );
  }
  if (gates.minPassRate !== undefined && record.passRate < gates.minPassRate) {
    failures.push(
      `pass rate ${pct(record.passRate)} below floor ${pct(gates.minPassRate)}`,
    );
  }
  return verdict(failures, EXIT_RUN_GATE);
}

/** Gate a comparison: per-case regressions plus aggregate/pass-rate drop budgets. */
export function evaluateCompareGates(
  result: Pick<
    CompareResult,
    'aggregateDelta' | 'passRateDelta' | 'regressions'
  >,
  gates: CompareGates,
): GateVerdict {
  const failures: string[] = [];
  if (!gates.allowRegressions && result.regressions.length > 0) {
    const ids = result.regressions.map((r) => r.caseId).join(', ');
    failures.push(`${result.regressions.length} case regression(s): ${ids}`);
  }
  if (
    gates.maxAggregateDrop !== undefined &&
    result.aggregateDelta < -gates.maxAggregateDrop
  ) {
    failures.push(
      `aggregate dropped ${pp(-result.aggregateDelta)} (budget ${pp(gates.maxAggregateDrop)})`,
    );
  }
  if (
    gates.maxPassRateDrop !== undefined &&
    result.passRateDelta < -gates.maxPassRateDrop
  ) {
    failures.push(
      `pass rate dropped ${pp(-result.passRateDelta)} (budget ${pp(gates.maxPassRateDrop)})`,
    );
  }
  return verdict(failures, EXIT_COMPARE_GATE);
}
