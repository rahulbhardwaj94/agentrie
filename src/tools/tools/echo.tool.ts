import { z } from 'zod';
import type { Tool, ToolResult } from '../tool.interface';

const echoSchema = z.object({
  message: z.string().min(1).describe('The text to echo back'),
});
type EchoInput = z.infer<typeof echoSchema>;

/**
 * Safe sample tool with no side effects — used to exercise the AgentRunner loop
 * end-to-end (Phase 0/1) without touching the shell or filesystem.
 */
export class EchoTool implements Tool<EchoInput> {
  readonly name = 'echo';
  readonly description = 'Echo a message back verbatim. Use to test tool calls.';
  readonly inputSchema = echoSchema;

  async execute(input: EchoInput): Promise<ToolResult> {
    return { content: input.message };
  }
}
