import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateOtpCode } from './otp-code.js';
import { OtpPepper } from './otp-digest.js';
import { WaabekClient } from './waabek.client.js';

/** The database operations the OTP lifecycle needs, and nothing else. */
export interface OtpChallengeStore {
  issueOtpChallenge(input: IssueOtpInput): Promise<IssueOtpResult>;
  beginOtpDelivery(outboxId: string): Promise<boolean>;
  settleOtpDelivery(input: SettleOtpDeliveryInput): Promise<boolean>;
  verifyOtpChallenge(challengeId: string, codeHash: Buffer): Promise<OtpVerifyOutcome>;
}

export interface IssueOtpInput {
  readonly purpose: string;
  readonly channel: string;
  readonly destinationHash: Buffer;
  readonly codeHash: Buffer;
  readonly toPhoneE164: string;
  readonly templateName: string;
  readonly templateLocale: string;
  readonly userId: string | null;
  readonly requestIp: string | null;
  readonly ipHash: Buffer | null;
}

export type IssueOutcome =
  | 'issued'
  | 'cooldown'
  | 'rate_limited_destination_hour'
  | 'rate_limited_destination_day'
  | 'rate_limited_ip_hour';

export interface IssueOtpResult {
  readonly outcome: IssueOutcome;
  readonly challengeId: string | null;
  readonly outboxId: string | null;
  readonly sendCount: number | null;
  readonly retryAfterSeconds: number | null;
  readonly expiresAt: Date | null;
}

/**
 * How one OTP delivery attempt ends.
 *
 * `status` is narrowed to sent or failed on purpose. `settle_outbox_message` also accepts `queued`, but
 * requeueing an OTP message would leave a row that no later attempt could deliver: the clear code is
 * gone by then. Excluding it here means the mistake cannot be written.
 */
export interface SettleOtpDeliveryInput {
  readonly outboxId: string;
  readonly status: 'sent' | 'failed';
  readonly providerMessageId: string | null;
  readonly errorType: string | null;
}

export type OtpVerifyOutcome =
  | 'verified'
  | 'invalid'
  | 'expired'
  | 'consumed'
  | 'too_many_attempts'
  | 'not_found';

/** What the caller learns about an issuance. The code is never part of it. */
export type OtpSendResult =
  | { readonly status: 'sent'; readonly challengeId: string; readonly expiresAt: Date | null }
  | { readonly status: 'cooldown'; readonly retryAfterSeconds: number }
  | { readonly status: 'rate_limited'; readonly reason: IssueOutcome }
  | { readonly status: 'delivery_failed'; readonly challengeId: string };

export const OTP_CHALLENGE_STORE = Symbol('OTP_CHALLENGE_STORE');
export const OTP_PEPPER = Symbol('OTP_PEPPER');

/**
 * The OTP challenge lifecycle.
 *
 * This project owns the security of the OTP; Waabek only carries the message. So the code is generated
 * here, hashed here, and verified here, and the provider is never asked whether a code was correct.
 *
 * The clear code exists only inside {@link sendWhatsAppOtp}, as a local. It is never returned to the
 * caller, never logged, never written to the database, and never placed in a queue job — the latter two
 * are enforced independently by the `whatsapp_outbox` no-secret constraint and by the worker's
 * IDs-only job payload rule, which is why delivery happens in this call rather than in the worker.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @Inject(OTP_CHALLENGE_STORE) private readonly store: OtpChallengeStore,
    @Inject(OTP_PEPPER) private readonly pepper: OtpPepper,
    private readonly waabek: WaabekClient,
  ) {}

  /**
   * Issues or resends a WhatsApp OTP.
   *
   * The order matters: the challenge is recorded — which is where the cooldown and the 5/h, 10/day and
   * 20/h-per-IP limits are enforced — before the provider is contacted, so a caller cannot use the
   * provider as a way around the limits.
   */
  async sendWhatsAppOtp(request: SendWhatsAppOtpRequest): Promise<OtpSendResult> {
    const code = generateOtpCode();
    const issued = await this.store.issueOtpChallenge({
      purpose: request.purpose,
      channel: 'whatsapp',
      destinationHash: request.destinationHash,
      codeHash: this.pepper.digest(code),
      toPhoneE164: request.toPhoneE164,
      templateName: request.templateName,
      templateLocale: request.templateLocale,
      userId: request.userId ?? null,
      requestIp: request.requestIp ?? null,
      ipHash: request.ipHash ?? null,
    });

    if (issued.outcome === 'cooldown') {
      return { status: 'cooldown', retryAfterSeconds: issued.retryAfterSeconds ?? 0 };
    }
    if (issued.outcome !== 'issued') {
      return { status: 'rate_limited', reason: issued.outcome };
    }

    const { challengeId, outboxId } = issued;
    if (challengeId === null || outboxId === null) {
      throw new Error('An issued OTP challenge is missing its identifiers.');
    }

    // Someone else already picked this message up; do not send it twice.
    if (!(await this.store.beginOtpDelivery(outboxId))) {
      return { status: 'delivery_failed', challengeId };
    }

    const outcome = await this.waabek.send(request.toPhoneE164, request.composeMessage(code));

    if (outcome.status === 'sent') {
      await this.store.settleOtpDelivery({
        outboxId,
        status: 'sent',
        providerMessageId: outcome.providerMessageId,
        errorType: null,
      });
      return { status: 'sent', challengeId, expiresAt: issued.expiresAt };
    }

    // The send failed, and that is terminal for this message whatever the cause — 4xx, 5xx, 429, a
    // timeout or an unreachable provider all end here. The row is never returned to the queue: the clear
    // code is already gone, so a later relay attempt could only send the wrong thing or nothing at all.
    // The challenge itself is left intact and unconsumed, and the person asks for a new code through the
    // approved resend flow once the cooldown allows.
    await this.store.settleOtpDelivery({
      outboxId,
      status: 'failed',
      providerMessageId: null,
      errorType: outcome.errorType,
    });
    this.logger.warn('WhatsApp OTP delivery did not succeed; the challenge was not consumed.');
    return { status: 'delivery_failed', challengeId };
  }

  /**
   * Verifies a submitted code.
   *
   * The digest is computed here and the comparison, the attempt count and the single consumption all
   * happen inside one row-locked database call, so two concurrent submissions of the same correct code
   * cannot both succeed.
   */
  async verify(challengeId: string, code: string): Promise<OtpVerifyOutcome> {
    return await this.store.verifyOtpChallenge(challengeId, this.pepper.digest(code));
  }
}

export interface SendWhatsAppOtpRequest {
  readonly purpose: string;
  /** Already in the approved E.164 representation; this step defines no parsing rules. */
  readonly toPhoneE164: string;
  readonly destinationHash: Buffer;
  readonly templateName: string;
  readonly templateLocale: string;
  readonly userId?: string | null;
  readonly requestIp?: string | null;
  readonly ipHash?: Buffer | null;
  /** Builds the message body from the code. Supplied by the caller so no message text is assumed here. */
  readonly composeMessage: (code: string) => string;
}
