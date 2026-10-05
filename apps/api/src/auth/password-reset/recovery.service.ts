import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PseudonymousUserId } from '@repo/server-config';
import { PSEUDONYMOUS_USER_ID, recordLogIdentity } from '../../logging/log-identity.js';
import {
  AuthProviderUnavailableError,
  InvalidCredentialsError,
  LoginThrottledError,
  PasswordPolicyError,
} from '../auth-errors.js';
import { AUTH_EVENT, AuthSecurityEventsService } from '../auth-security-events.service.js';
import { OtpService, type OtpSendResult } from '../otp/otp.service.js';
import { OtpPepper } from '../otp/otp-digest.js';
import { OTP_PEPPER } from '../otp/otp.service.js';
import { WaabekClient } from '../otp/waabek.client.js';
import { hashClientIp, hashIdentifier, hashUserAgent } from '../subject-hash.js';
import { SUPABASE_AUTH_CLIENT } from '../login.service.js';
import type { SupabaseAuthClient } from '../supabase-auth.client.js';
import { PasswordResetService } from './password-reset.service.js';
import { generateResetToken, resetTokenDigest, type ResetToken } from './reset-token.js';

/** The database operations the recovery flow needs beyond C-18's own. */
export interface RecoveryStore {
  /** `app_private.password_reset_contact`: the account and the contact an OTP may go to, or null. */
  passwordResetContact(identifier: string): Promise<{ userId: string; phoneE164: string } | null>;
  /** `app_private.verified_contact_for_user`: where the post-reset notification goes, or null. */
  verifiedContactForUser(userId: string): Promise<string | null>;
  /** `app_private.verify_password_reset_otp`: verifies and issues the reset token in one transaction. */
  verifyPasswordResetOtp(input: {
    challengeId: string;
    codeHash: Buffer;
    tokenHash: Buffer;
  }): Promise<{ outcome: string; tokenId: string | null; expiresAt: Date | null }>;
  /** `app_private.password_reset_token_status`: a read that never consumes. */
  passwordResetTokenStatus(tokenHash: Buffer): Promise<{ status: string; userId: string | null }>;
  /** `app_private.rate_limit_hit`, the durable counter behind the approved OTP-send limits. */
  hit(bucket: string, subjectHash: Buffer, windowSeconds: number, limit: number): Promise<boolean>;
  /** `app_private.queue_whatsapp_otp`: one outbox row for the post-reset notification. */
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

export const RECOVERY_STORE = Symbol('RECOVERY_STORE');
export const WEB_PUBLIC_ORIGIN = Symbol('WEB_PUBLIC_ORIGIN');

/** The approved OTP purpose for this flow. Never the D10 `recovery` purpose. */
export const RECOVERY_OTP_PURPOSE = 'password_reset';

/** The approved template keys. The message text is composed from them and nothing else. */
export const RECOVERY_TEMPLATES = Object.freeze({
  otp: 'password_reset_otp',
  completed: 'password_reset_completed',
});

/** Default message locale for the two templates until a per-account locale exists. */
const TEMPLATE_LOCALE = 'en';

/**
 * The approved OTP-send limits, reused exactly (owner decision 5).
 *
 * These are the same numbers `app_private.issue_otp_challenge` enforces for a real destination. They are
 * applied here, keyed on the identifier, for requests that will *not* reach that function — an unknown
 * identifier or an account with no verified contact. Without that, five requests for a real account
 * would be throttled while five for an invented one would not, and the difference would answer the only
 * question this endpoint must never answer.
 */
const IDENTIFIER_LIMITS = Object.freeze([
  Object.freeze({ bucket: 'otp.send.destination.hour', windowSeconds: 3_600, limit: 5 }),
  Object.freeze({ bucket: 'otp.send.destination.day', windowSeconds: 86_400, limit: 10 }),
]);
const IP_LIMIT = Object.freeze({ bucket: 'otp.send.ip.hour', windowSeconds: 3_600, limit: 20 });

export interface RecoveryStartInput {
  readonly identifier: string;
  readonly requestIp: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

export interface RecoveryVerifyInput {
  readonly challengeId: string;
  readonly otp: string;
  readonly requestIp: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

export interface RecoveryResetInput {
  readonly resetToken: string;
  readonly newPassword: string;
  readonly requestIp: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

/** What the BFF receives from a verification. The token crosses exactly one server-to-server hop. */
export interface RecoveryVerification {
  readonly token: ResetToken;
  /** Built server-side from `WEB_PUBLIC_ORIGIN`; the BFF strips the token before the browser sees it. */
  readonly link: string;
  readonly expiresAt: Date;
}

/** Internal reason codes. They reach a security event or a log line, never a response. */
const REASON = Object.freeze({
  completed: 'password_reset_completed',
});

/**
 * The password-reset recovery flow (F3).
 *
 * Three steps, each with one job: `start` sends a code to a contact the account has already verified,
 * `verify` exchanges a correct code for a C-18 reset token, and `reset` changes the password and cuts
 * every existing session. No step creates a session, and none of them tells the caller anything about
 * an account it has not proved it controls.
 *
 * **Enumeration safety is a property of the code path, not of a response builder.** `start` does the
 * same work in the same order whether or not the account exists: it counts the request against the
 * approved limits either way, and answers with a challenge identifier of the same shape either way. The
 * only branch is whether a message is handed to the provider, which the caller cannot observe.
 *
 * **The clear reset token exists only between `verify` and the BFF.** It is generated in
 * {@link PasswordResetService}, wrapped so it redacts itself in every log, string and JSON context, and
 * handed back inside {@link RecoveryVerification}. Nothing else keeps it.
 */
@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    @Inject(RECOVERY_STORE) private readonly store: RecoveryStore,
    private readonly otp: OtpService,
    private readonly tokens: PasswordResetService,
    private readonly events: AuthSecurityEventsService,
    @Inject(SUPABASE_AUTH_CLIENT) private readonly provider: SupabaseAuthClient,
    @Inject(OTP_PEPPER) private readonly pepper: OtpPepper,
    private readonly waabek: WaabekClient,
    @Inject(WEB_PUBLIC_ORIGIN) private readonly webPublicOrigin: string,
    @Inject(PSEUDONYMOUS_USER_ID) private readonly pseudonymous: PseudonymousUserId,
  ) {}

