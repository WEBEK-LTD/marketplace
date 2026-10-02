import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PseudonymousUserId } from '@repo/server-config';
import { PSEUDONYMOUS_USER_ID, recordLogIdentity } from '../../logging/log-identity.js';
import {
  AuthProviderUnavailableError,
  AuthenticationRequiredError,
  InvalidCredentialsError,
  TotpAlreadyEnrolledError,
  TotpNotEnrolledError,
} from '../auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../login.service.js';
import type { SupabaseAuthClient, SupabaseSession, TotpEnrolment } from '../supabase-auth.client.js';

/**
 * TOTP enrolment and the AAL2 challenge (Phase 7-B).
 *
 * Six properties are enforced here rather than left to a caller, and each is the reason a piece of this
 * looks the way it does.
 *
 * **The secret lives with the provider, and this project never holds it.** The approved model is
 * "Supabase Auth stores credentials, sessions and TOTP factors behind a NestJS Auth façade". So the
 * factor is created by the provider, the code is checked by the provider, and the only moment a secret
 * exists anywhere in this process is the single enrolment response that carries it to the screen the
 * person is reading. It is never written to our database, never logged, never placed in a URL and never
 * returned twice — asking to enrol again when a verified factor exists is refused outright.
 *
 * **`aal2` can only come from the provider, so it does.** `public.is_aal2()` reads the `aal` claim of the
 * caller's JWT, and only a session GoTrue minted after a satisfied MFA challenge carries `aal2`. There is
 * no arrangement in which this service could manufacture that claim, and it does not try: verification
 * returns the provider's new session, the BFF swaps it into the staff cookies, and staff RLS then sees
 * `aal2` exactly as 0003 has always required. Nothing in 0003 is touched.
 *
 * **Our own authority is the step-up grant, not the token.** A claim in a token this project does not
 * verify is a caller's assertion; a row in our database is not. So when a challenge names an operation,
 * a satisfied verification records a grant through `app_private.issue_totp_step_up_grant` — 0042's
 * function, unchanged, which fixes `granted_via = 'totp'` and C-16's ten minutes as literals no caller
 * can influence. Spending it stays `app_private.consume_step_up_grant` under C-19's single-use,
 * single-operation, single-owner rules. This is the second 2FA system's absence made concrete: there is
 * one grant table, one issuer per source of proof, and one consumer.
 *
 * **The browser never chooses what it is answering.** The factor id and the challenge id are server
 * state. They travel to the BFF on the internal hop and live in an `HttpOnly` cookie; no request from a
 * page carries either, and there is no field in the approved schemas for one to arrive in.
 *
 * **Every refusal is the same refusal.** A wrong code, an expired challenge, a challenge already spent
 * and a factor belonging to somebody else all leave here as {@link InvalidCredentialsError}. The only
 * two distinct answers are about the caller's *own* state, which they can already see: they have a
 * verified factor when they tried to enrol, or they have none when a challenge was asked for.
 *
 * **Buyers are untouched.** Nothing here enrols anybody, requires anybody to enrol, or refuses anybody
 * who has not. It offers enrolment to whoever asks and enforces a challenge only where a caller has a
 * verified factor. The staff requirement is applied by the surfaces that need it, not by this service
 * making 2FA mandatory for every account in the marketplace.
 */

/** The issuer name an authenticator shows beside the account. Fixed: it is not a caller's to choose. */
export const TOTP_ISSUER = 'Marketplace';

/** The factor's friendly name at the provider. Likewise fixed, and deliberately not personal. */
export const TOTP_FRIENDLY_NAME = 'Authenticator app';

/** The database operation this service needs, and nothing else. */
export interface TotpStepUpStore {
  /** `app_private.issue_totp_step_up_grant` (0042): a 10-minute grant for one operation. */
  issueTotpStepUpGrant(input: {
    userId: string;
    operation: string;
  }): Promise<{ outcome: string; grantId: string | null; expiresAt: Date | null }>;
}

export const TOTP_STEP_UP_STORE = Symbol('TOTP_STEP_UP_STORE');

export type TotpStatus = 'not_enrolled' | 'enrolled';

/** What a raised challenge hands back to the BFF, and nothing a browser ever sees. */
export interface TotpChallenge {
  readonly factorId: string;
  readonly challengeId: string;
}

/** What a satisfied verification produces: always a session, and a grant when one was asked for. */
export interface TotpVerification {
  readonly session: SupabaseSession;
  readonly grantId: string | null;
  readonly grantExpiresAt: Date | null;
}

@Injectable()
export class TotpService {
  private readonly logger = new Logger(TotpService.name);

  constructor(
    @Inject(SUPABASE_AUTH_CLIENT) private readonly provider: SupabaseAuthClient,
    @Inject(TOTP_STEP_UP_STORE) private readonly store: TotpStepUpStore,
    @Inject(PSEUDONYMOUS_USER_ID) private readonly pseudonymous: PseudonymousUserId,
  ) {}

  /**
   * Whether the caller has a verified authenticator.
   *
   * Two states, and deliberately no third. A factor that exists but was never verified reads as
   * `not_enrolled`, because that is what it means to the person: they started and did not finish, and the
   * thing to offer them is enrolment. No factor identifier and no count leaves this method.
   */
  async status(accessToken: string): Promise<TotpStatus> {
    const factors = await this.callerFactors(accessToken);
    return factors.some((factor) => factor.verified) ? 'enrolled' : 'not_enrolled';
  }

