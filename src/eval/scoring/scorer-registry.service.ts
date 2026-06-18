import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import type { ScoreContext, ScoreResult } from '../eval.types';
import { SCORER, type Scorer } from './scorer.interface';

export interface CaseScoring {
  scores: ScoreResult[];
  /** Weighted mean over AVAILABLE scorers (0..1). */
  score: number;
  /** AND over the REQUIRED, available scorers. */
  pass: boolean;
}

/**
 * ScorerRegistry — resolves the set of scorers that apply to a case, runs them,
 * and composes the verdict.
 *
 * Composition rules (explicit + configurable):
 *  - aggregate case score = WEIGHTED MEAN of available scorer scores; weights come
 *    from `EVAL_WEIGHTS` (per-scorer-name), falling back to each scorer's
 *    `defaultWeight`.
 *  - case passes iff every REQUIRED, available scorer passes. Required = the case's
 *    `requiredScorers` if set, else every scorer that produced an available result.
 *  - `unavailable` results (e.g. judge with no key) are excluded from both the mean
 *    and the pass decision — they never sink a case.
 */
@Injectable()
export class ScorerRegistry {
  private readonly logger = new Logger(ScorerRegistry.name);
  private readonly weights: Record<string, number>;

  constructor(
    @Inject(SCORER) private readonly scorers: Scorer[],
    private readonly config: AppConfigService,
  ) {
    this.weights = this.config.evalWeights;
    this.logger.log(
      `Registered scorers: ${this.scorers.map((s) => s.name).join(', ')}`,
    );
  }

  /** Names of all registered scorers (for the report legend / CLI). */
  names(): string[] {
    return this.scorers.map((s) => s.name);
  }

  private weightFor(s: Scorer): number {
    return this.weights[s.name] ?? s.defaultWeight;
  }

  async scoreCase(ctx: ScoreContext): Promise<CaseScoring> {
    const applicable = this.scorers.filter((s) => s.appliesTo(ctx.case));
    const scores: ScoreResult[] = [];
    for (const scorer of applicable) {
      try {
        scores.push(await scorer.score(ctx));
      } catch (err) {
        // A scorer throwing must not abort the case; record it as a hard fail.
        scores.push({
          name: scorer.name,
          score: 0,
          pass: false,
          detail: `scorer threw: ${(err as Error).message}`,
        });
      }
    }

    const available = applicable
      .map((s, i) => ({ scorer: s, result: scores[i] }))
      .filter((x) => !x.result.unavailable);

    // Weighted mean over available scorers.
    let weightSum = 0;
    let weighted = 0;
    for (const { scorer, result } of available) {
      const w = this.weightFor(scorer);
      weighted += w * result.score;
      weightSum += w;
    }
    const score = weightSum > 0 ? weighted / weightSum : 0;

    // Pass = all REQUIRED, available scorers pass.
    const required = ctx.case.requiredScorers;
    const pass =
      available.length === 0
        ? false
        : available
            .filter(({ scorer }) =>
              required ? required.includes(scorer.name) : true,
            )
            .every(({ result }) => result.pass);

    return { scores, score, pass };
  }
}
