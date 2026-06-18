import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule } from '@nestjs/mongoose';
import { AgentModule } from './agent/agent.module';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { EvalModule } from './eval/eval.module';
import { EventsModule } from './events/events.module';
import { LlmModule } from './llm/llm.module';
import { LockModule } from './lock/lock.module';
import { MemoryModule } from './memory/memory.module';
import { ObservabilityModule } from './observability/observability.module';
import { RedisModule } from './redis/redis.module';
import { ToolsModule } from './tools/tools.module';

/**
 * Root module. Order of intent:
 *   config (fail-fast) -> infra (redis, mongo, event-emitter) -> providers
 *   (llm, lock, tools, observability) -> domain (memory=Phase1, agent=Phase0,
 *   events=Phase2).
 */
@Module({
  imports: [
    AppConfigModule,
    EventEmitterModule.forRoot(),
    // Mongo connection (source of truth). URI is Zod-validated at boot.
    MongooseModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({ uri: config.mongoUri }),
    }),
    RedisModule,
    ObservabilityModule,
    LlmModule,
    LockModule,
    ToolsModule,
    MemoryModule,
    AgentModule,
    EventsModule,
    EvalModule,
  ],
})
export class AppModule {}
