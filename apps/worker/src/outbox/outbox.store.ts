import { createDatabase, type Database } from '@repo/db';
import { type Kysely, sql } from 'kysely';
import type { OutboxEventView } from './outbox-handler.registry.js';

/**
 * The worker's gateway to the transactional outbox and to `job_runs` (Phase 8-A).
 *
 * Six statements, every one a call to a named SECURITY DEFINER function. There is no table access and
 * no query-builder use anywhere in this file, and that is not a style choice: `app_worker` holds **no
 * table privileges at all** (migration 0003; contract 0031 asserts it), so a direct read of
 * `outbox_events` from this role would simply be refused. Four of the six functions are 0007's,
 * unchanged; two are 0083's, and 0083 says why they had to exist.
 *
 * `app_worker` is `noinherit` and logs in directly, so no `SET ROLE` is needed — the same arrangement
 * 7-D uses for the email relay and the API uses for `app_system`.
 */

/** `job_runs.status`, as 0007's `job_runs_status_allowed` constrains it. */
export type JobRunStatus = 'succeeded' | 'failed' | 'skipped';

export interface OutboxStore {
  /**
   * `app_private.claim_outbox_events_for(event_types, limit)`.
   *
   * Never called with an empty list: the function refuses one, and the relay does not run at all when
   * the registry is empty.
   */
  claimForEventTypes(eventTypes: readonly string[], limit: number): Promise<readonly OutboxEventView[]>;
  read(id: string): Promise<OutboxEventView | null>;
  complete(id: string): Promise<boolean>;
  deadLetter(id: string, errorType: string): Promise<boolean>;
  sweep(staleAfter: string, limit: number): Promise<number>;
  /** Returns the run id, or null when this scheduled occurrence was already recorded. */
  startJobRun(jobName: string, scheduledFor: Date | null): Promise<string | null>;
  finishJobRun(
    id: string,
    status: JobRunStatus,
    processedCount: number | null,
    errorType: string | null,
  ): Promise<boolean>;
}

interface EventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: Date | string;
  attempts: number;
  published_at?: Date | string | null;
  completed_at?: Date | string | null;
  dead_lettered_at?: Date | string | null;
}

function date(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function view(row: EventRow): OutboxEventView {
  const occurredAt = date(row.occurred_at);
  if (occurredAt === null) throw new Error('An outbox event row carried no occurred_at.');
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt,
    attempts: row.attempts,
    publishedAt: date(row.published_at),
    completedAt: date(row.completed_at),
    deadLetteredAt: date(row.dead_lettered_at),
  };
}

export class AppWorkerOutboxStore implements OutboxStore {
  constructor(private readonly db: Kysely<Database>) {}

  static fromConnectionString(connectionString: string, maxConnections: number): AppWorkerOutboxStore {
    return new AppWorkerOutboxStore(createDatabase<Database>({ connectionString, maxConnections }));
  }

  /**
   * The claim is the only write the relay makes to `outbox_events`.
   *
   * 0083's function selects `published_at is null and dead_lettered_at is null and available_at <= now()
   * and event_type = any(...)` `for update skip locked`, then sets `published_at` and increments
   * `attempts`. Two relays therefore claim disjoint sets, which is where this increment's idempotency
   * begins rather than in anything this class does.
   */
  async claimForEventTypes(eventTypes: readonly string[], limit: number): Promise<readonly OutboxEventView[]> {
    const result = await sql<EventRow>`
      select id, aggregate_type, aggregate_id, event_type, payload, occurred_at, attempts
        from app_private.claim_outbox_events_for(${[...eventTypes]}::text[], ${limit}::integer)
    `.execute(this.db);
    return result.rows.map((row) => view({ ...row, published_at: null, completed_at: null, dead_lettered_at: null }));
  }

  async read(id: string): Promise<OutboxEventView | null> {
    const result = await sql<EventRow>`
      select id, aggregate_type, aggregate_id, event_type, payload, occurred_at, attempts,
             published_at, completed_at, dead_lettered_at
        from app_private.outbox_event_for_worker(${id}::uuid)
    `.execute(this.db);
    const row = result.rows[0];
    return row === undefined ? null : view(row);
  }

  /** `complete_outbox_event`. False means somebody else finished it first — information, not an error. */
  async complete(id: string): Promise<boolean> {
    return this.bool(sql<{ done: boolean }>`select app_private.complete_outbox_event(${id}::uuid) as done`);
  }

  /** `dead_letter_outbox_event`. Only the error class is stored, never a message or a stack. */
  async deadLetter(id: string, errorType: string): Promise<boolean> {
    return this.bool(
      sql<{ done: boolean }>`select app_private.dead_letter_outbox_event(${id}::uuid, ${errorType}::text) as done`,
    );
  }

  /** `sweep_outbox_events`. Returns published events with no completion to the pending state. */
  async sweep(staleAfter: string, limit: number): Promise<number> {
    const result = await sql<{ swept: number }>`
      select app_private.sweep_outbox_events(${staleAfter}::interval, ${limit}::integer) as swept
    `.execute(this.db);
    const swept = result.rows[0]?.swept;
    if (typeof swept !== 'number') throw new Error('Sweeping the outbox returned no row.');
    return swept;
  }

  /**
   * `start_job_run`. Returns null when `(job_name, scheduled_for)` already exists — 0007's own
   * unique index — which is exactly what a redelivered scheduler occurrence must not duplicate.
   */
  async startJobRun(jobName: string, scheduledFor: Date | null): Promise<string | null> {
    const result = await sql<{ id: string | null }>`
      select app_private.start_job_run(${jobName}::text, ${scheduledFor}::timestamptz) as id
    `.execute(this.db);
    return result.rows[0]?.id ?? null;
  }

  async finishJobRun(
    id: string,
    status: JobRunStatus,
    processedCount: number | null,
    errorType: string | null,
  ): Promise<boolean> {
    // `details` stays `{}`. 0081 projects only `job_key` and `sqlstate` from it, and a count belongs in
    // the `processed_count` column, which that surface already reads.
    return this.bool(sql<{ done: boolean }>`
      select app_private.finish_job_run(
        ${id}::uuid,
        ${status}::text,
        ${processedCount}::integer,
        ${errorType}::text,
        '{}'::jsonb
      ) as done
    `);
  }

  private async bool(query: { execute(db: Kysely<Database>): Promise<{ rows: Array<{ done?: boolean }> }> }): Promise<boolean> {
    const result = await query.execute(this.db);
    const done = result.rows[0]?.done;
    if (typeof done !== 'boolean') throw new Error('An outbox function returned no row.');
    return done;
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}