  /**
   * Starts a reset.
   *
   * Returns a challenge identifier whatever happens. For an account with a verified contact it is the
   * real challenge; otherwise it is a fresh UUID that matches nothing, which fails verification exactly
   * as a wrong code does. The alternative — returning an id only when the account exists — would make
   * this endpoint an account oracle in one field.
   *
   * @throws LoginThrottledError when an approved OTP-send limit refuses the request.
   * @throws AuthProviderUnavailableError when the counters or the provider could not be reached.
   */
  async start(input: RecoveryStartInput): Promise<{ challengeId: string }> {
    const identifierHash = hashIdentifier(input.identifier);
    const ipHash = hashClientIp(input.requestIp);

    // Counted first and for every request, so the throttle cannot be used to tell the two paths apart.
    await this.countIpRequest(ipHash);

    const contact = await this.resolveContact(input.identifier);
    if (contact === null) {
      // The same limits, keyed on the identifier, so an unknown identifier is refused at the same point
      // a known one would be. Nothing else happens: no provider call, no row, no timing-visible work
      // that a real send would not also do.
      await this.countIdentifierRequest(identifierHash);
      return { challengeId: randomUUID() };
    }

    let sent: OtpSendResult;
    try {
      sent = await this.otp.sendWhatsAppOtp({
        purpose: RECOVERY_OTP_PURPOSE,
        toPhoneE164: contact.phoneE164,
        // The destination limits inside `issue_otp_challenge` are keyed on this digest.
        destinationHash: hashIdentifier(contact.phoneE164),
        templateName: RECOVERY_TEMPLATES.otp,
        templateLocale: TEMPLATE_LOCALE,
        userId: contact.userId,
        requestIp: input.requestIp,
        ipHash,
        composeMessage: (code) => recoveryOtpMessage(code),
      });
    } catch (error) {
      throw new AuthProviderUnavailableError(error);
    }

    if (sent.status === 'cooldown' || sent.status === 'rate_limited') {
      throw new LoginThrottledError(sent.status === 'cooldown' ? 'recovery_cooldown' : sent.status);
    }
    if (sent.status === 'delivery_failed') {
      throw new AuthProviderUnavailableError(new Error('recovery message was not delivered'));
    }
    return { challengeId: sent.challengeId };
  }

