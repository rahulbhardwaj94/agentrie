import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { MetricsService } from '../observability/metrics.service';
import { LOCK_SERVICE } from './lock.interface';
import { RedlockService } from './redlock.service';

/**
 * Independent ioredis connections, one per Redlock master. Kept separate from the
 * shared REDIS_CLIENT (used by the memory store) because Redlock's safety rests on
 * the masters being independent; this module owns their lifecycle.
 */
export const REDLOCK_NODES = Symbol('REDLOCK_NODES');

/**
 * Binds LOCK_SERVICE to the Redlock implementation. @Global so both the summarizer
 * (Phase 1) and the SQS consumer (Phase 2) share one primitive.
 *
 * Backward compatible: with a single REDIS_URL (and no REDIS_NODES) this provisions
 * one master and Redlock degrades to the previous single-node behavior. Set
 * REDIS_NODES to a comma-separated list of independent masters for true quorum.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDLOCK_NODES,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Redis[] =>
        config.redisLockNodes.map((url) => {
          const client = new Redis(url, {
            // Fail fast on a dead master rather than buffering lock ops forever;
            // an unreachable master is a no-vote, the quorum logic handles it.
            maxRetriesPerRequest: 3,
            lazyConnect: false,
          });
          client.on('error', (err) =>
            new Logger('Redlock').error(`Redis lock node error: ${err.message}`),
          );
          return client;
        }),
    },
    {
      provide: LOCK_SERVICE,
      inject: [REDLOCK_NODES, AppConfigService, MetricsService],
      useFactory: (
        nodes: Redis[],
        config: AppConfigService,
        metrics: MetricsService,
      ) =>
        new RedlockService(
          nodes,
          { driftFactor: config.lockDriftFactor },
          metrics,
        ),
    },
  ],
  exports: [LOCK_SERVICE],
})
export class LockModule implements OnApplicationShutdown {
  private readonly logger = new Logger(LockModule.name);

  constructor(@Inject(REDLOCK_NODES) private readonly nodes: Redis[]) {}

  async onApplicationShutdown(): Promise<void> {
    this.logger.log(`Closing ${this.nodes.length} Redlock master connection(s)`);
    await Promise.allSettled(this.nodes.map((node) => node.quit()));
  }
}
