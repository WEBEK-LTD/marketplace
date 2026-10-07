import type { Redis } from 'ioredis';
import type { WorkerLogger } from '../logging/logger.js';
import type { QueueDefinition, QueueJob, QueueSchedule } from '../queue/definitions.js';
import type { IdPayload } from '../queue/payload.js';

/** The stream the API writes to, and the group this consumer reads it with (O-21). */
export const LISTING_EVENT_STREAM = 'analytics:listing-events';
export const LISTING_EVENT_GROUP = 'listing-events-consumer';

export const LISTING_EVENT_QUEUE = 'analytics-listing-events';
export const LISTING_EVENT_JOB = 'drain';
export const LISTING_EVENT_SCHEDULER_ID = 'analytics-listing-events';

export const LISTING_EVENT_CONSUMER_ID = 'a1010000-0000-4000-8000-000000000001';
export const LISTING_EVENT_PAYLOAD: IdPayload = Object.freeze({ consumerId: LISTING_EVENT_CONSUMER_ID });

/** How many stream entries one tick claims. Each entry is a batch of up to fifty events. */
export const LISTING_EVENT_DRAIN_BATCH = 50;

/**
 * How often the stream is drained.
 *
 * A second, which is the same order as O-21's own stated exposure — "up to about 1 s of events can be lost
 * if Redis crashes with every-second persistence" — so the drain is not what decides the loss window.
 * Deliberately a constant rather than a configuration variable: nothing in this increment needs to tune it,
 * and an environment variable nobody sets is an environment variable nobody maintains.
 */
export const LISTING_EVENT_DRAIN_INTERVAL_MS = 1_000;

/** The one database operation this consumer needs: 0013's batched, de-duplicating insert. */
export interface ListingEventWriter {
  recordListingEvents(rows: readonly Record<string, unknown>[]): Promise<number>;
}

/**
 * The listing event stream consumer (0101, O-21's approved path).
 *
 * The API writes one stream entry per batch; this drains them into
 * `app_private.record_listing_events` and acknowledges what it wrote.
 *
 * **It interprets nothing.** The API has already resolved the account from the session, hashed the session
 * identifier under the analytics key and put the rows in the shape the database writer reads. This moves
 * bytes: no field is derived here, and in particular nothing here can decide whose event it is.
 *
 * **At-least-once, which is safe because the writer de-duplicates.** An entry is acknowledged only after the
 * insert returns, so a crash between the two re-delivers it and the second insert writes nothing — the
 * de-duplication is on `event_id` alone, through 0107's `public.listing_event_ids`. (It was on
 * `(event_id, occurred_at)` until then, which this path happened to survive because a redelivered stream entry
 * carries the timestamp already stamped into it.) The alternative, acknowledging first, would be at-most-once
 * and would lose events on exactly the failure this ordering is for.
 *
 * **A poison entry is dropped rather than retried for ever.** An entry whose payload cannot be parsed is
 * acknowledged and logged: it can never succeed, and leaving it pending would block the group's backlog
 * behind one malformed string. An entry that parses but whose insert fails is left unacknowledged, because
 * that is usually the database being briefly unavailable and the next tick should try again.
 */
export class ListingEventConsumerQueue implements QueueDefinition {
  readonly name = LISTING_EVENT_QUEUE;
  readonly schedule: QueueSchedule;

  #groupReady = false;

  constructor(
    private readonly redis: Redis,
    private readonly writer: ListingEventWriter,
    private readonly logger: WorkerLogger,
    intervalMs: number,
    private readonly batchSize: number = LISTING_EVENT_DRAIN_BATCH,
  ) {
    this.schedule = {
      jobName: LISTING_EVENT_JOB,
      schedulerId: LISTING_EVENT_SCHEDULER_ID,
      everyMs: intervalMs,
      data: LISTING_EVENT_PAYLOAD,
    };
  }

  async process(_job: QueueJob): Promise<void> {
    await this.drain();
  }

  /** One pass: claim, write, acknowledge. Answers how many entries it acknowledged. */
  async drain(): Promise<number> {
    await this.#ensureGroup();

    const claimed = await this.#claim();
    if (claimed.length === 0) return 0;

    let acknowledged = 0;
    for (const entry of claimed) {
      const rows = this.#parse(entry.payload);

      if (rows === null) {
        // Unparseable, and it never will be. Acknowledged so one bad entry cannot hold the backlog.
        await this.#acknowledge(entry.id);
        acknowledged += 1;
        this.logger.warn('A listing event stream entry could not be read and was discarded.');
        continue;
      }

      if (rows.length === 0) {
        await this.#acknowledge(entry.id);
        acknowledged += 1;
        continue;
      }

      // Written before acknowledged. A crash here re-delivers the entry and the writer drops the repeat.
      await this.writer.recordListingEvents(rows);
      await this.#acknowledge(entry.id);
      acknowledged += 1;
    }

    return acknowledged;
  }

  /**
   * Creates the consumer group if it is not there, once per process.
   *
   * `MKSTREAM` so the group can exist before the API has ever written, and `BUSYGROUP` is the expected
   * answer on every start after the first.
   */
  async #ensureGroup(): Promise<void> {
    if (this.#groupReady) return;
    try {
      await this.redis.xgroup('CREATE', LISTING_EVENT_STREAM, LISTING_EVENT_GROUP, '0', 'MKSTREAM');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!message.includes('BUSYGROUP')) throw error;
    }
    this.#groupReady = true;
  }

  /**
   * Entries for this consumer: anything already delivered to it and never acknowledged first, then anything
   * new.
   *
   * Taking the pending list first is what makes a restart resume rather than skip: entries claimed by a
   * process that died are still assigned to this consumer name and would otherwise sit unread for ever.
   */
  async #claim(): Promise<readonly { id: string; payload: string | undefined }[]> {
    const pending = await this.#read('0');
    if (pending.length > 0) return pending;
    return await this.#read('>');
  }

  async #read(cursor: string): Promise<readonly { id: string; payload: string | undefined }[]> {
    const replies = (await this.redis.xreadgroup(
      'GROUP',
      LISTING_EVENT_GROUP,
      LISTING_EVENT_GROUP,
      'COUNT',
      this.batchSize,
      'STREAMS',
      LISTING_EVENT_STREAM,
      cursor,
    )) as [string, [string, string[]][]][] | null;

    if (replies === null) return [];

    const entries: { id: string; payload: string | undefined }[] = [];
    for (const [, streamEntries] of replies) {
      for (const [id, fields] of streamEntries) {
        // The API writes one field pair, `events` and the JSON. Anything else is not ours to interpret.
        const index = fields.indexOf('events');
        entries.push({ id, payload: index === -1 ? undefined : fields[index + 1] });
      }
    }
    return entries;
  }

  async #acknowledge(id: string): Promise<void> {
    await this.redis.xack(LISTING_EVENT_STREAM, LISTING_EVENT_GROUP, id);
  }

  /** The rows, or null when the payload is not a JSON array of objects. Nothing is coerced. */
  #parse(payload: string | undefined): readonly Record<string, unknown>[] | null {
    if (payload === undefined) return null;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!Array.isArray(parsed)) return null;
      if (!parsed.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))) return null;
      return parsed as readonly Record<string, unknown>[];
    } catch {
      return null;
    }
  }
}
