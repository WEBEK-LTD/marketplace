import { Inject, Injectable, Logger } from '@nestjs/common';
import { AccountLockedError, EnforcementUnavailableError } from './auth-errors.js';

/**
 * The database operations this layer needs, and nothing else.
 *
 * Narrow on purpose: the enforcement service must not be able to reach the rest of the schema, and a
 * test must be able to supply a store without a database.
 */
export interface LoginEnforcementStore {
  /** `app_private.is_account_locked(uuid)`. */
  isAccountLocked(userId: string): Promise<boolean>;
  /** `app_private.record_login_attempt(...)`; resolves to whether the account is locked afterwards. */
  recordLoginAttempt(attempt: LoginAttempt): Promise<boolean>;
}

export interface LoginAttempt {
  /** Null when the identifier matched no account. The attempt is still recorded. */
  readonly userId: string | null;
  readonly identifierHash: Buffer;
  readonly succeeded: boolean;
  readonly failureReason: string | null;
  readonly requestIp: string | null;
  readonly userAgentHash: Buffer | null;
}

export const LOGIN_ENFORCEMENT_STORE = Symbol('LOGIN_ENFORCEMENT_STORE');

/**
 * The enforcement point required by AUTH-3 / N1:
 *
 *   > NestJS enforces durable lockout before any Supabase call
 *
 * Every method fails closed. The specification requires the Postgres fallback to "never fail open for
 * auth", so an unreachable database denies the attempt rather than letting it through. This is the one
 * behaviour worth stating plainly, because the tempting implementation — treat a database error as "not
 * locked" and carry on — turns an outage into an open door.
 *
 * This service performs no Supabase call, issues no session and sets no cookie. It is the gate that runs
 * first; what happens after it is a later Phase 3 step.
 */
@Injectable()
export class LoginEnforcementService {
  private readonly logger = new Logger(LoginEnforcementService.name);

  constructor(@Inject(LOGIN_ENFORCEMENT_STORE) private readonly store: LoginEnforcementStore) {}

  /**
   * Refuses the attempt if the account holds an active lockout.
   *
   * Call this before contacting Supabase. A null user id — an identifier that matched no account —
   * passes, because there is no account to be locked; the caller must still go on to record the failure.
   */
  async assertNotLocked(userId: string | null): Promise<void> {
    if (userId === null) return;

    let locked: boolean;
    try {
      locked = await this.store.isAccountLocked(userId);
    } catch (error) {
      // Deliberately not `return`: an unknown lockout state is treated as locked.
      this.logger.error('Durable lockout check failed; denying the attempt.');
      throw new EnforcementUnavailableError(error);
    }

    if (locked) throw new AccountLockedError();
  }

  /**
   * Records the outcome of an attempt and applies the approved lockout rule in the same statement.
   *
   * Resolves to whether the account is locked *after* this attempt, which lets a caller record a
   * security event for the transition. A recording failure is raised, never swallowed: an attempt that
   * cannot be counted is an attempt that cannot lock anything, so continuing would defeat the control.
   */
  async recordAttempt(attempt: LoginAttempt): Promise<boolean> {
    try {
      return await this.store.recordLoginAttempt(attempt);
    } catch (error) {
      this.logger.error('Recording a login attempt failed; denying the attempt.');
      throw new EnforcementUnavailableError(error);
    }
  }
}
