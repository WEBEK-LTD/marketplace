import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PseudonymousUserId } from '@repo/server-config';
import { PSEUDONYMOUS_USER_ID, recordLogIdentity } from '../logging/log-identity.js';
import {
  AuthProviderUnavailableError,
  InvalidCredentialsError,
  LoginThrottledError,
} from './auth-errors.js';
import { AUTH_EVENT, AuthSecurityEventsService } from './auth-security-events.service.js';
import { SUPABASE_AUTH_CLIENT } from './login.service.js';
import { OtpPepper } from './otp/otp-digest.js';
import { OTP_PEPPER, OtpService, type OtpSendResult } from './otp/otp.service.js';
import { hashClientIp, hashIdentifier, hashUserAgent } from './subject-hash.js';
import type { SupabaseAuthClient } from './supabase-auth.client.js';

/** The database operations registration needs, beyond what the OTP lifecycle already owns. */
export interface RegistrationStore {
  /**
   * `app_private.register_verify_contact` (0065): verifies a `phone_verify` code for an account that has
   * no session yet, and returns whose it was so the caller can confirm that account's contact.
   */
  registerVerifyContact(input: {
    challengeId: string;
    codeHash: Buffer;
  }): Promise<{ outcome: string; userId: string | null }>;
  /**
   * `app_private.register_resend_contact` (0065): resolves the account and number behind a registration
   * still in progress, so its code can be sent again. It resolves nothing for an account that has already
   * confirmed a contact, and it takes no phone, so a resend cannot be aimed.
   */
  registerResendContact(challengeId: string): Promise<{
    outcome: string;
    userId: string | null;
    toPhoneE164: string | null;
  }>;
}

export const REGISTRATION_STORE = Symbol('REGISTRATION_STORE');

/** The approved OTP purpose. An ordinary contact verification, not a login or a step-up. */
export const REGISTRATION_OTP_PURPOSE = 'phone_verify';

/** The approved template key. The message text is composed from it and nothing else. */
export const REGISTRATION_TEMPLATE = 'registration_phone_otp';

const TEMPLATE_LOCALE = 'en';

/**
 * What every step needs from the request.
 *
 * The IP alone, because the IP is what keys the per-IP send limit inside `issue_otp_challenge`. The two
 * further values the C-20 event payload carries are on {@link RegisterInput}, since registration is the
 * only step that writes one.
 */
export interface RegistrationRequestContext {
  readonly requestIp: string | null;
}

