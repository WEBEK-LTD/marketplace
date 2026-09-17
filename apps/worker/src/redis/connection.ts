import { Redis } from 'ioredis';
import { errorSummary, type WorkerLogger } from '../logging/logger.js';

/** Capped reconnect backoff: 200 ms steps up to 5 s; never gives up. */
export const RECONNECT_STEP_MS = 200;
export const RECONNECT_MAX_MS = 5_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(attempt * RECONNECT_STEP_MS, RECONNECT_MAX_MS);
}

/**
 * Creates the Redis connection used by BullMQ. TLS is enabled by a rediss:// URL.
 * The URL is never logged.
 */
export function createRedisConnection(url: string, parentLogger: WorkerLogger): Redis {
  const logger = parentLogger.child({ module: 'redis' });
  const connection = new Redis(url, {
    // Required by BullMQ workers: commands wait for reconnection instead of failing.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy: reconnectDelay,
  });
  let lastError = '';
  connection.on('error', (error: unknown) => {
    const summary = errorSummary(error);
    const key = `${summary.errorType}:${summary.code ?? ''}`;
    if (key !== lastError) {
      lastError = key;
      logger.warn({ event: 'redis_error', ...summary }, 'Redis connection error');
    }
  });
  connection.on('ready', () => {
    lastError = '';
    logger.info({ event: 'redis_ready' }, 'Redis connection ready');
  });
  return connection;
}
