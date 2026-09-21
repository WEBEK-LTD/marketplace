import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabase, type Database } from '@repo/db';
import { type Kysely, sql } from 'kysely';
import type { LoginAttempt, LoginEnforcementStore } from './login-enforcement.service.js';
import type {
  IssueOtpInput,
  IssueOtpResult,
  OtpChallengeStore,
  OtpVerifyOutcome,
  SettleOtpDeliveryInput,
} from './otp/otp.service.js';
import type {
  AuthorizedRun,
  IssueStepUpInput,
  IssueStepUpResult,
  StepUpAuthorization,
  StepUpOutcome,
  StepUpStore,
} from './step-up/step-up.service.js';

/**
 * Thrown to unwind the transaction when a grant could not be consumed.
 *
 * It never escapes {@link AppSystemStore.runWithStepUpGrant}: a refusal is an outcome, not an error, and
 * rolling back is simply how nothing is left behind.
 */
class NotAuthorized extends Error {
  constructor() {
    super('step-up grant not consumed');
    this.name = 'NotAuthorized';
  }
}

/** Raw shape returned by `app_private.issue_step_up_grant`. */
interface StepUpRow {
  outcome: StepUpOutcome;
  grant_id: string | null;
  expires_at: Date | null;
}

/** Raw shape returned by `app_private.issue_otp_challenge`. */
interface IssueOtpRow {
  outcome: IssueOtpResult['outcome'];
  challenge_id: string | null;
  outbox_id: string | null;
  send_count: number | null;
  retry_after_seconds: number | null;
  expires_at: Date | null;
}

/**
 * The `app_system` connection, and the only place the auth enforcement functions are called.
 *
 * `app_system` holds no table privileges anywhere — the 0031 role-boundary contract enforces that — so
 * every statement here goes through a named SECURITY DEFINER function. There is no query builder use and
 * no table access on purpose: if this file ever needs to read a table directly, the security model has
 * changed and that change belongs in a migration and an owner decision, not here.
 *
 * `app_system` is `noinherit` and logs in directly (migration 0003), so no `SET ROLE` is needed.
 */
