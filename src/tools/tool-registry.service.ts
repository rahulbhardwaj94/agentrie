import { Injectable, Logger } from '@nestjs/common';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  Tool,
  ToolDefinitionView,
  ToolResult,
  ToolScope,
} from './tool.interface';

/**
 * Strongly-typed tool registry (Phase 4 surface; the validate+execute path is
 * REAL because Phase 0's loop drives it).
 *
 * Guarantees:
 *  - **Allowlist**: only registered tools can run; unknown names are rejected.
 *  - **Zod validation** before execution; invalid input returns a structured,
 *    LLM-readable error (never executes the tool).
 *  - **Never crashes the process**: thrown errors / rejected promises inside a
 *    tool are caught and returned as `isError` text into the LLM context.
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly tools = new Map<string, Tool<unknown>>();

  register(tool: Tool<unknown>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
    this.logger.log(`Registered tool: ${tool.name}`);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Whether `name` is in scope: registered, in `allow` (if set), and not in `deny`.
   * Omitting `scope` (or empty allow/deny) means "all registered tools".
   */
  private inScope(name: string, scope?: ToolScope): boolean {
    if (scope?.allow && scope.allow.length > 0 && !scope.allow.includes(name)) {
      return false;
    }
    return !scope?.deny?.includes(name);
  }

  /**
   * Tool definitions advertised to the model (JSON Schema from each Zod schema),
   * optionally narrowed to a per-run {@link ToolScope}.
   */
  list(scope?: ToolScope): ToolDefinitionView[] {
    return [...this.tools.values()]
      .filter((t) => this.inScope(t.name, scope))
      .map((t) => ({
        name: t.name,
        description: t.description,
        // Cast avoids "excessively deep" generic instantiation on complex Zod types;
        // the runtime conversion is unaffected.
        inputSchema: zodToJsonSchema(t.inputSchema as never, {
          target: 'jsonSchema7',
          $refStrategy: 'none',
        }) as Record<string, unknown>,
      }));
  }

  /** Sorted names of the in-scope tools — used to fingerprint the exposed set. */
  names(scope?: ToolScope): string[] {
    return [...this.tools.keys()].filter((n) => this.inScope(n, scope)).sort();
  }

  /**
   * Validate input then execute, honoring the per-run {@link ToolScope}. Returns a
   * ToolResult either way — the caller (AgentRunner) feeds `content` back to the
   * model regardless of success.
   */
  async execute(
    name: string,
    rawInput: unknown,
    scope?: ToolScope,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      // Allowlist rejection — readable by the model so it can self-correct.
      return {
        isError: true,
        content: `Unknown tool '${name}'. Available tools: ${this.names(scope).join(', ')}`,
      };
    }
    if (!this.inScope(name, scope)) {
      // Registered but withheld from THIS run — a scope boundary, not an allowlist
      // miss. Readable so the model stops trying to call it.
      return {
        isError: true,
        content: `Tool '${name}' is not available in this run. Available tools: ${this.names(scope).join(', ')}`,
      };
    }

    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return {
        isError: true,
        content: `Invalid input for tool '${name}': ${issues}`,
      };
    }

    try {
      return await tool.execute(parsed.data);
    } catch (err) {
      // Unexpected throw -> error text into context, process survives.
      this.logger.error(`Tool '${name}' threw: ${(err as Error).message}`);
      return {
        isError: true,
        content: `Tool '${name}' failed: ${(err as Error).message}`,
      };
    }
  }
}
