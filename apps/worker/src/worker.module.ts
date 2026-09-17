import { Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { WorkerEnv } from './config/env.js';
import type { WorkerLogger } from './logging/logger.js';
import { QUEUE_DEFINITIONS, type QueueDefinition } from './queue/definitions.js';
import { createRedisConnection } from './redis/connection.js';
import { WorkerRuntime } from './runtime/worker-runtime.js';

export const WORKER_ENV = Symbol('WORKER_ENV');
export const WORKER_LOGGER = Symbol('WORKER_LOGGER');
export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');

/** Makes sure the Redis connection is closed if the context closes without a runtime stop. */
@Injectable()
class RedisCloser implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  onApplicationShutdown(): void {
    if (this.redis.status !== 'end') {
      this.redis.disconnect();
    }
  }
}

/** Standalone NestJS module. No business queues are registered in Phase 1 Step 4. */
@Module({})
export class WorkerModule {
  static forRoot(env: WorkerEnv, logger: WorkerLogger, definitions: readonly QueueDefinition[] = []): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: WORKER_ENV, useValue: env },
        { provide: WORKER_LOGGER, useValue: logger },
        { provide: QUEUE_DEFINITIONS, useValue: definitions },
        { provide: REDIS_CONNECTION, useFactory: () => createRedisConnection(env.redisUrl, logger) },
        {
          provide: WorkerRuntime,
          inject: [WORKER_ENV, REDIS_CONNECTION, QUEUE_DEFINITIONS, WORKER_LOGGER],
          useFactory: (e: WorkerEnv, redis: Redis, defs: readonly QueueDefinition[], log: WorkerLogger) =>
            new WorkerRuntime(e, redis, defs, log),
        },
        RedisCloser,
      ],
      exports: [WorkerRuntime, REDIS_CONNECTION],
    };
  }
}