@Injectable()
export class AppSystemStore
  implements LoginEnforcementStore, OtpChallengeStore, StepUpStore, OnApplicationShutdown
{
  private readonly logger = new Logger(AppSystemStore.name);

  constructor(private readonly db: Kysely<Database>) {}

  static fromConnectionString(connectionString: string, maxConnections: number): AppSystemStore {
    return new AppSystemStore(createDatabase<Database>({ connectionString, maxConnections }));
  }

  async isAccountLocked(userId: string): Promise<boolean> {
    const result = await sql<{ locked: boolean }>`
      select app_private.is_account_locked(${userId}::uuid) as locked
    `.execute(this.db);

    const locked = result.rows[0]?.locked;
    // An empty result is not "unlocked": it is an answer we did not get. Fail closed.
    if (typeof locked !== 'boolean') throw new Error('Lockout check returned no row.');
    return locked;
  }

  async recordLoginAttempt(attempt: LoginAttempt): Promise<boolean> {
    const result = await sql<{ locked: boolean }>`
      select app_private.record_login_attempt(
        ${attempt.userId}::uuid,
        ${attempt.identifierHash}::bytea,
        ${attempt.succeeded}::boolean,
        ${attempt.failureReason}::text,
        ${attempt.requestIp}::inet,
        ${attempt.userAgentHash}::bytea
      ) as locked
    `.execute(this.db);

    const locked = result.rows[0]?.locked;
    if (typeof locked !== 'boolean') throw new Error('Recording a login attempt returned no row.');
    return locked;
  }

  async issueOtpChallenge(input: IssueOtpInput): Promise<IssueOtpResult> {
    const result = await sql<IssueOtpRow>`
      select outcome, challenge_id, outbox_id, send_count, retry_after_seconds, expires_at
        from app_private.issue_otp_challenge(
          ${input.purpose}::text,
          ${input.channel}::text,
          ${input.destinationHash}::bytea,
          ${input.codeHash}::bytea,
          ${input.toPhoneE164}::text,
          ${input.templateName}::text,
          ${input.templateLocale}::text,
          ${input.userId}::uuid,
          ${input.requestIp}::inet,
          ${input.ipHash}::bytea
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Issuing an OTP challenge returned no row.');
    return {
      outcome: row.outcome,
      challengeId: row.challenge_id,
      outboxId: row.outbox_id,
      sendCount: row.send_count,
      retryAfterSeconds: row.retry_after_seconds,
      expiresAt: row.expires_at,
    };
  }

  async beginOtpDelivery(outboxId: string): Promise<boolean> {
    const result = await sql<{ claimed: boolean }>`
      select app_private.begin_otp_delivery(${outboxId}::uuid) as claimed
    `.execute(this.db);
    const claimed = result.rows[0]?.claimed;
    if (typeof claimed !== 'boolean') throw new Error('Claiming an OTP delivery returned no row.');
    return claimed;
  }

  async settleOtpDelivery(input: SettleOtpDeliveryInput): Promise<boolean> {
    const result = await sql<{ settled: boolean }>`
      select app_private.settle_outbox_message(
        'whatsapp'::text,
        ${input.outboxId}::uuid,
        ${input.status}::text,
        ${input.providerMessageId}::text,
        ${input.errorType}::text,
        null::timestamptz
      ) as settled
    `.execute(this.db);
    const settled = result.rows[0]?.settled;
    if (typeof settled !== 'boolean') throw new Error('Settling an OTP delivery returned no row.');
    return settled;
  }

  async verifyOtpChallenge(challengeId: string, codeHash: Buffer): Promise<OtpVerifyOutcome> {
    const result = await sql<{ outcome: OtpVerifyOutcome }>`
      select app_private.verify_otp_challenge(${challengeId}::uuid, ${codeHash}::bytea) as outcome
    `.execute(this.db);
    const outcome = result.rows[0]?.outcome;
    if (outcome === undefined) throw new Error('Verifying an OTP challenge returned no row.');
    return outcome;
  }

  async issueStepUpGrant(input: IssueStepUpInput): Promise<IssueStepUpResult> {
    const result = await sql<StepUpRow>`
      select outcome, grant_id, expires_at
        from app_private.issue_step_up_grant(
          ${input.challengeId}::uuid,
          ${input.codeHash}::bytea,
          ${input.operation}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Issuing a step-up grant returned no row.');
    return { outcome: row.outcome, grantId: row.grant_id, expiresAt: row.expires_at };
  }

  /**
   * Consumes a step-up grant and runs the protected operation in one transaction (C-19).
   *
   * The ordering is deliberate and load-bearing. The consume is a single conditional UPDATE, so two
   * simultaneous callers cannot both take the grant; the row then stays locked for the rest of this
   * transaction, so if `operation` throws, the rollback returns the grant and a waiting caller may still
   * use it. That is what makes the grant spent on success rather than on attempt.
   *
   * An error from `operation` is re-thrown unchanged after the rollback: the caller needs to know their
   * operation failed, not merely that it was not authorised.
   */
  async runWithStepUpGrant<T>(
    authorization: StepUpAuthorization,
    operation: () => Promise<T>,
  ): Promise<AuthorizedRun<T>> {
    try {
      const result = await this.db.transaction().execute(async (trx) => {
        const consumed = await sql<{ consumed: boolean }>`
          select app_private.consume_step_up_grant(
            ${authorization.grantId}::uuid,
            ${authorization.userId}::uuid,
            ${authorization.operation}::text
          ) as consumed
        `.execute(trx);

        const authorized = consumed.rows[0]?.consumed;
        if (typeof authorized !== 'boolean') throw new Error('Consuming a step-up grant returned no row.');
        if (!authorized) throw new NotAuthorized();

        return await operation();
      });
      return { authorized: true, result };
    } catch (error) {
      if (error instanceof NotAuthorized) return { authorized: false };
      throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
    this.logger.log('app_system connection pool closed');
  }
}
