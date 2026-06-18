import { Inject, Injectable, Logger } from '@nestjs/common';
import { EvalRunnerService } from './eval-runner.service';
import type {
  AgentConfigOverride,
  CaseDiff,
  CaseResult,
  CompareResult,
  CompareSide,
  Dataset,
  EvalRunRecord,
  ScorerMove,
} from './eval.types';
import {
  EVAL_RUN_STORE,
  type EvalRunStore,
} from './store/eval-run-store.interface';

/**
 * EvalCompareService — the product moment: "did my change help?".
 *
 * Runs (or loads) a baseline and a candidate over the same dataset and produces a
 * single diff artifact: aggregate delta, per-case regressions/improvements, and
 * which scorer moved on each. A case that PASSED under baseline and FAILS under
 * candidate is the headline — surfaced first and loudly.
 */
@Injectable()
export class EvalCompareService {
  private readonly logger = new Logger(EvalCompareService.name);

  constructor(
    private readonly runner: EvalRunnerService,
    @Inject(EVAL_RUN_STORE) private readonly store: EvalRunStore,
  ) {}

  /** Run both configs fresh, then diff. */
  async compareConfigs(
    dataset: Dataset,
    baseline: AgentConfigOverride,
    candidate: AgentConfigOverride,
  ): Promise<CompareResult> {
    const baselineRun = await this.runner.run(dataset, {
      label: baseline.label ?? 'baseline',
      ...baseline,
    });
    const candidateRun = await this.runner.run(dataset, {
      label: candidate.label ?? 'candidate',
      ...candidate,
    });
    return this.diff(baselineRun, candidateRun);
  }

  /** Diff a NEW candidate run against an already-persisted baseline run. */
  async compareToBaselineRun(
    dataset: Dataset,
    baselineRunId: string,
    candidate: AgentConfigOverride,
  ): Promise<CompareResult> {
    const baselineRun = await this.store.getById(baselineRunId);
    if (!baselineRun) {
      throw new Error(`Baseline run '${baselineRunId}' not found in eval_runs`);
    }
    if (baselineRun.datasetId !== dataset.id) {
      throw new Error(
        `Baseline run '${baselineRunId}' is for dataset '${baselineRun.datasetId}', not '${dataset.id}'`,
      );
    }
    const candidateRun = await this.runner.run(dataset, {
      label: candidate.label ?? 'candidate',
      ...candidate,
    });
    return this.diff(baselineRun, candidateRun);
  }

  /** Pure diff of two completed runs (also reusable in tests). */
  diff(baseline: EvalRunRecord, candidate: EvalRunRecord): CompareResult {
    const baseById = new Map(baseline.caseResults.map((c) => [c.caseId, c]));
    const cases: CaseDiff[] = [];

    for (const cand of candidate.caseResults) {
      const base = baseById.get(cand.caseId);
      if (!base) continue; // case absent from baseline — skip from the diff
      cases.push(this.caseDiff(base, cand));
    }

    const regressions = cases.filter((c) => c.classification === 'regression');
    const improvements = cases.filter(
      (c) => c.classification === 'improvement',
    );
    const scoreChanges = cases.filter(
      (c) => c.classification === 'score-up' || c.classification === 'score-down',
    );

    if (regressions.length > 0) {
      this.logger.warn(
        `⚠ ${regressions.length} regression(s): ${regressions
          .map((r) => r.caseId)
          .join(', ')}`,
      );
    }

    return {
      datasetId: candidate.datasetId,
      datasetVersion: candidate.datasetVersion,
      baseline: this.side(baseline),
      candidate: this.side(candidate),
      aggregateDelta: candidate.aggregateScore - baseline.aggregateScore,
      passRateDelta: candidate.passRate - baseline.passRate,
      regressions,
      improvements,
      scoreChanges,
      cases,
    };
  }

  private caseDiff(base: CaseResult, cand: CaseResult): CaseDiff {
    const scoreDelta = cand.score - base.score;
    let classification: CaseDiff['classification'];
    if (base.pass && !cand.pass) classification = 'regression';
    else if (!base.pass && cand.pass) classification = 'improvement';
    else if (scoreDelta > 1e-9) classification = 'score-up';
    else if (scoreDelta < -1e-9) classification = 'score-down';
    else classification = 'unchanged';

    return {
      caseId: cand.caseId,
      baselinePass: base.pass,
      candidatePass: cand.pass,
      baselineScore: base.score,
      candidateScore: cand.score,
      scoreDelta,
      classification,
      scorerMoves: this.scorerMoves(base, cand),
    };
  }

  /** Scorers whose pass or score changed between the two runs for a case. */
  private scorerMoves(base: CaseResult, cand: CaseResult): ScorerMove[] {
    const baseByName = new Map(base.scores.map((s) => [s.name, s]));
    const moves: ScorerMove[] = [];
    for (const cs of cand.scores) {
      const bs = baseByName.get(cs.name);
      if (!bs) continue;
      if (bs.pass !== cs.pass || Math.abs(bs.score - cs.score) > 1e-9) {
        moves.push({
          name: cs.name,
          baselineScore: bs.score,
          candidateScore: cs.score,
          baselinePass: bs.pass,
          candidatePass: cs.pass,
        });
      }
    }
    return moves;
  }

  private side(run: EvalRunRecord): CompareSide {
    return {
      runId: run.runId,
      label: run.config.label,
      aggregateScore: run.aggregateScore,
      passRate: run.passRate,
    };
  }
}