  /**
   * Verifies a submitted code and issues the reset token.
   *
   * Every failure — wrong code, unknown challenge, a challenge belonging to another flow, an expired one
   * or one whose attempts are spent — leaves here as the same error, because the caller must not learn
   * which. The database consumes the challenge and issues the token in one transaction, so a correct
   * code can produce exactly one token.
   */
  async verify(input: RecoveryVerifyInput): Promise<RecoveryVerification> {
    const token = generateResetToken();
    let result: { outcome: string; tokenId: string | null; expiresAt: Date | null };
    try {
      result = await this.store.verifyPasswordResetOtp({
        challengeId: input.challengeId,
        codeHash: this.pepper.digest(input.otp),
        tokenHash: token.digest(),
      });
    } catch (error) {
      this.logger.error('Verifying a recovery code failed.');
      throw new AuthProviderUnavailableError(error);
    }

    if (result.outcome !== 'verified' || result.expiresAt === null) {
      throw new InvalidCredentialsError();
    }

    return { token, link: this.resetLinkFor(token), expiresAt: result.expiresAt };
  }

  /**
   * Completes a reset, in the approved order.
   *
   *   1. the password is validated against D1 **before** anything else, so a password the policy refuses
   *      never costs the person their token;
   *   2. the token is checked without being consumed, which also resolves the account it is bound to;
   *   3. the password is set through the Supabase Auth Admin API;
   *   4. every existing session is revoked;
   *   5. only then is the token consumed, atomically, so a failure anywhere above leaves it usable;
   *   6. the security event is recorded and the notification is queued.
   *
   * No session is created at any point, and nothing here touches a second factor.
   */
  async reset(input: RecoveryResetInput): Promise<void> {
    // 1. Policy first. A rejected password must not spend the token.
    const policy = this.tokens.validateNewPassword(input.newPassword);
    if (!policy.valid) {
      throw new PasswordPolicyError(policy.issues);
    }

    // 2. A read, not a consumption: the approved ordering consumes only after the password is changed.
    const digest = digestOrNull(input.resetToken);
    if (digest === null) throw new InvalidCredentialsError();

    let status: { status: string; userId: string | null };
    try {
      status = await this.store.passwordResetTokenStatus(digest);
    } catch (error) {
      this.logger.error('Reading a reset token status failed.');
      throw new AuthProviderUnavailableError(error);
    }
    if (status.status !== 'valid' || status.userId === null) {
      // Invalid, expired, already used or bound to nobody: one error for all of them.
      throw new InvalidCredentialsError();
    }
    const userId = status.userId;

    // The request has now *proved* which account it acts for, by presenting a valid single-use reset
    // token (C-13, O8-12). Deliberately here and nowhere earlier in recovery: the start step merely
    // looks an identifier up, and naming the account there would make the server log disclose whether
    // an identifier matched — the one thing the neutral response exists to hide.
    recordLogIdentity(this.pseudonymous, userId);

    // 3 and 4. Both are provider calls, and neither failure may be reported as a completed reset. The
    // token is still unconsumed here, so a person whose reset failed halfway can simply try again.
    //
    // A revocation failure is as fatal as a password-update failure on purpose: a password changed
    // without the old sessions being cut is precisely the state an attacker holding a session wants.
    await this.callProvider(() => this.provider.updatePassword(userId, input.newPassword));
    await this.callProvider(() => this.provider.revokeAllSessions(userId));

    // 5. The single atomic consumption, bound to the account the token was issued for.
    const consumed = await this.tokens.consume({ token: input.resetToken, expectedUserId: userId });
    if (consumed.status !== 'consumed') {
      // Another request won the race. The password is already the new one, and saying more than "this
      // token is no longer usable" would describe a token that is not this caller's to know about.
      throw new InvalidCredentialsError();
    }

    // 6. Observability and courtesy, in that order. Neither may fail the reset that already happened.
    await this.events.record({
      eventType: AUTH_EVENT.passwordResetSuccess,
      userId,
      identifierHash: hashIdentifier(userId),
      ipHash: hashClientIp(input.requestIp),
      userAgentHash: hashUserAgent(input.userAgent),
      requestId: input.requestId,
      reasonCode: REASON.completed,
    });
    await this.notifyCompleted(userId);
  }