export interface RegisterInput extends RegistrationRequestContext {
  /** Already normalised by the contract: trimmed and lower-cased. */
  readonly email: string;
  readonly phone: string;
  readonly password: string;
  readonly displayName?: string | undefined;
  /** Hashed before it leaves this service, for the C-20 event payload. Never stored as given. */
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

/**
 * The verification step, which needs nothing from the request but what the person typed.
 *
 * Deliberately **not** extended from {@link RegistrationRequestContext}: verification consumes no send,
 * so there is no per-IP limit to key and no reason for this step to see the caller's address at all.
 */
export interface ResendRegistrationInput extends RegistrationRequestContext {
  readonly challengeId: string;
}

export interface VerifyRegistrationInput {
  readonly challengeId: string;
  readonly otp: string;
}

/**
 * The internal reason code on the registration event. It reaches that row and nothing else.
 *
 * `security_events` requires the shape `^[a-z][a-z0-9_]{0,63}$`, and a reason code is a short internal
 * token, never a message and never a value somebody typed.
 */
const REASON = Object.freeze({ created: 'registration_created' });

/** The message that carries the code to a new account's number. No address, no link, no account detail. */
export function registrationOtpMessage(code: string): string {
  return `${code} is your code to confirm this number and finish creating your account. It expires in 10 minutes. If you did not ask for it, ignore this message.`;
}

/**
 * Registration and contact verification (Phase 7-A).
 *
 * Two steps: an account with **no confirmed contact** plus a code to the phone, then — once that code
 * comes back — that account's phone is confirmed, which is what lets it sign in for the first time.
 *
 * Five properties are enforced here rather than left to a caller.
 *
 * **Nothing here is a second OTP mechanism.** The send, its limits, its cooldowns, its outbox row and its
 * delivery settlement are 0006's lifecycle through {@link OtpService.sendWhatsAppOtp}, used exactly as
 * the contact change and the password recovery use it. The purpose is `phone_verify`, which
 * `otp_challenges_purpose_allowed` has always permitted, and the only new database objects are the two
 * reads 0065 adds.
 *
 * **The phone is the contact, because this repository says so.** `app_private.verified_contact_for_user`
 * returns `auth.users.phone` and only when `phone_confirmed_at` is set; `password_reset_contact` refuses
 * an account without one; the only contact-change surface in the API is the phone pair. Registration
 * verifies the same contact over the same channel. The email is the sign-in identifier and is not
 * verified here — which is also why 7-A does not depend on the email delivery worker that 7-D adds.
 *
 * **An address that is already taken is indistinguishable from a new one.** This is F3's rule applied
 * unchanged. When the provider refuses the creation because the email or the phone already belongs to an
 * account, this service returns a challenge identifier that belongs to nothing — precisely what
 * `RecoveryService.start` returns for an identifier it cannot resolve. Verification then fails on that id
 * like any wrong code. No branch above this file can tell the two apart, and the approved response schema
 * has no field in which a difference could appear.
 *
 * **No session is created.** Not at registration and not at verification: the approved decision is VERIFY
 * FIRST, and a session handed out at either step would make that phrase untrue. The person signs in
 * afterwards through the existing login flow with the password they chose.
 *
 * **No new rate limit is defined.** Registration always goes through `issue_otp_challenge`, so it is
 * bounded by that function's own approved limits — 5/hour and 10/day per destination, 20/hour per IP, and
 * the 60/120/300 s resend cooldowns. This service adds no counter and no number of its own.
 *
 * **One security event, on one path.** A created account writes a single `auth.registration.success` row
 * through the existing C-20 writer — the eighth approved type, added to that one function by addition in
 * 0065, with no new table and no second telemetry path. It is written where the account is actually
 * created, and nowhere else: not for a submission that validated but created nothing, not for an address
 * that was already taken, not for a resend, not for a validation failure, and not again at verification.
 *
 * There is deliberately no registration failure type. A row that exists for a refused registration and
 * not for an accepted one is countable, and counting it would answer the question this whole flow answers
 * identically. F3 and F4 each declined a failure type for that reason; this declines it for the same one.
 * The refusal that *is* recorded is the login gate's, under the existing `auth.login.failure` with the
 * reason code `contact_unverified`, and 7-A leaves that exactly as it is.
 *
 * Recording is best effort, as C-20's writer has always been: a timeline that cannot be appended to must
 * not turn into a registration that cannot be completed. The account exists either way, and the person's
 * code is already on its way.
 */
@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    @Inject(REGISTRATION_STORE) private readonly store: RegistrationStore,
    private readonly otp: OtpService,
    private readonly events: AuthSecurityEventsService,
    @Inject(SUPABASE_AUTH_CLIENT) private readonly provider: SupabaseAuthClient,
    @Inject(OTP_PEPPER) private readonly pepper: OtpPepper,
    @Inject(PSEUDONYMOUS_USER_ID) private readonly pseudonymous: PseudonymousUserId,
  ) {}

  /**
   * Creates the account and sends the code.
   *
   * The order matters. The account is created first, because a code has to belong to an account for the
   * verification step to have anything to confirm. When creation is refused because the address is taken,
   * no code is sent — sending one would deliver a code to a number the requester may not hold — and the
   * response is synthesised instead. That is the one place the two paths do different work, and it is not
   * observable: both answer with a challenge identifier of the same shape, and both are bounded by the
   * same per-IP limits, since a request that reaches the OTP path counts against them and a request that
   * does not reach it consumes no send at all.
   *
   * @throws LoginThrottledError when an approved OTP-send limit or resend cooldown refuses the request.
   * @throws AuthProviderUnavailableError when the account could not be created or the code not delivered.
   */
  async register(input: RegisterInput): Promise<{ challengeId: string }> {
    let userId: string | null;
    try {
      userId = await this.provider.createUnconfirmedUser({
        email: input.email,
        phone: input.phone,
        password: input.password,
        // Carried through to `user_metadata.display_name`, which 0005's trigger already reads when it
        // creates the person's profile row. 7-A writes no profile itself.
        displayName: input.displayName,
      });
    } catch (error) {
      throw error instanceof AuthProviderUnavailableError
        ? error
        : new AuthProviderUnavailableError(error);
    }

    if (userId === null) {
      // The email or the phone is already taken. Nothing was created and nothing is sent. The answer is a
      // challenge identifier that matches nothing, exactly as RecoveryService.start answers an identifier
      // it cannot resolve; the person who really owns that address is not messaged, and the person who
      // asked learns nothing.
      return { challengeId: randomUUID() };
    }

    let sent: OtpSendResult;
    try {
      sent = await this.otp.sendWhatsAppOtp({
        purpose: REGISTRATION_OTP_PURPOSE,
        toPhoneE164: input.phone,
        // The destination limits inside `issue_otp_challenge` are keyed on this digest.
        destinationHash: hashIdentifier(input.phone),
        templateName: REGISTRATION_TEMPLATE,
        templateLocale: TEMPLATE_LOCALE,
        userId,
        requestIp: input.requestIp,
        ipHash: hashClientIp(input.requestIp),
        composeMessage: (code) => registrationOtpMessage(code),
      });
    } catch (error) {
      throw new AuthProviderUnavailableError(error);
    }

    if (sent.status === 'cooldown' || sent.status === 'rate_limited') {
      // The same error class the recovery start raises for the same limits, so both render the one 429
      // the approved contract documents.
      throw new LoginThrottledError(
        sent.status === 'cooldown' ? 'registration_cooldown' : sent.status,
      );
    }
    if (sent.status === 'delivery_failed') {
      throw new AuthProviderUnavailableError(new Error('the registration code was not delivered'));
    }

    // One event, for one created account (C-20). Written last, so it records a registration that actually
    // got as far as a code being sent, and written only here — the path above that found the address taken
    // returned before reaching this line, which is what keeps the row from being countable.
    //
    // Everything in it is already pseudonymous: the email arrives as a sha256 digest and the address
    // itself never leaves this method, the IP and user agent likewise. There is no parameter on the writer
    // for a password, a code, a digest of a code or a token, so none can be here.
    await this.events.record({
      eventType: AUTH_EVENT.registrationSuccess,
      userId,
      identifierHash: hashIdentifier(input.email),
      ipHash: hashClientIp(input.requestIp),
      userAgentHash: hashUserAgent(input.userAgent),
      requestId: input.requestId,
      reasonCode: REASON.created,
    });

    return { challengeId: sent.challengeId };
  }

  /**
   * Sends the code again for a registration still in progress.
   *
   * A code that never arrives is the ordinary case, and this is how a person recovers from it without
   * starting over — re-submitting the registration form would find the address taken, which by design
   * tells them nothing and sends nothing.
   *
   * The destination is not a parameter anywhere in this path: 0065 resolves it from the account, and only
   * for an account whose email and phone are both unconfirmed. So this cannot send a message to a number
   * of the caller's choosing, and cannot reach anybody who has finished registering.
   *
   * A fresh challenge replaces the old one, which is why the identifier comes back: the BFF puts it in the
   * cookie it already owns. The old challenge is left unconsumed and simply expires.
   *
   * @throws InvalidCredentialsError when the challenge resolves nothing — the same answer a wrong code
   * earns, so this route discloses no more than that one does.
   * @throws LoginThrottledError when the approved cooldown or send limits refuse it. Asking again too soon
   * is refused by the same numbers a first send is refused by; nothing here defines a limit.
   */
  async resend(input: ResendRegistrationInput): Promise<{ challengeId: string }> {
    let resolved: { outcome: string; userId: string | null; toPhoneE164: string | null };
    try {
      resolved = await this.store.registerResendContact(input.challengeId);
    } catch (error) {
      this.logger.error('Resolving a registration resend failed.');
      throw new AuthProviderUnavailableError(error);
    }

    if (resolved.outcome !== 'resend' || resolved.userId === null || resolved.toPhoneE164 === null) {
      throw new InvalidCredentialsError();
    }

    const phone = resolved.toPhoneE164;
    let sent: OtpSendResult;
    try {
      sent = await this.otp.sendWhatsAppOtp({
        purpose: REGISTRATION_OTP_PURPOSE,
        toPhoneE164: phone,
        destinationHash: hashIdentifier(phone),
        templateName: REGISTRATION_TEMPLATE,
        templateLocale: TEMPLATE_LOCALE,
        userId: resolved.userId,
        requestIp: input.requestIp,
        ipHash: hashClientIp(input.requestIp),
        composeMessage: (code) => registrationOtpMessage(code),
      });
    } catch (error) {
      throw new AuthProviderUnavailableError(error);
    }

    if (sent.status === 'cooldown' || sent.status === 'rate_limited') {
      throw new LoginThrottledError(
        sent.status === 'cooldown' ? 'registration_cooldown' : sent.status,
      );
    }
    if (sent.status === 'delivery_failed') {
      throw new AuthProviderUnavailableError(new Error('the registration code was not delivered'));
    }

    return { challengeId: sent.challengeId };
  }

  /**
   * Verifies the code and confirms the account's phone.
   *
   * Every refusal leaves here as the same error: a wrong code, an expired one, a spent one, an exhausted
   * one, a challenge issued for another purpose, a challenge with no account, and a challenge identifier
   * that belongs to nothing — which is what the synthetic identifier from a taken address produces. A
   * caller cannot tell which happened, and so cannot use this step to discover that an address was
   * already registered.
   *
   * @throws InvalidCredentialsError for every unsuccessful verification, whatever its cause.
   */
  async verify(input: VerifyRegistrationInput): Promise<void> {
    let result: { outcome: string; userId: string | null };
    try {
      result = await this.store.registerVerifyContact({
        challengeId: input.challengeId,
        codeHash: this.pepper.digest(input.otp),
      });
    } catch (error) {
      this.logger.error('Verifying a registration code failed.');
      throw new AuthProviderUnavailableError(error);
    }

    if (result.outcome !== 'verified' || result.userId === null) {
      throw new InvalidCredentialsError();
    }

    // The request now has a user (C-13, O8-12). Log correlation only; the raw UUID is never logged.
    recordLogIdentity(this.pseudonymous, result.userId);

    // The provider is told the outcome of a verification this project performed itself — the code was
    // generated, hashed and checked here, and the provider was never asked whether it was correct. Until
    // this call succeeds the account still has no confirmed contact, so the login gate keeps refusing it:
    // a failure here leaves the account unable to sign in rather than able to, which is the right way
    // round. The number is not re-sent, so this cannot change which number the account holds.
    try {
      await this.provider.confirmPhone(result.userId);
    } catch (error) {
      throw error instanceof AuthProviderUnavailableError
        ? error
        : new AuthProviderUnavailableError(error);
    }
  }
}
