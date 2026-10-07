import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

/** The Redis Stream O-21 names. The worker reads it through a consumer group of the same name. */
export const LISTING_EVENT_STREAM = 'analytics:listing-events';

/** The consumer group the worker reads with. Created by whichever side gets there first. */
export const LISTING_EVENT_GROUP = 'listing-events-consumer';

export const LISTING_EVENT_STREAM_PORT = Symbol('LISTING_EVENT_STREAM_PORT');

/**
 * One batch on its way to the worker.
 *
 * The rows are already in the shape `app_private.record_listing_events` expects — snake_case keys, a hex
 * session digest — so the worker neither interprets nor reshapes them. It moves bytes.
 */
export interface ListingEventStreamPort {
  /** Resolves when the batch is on the stream. Throws when it is not, which is the fallback's cue. */
  publish(rows: readonly Record<string, unknown>[]): Promise<void>;
}

/**
 * The approved ingestion path: `XADD` onto one stream, drained by the worker's consumer group (O-21).
 *
 * **Why a stream rather than a direct insert on every request.** A beacon is high-volume and bursty, and an
 * insert per request would put that burst straight onto the database on the request path. The stream absorbs
 * it and the worker inserts in batches. O-21 accepts the known cost: with every-second Redis persistence, up
 * to about a second of events can be lost if Redis dies outright.
 *
 * **The timeouts are short on purpose.** Ingestion must never hold a request open: if Redis is slow, the
 * caller falls through to the degraded direct path, which is durable. Slower is better than dropped, and
 * both are better than a hung beacon.
 */
export class RedisListingEventStream implements ListingEventStreamPort, OnApplicationShutdown {
  private readonly logger = new Logger(RedisListingEventStream.name);

  constructor(private readonly redis: Redis) {
    // A connection error is an expected, handled condition here: the degraded path answers instead. Without
    // a listener ioredis emits it as an unhandled error event and can take the process down.
    this.redis.on('error', () => undefined);
  }

  static fromUrl(url: string): RedisListingEventStream {
    return new RedisListingEventStream(
      new Redis(url, {
        commandTimeout: 250,
        connectTimeout: 250,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
      }),
    );
  }

  async publish(rows: readonly Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    // One entry per batch rather than per event: the worker's unit of work is a batch, the database writer
    // takes an array, and the de-duplication key is `event_id`, per event, either way (0107).
    const id = await this.redis.xadd(LISTING_EVENT_STREAM, '*', 'events', JSON.stringify(rows));
    if (id === null) throw new Error('The listing event stream returned no entry id.');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
