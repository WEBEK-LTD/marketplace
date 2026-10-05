import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { ThrottleCounter } from './login-throttle.service.js';

/**
 * The first C-1 tier: a fixed-window counter in Redis.
 *
 * The window is aligned to a multiple of its own length, exactly as `app_private.rate_limit_hit` aligns
 * it, so the two tiers agree about which window a request belongs to. A fallback from Redis to the
 * database mid-window therefore continues the same window rather than handing the client a fresh
 * allowance.
 *
 * Keys carry the hashed subject as hex, never an identifier or an address. Redis holds no plaintext.
 */
export class RedisThrottleCounter implements ThrottleCounter, OnApplicationShutdown {
  private readonly logger = new Logger(RedisThrottleCounter.name);

  constructor(private readonly redis: Redis) {
    // A connection error is an expected, handled condition here: the durable counter answers instead.
    // Without a listener ioredis emits it as an unhandled error event and can take the process down —
    // a Redis outage must degrade this tier, never the API.
    this.redis.on('error', () => undefined);
  }

  static fromUrl(url: string): RedisThrottleCounter {
    return new RedisThrottleCounter(
      new Redis(url, {
        // A throttle check must not hang a login. If Redis is slow, the durable counter answers.
        commandTimeout: 250,
        connectTimeout: 250,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
      }),
    );
  }

  async hit(bucket: string, subjectHash: Buffer, windowSeconds: number, limit: number): Promise<boolean> {
    const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
    const key = `throttle:${bucket}:${subjectHash.toString('hex')}:${windowStart}`;

    const replies = await this.redis
      .multi()
      .incr(key)
      // Set on every hit rather than only the first: a crash between INCR and EXPIRE would otherwise
      // leave a key that never expires and locks the subject out for good.
      .expire(key, windowSeconds)
      .exec();

    // `exec()` resolves to null when the transaction was discarded. That is not "no hits": it is no
    // answer, and the caller must fall through to the durable counter rather than allow the request.
    if (replies === null) throw new Error('Redis throttle transaction was discarded.');
    const [error, hits] = replies[0] ?? [new Error('Redis throttle counter returned no reply.'), null];
    if (error !== null) throw error;
    if (typeof hits !== 'number') throw new Error('Redis throttle counter returned no count.');
    return hits <= limit;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
    this.logger.log('Redis throttle connection closed');
  }
}
