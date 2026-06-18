import { DatasetLoader } from '../src/eval/dataset/dataset-loader.service';
import type { CaseResult, Dataset } from '../src/eval/eval.types';
import { buildEvalHarness } from './helpers/eval-harness';

/**
 * Required eval-layer tests — all on the keyless FakeLlmProvider, no infra.
 *
 *  1. runner produces a DETERMINISTIC aggregate score on the seed dataset,
 *  2. a trace-derived scorer fails a case that over-spends its iteration budget,
 *  3. compare mode flags a PLANTED regression (config B regresses one case),
 *  4. the forbidden-tool scorer fires when a `mustNotCallTools` tool is called.
 */

function byId(results: CaseResult[]): Map<string, CaseResult> {
  return new Map(results.map((r) => [r.caseId, r]));
}

describe('Eval layer (FakeLlmProvider)', () => {
  it('runs the seed dataset to a deterministic aggregate score', async () => {
    const dataset = await new DatasetLoader().load('seed');

    const a = await buildEvalHarness().runner.run(dataset);
    const b = await buildEvalHarness().runner.run(dataset);

    // Determinism: identical aggregate + per-case pass set across independent runs.
    expect(a.aggregateScore).toBe(b.aggregateScore);
    expect(a.passRate).toBe(b.passRate);
    expect(a.caseResults.map((c) => `${c.caseId}:${c.pass}`)).toEqual(
      b.caseResults.map((c) => `${c.caseId}:${c.pass}`),
    );

    // Not trivially perfect (intentional failures) nor zero.
    expect(a.aggregateScore).toBeGreaterThan(0);
    expect(a.aggregateScore).toBeLessThan(1);
    expect(a.caseResults).toHaveLength(dataset.cases.length);

    // Known outcomes anchor the determinism.
    const r = byId(a.caseResults);
    expect(r.get('qa-exact')?.pass).toBe(true);
    expect(r.get('numeric-total-pass')?.pass).toBe(true);
    expect(r.get('iteration-budget-pass')?.pass).toBe(true);
    expect(r.get('contains-fail')?.pass).toBe(false);
    expect(r.get('numeric-fail')?.pass).toBe(false);

    // The run was persisted through the store seam.
    expect(buildEvalHarness().store.records).toBeDefined();
  });

  it('fails a case that over-spends its iteration budget (trace-derived)', async () => {
    const dataset: Dataset = {
      id: 'budget',
      version: '1.0.0',
      cases: [
        {
          id: 'overspends-iterations',
          // The fake loops on a tool directive; default guardrails let it run to
          // the 10-iteration ceiling, well past the constraint of 2.
          input: { prompt: 'use tool: echo {"message":"loop"}' },
          expected: { status: 'max_iterations' },
          constraints: { maxIterations: 2 },
          requiredScorers: ['iteration-budget'],
        },
      ],
    };

    const record = await buildEvalHarness().runner.run(dataset);
    const c = record.caseResults[0];

    const iterScore = c.scores.find((s) => s.name === 'iteration-budget');
    expect(iterScore).toBeDefined();
    expect(iterScore?.pass).toBe(false);
    expect(c.pass).toBe(false);
    // The verdict was read off the actual span tree, not the result counter.
    expect(c.spanTree.length).toBeGreaterThan(0);
  });

  it('flags a planted regression in compare mode', async () => {
    // Two cases: one stable plain case, one tool case whose tool-call budget is
    // breached only under the looser candidate config.
    const dataset: Dataset = {
      id: 'planted',
      version: '1.0.0',
      cases: [
        {
          id: 'stable-plain',
          input: { prompt: 'A plain question' },
          expected: { contains: ['Fake answer'], status: 'completed' },
        },
        {
          id: 'tool-budget-case',
          input: { prompt: 'use tool: echo {"message":"x"}' },
          expected: { status: 'max_tool_calls' },
          constraints: { maxToolCalls: 4 },
          requiredScorers: ['tool-call-budget', 'status'],
        },
      ],
    };

    const harness = buildEvalHarness();
    const result = await harness.compare.compareConfigs(
      dataset,
      { maxToolCalls: 3, label: 'baseline' }, // 3 tool calls ≤ 4 → passes
      { maxToolCalls: 8, label: 'candidate' }, // 8 tool calls > 4 → regresses
    );

    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].caseId).toBe('tool-budget-case');
    // The moved scorer is named, and the stable case did not regress.
    expect(
      result.regressions[0].scorerMoves.map((m) => m.name),
    ).toContain('tool-call-budget');
    expect(result.cases.find((c) => c.caseId === 'stable-plain')?.classification)
      .not.toBe('regression');
    expect(result.aggregateDelta).toBeLessThan(0);
  });

  it('fires the forbidden-tool scorer when a forbidden tool is called', async () => {
    const dataset: Dataset = {
      id: 'forbidden',
      version: '1.0.0',
      cases: [
        {
          id: 'calls-forbidden-echo',
          input: { prompt: 'use tool: echo {"message":"secret"}' },
          expected: { status: 'max_iterations' },
          constraints: { mustNotCallTools: ['echo'] },
          requiredScorers: ['forbidden-tool'],
        },
      ],
    };

    const record = await buildEvalHarness().runner.run(dataset);
    const c = record.caseResults[0];

    const forbidden = c.scores.find((s) => s.name === 'forbidden-tool');
    expect(forbidden).toBeDefined();
    expect(forbidden?.pass).toBe(false);
    expect(forbidden?.detail).toContain('echo');
    expect(c.pass).toBe(false);
  });
});
