import { Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { AgentRunner } from './agent-runner.service';
import type { AgentTerminalResult } from './agent.types';

const runDtoSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  system: z.string().optional(),
});

/**
 * Minimal HTTP surface to exercise Phase 0 + Phase 1 end-to-end:
 *   POST /agent/run { sessionId, prompt, system? }
 * Returns the structured terminal result. Drives the AgentRunner, which in turn
 * reads/writes the token-aware window and triggers summarization at 80%.
 */
@Controller('agent')
export class AgentController {
  constructor(private readonly runner: AgentRunner) {}

  @Post('run')
  async run(@Body() body: unknown): Promise<AgentTerminalResult> {
    const input = runDtoSchema.parse(body);
    return this.runner.run(input);
  }
}
