import type {
  LlmCompleteOptions,
  LlmProvider,
  LlmResponse,
} from '../../src/llm/llm-provider.interface';
import type { SessionRepository } from '../../src/memory/session.repository';

/**
 * Deterministic test LLM provider. countTokens uses a fixed words-per-token rule
 * so window/summarization math is predictable; context limit is injectable so a
 * test can cross the 80% threshold with tiny inputs.
 */
export class TestLlmProvider implements LlmProvider {
  constructor(
    private readonly contextLimit = 100,
    private readonly completeImpl?: (
      o: LlmCompleteOptions,
    ) => Promise<LlmResponse>,
  ) {}

  getSystemName(): string {
    return 'test';
  }
  getModel(): string {
    return 'test-model';
  }
  getContextLimit(): number {
    return this.contextLimit;
  }
  async countTokens(text: string): Promise<number> {
    if (!text) return 0;
    // 1 token per whitespace-delimited word — stable and easy to reason about.
    return text.trim().split(/\s+/).length;
  }
  async complete(options: LlmCompleteOptions): Promise<LlmResponse> {
    if (this.completeImpl) return this.completeImpl(options);
    return {
      text: 'ok',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: this.getModel(),
    };
  }
}

/** A SessionRepository stub that records calls but does no I/O. */
export function makeRepoStub(): jest.Mocked<
  Pick<
    SessionRepository,
    'ensureSession' | 'appendMessage' | 'appendSummary' | 'archive' | 'getSession'
  >
> {
  return {
    ensureSession: jest.fn().mockResolvedValue(undefined),
    appendMessage: jest.fn().mockResolvedValue(undefined),
    appendSummary: jest.fn().mockResolvedValue(undefined),
    archive: jest.fn().mockResolvedValue(undefined),
    getSession: jest.fn().mockResolvedValue(null),
  } as never;
}
