import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PseudonymousUserId } from '@repo/server-config';
import { PSEUDONYMOUS_USER_ID, recordLogIdentity } from '../logging/log-identity.js';
import {
  AuthProviderUnavailableError,
  AuthenticationRequiredError,
  ContactChangeThrottledError,
  InvalidCredentialsError,
} from '../auth/auth-errors.js';
import { AUTH_EVENT, AuthSecurityEventsService } from '../auth/auth-security-events.service.js';
import { SUPABASE_AUTH_CLIENT } from '../auth/login.service.js';
import { OtpPepper } from '../auth/otp/otp-digest.js';
import { OTP_PEPPER, OtpService, type OtpSendResult } from '../auth/otp/otp.service.js';
import { WaabekClient } from '../auth/otp/waabek.client.js';
import { hashClientIp, hashIdentifier, hashUserAgent } from '../auth/subject-hash.js';
import type { SupabaseAuthClient } from '../auth/supabase-auth.client.js';

/** The database operations the contact change needs, beyond what the OTP lifecycle already owns. */
export interface ContactChangeStore {
  /** `app_private.verify_contact_change_otp`: verifies a phone_verify code that belongs to this account. */
  verifyContactChangeOtp(input: {
    challengeId: string;
    codeHash: Buffer;
    userId: string;
  }): Promise<{ outcome: string; newPhoneE164: string | null }>;
  /** `app_private.verified_contact_for_user`: the number to notify **before** it is replaced. */
  verifiedContactForUser(userId: string): Promise<string | null>;
  /** `app_private.queue_whatsapp_otp`: one outbox row for the post-change notification. */
  queueWhatsAppMessage(input: {
    toPhoneE164: string;
    templateName: string;
    templateLocale: string;
    userId: string | null;
  }): Promise<string | null>;
  beginOtpDelivery(outboxId: string): Promise<boolean>;
  settleOtpDelivery(input: {
    outboxId: string;
    status: 'sent' | 'failed';
    providerMessageId: string | null;
    errorType: string | null;
  }): Promise<boolean>;
}

export const CONTACT_CHANGE_STORE = Symbol('CONTACT_CHANGE_STORE');

/** The approved OTP purpose. An ordinary contact verification, not a login or a step-up. */
export const CONTACT_CHANGE_OTP_PURPOSE = 'phone_verify';

/** The approved template keys. The message text is composed from them and nothing else. */
export const CONTACT_CHANGE_TEMPLATES = Object.freeze({
  otp: 'contact_change_phone_otp',
  completed: 'contact_change_phone_completed',
});

const TEMPLATE_LOCALE = 'en';

/** Internal reason code. It reaches the security event and nothing else. */
const REASON = Object.freeze({ completed: 'contact_change_completed' });

export interface ContactChangeRequestContext {
  readonly accessToken: string;
  readonly requestIp: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

export interface StartPhoneChangeInput extends ContactChangeRequestContext {
  readonly phone: string;
}

export interface VerifyPhoneChangeInput extends ContactChangeRequestContext {
  readonly challengeId: string;
  readonly otp: string;
}

/**
 * The phone contact change (F4).
 *
 * Two steps: a code to the new number, then — once that code comes back — the number becomes the
 * account's confirmed phone through the provider's Admin API, the previous number is told, and a
 * security event is written.
 *
 * Four properties are enforced here rather than left to a caller.
 *
 * **The account is never named by the request.** Both steps resolve it from the caller's own access
 * token through the provider, so a request cannot address someone else's account. There is no user
 * field in either schema for one to arrive in.
 *
 * **The challenge is bound to that account.** `app_private.verify_contact_change_otp` refuses a
 * challenge belonging to another account or issued for another purpose, and reports both as "not found"
 * so a caller learns nothing about challenges that are not theirs.
 *
 * **No session is created and none is revoked.** A contact change is not an authentication event: the
 * approved decision leaves existing sessions alone, so nothing in this file touches a cookie, a token or
 * the provider's session endpoints.
 *
 * **The old number is captured before the change.** It is read while it is still the account's phone,
 * so the notification can reach it afterwards; the person's previous contact is told what happened, and
 * the message carries nothing but that fact.
 */
@Injectable()
export class ContactChangeService {
  private readonly logger = new Logger(ContactChangeService.name);

  constructor(
    @Inject(CONTACT_CHANGE_STORE) private readonly store: ContactChangeStore,
    private readonly otp: OtpService,
    private readonly events: AuthSecurityEventsService,
    @Inject(SUPABASE_AUTH_CLIENT) private readonly provider: SupabaseAuthClient,
    @Inject(OTP_PEPPER) private readonly pepper: OtpPepper,
    private readonly waabek: WaabekClient,
    @Inject(PSEUDONYMOUS_USER_ID) private readonly pseudonymous: PseudonymousUserId,
  ) {}

