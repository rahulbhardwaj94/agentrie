import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import {
  LLM_PROVIDER,
  LlmRateLimitError,
  LlmTimeoutError,
  type LlmProvider,
} from '../../llm/llm-provider.interface';
import type { EvalCase, ScoreContext, ScoreResult } from '../eval.types';
import type { Scorer } from './scorer.interface';

/**
 * LLM-as-judge scorer — grades a case's answer against a natural-language rubric.
 *
 * Opt-in: only does real model work when `EVAL_JUDGE_ENABLED=true` AND a real
 * provider is configured. Otherwise it degrades gracefully:
 *  - judge disabled            -> `unavailable` (excluded from aggregate/pass),
 *  - enabled but keyless (fake) -> a DETERMINISTIC stub verdict, so the suite stays
 *    fully runnable offline and tests are reproducible,
 *  - enabled + real provider    -> calls the model for a structured 0..1 verdict;
 *    a timeout/429/parse failure marks the case `judge-unavailable`, never crashes.
 */
@Injectable()
export class JudgeScorer implements Scorer {
  readonly name = 'llm-judge';
  readonly defaultWeight = 1;
  private readonly logger = new Logger(JudgeScorer.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly config: AppConfigService,
  ) {}

  appliesTo(c: EvalCase): boolean {
    return c.expected.rubric !== undefined;
  }

  async score(ctx: ScoreContext): Promise<ScoreResult> {
    const rubric = ctx.case.expected.rubric ?? '';
    const answer = ctx.result.answer;

    if (!this.config.evalJudgeEnabled) {
      return {
        name: this.name,
        score: 0,
        pass: true,
        unavailable: true,
        detail: 'judge disabled (set EVAL_JUDGE_ENABLED=true to enable)',
      };
    }

    // Keyless / fake provider: deterministic stub so the suite stays runnable.
    if (this.llm.getSystemName() === 'fake') {
      const ok = ctx.result.status === 'completed' && answer.trim().length > 0;
      const score = ok ? 0.8 : 0.2;
      return {
        name: this.name,
        score,
        pass: score >= 0.5,
        detail: `fake-stub-judge: ${ok ? 'non-empty completed answer' : 'empty/aborted answer'} (deterministic)`,
      };
    }

    try {
      return await this.realJudge(rubric, answer);
    } catch (err) {
      if (
        err instanceof LlmTimeoutError ||
        err instanceof LlmRateLimitError
      ) {
        this.logger.warn(`judge degraded: ${(err as Error).message}`);
        return this.unavailable(`judge-unavailable: ${(err as Error).name}`);
      }
      this.logger.warn(`judge failed: ${(err as Error).message}`);
      return this.unavailable(`judge-unavailable: ${(err as Error).message}`);
    }
  }

  private async realJudge(rubric: string, answer: string): Promise<ScoreResult> {
    const res = await this.llm.complete({
      system:
        'You are a strict evaluation judge. Given a RUBRIC and an agent ANSWER, ' +
        'score from 0.0 to 1.0 how well the answer satisfies the rubric. ' +
        'Respond with ONLY compact JSON: {"score": <number 0..1>, "pass": <boolean>, "reasoning": "<one sentence>"}.',
      messages: [
        { role: 'user', content: `RUBRIC:\n${rubric}\n\nANSWER:\n${answer}` },
      ],
      maxOutputTokens: 256,
    });

    const parsed = this.parseVerdict(res.text);
    if (!parsed) {
      return this.unavailable(
        `judge-unavailable: could not parse verdict from "${res.text.slice(0, 80)}"`,
      );
    }
    const score = clamp01(parsed.score);
    const pass = parsed.pass ?? score >= 0.5;
    return {
      name: this.name,
      score,
      pass,
      detail: `judge: ${score.toFixed(2)} — ${parsed.reasoning ?? 'no reasoning'}`,
    };
  }

  private parseVerdict(
    text: string,
  ): { score: number; pass?: boolean; reasoning?: string } | null {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const obj = JSON.parse(match[0]) as {
        score?: unknown;
        pass?: unknown;
        reasoning?: unknown;
      };
      if (typeof obj.score !== 'number') return null;
      return {
        score: obj.score,
        pass: typeof obj.pass === 'boolean' ? obj.pass : undefined,
        reasoning:
          typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
      };
    } catch {
      return null;
    }
  }

  private unavailable(detail: string): ScoreResult {
    return { name: this.name, score: 0, pass: true, unavailable: true, detail };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
