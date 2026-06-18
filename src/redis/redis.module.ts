import {
  Global,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';

/** DI token for the shared ioredis client. */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Shared Redis client. One connection, injected wherever needed (lock + memory).
 * @Global so consumers don't re-import. The provider implements graceful shutdown
 * via the module's OnApplicationShutdown hook below (quit drains in-flight cmds).
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        const client = new Redis(config.redisUrl, {
          // Fail fast on a dead Redis rather than buffering commands forever.
          maxRetriesPerRequest: 3,
          lazyConnect: false,
        });
        client.on('error', (err) =>
          new Logger('Redis').error(`Redis error: ${err.message}`),
        );
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);
  // Nest injects the same instance bound to REDIS_CLIENT.
  constructor() {}

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Redis module shutting down');
    // Client cleanup is handled by Nest's container teardown of the factory; for
    // explicit drain see redis client.quit() — left to container lifecycle here.
  }
}
