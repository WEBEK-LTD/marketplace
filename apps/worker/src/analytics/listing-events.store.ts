import { createDatabase, type Database } from '@repo/db';
import { type Kysely, sql } from 'kysely';
import type { ListingEventWriter } from './listing-events.consumer.js';

/**
 * The consumer's gateway to `public.listing_events` (0101).
 *
 * One statement, a call to migration 0013's named SECURITY DEFINER writer. No table access, as everywhere
 * else in this worker: `app_worker` holds **no table privileges at all** (migration 0003, asserted by
 * contract 0031), so a direct insert from this role would be refused.
 *
 * **Its own file, rather than another method on the email relay's store.** 7-D's gateway documents itself as
 * two calls to migration 0008's functions and its boundary suite pins exactly those two; ingestion is a
 * different increment writing a different function, and hanging it off that class would make 7-D's invariant
 * unprovable for a reason that has nothing to do with email. One file per increment's gateway keeps each
 * boundary assertion about the thing it belongs to.
 */
export class AppWorkerListingEventStore implements ListingEventWriter {
  constructor(private readonly db: Kysely<Database>) {}

  static fromConnectionString(connectionString: string, maxConnections: number): AppWorkerListingEventStore {
    return new AppWorkerListingEventStore(createDatabase<Database>({ connectionString, maxConnections }));
  }

  /**
   * `app_private.record_listing_events(jsonb)` (0013), through `app_worker`, which 0013 granted execute on.
   *
   * Answers how many rows were inserted, which is not how many were sent: the writer de-duplicates on the
   * event id alone, through 0107's identity ledger, so a re-delivered stream entry inserts nothing and the
   * count is zero. That is the whole reason the consumer may acknowledge after writing rather than before.
   */
  async recordListingEvents(rows: readonly Record<string, unknown>[]): Promise<number> {
    const result = await sql<{ inserted: number }>`
      select app_private.record_listing_events(${JSON.stringify(rows)}::jsonb) as inserted
    `.execute(this.db);

    return result.rows[0]?.inserted ?? 0;
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}
