import { z } from 'zod';
import type { AppConfigService } from '../src/config/app-config.service';
import { AgentRunner } from '../src/agent/agent-runner.service';
import type {
  LlmCompleteOptions,
  LlmResponse,
} from '../src/llm/llm-provider.interface';
import type {
  ActiveContext,
  MemoryStore,
  StoredMessage,
} from '../src/memory/memory-store.interface';
import { MetricsService } from '../src/observability/metrics.service';
import { TracingService } from '../src/observability/tracing.service';
import { ToolRegistryService } from '../src/tools/tool-registry.service';
import { EchoTool } from '../src/tools/tools/echo.tool';
import { TestLlmProvider } from './helpers/fakes';

/** Trivial in-memory MemoryStore for exercising the loop. */
class InMemoryStore implements MemoryStore {
  private msgs: StoredMessage[] = [];
  private seq = 0;
  async append(_s: string, m: import('../src/llm/llm-provider.interface').LlmMessage) {
    const stored: StoredMessage = {
      ...m,
      id: `m${this.seq++}`,
      tokenCount: 1,
      ts: Date.now(),
    };
    this.msgs.push(stored);
    return stored;
  }
  async getActiveContext(sessionId: string): Promise<ActiveContext> {
    return { sessionId, messages: this.msgs, totalTokens: this.msgs.length };
  }
  async getTokenCount(): Promise<number> {
    return this.msgs.length;
  }
  async replaceOldestWithSummary(): Promise<number> {
    return this.msgs.length;
  }
  async setSystemPrompt(_s: string, content: string): Promise<void> {
    this.msgs.unshift({
      id: 'sys',
      role: 'system',
      content,
      tokenCount: 1,
      ts: Date.now(),
      pinned: true,
    });
  }
}

const config = {
  agentMaxIterations: 10,
  agentMaxToolCalls: 20,
  agentTimeoutMs: 30_000,
  llmMaxOutputTokens: 100,
  llmTimeoutMs: 5_000,
} as AppConfigService;

function makeRunner(complete: (o: LlmCompleteOptions) => Promise<LlmResponse>) {
  const llm = new TestLlmProvider(100_000, complete);
  const memory = new InMemoryStore();
  const tools = new ToolRegistryService();
  tools.register(new EchoTool());
  const tracing = new TracingService();
  const metrics = new MetricsService();
  return new AgentRunner(llm, memory, tools, tracing, metrics, config);
}

describe('AgentRunner (Phase 0 decision loop)', () => {
  it('executes a tool call then returns a final answer (completed)', async () => {
    let call = 0;
    const runner = makeRunner(async () => {
      call += 1;
      if (call === 1) {
        return {
          text: 'let me echo',
          toolCalls: [{ id: 't1', name: 'echo', input: { message: 'hi' } }],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'test-model',
        };
      }
      return {
        text: 'final answer',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'test-model',
      };
    });

    const result = await runner.run({ sessionId: 's', prompt: 'echo hi' });

    expect(result.status).toBe('completed');
    expect(result.answer).toBe('final answer');
    expect(result.toolCalls).toBe(1);
    expect(result.iterations).toBe(2);
  });

  it('trips the max-iterations guardrail when the model never stops calling tools', async () => {
    const runner = makeRunner(async () => ({
      text: 'calling again',
      toolCalls: [{ id: 't', name: 'echo', input: { message: 'loop' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'test-model',
    }));

    const result = await runner.run({
      sessionId: 's',
      prompt: 'loop forever',
      guardrails: { maxIterations: 3 },
    });

    expect(result.status).toBe('max_iterations');
    expect(result.iterations).toBe(3);
  });

  it('returns a structured error result instead of throwing', async () => {
    const runner = makeRunner(async () => {
      throw new Error('provider exploded');
    });

    const result = await runner.run({ sessionId: 's', prompt: 'boom' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('provider exploded');
  });
});

describe('AgentRunner — per-run tool scope', () => {
  /** A second tool so a scope can hide one of two. Records if it actually ran. */
  function calcTool() {
    const tool = {
      name: 'calc',
      description: 'adds',
      inputSchema: z.object({ a: z.number() }),
      ran: false,
      async execute() {
        tool.ran = true;
        return { content: 'ok' };
      },
    };
    return tool;
  }

  function scopedRunner(complete: (o: LlmCompleteOptions) => Promise<LlmResponse>) {
    const llm = new TestLlmProvider(100_000, complete);
    const memory = new InMemoryStore();
    const tools = new ToolRegistryService();
    tools.register(new EchoTool());
    const calc = calcTool();
    tools.register(calc);
    const runner = new AgentRunner(
      llm,
      memory,
      tools,
      new TracingService(),
      new MetricsService(),
      config,
    );
    return { runner, calc };
  }

  it('advertises only the in-scope tools to the model', async () => {
    let advertised: string[] = [];
    const { runner } = scopedRunner(async (o) => {
      advertised = (o.tools ?? []).map((t) => t.name);
      return {
        text: 'done',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'test-model',
      };
    });

    await runner.run({ sessionId: 's', prompt: 'hi', tools: { allow: ['echo'] } });
    expect(advertised).toEqual(['echo']);
  });

  it('refuses an out-of-scope tool call without running the tool body', async () => {
    let call = 0;
    const { runner, calc } = scopedRunner(async () => {
      call += 1;
      if (call === 1) {
        // The model tries the denied tool anyway — the registry must block it.
        return {
          text: 'using calc',
          toolCalls: [{ id: 't1', name: 'calc', input: { a: 1 } }],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'test-model',
        };
      }
      return {
        text: 'final',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'test-model',
      };
    });

    const result = await runner.run({
      sessionId: 's',
      prompt: 'go',
      tools: { deny: ['calc'] },
    });

    expect(result.status).toBe('completed');
    // The scope is a real execution boundary, not just advertisement.
    expect(calc.ran).toBe(false);
  });
});
