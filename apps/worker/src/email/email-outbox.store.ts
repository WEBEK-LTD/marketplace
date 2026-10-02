import { createDatabase, type Database } from '@repo/db';
import { type Kysely, sql } from 'kysely';

/**
 * The worker's gateway to `public.email_outbox` (Phase 7-D).
 *
 * Two statements, both of them calls to named SECURITY DEFINER functions of migration 0008. There is no
 * table access and no query builder use anywhere in this file, and that is not a style choice:
 * `app_worker` holds **no table privileges at all** (migration 0003; contract 0031 asserts it), so a
 * direct read of `email_outbox` from this role would simply be refused. If this file ever needs a
 * table, the security model has changed and that change belongs in a migration and an owner decision.
 *
 * `app_worker` is `noinherit` and logs in directly, so no `SET ROLE` is needed — the same arrangement
 * the API uses for `app_system`.
 */

/** One claimed message, exactly as `claim_outbox_messages('email', …)` returns it. */
export interface ClaimedEmailRow {
  readonly id: string;
  readonly recipientUserId: string | null;
  readonly destination: string;
  readonly payload: unknown;
  /** Attempts **including this one**: 0008 increments the counter as it claims. */
  readonly attempts: number;
}

/** How one attempt is recorded. Mirrors `settle_outbox_message`'s four settlement statuses minus the
 * one nobody has defined a convention for: `'cancelled'` is accepted by the function and used by no
 * caller in this repository, so 7-D does not write it. */
export interface SettleEmailInput {
  readonly id: string;
  readonly status: 'sent' | 'failed' | 'queued';
  readonly providerMessageId: string | null;
  readonly errorType: string | null;
  /** Only meaningful for `'queued'`: when the row becomes claimable again. */
  readonly retryAt: Date | null;
}

/** The database operations the email relay needs, and nothing else. */
export interface EmailOutboxStore {
  claimEmailBatch(limit: number): Promise<readonly ClaimedEmailRow[]>;
  settleEmailMessage(input: SettleEmailInput): Promise<boolean>;
}

interface ClaimRow {
  id: string;
  recipient_user_id: string | null;
  destination: string;
  payload: unknown;
  attempts: number;
}

export class AppWorkerStore implements EmailOutboxStore {
  constructor(private readonly db: Kysely<Database>) {}

  static fromConnectionString(connectionString: string, maxConnections: number): AppWorkerStore {
    return new AppWorkerStore(createDatabase<Database>({ connectionString, maxConnections }));
  }

  /**
   * `app_private.claim_outbox_messages('email', limit)`.
   *
   * The function selects `status = 'queued' and available_at <= now()` `for update skip locked`, then
   * moves each row to `'sending'` and increments `attempts`. Two relays running at once therefore claim
   * disjoint sets, and a row is never handed out twice — which is where this increment's idempotency
   * begins rather than in anything the worker does.
   */
  async claimEmailBatch(limit: number): Promise<readonly ClaimedEmailRow[]> {
    const result = await sql<ClaimRow>`
      select id, recipient_user_id, destination, payload, attempts
        from app_private.claim_outbox_messages('email'::text, ${limit}::integer)
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      recipientUserId: row.recipient_user_id,
      destination: row.destination,
      payload: row.payload,
      attempts: row.attempts,
    }));
  }

  /**
   * `app_private.settle_outbox_message('email', …)`.
   *
   * Returns false when the row was not in `'sending'`, which is the function's own guard: "Only a
   * message currently being sent can be settled, so a late duplicate changes nothing." A false here is
   * therefore information, not an error — somebody else finished this message first.
   */
  async settleEmailMessage(input: SettleEmailInput): Promise<boolean> {
    const result = await sql<{ settled: boolean }>`
      select app_private.settle_outbox_message(
        'email'::text,
        ${input.id}::uuid,
        ${input.status}::text,
        ${input.providerMessageId}::text,
        ${input.errorType}::text,
        ${input.retryAt}::timestamptz
      ) as settled
    `.execute(this.db);

    const settled = result.rows[0]?.settled;
    if (typeof settled !== 'boolean') throw new Error('Settling an email delivery returned no row.');
    return settled;
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}
