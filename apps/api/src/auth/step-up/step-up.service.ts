import { Inject, Injectable } from '@nestjs/common';
import { OtpPepper } from '../otp/otp-digest.js';
import { OTP_PEPPER } from '../otp/otp.service.js';

/**
 * Step-up grants issued by a verified OTP (specification flow F5, the "our OTP" half).
 *
 *   > Step-up | Our OTP or a Supabase TOTP challenge, recorded in `step_up_grants` with a short
 *   > validity; required for password change, payout-detail change, account deletion,
 *   > revoke-all-sessions
 *
 * Owner decision C-16 sets that validity at exactly 10 minutes, and a WhatsApp OTP is recorded as
 * `otp_whatsapp`. Both live in the database function, not here: the duration and the recorded source of
 * proof are security facts, and a caller must not be able to influence either.
 *
 * The TOTP half of F5 needs a live Supabase project and is not implemented.
 */

/** The database operations this service needs, and nothing else. */
export interface StepUpStore {
  issueStepUpGrant(input: IssueStepUpInput): Promise<IssueStepUpResult>;
  /**
   * Consumes `authorization` and runs `operation` in one transaction, so a failing operation gives the
   * grant back. Resolves to `authorized: false` when the grant could not be consumed.
   */
  runWithStepUpGrant<T>(
    authorization: StepUpAuthorization,
    operation: () => Promise<T>,
  ): Promise<AuthorizedRun<T>>;
}

/** Which grant is being spent, by whom, for what. */
export interface StepUpAuthorization {
  readonly grantId: string;
  readonly userId: string;
  readonly operation: string;
}

export type AuthorizedRun<T> =
  | { readonly authorized: true; readonly result: T }
  | { readonly authorized: false };

export interface IssueStepUpInput {
  readonly challengeId: string;
  readonly codeHash: Buffer;
  /** The one operation the grant will authorise. */
  readonly operation: string;
}

/**
 * `granted` means a grant now exists. Everything else is a reason none does, passed through from the
 * OTP verification unchanged so the caller can log precisely without the service reinterpreting it.
 */
export type StepUpOutcome =
  | 'granted'
  | 'invalid'
  | 'expired'
  | 'consumed'
  | 'too_many_attempts'
  | 'not_found'
  | 'no_user';

export interface IssueStepUpResult {
  readonly outcome: StepUpOutcome;
  readonly grantId: string | null;
  readonly expiresAt: Date | null;
}

export const STEP_UP_STORE = Symbol('STEP_UP_STORE');

@Injectable()
export class StepUpService {
  constructor(
    @Inject(STEP_UP_STORE) private readonly store: StepUpStore,
    @Inject(OTP_PEPPER) private readonly pepper: OtpPepper,
  ) {}

  /**
   * Runs a protected operation behind a step-up grant (owner decision C-19).
   *
   * The grant is consumed and the operation runs inside one transaction, which is what makes the two
   * approved rules hold together. Consuming is a single conditional UPDATE, so two simultaneous callers
   * cannot both take the grant; and because the row stays locked until this transaction ends, a caller
   * whose operation throws rolls the consumption back and leaves the grant for someone else. So the
   * grant is spent when the operation *succeeds*, not when it is attempted.
   *
   * Merely asking whether a grant exists does not come through here and does not consume anything.
   *
   * No protected operation is implemented yet: this is the primitive password change, payout-detail
   * change, account deletion and revoke-all-sessions will each call.
   */
  async authorize<T>(
    authorization: StepUpAuthorization,
    operation: () => Promise<T>,
  ): Promise<AuthorizedRun<T>> {
    return await this.store.runWithStepUpGrant(authorization, operation);
  }

  /**
   * Verifies the submitted code and, only if it is correct on a live unused challenge, records the
   * grant.
   *
   * Verification and issuance are one database call on purpose. Splitting them would let two concurrent
   * requests both observe "verified" before either recorded a grant; keeping them together means the
   * single consumption the OTP challenge already guarantees is the same event that authorises the
   * grant. The submitted code is hashed here and never leaves this method.
   */
  async grantFromOtp(challengeId: string, code: string, operation: string): Promise<IssueStepUpResult> {
    return await this.store.issueStepUpGrant({
      challengeId,
      codeHash: this.pepper.digest(code),
      operation,
    });
  }
}
