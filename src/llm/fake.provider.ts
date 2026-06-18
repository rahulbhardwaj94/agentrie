import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import type {
  LlmCompleteOptions,
  LlmProvider,
  LlmResponse,
} from './llm-provider.interface';

/**
 * FakeLlmProvider — deterministic, keyless provider used by tests and by default
 * local runs when ANTHROPIC_API_KEY is unset.
 *
 * Token counting: a ~4-chars-per-token heuristic. This is intentionally simple but
 * stable, which is exactly what the sliding-window + summarization tests need. The
 * real tokenizer lives in AnthropicProvider; nothing else hardcodes one.
 *
 * Behaviour: if the latest user message asks to use a tool (contains "use tool:
 * <name> <json>"), it emits a single tool call; otherwise it returns a canned
 * final answer. This lets the AgentRunner loop be exercised end-to-end offline.
 */
@Injectable()
export class FakeLlmProvider implements LlmProvider {
  private readonly logger = new Logger(FakeLlmProvider.name);
  private static readonly CHARS_PER_TOKEN = 4;

  constructor(private readonly config: AppConfigService) {}

  getSystemName(): string {
    return 'fake';
  }

  getModel(): string {
    return `fake-${this.config.llmModel}`;
  }

  getContextLimit(): number {
    return this.config.llmContextLimit;
  }

  async countTokens(text: string): Promise<number> {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / FakeLlmProvider.CHARS_PER_TOKEN));
  }

  async complete(options: LlmCompleteOptions): Promise<LlmResponse> {
    const lastUser = [...options.messages]
      .reverse()
      .find((m) => m.role === 'user');
    const prompt = lastUser?.content ?? '';

    // Compute usage from the full assembled context so spans/usage are realistic.
    const inputText =
      (options.system ?? '') +
      options.messages.map((m) => m.content).join('\n');
    const inputTokens = await this.countTokens(inputText);

    // Tool-call directive: "use tool: <name> {json args}"
    const toolMatch = prompt.match(/use tool:\s*(\S+)\s*(\{.*\})?/is);
    if (toolMatch && options.tools?.some((t) => t.name === toolMatch[1])) {
      const name = toolMatch[1];
      let input: Record<string, unknown> = {};
      if (toolMatch[2]) {
        try {
          input = JSON.parse(toolMatch[2]) as Record<string, unknown>;
        } catch {
          // Leave input empty; the registry will return a validation error the
          // model "reads" on the next turn — exercising the error path.
        }
      }
      const text = `Calling tool ${name}.`;
      return {
        text,
        toolCalls: [{ id: `fake-tool-${Date.now()}`, name, input }],
        stopReason: 'tool_use',
        usage: { inputTokens, outputTokens: await this.countTokens(text) },
        model: this.getModel(),
      };
    }

    // Summarization requests carry a known marker (see summarization.worker.ts).
    const isSummaryRequest = (options.system ?? '').includes('SUMMARIZER');
    const text = isSummaryRequest
      ? `Summary: ${prompt.slice(0, 200)}`
      : `Fake answer to: ${prompt.slice(0, 200)}`;

    return {
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens, outputTokens: await this.countTokens(text) },
      model: this.getModel(),
    };
  }
}
