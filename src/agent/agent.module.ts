import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentRunner } from './agent-runner.service';

/**
 * Phase 0 module. AgentRunner depends on LLM_PROVIDER, MEMORY_STORE,
 * ToolRegistryService, and TracingService — all provided by @Global modules.
 */
@Module({
  controllers: [AgentController],
  providers: [AgentRunner],
  exports: [AgentRunner],
})
export class AgentModule {}
