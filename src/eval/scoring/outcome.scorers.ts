import { Injectable } from '@nestjs/common';
import type { EvalCase, ScoreContext, ScoreResult } from '../eval.types';
import type { Scorer } from './scorer.interface';

/**
 * Outcome scorers — verdicts derived from the structured terminal result
 * (`AgentTerminalResult`). These answer "did the agent produce the right answer?"
 * independent of how it got there.
 */

/** Exact string match against the agent's final answer. */
@Injectable()
export class ExactMatchScorer implements Scorer {
  readonly name = 'exact-match';
  readonly defaultWeight = 1;

  appliesTo(c: EvalCase): boolean {
    return c.expected.equals !== undefined;
  }

  score(ctx: ScoreContext): ScoreResult {
    const expected = ctx.case.expected.equals ?? '';
    const got = ctx.result.answer;
    const pass = got === expected;
    return {
      name: this.name,
      score: pass ? 1 : 0,
      pass,
      detail: pass
        ? 'answer matched exactly'
        : `expected "${truncate(expected)}", got "${truncate(got)}"`,
    };
  }
}

/**
 * Predicate scorer (declarative form): the answer must contain EVERY listed
 * substring. This is the JSON-expressible predicate; arbitrary code predicates
 * plug in as additional Scorers via the registry without touching the dataset.
 * Partial credit = fraction of substrings present, so a near-miss isn't a flat 0.
 */
@Injectable()
export class ContainsScorer implements Scorer {
  readonly name = 'contains';
  readonly defaultWeight = 1;

  appliesTo(c: EvalCase): boolean {
    return c.expected.contains !== undefined;
  }

  score(ctx: ScoreContext): ScoreResult {
    const needles = ctx.case.expected.contains ?? [];
    const got = ctx.result.answer;
    const present = needles.filter((n) => got.includes(n));
    const score = needles.length === 0 ? 1 : present.length / needles.length;
    const pass = present.length === needles.length;
    const missing = needles.filter((n) => !got.includes(n));
    return {
      name: this.name,
      score,
      pass,
      detail: pass
        ? `all ${needles.length} substrings present`
        : `missing: ${missing.map((m) => `"${truncate(m, 40)}"`).join(', ')}`,
    };
  }
}

/**
 * Numeric-tolerance scorer — parse the LAST number out of the answer and compare
 * to the expected value within an absolute tolerance. Last-number extraction
 * matches the common "... the result is 42" phrasing.
 */
@Injectable()
export class NumericToleranceScorer implements Scorer {
  readonly name = 'numeric-tolerance';
  readonly defaultWeight = 1;

  appliesTo(c: EvalCase): boolean {
    return c.expected.numeric !== undefined;
  }

  score(ctx: ScoreContext): ScoreResult {
    const spec = ctx.case.expected.numeric;
    if (!spec) {
      return { name: this.name, score: 0, pass: false, detail: 'no numeric spec' };
    }
    const matches = ctx.result.answer.match(/-?\d+(?:\.\d+)?/g);
    if (!matches || matches.length === 0) {
      return {
        name: this.name,
        score: 0,
        pass: false,
        detail: `no number found in answer "${truncate(ctx.result.answer)}"`,
      };
    }
    const got = Number(matches[matches.length - 1]);
    const delta = Math.abs(got - spec.value);
    const pass = delta <= spec.tolerance;
    return {
      name: this.name,
      score: pass ? 1 : 0,
      pass,
      detail: pass
        ? `${got} within ±${spec.tolerance} of ${spec.value}`
        : `${got} is ${delta} off ${spec.value} (tolerance ±${spec.tolerance})`,
    };
  }
}

/**
 * Terminal-status scorer — asserts the run ended in the expected status
 * (defaults to 'completed' when a case declares `expected.status`). Catches a
 * change that, say, starts tripping a guardrail it used to clear.
 */
@Injectable()
export class StatusScorer implements Scorer {
  readonly name = 'status';
  readonly defaultWeight = 1;

  appliesTo(c: EvalCase): boolean {
    return c.expected.status !== undefined;
  }

  score(ctx: ScoreContext): ScoreResult {
    const expected = ctx.case.expected.status ?? 'completed';
    const got = ctx.result.status;
    const pass = got === expected;
    return {
      name: this.name,
      score: pass ? 1 : 0,
      pass,
      detail: pass
        ? `status ${got} as expected`
        : `expected status '${expected}', got '${got}'`,
    };
  }
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
