import type {
  EvalCase,
  ScoreContext,
  ScoreResult,
} from '../eval.types';

/**
 * Scorer — a pluggable verdict over one case's {case, result, spans}.
 *
 * Two families ship:
 *  - outcome scorers reason over the structured terminal result, and
 *  - trace-derived scorers reason over the captured span tree (the differentiator).
 *
 * Scorers are registered via the `SCORER` multi-provider token (mirrors how tools
 * register into the ToolRegistry) and resolved by the ScorerRegistry. A scorer
 * declares whether it `appliesTo` a case so irrelevant scorers don't dilute the
 * aggregate (e.g. the numeric scorer only runs when a case sets `expected.numeric`).
 */
export interface Scorer {
  /** Stable id, referenced by `case.requiredScorers` and the weights config. */
  readonly name: string;
  /** Default weight in the weighted-mean aggregate (config can override). */
  readonly defaultWeight: number;
  /** Whether this scorer has something to assert about the given case. */
  appliesTo(c: EvalCase): boolean;
  /** Produce a 0..1 verdict. May be async (the judge calls the LLM). */
  score(ctx: ScoreContext): Promise<ScoreResult> | ScoreResult;
}

/** Multi-provider DI token: every registered scorer binds to this. */
export const SCORER = Symbol('SCORER');