  /**
   * Creates a factor and returns the enrolment material once.
   *
   * **Refused when a verified factor already exists.** AUTH-10 rows 10.10 and 10.11 — whether the
   * provider permits enrolling a second factor at `aal1` or `aal2` — are marked "Needs spike" and the
   * spike cannot be run here, so this service does not rely on the provider to decide it. Refusing is the
   * safe direction: it cannot silently add a second way into a staff account, and it cannot be used to
   * replace somebody's authenticator with one the requester controls. Replacing a lost authenticator is
   * D9's recovery path, which the specification gates on O-1 tests 4 and 5.
   *
   * An unverified factor from an abandoned attempt is not an obstacle: it is left where it is and a fresh
   * one is created, because the provider holds both and only a verified one can ever satisfy a challenge.
   */
  async enrol(accessToken: string): Promise<TotpEnrolment> {
    const factors = await this.callerFactors(accessToken);
    if (factors.some((factor) => factor.verified)) throw new TotpAlreadyEnrolledError();

    try {
      return await this.provider.enrolTotpFactor(accessToken, {
        friendlyName: TOTP_FRIENDLY_NAME,
        issuer: TOTP_ISSUER,
      });
    } catch (error) {
      throw this.providerFailure(error);
    }
  }

  /**
   * Raises a challenge against the factor the caller is completing or already holds.
   *
   * One factor is chosen here rather than by the caller: a verified one when there is one, otherwise the
   * most recent unverified one, which is the enrolment in progress. A caller with no factor at all is
   * refused with {@link TotpNotEnrolledError} — their own state, which they can already see — rather than
   * with the generic refusal, because there is nothing for them to retry.
   */
  async challenge(accessToken: string): Promise<TotpChallenge> {
    const factors = await this.callerFactors(accessToken);
    const factor = factors.find((candidate) => candidate.verified) ?? factors.at(-1);
    if (factor === undefined) throw new TotpNotEnrolledError();

    try {
      const challengeId = await this.provider.challengeTotpFactor(accessToken, factor.id);
      return { factorId: factor.id, challengeId };
    } catch (error) {
      throw this.providerFailure(error);
    }
  }

  /**
   * Submits the code, and records a step-up grant when the challenge was raised for an operation.
   *
   * The order is deliberate. The provider verifies first, because nothing should be recorded about a code
   * that was wrong; the grant is written second, from the verification that just succeeded. A failure to
   * record the grant fails the request — unlike a security event, a grant *is* the authorisation, and
   * reporting success without one would tell the caller they may do something they may not.
   *
   * The session comes back whatever happens, because verification is what raises the caller's assurance
   * level; the grant is the extra authority for one named operation on top of it.
   */
  async verify(input: {
    accessToken: string;
    factorId: string;
    challengeId: string;
    code: string;
    operation: string | null;
  }): Promise<TotpVerification> {
    let session: SupabaseSession;
    try {
      session = await this.provider.verifyTotpFactor(input.accessToken, {
        factorId: input.factorId,
        challengeId: input.challengeId,
        code: input.code,
      });
    } catch (error) {
      throw this.providerFailure(error);
    }

    // The request now has a user (C-13, O8-12). Log correlation only; the raw UUID is never logged.
    recordLogIdentity(this.pseudonymous, session.userId);

    if (input.operation === null) return { session, grantId: null, grantExpiresAt: null };

    let granted: { outcome: string; grantId: string | null; expiresAt: Date | null };
    try {
      // 0042's writer. `granted_via = 'totp'` and the ten minutes are literals inside it: this call
      // supplies the account and the operation and can influence nothing else about the grant.
      granted = await this.store.issueTotpStepUpGrant({
        userId: session.userId,
        operation: input.operation,
      });
    } catch (error) {
      this.logger.error('Recording a TOTP step-up grant failed.');
      throw new AuthProviderUnavailableError(error);
    }

    if (granted.outcome !== 'granted' || granted.grantId === null) {
      // The code was right and the session is real, but the authorisation was not recorded. Saying so is
      // the only honest answer: a caller told "verified" would go on to attempt an operation that has
      // nothing behind it.
      this.logger.error('A TOTP verification produced no step-up grant.');
      throw new AuthProviderUnavailableError(new Error('the step-up grant was not recorded'));
    }

    return { session, grantId: granted.grantId, grantExpiresAt: granted.expiresAt };
  }

  /** The caller's TOTP factors, with a refused token kept distinct from an unreachable provider. */
  private async callerFactors(accessToken: string): ReturnType<SupabaseAuthClient['listTotpFactors']> {
    try {
      return await this.provider.listTotpFactors(accessToken);
    } catch (error) {
      throw this.providerFailure(error);
    }
  }

  /**
   * Keeps the four distinct outcomes distinct, and turns everything else into a 503.
   *
   * A refused session, a refused code and this project's own two state errors each already carry their
   * approved status. Anything else that went wrong is an outage, never a wrong code: rendering a provider
   * failure as "that code was not accepted" would have people retyping a correct code at a broken service.
   */
  private providerFailure(error: unknown): Error {
    if (error instanceof AuthenticationRequiredError) return error;
    if (error instanceof InvalidCredentialsError) return error;
    if (error instanceof TotpAlreadyEnrolledError) return error;
    if (error instanceof TotpNotEnrolledError) return error;
    if (error instanceof AuthProviderUnavailableError) return error;
    return new AuthProviderUnavailableError(error);
  }
}
