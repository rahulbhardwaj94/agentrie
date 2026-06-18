import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MEMORY_STORE } from './memory-store.interface';
import { RedisMemoryStore } from './redis-memory.store';
import { Session, SessionSchema } from './schemas/session.schema';
import { SessionRepository } from './session.repository';
import { SummarizationWorker } from './summarization.worker';

/**
 * Phase 1 wiring: Mongo model + durable repo, the Redis hot-window store (bound to
 * MEMORY_STORE), and the in-process summarization worker. @Global so the agent
 * module can inject MEMORY_STORE.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
    ]),
  ],
  providers: [
    SessionRepository,
    RedisMemoryStore,
    SummarizationWorker,
    { provide: MEMORY_STORE, useExisting: RedisMemoryStore },
  ],
  exports: [MEMORY_STORE, RedisMemoryStore, SessionRepository, SummarizationWorker],
})
export class MemoryModule {}
