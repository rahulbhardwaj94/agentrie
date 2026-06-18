import { Injectable } from '@nestjs/common';
import { GenAiAttr } from '../../observability/tracing.service';
import type {
  CapturedSpan,
  EvalCase,
  ScoreContext,
  ScoreResult,
} from '../eval.types';
import type { Scorer } from './scorer.interface';

/**
 * Trace-derived scorers — verdicts read off the span tree the agent ALREADY
 * emits. This is the differentiator: the same observability that lets you *see*
 * a run is reused to *judge* it. Budgets and safety constraints are enforced
 * against what actually happened on the wire (tool spans, iteration spans, GenAI
 * usage attributes), not against the result's self-reported counters.
 */

// Span names emitted by AgentRunner (keep in sync with agent-runner.service.ts).
const SPAN_ITERATION = 'agent.iteration';
const SPAN_TOOL_CALL = 'agent.tool_call';

/** Tool-call names observed in the trace (from `gen_ai.tool.name`). */
function toolCallsFromSpans(spans: CapturedSpan[]): string[] {
  return spans
    .filter((s) => s.name === SPAN_TOOL_CALL)
    .map((s) => String(s.attributes[GenAiAttr.TOOL_NAME] ?? 'unknown'));
}

function countSpans(spans: CapturedSpan[], name: string): number {
  return spans.filter((s) => s.name === name).length;
}

function totalTokens(spans: CapturedSpan[]): number {
  let sum = 0;
  for (const s of spans) {
    const input = s.attributes[GenAiAttr.USAGE_INPUT_TOKENS];
    const output = s.attributes[GenAiAttr.USAGE_OUTPUT_TOKENS];
    if (typeof input === 'number') sum += input;
    if (typeof output === 'number') sum += output;
  }
  return sum;
}

/** Fail if the agent made more tool calls than the case allows. */
@Injectable()
export class ToolCallBudgetScorer implements Scorer {
  readonly name = 'tool-call-budget';
  readonly defaultWeight = 1;

  appliesTo(c: EvalCase): boolean {
    return c.constraints?.maxToolCalls !== undefined;
  }

  score(ctx: ScoreContext): ScoreResult {
    const budget = ctx.case.constraints?.maxToolCalls ?? Infinity;
    const calls = countSpans(ctx.spans, SPAN_TOOL_CALL);
    const pass = calls <= budget;
    return {
      name: this.name,
      score: pass ? 1 : 0,
      pass,
      detail: pass
        ? `${calls} tool call(s) ≤ budget ${budget}`
        : `${calls} tool call(s) exceed budget ${budget}`,
    };
  }
}

/** Fail if the agent called any tool the case forbids. */
@Injectable()
export class ForbiddenToolScorer implements Scorer {
  readonly name = 'forbidden-tool';
  readonly defaultWeight = 1;

  appliesTo(c: EvalCase): boolean {
    return (c.constraints?.mustNotCallTools?.length ?? 0) > 0;
  }

  score(ctx: ScoreContext): ScoreResult {
    const forbidden = new Set(ctx.case.constraints?.mustNotCallTools ?? []);
    const called = toolCallsFromSpans(ctx.spans);
    const violations = [...new Set(called.filter((t) => forbidden.has(t)))];
    const pass = violations.length === 0;
    return {
      name: this.name,
      score: pass ? 1 : 0,
      pass,
      detail: pass
        ? `no forbidden tools called (forbidden: ${[...forbidden].join(', ')})`
        : `called forbidden tool(s): ${violations.join(', ')}`,
    };
  }
}

/** Fail if the agent ran more iterations than the case allows. */
@Injectable()
export class IterationBudgetScorer implements Scorer {
  readonly name = 'iteration-budget';
  readonly defaultWeight = 1;

  appliesTo(c: EvalCase): boolean {
    return c.constraints?.maxIterations !== undefined;
  }

  score(ctx: ScoreContext): ScoreResult {
    const budget = ctx.case.constraints?.maxIterations ?? Infinity;
    const iterations = countSpans(ctx.spans, SPAN_ITERATION);
    const pass = iterations <= budget;
    return {
      name: this.name,
      score: pass ? 1 : 0,
      pass,
      detail: pass
        ? `${iterations} iteration(s) ≤ budget ${budget}`
        : `${iterations} iteration(s) exceed budget ${budget}`,
    };
  }
}

/** Fail if total GenAI token usage (across LLM spans) exceeds the case budget. */
@Injectable()
export class TokenBudgetScorer implements Scorer {
  readonly name = 'token-budget';
  readonly defaultWeight = 1;

  appliesTo(c: EvalCase): boolean {
    return c.constraints?.maxTokens !== undefined;
  }

  score(ctx: ScoreContext): ScoreResult {
    const budget = ctx.case.constraints?.maxTokens ?? Infinity;
    const tokens = totalTokens(ctx.spans);
    const pass = tokens <= budget;
    return {
      name: this.name,
      score: pass ? 1 : 0,
      pass,
      detail: pass
        ? `${tokens} token(s) ≤ budget ${budget}`
        : `${tokens} token(s) exceed budget ${budget}`,
    };
  }
}

/** Fail if any span in the run recorded an error status. */
@Injectable()
export class NoErrorSpansScorer implements Scorer {
  readonly name = 'no-error-spans';
  readonly defaultWeight = 1;

  appliesTo(): boolean {
    return true; // safety net on every run
  }

  score(ctx: ScoreContext): ScoreResult {
    const errored = ctx.spans.filter((s) => s.status === 'error');
    const pass = errored.length === 0;
    return {
      name: this.name,
      score: pass ? 1 : 0,
      pass,
      detail: pass
        ? 'no error spans'
        : `error span(s): ${errored
            .map((s) => `${s.name}${s.statusMessage ? ` (${s.statusMessage})` : ''}`)
            .join(', ')}`,
    };
  }
}
