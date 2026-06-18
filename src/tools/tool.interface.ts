import type { z } from 'zod';

/**
 * A registered tool. Each declares a Zod input schema; the registry validates
 * inputs against it BEFORE execution and rejects with a structured, LLM-readable
 * error. `execute` receives already-validated, typed input.
 */
export interface Tool<TInput = unknown> {
  name: string;
  description: string;
  /** Zod schema for the tool input — the source of truth for validation. */
  inputSchema: z.ZodType<TInput>;
  /**
   * Execute the tool. Implementations should NOT throw for expected failures —
   * return `{ isError: true, content }` so the text flows back into the LLM
   * context. The registry also wraps unexpected throws so the process never dies.
   */
  execute(input: TInput): Promise<ToolResult>;
}

export interface ToolResult {
  /** Text/JSON the model reads next turn. For errors, the error message/stderr. */
  content: string;
  isError?: boolean;
}

/** A tool definition advertised to the model (JSON Schema derived from Zod). */
export interface ToolDefinitionView {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Per-run restriction of the exposed tool set, applied on top of the registry's
 * allowlist. Lets a single run (or an eval compare candidate) narrow which
 * registered tools the agent can see and call, without re-registering anything.
 *
 *  - `allow` — when set & non-empty, ONLY these names are in scope (base set).
 *  - `deny`  — these names are removed (subtracted from the base set).
 *
 * Both may combine (in `allow` AND not in `deny`). Omitting both = the full
 * registry. The scope gates BOTH advertisement (`list`) and execution (`execute`).
 */
export interface ToolScope {
  allow?: string[];
  deny?: string[];
}

export const TOOL_REGISTRY = Symbol('TOOL_REGISTRY');
