import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import {
  LLM_PROVIDER,
  type LlmMessage,
  type LlmProvider,
  type LlmToolCall,
  type LlmToolResult,
} from '../llm/llm-provider.interface';
import {
  MEMORY_STORE,
  type MemoryStore,
} from '../memory/memory-store.interface';
import { MetricsService } from '../observability/metrics.service';
import { TracingService } from '../observability/tracing.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import type {
  AgentGuardrails,
  AgentRunInput,
  AgentTerminalResult,
} from './agent.types';

/**
 * AgentRunner — the orchestration brain (Phase 0, REAL).
 *
 * Loop: assemble context from memory -> call LlmProvider -> if the response has
 * tool calls, execute them via the ToolRegistry and append results -> repeat,
 * until a final answer or a guardrail (max iterations / max tool calls /
 * wall-clock timeout) trips. On a trip it returns a structured terminal result;
 * it never throws into the void.
 *
 * Observability: one span per iteration, with child spans for the LLM call and
 * each tool call, tagged with GenAI semantic-convention attributes.
 */
@Injectable()
export class AgentRunner {
  private readonly logger = new Logger(AgentRunner.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(MEMORY_STORE) private readonly memory: MemoryStore,
    private readonly tools: ToolRegistryService,
    private readonly tracing: TracingService,
    private readonly metrics: MetricsService,
    private readonly config: AppConfigService,
  ) {}

  private resolveGuardrails(input: AgentRunInput): AgentGuardrails {
    return {
      maxIterations:
        input.guardrails?.maxIterations ?? this.config.agentMaxIterations,
      maxToolCalls:
        input.guardrails?.maxToolCalls ?? this.config.agentMaxToolCalls,
      timeoutMs: input.guardrails?.timeoutMs ?? this.config.agentTimeoutMs,
    };
  }

  async run(input: AgentRunInput): Promise<AgentTerminalResult> {
    const guardrails = this.resolveGuardrails(input);
    const deadline = Date.now() + guardrails.timeoutMs;

    return this.tracing.withSpan(
      'agent.run',
      async () => this.runLoop(input, guardrails, deadline),
      { 'agent.session_id': input.sessionId },
    );
  }

  private async runLoop(
    input: AgentRunInput,
    guardrails: AgentGuardrails,
    deadline: number,
  ): Promise<AgentTerminalResult> {
    const { sessionId } = input;
    let iterations = 0;
    let toolCalls = 0;
    let answer = '';

    const terminal = (
      status: AgentTerminalResult['status'],
      error?: string,
    ): AgentTerminalResult => {
      // Single exit funnel for every status -> one place to emit the run metric.
      this.metrics.recordAgentRun(status, iterations);
      return { status, sessionId, answer, iterations, toolCalls, error };
    };

    try {
      if (input.system) {
        await this.memory.setSystemPrompt(sessionId, input.system);
      }
      // Seed the turn with the user's prompt (also persisted to Mongo).
      await this.memory.append(sessionId, {
        role: 'user',
        content: input.prompt,
      });

      // Per-run tool scope narrows the registry allowlist for THIS run (advertise +
      // execute). Omitted => the full registry.
      const toolDefs = this.tools.list(input.tools);

      while (true) {
        if (iterations >= guardrails.maxIterations) {
          return terminal('max_iterations');
        }
        if (Date.now() >= deadline) {
          return terminal('timeout');
        }
        iterations += 1;

        const result = await this.tracing.withSpan(
          'agent.iteration',
          async () => this.iterate(input, toolDefs, deadline),
          { 'agent.iteration': iterations },
        );

        answer = result.text || answer;

        if (result.toolRequests.length === 0) {
          // No tool calls -> final answer.
          return terminal('completed');
        }

        // Guardrail: cap total tool calls across the run.
        if (toolCalls + result.toolRequests.length > guardrails.maxToolCalls) {
          return terminal('max_tool_calls');
        }

        // Execute each requested tool, append results back into memory.
        const toolResults: LlmToolResult[] = [];
        for (const req of result.toolRequests) {
          toolCalls += 1;
          const execResult = await this.tracing.withSpan(
            'agent.tool_call',
            async (span) => {
              this.tracing.setToolName(span, req.name);
              return this.tools.execute(req.name, req.input, input.tools);
            },
            { 'gen_ai.tool.name': req.name },
          );
          this.metrics.recordToolCall(req.name, execResult.isError ?? false);
          toolResults.push({
            toolCallId: req.id,
            content: execResult.content,
            isError: execResult.isError,
          });
        }

        // Persist the assistant tool-call turn + the tool results into the window.
        await this.memory.append(sessionId, {
          role: 'assistant',
          content: result.text,
          toolCalls: result.toolRequests,
        });
        await this.memory.append(sessionId, {
          role: 'tool',
          content: '',
          toolResults,
        });
      }
    } catch (err) {
      this.logger.error(
        `Agent run failed for ${sessionId}: ${(err as Error).message}`,
      );
      return terminal('error', (err as Error).message);
    }
  }

  /**
   * One iteration = assemble context -> single LLM call. Returns the assistant
   * text and any tool requests. Wrapped in an LLM child span with GenAI tags.
   */
  private async iterate(
    input: AgentRunInput,
    toolDefs: ReturnType<ToolRegistryService['list']>,
    deadline: number,
  ): Promise<{ text: string; toolRequests: LlmToolCall[] }> {
    const ctx = await this.memory.getActiveContext(input.sessionId);
    const system = ctx.messages.find((m) => m.role === 'system')?.content;
    // Non-system messages form the conversation; system travels separately.
    const messages: LlmMessage[] = ctx.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls,
        toolResults: m.toolResults,
      }));

    const remainingMs = Math.max(1, deadline - Date.now());

    const response = await this.tracing.withSpan(
      'llm.complete',
      async (span) => {
        const startedAt = Date.now();
        const res = await this.llm.complete({
          system,
          messages,
          tools: toolDefs,
          maxOutputTokens: this.config.llmMaxOutputTokens,
          timeoutMs: Math.min(remainingMs, this.config.llmTimeoutMs),
        });
        const system_ = this.llm.getSystemName();
        this.tracing.setLlmAttributes(span, {
          system: system_,
          model: res.model,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
        });
        this.metrics.recordLlmCall({
          model: res.model,
          system: system_,
          durationMs: Date.now() - startedAt,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
        });
        return res;
      },
    );

    return { text: response.text, toolRequests: response.toolCalls };
  }
}
