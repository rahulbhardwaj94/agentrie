import type { CaseDiff, CompareResult, EvalRunRecord } from '../src/eval/eval.types';
import {
  EXIT_COMPARE_GATE,
  EXIT_OK,
  EXIT_RUN_GATE,
  evaluateCompareGates,
  evaluateRunGates,
  parseThreshold,
} from '../src/eval/gating';

describe('parseThreshold', () => {
  it('reads a fraction as-is and a percent (>1) as /100', () => {
    expect(parseThreshold('0.85')).toBeCloseTo(0.85);
    expect(parseThreshold('85')).toBeCloseTo(0.85);
    expect(parseThreshold('1')).toBe(1); // exactly 1 == 100%, not a percent
    expect(parseThreshold('0')).toBe(0);
  });

  it('throws on a non-finite or negative value (a typo fails loudly)', () => {
    expect(() => parseThreshold('abc')).toThrow();
    expect(() => parseThreshold('-1')).toThrow();
  });
});

describe('evaluateRunGates', () => {
  const record = (over: Partial<EvalRunRecord> = {}): EvalRunRecord =>
    ({ aggregateScore: 0.8, passRate: 0.75, ...over }) as EvalRunRecord;

  it('passes (exit 0) when no gates are configured', () => {
    const v = evaluateRunGates(record(), {});
    expect(v).toEqual({ passed: true, exitCode: EXIT_OK, failures: [] });
  });

  it('passes when the run clears both floors', () => {
    const v = evaluateRunGates(record(), { minScore: 0.7, minPassRate: 0.7 });
    expect(v.passed).toBe(true);
  });

  it('fails (exit 3) under the score floor and names the shortfall', () => {
    const v = evaluateRunGates(record({ aggregateScore: 0.6 }), { minScore: 0.7 });
    expect(v.passed).toBe(false);
    expect(v.exitCode).toBe(EXIT_RUN_GATE);
    expect(v.failures[0]).toContain('aggregate score');
  });

  it('reports each failing floor independently', () => {
    const v = evaluateRunGates(record({ aggregateScore: 0.5, passRate: 0.4 }), {
      minScore: 0.7,
      minPassRate: 0.6,
    });
    expect(v.failures).toHaveLength(2);
  });
});

describe('evaluateCompareGates', () => {
  const regression = (id: string): CaseDiff =>
    ({ caseId: id, classification: 'regression' }) as CaseDiff;

  const result = (over: Partial<CompareResult> = {}): CompareResult =>
    ({
      aggregateDelta: 0,
      passRateDelta: 0,
      regressions: [],
      ...over,
    }) as CompareResult;

  it('passes (exit 0) on a clean comparison with no gates', () => {
    expect(evaluateCompareGates(result(), {}).exitCode).toBe(EXIT_OK);
  });

  it('fails (exit 2) on any regression by default, listing the case ids', () => {
    const v = evaluateCompareGates(
      result({ regressions: [regression('c1'), regression('c2')] }),
      {},
    );
    expect(v.passed).toBe(false);
    expect(v.exitCode).toBe(EXIT_COMPARE_GATE);
    expect(v.failures[0]).toContain('c1, c2');
  });

  it('tolerates regressions when explicitly allowed', () => {
    const v = evaluateCompareGates(result({ regressions: [regression('c1')] }), {
      allowRegressions: true,
    });
    expect(v.passed).toBe(true);
  });

  it('fails when the aggregate drop exceeds its budget, passes within it', () => {
    // dropped 5pp; budget 2pp -> fail.
    expect(
      evaluateCompareGates(result({ aggregateDelta: -0.05 }), {
        maxAggregateDrop: 0.02,
      }).passed,
    ).toBe(false);
    // dropped 1pp; budget 2pp -> pass.
    expect(
      evaluateCompareGates(result({ aggregateDelta: -0.01 }), {
        maxAggregateDrop: 0.02,
      }).passed,
    ).toBe(true);
    // An improvement (positive delta) never trips the drop budget.
    expect(
      evaluateCompareGates(result({ aggregateDelta: 0.1 }), {
        maxAggregateDrop: 0.02,
      }).passed,
    ).toBe(true);
  });

  it('gates the pass-rate drop independently', () => {
    const v = evaluateCompareGates(result({ passRateDelta: -0.2 }), {
      maxPassRateDrop: 0.05,
    });
    expect(v.passed).toBe(false);
    expect(v.failures[0]).toContain('pass rate dropped');
  });
});