  /** Any provider failure is a 503, never a 500 and never a silently completed reset. */
  private async callProvider(call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      if (error instanceof AuthProviderUnavailableError) throw error;
      throw new AuthProviderUnavailableError(error);
    }
  }

  /** The reset link, built server-side. The origin never leaves the server in any response. */
  resetLinkFor(token: ResetToken): string {
    return `${this.webPublicOrigin}/auth/recovery?token=${encodeURIComponent(token.reveal())}`;
  }

  private async resolveContact(identifier: string): Promise<{ userId: string; phoneE164: string } | null> {
    try {
      return await this.store.passwordResetContact(identifier);
    } catch (error) {
      this.logger.error('Resolving a recovery contact failed.');
      throw new AuthProviderUnavailableError(error);
    }
  }

  private async countIpRequest(ipHash: Buffer | null): Promise<void> {
    if (ipHash === null) return;
    await this.enforce(IP_LIMIT.bucket, ipHash, IP_LIMIT.windowSeconds, IP_LIMIT.limit);
  }

  private async countIdentifierRequest(identifierHash: Buffer): Promise<void> {
    for (const limit of IDENTIFIER_LIMITS) {
      await this.enforce(limit.bucket, identifierHash, limit.windowSeconds, limit.limit);
    }
  }

  /** One counter. A counter that cannot answer refuses the request: never fail open (C-1's rule). */
  private async enforce(bucket: string, subject: Buffer, windowSeconds: number, limit: number): Promise<void> {
    let allowed: boolean;
    try {
      allowed = await this.store.hit(bucket, subject, windowSeconds, limit);
    } catch (error) {
      this.logger.error(`The ${bucket} counter could not be read; refusing the request.`);
      throw new AuthProviderUnavailableError(error);
    }
    if (!allowed) throw new LoginThrottledError(bucket);
  }

  /**
   * Queues and sends the post-reset notification.
   *
   * A side effect of a reset that has already happened: the password is changed, the sessions are cut
   * and the token is spent, so a provider outage here is logged and nothing more. The message carries
   * the approved template key and no variables at all — no password, no token, no digest.
   */
  private async notifyCompleted(userId: string): Promise<void> {
    try {
      const phone = await this.store.verifiedContactForUser(userId);
      if (phone === null) return;

      const outboxId = await this.store.queueWhatsAppMessage({
        toPhoneE164: phone,
        templateName: RECOVERY_TEMPLATES.completed,
        templateLocale: TEMPLATE_LOCALE,
        userId,
      });
      if (outboxId === null || !(await this.store.beginOtpDelivery(outboxId))) return;

      const outcome = await this.waabek.send(phone, passwordChangedMessage());
      await this.store.settleOtpDelivery({
        outboxId,
        status: outcome.status === 'sent' ? 'sent' : 'failed',
        providerMessageId: outcome.status === 'sent' ? outcome.providerMessageId : null,
        errorType: outcome.status === 'sent' ? null : outcome.errorType,
      });
    } catch {
      this.logger.error('The password-reset notification could not be sent; the reset itself stands.');
    }
  }
}

/** The message a person receives with their code. No link, no identifier, no account detail. */
export function recoveryOtpMessage(code: string): string {
  return `${code} is your password reset code. It expires in 10 minutes. If you did not ask for it, ignore this message.`;
}

/** The message a person receives after a completed reset. It carries nothing but the fact. */
export function passwordChangedMessage(): string {
  return 'Your password was changed. If this was not you, contact support immediately.';
}

/** A token of the wrong shape can only fail, and is never sent to the database. */
function digestOrNull(token: string): Buffer | null {
  try {
    return resetTokenDigest(token);
  } catch {
    return null;
  }
}
