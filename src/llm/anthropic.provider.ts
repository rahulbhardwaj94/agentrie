import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import {
  LlmRateLimitError,
  LlmTimeoutError,
  type LlmCompleteOptions,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse,
  type LlmStopReason,
  type LlmToolCall,
} from './llm-provider.interface';

/**
 * AnthropicProvider — the real provider, used when ANTHROPIC_API_KEY is set.
 *
 * The provider owns the tokenizer (`messages.countTokens`) and the model context
 * limit (config-driven; Opus 4.8 is 1M but we let ops cap it). Token counting and
 * limits are NEVER hardcoded outside this class.
 *
 * Assumption (documented): we do not enable extended/adaptive thinking here. Our
 * memory model persists plain message content, and Opus 4.8 requires thinking
 * blocks to be echoed back verbatim across turns — that would leak model-internal
 * state into the audit store. If thinking is wanted later, store the raw content
 * blocks alongside the plain text. See IMPLEMENTATION_STATUS.md.
 */
@Injectable()
export class AnthropicProvider implements LlmProvider {
  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly client: Anthropic;

  constructor(private readonly config: AppConfigService) {
    this.client = new Anthropic({ apiKey: this.config.anthropicApiKey });
  }

  getSystemName(): string {
    return 'anthropic';
  }

  getModel(): string {
    return this.config.llmModel;
  }

  getContextLimit(): number {
    return this.config.llmContextLimit;
  }

  async countTokens(text: string): Promise<number> {
    if (!text) return 0;
    try {
      // countTokens lives under the beta namespace in @anthropic-ai/sdk 0.32.
      // The provider still owns the tokenizer — nothing else hardcodes one.
      const res = await this.client.beta.messages.countTokens({
        model: this.getModel(),
        messages: [{ role: 'user', content: text }],
      });
      return res.input_tokens;
    } catch (err) {
      // countTokens failing should not crash the caller; fall back to an estimate
      // and surface the reason. ~4 chars/token is a safe over-estimate.
      this.logger.warn(
        `countTokens failed (${(err as Error).message}); using char estimate`,
      );
      return Math.ceil(text.length / 4);
    }
  }

  async complete(options: LlmCompleteOptions): Promise<LlmResponse> {
    const model = this.getModel();
    try {
      const res = await this.client.messages.create(
        {
          model,
          max_tokens: options.maxOutputTokens ?? this.config.llmMaxOutputTokens,
          system: options.system,
          messages: this.toAnthropicMessages(options.messages),
          tools: options.tools?.map((t) => ({
            name: t.name,
            description: t.description,
            // Our tool definitions already carry JSON Schema objects.
            input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
          })),
        },
        { timeout: options.timeoutMs ?? this.config.llmTimeoutMs },
      );

      const toolCalls: LlmToolCall[] = [];
      let text = '';
      for (const block of res.content) {
        if (block.type === 'text') {
          text += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }

      return {
        text,
        toolCalls,
        stopReason: this.mapStopReason(res.stop_reason),
        usage: {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
        },
        model: res.model,
      };
    } catch (err) {
      // Typed handling — no silent catches. Re-throw as our domain errors so the
      // AgentRunner / summarizer can branch on timeout vs rate-limit.
      if (err instanceof Anthropic.RateLimitError) {
        const headers = err.headers as Record<string, string> | undefined;
        const retryAfter = Number(headers?.['retry-after']);
        throw new LlmRateLimitError(
          'Anthropic rate limited (429)',
          Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
        );
      }
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        throw new LlmTimeoutError('Anthropic request timed out');
      }
      throw err;
    }
  }

  /** Map our neutral message shape onto the Anthropic Messages API shape. */
  private toAnthropicMessages(
    messages: LlmMessage[],
  ): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        // System content is passed via the top-level `system` field, not messages.
        continue;
      }
      if (m.role === 'tool' && m.toolResults?.length) {
        out.push({
          role: 'user',
          content: m.toolResults.map((r) => ({
            type: 'tool_result' as const,
            tool_use_id: r.toolCallId,
            content: r.content,
            is_error: r.isError,
          })),
        });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const content: Array<
          Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam
        > = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls) {
          content.push({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: c.input,
          });
        }
        out.push({ role: 'assistant', content });
        continue;
      }
      out.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      });
    }
    return out;
  }

  private mapStopReason(reason: string | null): LlmStopReason {
    switch (reason) {
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
        return 'stop_sequence';
      default:
        return 'end_turn';
    }
  }
}