  /**
   * Sends a code to the new number.
   *
   * The approved OTP-send limits and resend cooldowns are the ones `app_private.issue_otp_challenge`
   * already enforces — 5/hour and 10/day per destination, 20/hour per IP, 60/120/300 s between sends —
   * so this step neither defines nor relaxes a limit. A counter that cannot answer refuses the request.
   *
   * @returns the challenge identifier, for the BFF to hand to the second step.
   */
  async start(input: StartPhoneChangeInput): Promise<{ challengeId: string }> {
    const user = await this.callerOf(input.accessToken);

    let sent: OtpSendResult;
    try {
      sent = await this.otp.sendWhatsAppOtp({
        purpose: CONTACT_CHANGE_OTP_PURPOSE,
        toPhoneE164: input.phone,
        // The destination limits inside `issue_otp_challenge` are keyed on this digest, and the
        // verification later matches the outbox row by the same digest.
        destinationHash: hashIdentifier(input.phone),
        templateName: CONTACT_CHANGE_TEMPLATES.otp,
        templateLocale: TEMPLATE_LOCALE,
        userId: user.id,
        requestIp: input.requestIp,
        ipHash: hashClientIp(input.requestIp),
        composeMessage: (code) => contactChangeOtpMessage(code),
      });
    } catch (error) {
      throw new AuthProviderUnavailableError(error);
    }

    if (sent.status === 'cooldown' || sent.status === 'rate_limited') {
      throw new ContactChangeThrottledError(sent.status === 'cooldown' ? 'contact_change_cooldown' : sent.status);
    }
    if (sent.status === 'delivery_failed') {
      throw new AuthProviderUnavailableError(new Error('the contact-change code was not delivered'));
    }
    return { challengeId: sent.challengeId };
  }

  /**
   * Verifies the code and makes the new number the account's phone.
   *
   * The order is deliberate: the old number is read **before** the provider is updated, because after
   * the update it is no longer the account's phone and could not be notified.
   */
  async verify(input: VerifyPhoneChangeInput): Promise<void> {
    const user = await this.callerOf(input.accessToken);

    let result: { outcome: string; newPhoneE164: string | null };
    try {
      result = await this.store.verifyContactChangeOtp({
        challengeId: input.challengeId,
        codeHash: this.pepper.digest(input.otp),
        userId: user.id,
      });
    } catch (error) {
      this.logger.error('Verifying a contact-change code failed.');
      throw new AuthProviderUnavailableError(error);
    }

    if (result.outcome !== 'verified' || result.newPhoneE164 === null) {
      // A wrong code, an expired one, a spent one, a challenge of another purpose and a challenge
      // belonging to someone else all leave here the same way.
      throw new InvalidCredentialsError();
    }

    // Read while it is still the account's number.
    const previousPhone = await this.previousPhone(user.id);

    await this.callProvider(() => this.provider.updatePhone(user.id, result.newPhoneE164 as string));

    // Observability and courtesy, after the change that already happened. Neither may undo it.
    await this.events.record({
      eventType: AUTH_EVENT.contactChangeSuccess,
      userId: user.id,
      identifierHash: hashIdentifier(user.id),
      ipHash: hashClientIp(input.requestIp),
      userAgentHash: hashUserAgent(input.userAgent),
      requestId: input.requestId,
      reasonCode: REASON.completed,
    });
    await this.notifyPreviousContact(user.id, previousPhone);
  }

  /**
   * Whose request this is, according to the provider.
   *
   * A refused token is a 401 and says only that a session is needed; anything else that goes wrong while
   * asking is a 503, never a 500 and never a silently anonymous request.
   */
  private async callerOf(accessToken: string): Promise<{ id: string; phone: string | null }> {
    try {
      const user = await this.provider.getUser(accessToken);
      // Both steps come through here, so this is the one place the request learns who is calling
      // (C-13, O8-12). Log correlation only: no behaviour, no ordering and no response changes, and
      // the raw UUID is never logged.
      recordLogIdentity(this.pseudonymous, user.id);
      return user;
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) throw error;
      if (error instanceof AuthProviderUnavailableError) throw error;
      throw new AuthProviderUnavailableError(error);
    }
  }

  /** The number the account held before this change, or null when it had none to notify. */
  private async previousPhone(userId: string): Promise<string | null> {
    try {
      return await this.store.verifiedContactForUser(userId);
    } catch {
      // Not being able to read the old number is not a reason to refuse a verified change; the
      // notification is a side effect, and the change itself is what the person asked for.
      this.logger.error('The previous contact could not be read; the change still stands.');
      return null;
    }
  }

  /** Any provider failure is a 503, never a 500 and never a silently completed change. */
  private async callProvider(call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      if (error instanceof AuthProviderUnavailableError) throw error;
      throw new AuthProviderUnavailableError(error);
    }
  }

  /**
   * Tells the previous number that the account's phone was changed.
   *
   * A side effect of a change that has already happened: the provider has the new number and the code is
   * spent, so a delivery failure is logged and nothing more. The message carries the approved template
   * key and no variables — no code, no token, no number.
   */
  private async notifyPreviousContact(userId: string, previousPhone: string | null): Promise<void> {
    if (previousPhone === null) return;
    try {
      const outboxId = await this.store.queueWhatsAppMessage({
        toPhoneE164: previousPhone,
        templateName: CONTACT_CHANGE_TEMPLATES.completed,
        templateLocale: TEMPLATE_LOCALE,
        userId,
      });
      if (outboxId === null || !(await this.store.beginOtpDelivery(outboxId))) return;

      const outcome = await this.waabek.send(previousPhone, phoneChangedMessage());
      await this.store.settleOtpDelivery({
        outboxId,
        status: outcome.status === 'sent' ? 'sent' : 'failed',
        providerMessageId: outcome.status === 'sent' ? outcome.providerMessageId : null,
        errorType: outcome.status === 'sent' ? null : outcome.errorType,
      });
    } catch {
      this.logger.error('The contact-change notification could not be sent; the change itself stands.');
    }
  }
}

/** The message that carries the code to the new number. No account detail, no link. */
export function contactChangeOtpMessage(code: string): string {
  return `${code} is your code to confirm this number. It expires in 10 minutes. If you did not ask for it, ignore this message.`;
}

/** The message the previous number receives. It carries nothing but the fact. */
export function phoneChangedMessage(): string {
  return 'The phone number on your account was changed. If this was not you, contact support immediately.';
}
