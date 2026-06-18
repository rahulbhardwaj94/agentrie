import { Injectable } from '@nestjs/common';
import {
  context,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';

/**
 * GenAI semantic-convention attribute keys (OTel `gen_ai.*`). Centralized so
 * LLM/tool spans across the app stay consistent.
 */
export const GenAiAttr = {
  SYSTEM: 'gen_ai.system',
  REQUEST_MODEL: 'gen_ai.request.model',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  TOOL_NAME: 'gen_ai.tool.name',
} as const;

const TRACER_NAME = 'agentrie';

/**
 * Thin wrapper over @opentelemetry/api for creating spans and attaching GenAI
 * tags. Keeps span plumbing out of business logic (AgentRunner, providers).
 */
@Injectable()
export class TracingService {
  private get tracer() {
    return trace.getTracer(TRACER_NAME);
  }

  /**
   * Run `fn` inside a new active span. The span is ended automatically and
   * errors are recorded + re-thrown (never swallowed).
   */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes: Record<string, string | number | boolean> = {},
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      span.setAttributes(attributes);
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /** Tag an LLM span with GenAI request/usage attributes. */
  setLlmAttributes(
    span: Span,
    attrs: {
      system: string;
      model: string;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): void {
    span.setAttribute(GenAiAttr.SYSTEM, attrs.system);
    span.setAttribute(GenAiAttr.REQUEST_MODEL, attrs.model);
    if (attrs.inputTokens !== undefined) {
      span.setAttribute(GenAiAttr.USAGE_INPUT_TOKENS, attrs.inputTokens);
    }
    if (attrs.outputTokens !== undefined) {
      span.setAttribute(GenAiAttr.USAGE_OUTPUT_TOKENS, attrs.outputTokens);
    }
  }

  setToolName(span: Span, toolName: string): void {
    span.setAttribute(GenAiAttr.TOOL_NAME, toolName);
  }

  /** Current active context — used by propagation.ts to inject traceparent. */
  activeContext() {
    return context.active();
  }
}
