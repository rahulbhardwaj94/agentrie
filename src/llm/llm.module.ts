import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AnthropicProvider } from './anthropic.provider';
import { FakeLlmProvider } from './fake.provider';
import { LLM_PROVIDER } from './llm-provider.interface';

/**
 * Binds the LLM_PROVIDER token to the active provider via a factory:
 *   - ANTHROPIC_API_KEY present -> real AnthropicProvider
 *   - otherwise               -> deterministic FakeLlmProvider (keyless default)
 *
 * @Global so memory/agent/summarizer can inject LLM_PROVIDER without re-importing.
 * This is the single decoupling seam for swapping models/providers.
 */
@Global()
@Module({
  providers: [
    FakeLlmProvider,
    AnthropicProvider,
    {
      provide: LLM_PROVIDER,
      inject: [AppConfigService, FakeLlmProvider, AnthropicProvider],
      useFactory: (
        config: AppConfigService,
        fake: FakeLlmProvider,
        anthropic: AnthropicProvider,
      ) => (config.hasAnthropicKey ? anthropic : fake),
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
