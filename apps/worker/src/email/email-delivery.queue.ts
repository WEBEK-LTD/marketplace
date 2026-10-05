import { z } from 'zod';
import type { WorkerLogger } from '../logging/logger.js';
import { errorSummary } from '../logging/logger.js';
import type { QueueDefinition } from '../queue/definitions.js';
import type { IdPayload } from '../queue/payload.js';
import { backoffDelay, MAX_ATTEMPTS } from '../queue/policy.js';
import type { EmailOutboxStore } from './email-outbox.store.js';
import { isErrorType, type EmailMessage, type EmailTransport } from './email-transport.js';

/**
 * The email outbox relay (Phase 7-D).
 *
 * v5.2 names the worker's background path "Outbox relay → BullMQ → worker handlers" and lists "outbox
 * relay, sweeper, repeatable jobs" among its approved responsibilities. This is the first of those: a
 * repeatable job that claims a batch of queued email, hands each message to the provider-neutral
 * transport port, and records the outcome. It is the first entry in `QUEUE_DEFINITIONS`, which until
 * now was empty because "business queues are added in later phases".
 *
 * **The claim and the send happen in the same job execution**, which is the shape the one existing
 * delivery path in this repository already uses (`OtpService`: begin delivery, send, settle, in one
 * call). Claiming in one job and sending in another would leave a window in which a row sits in
 * `'sending'` with nothing on its way to finish it, and no reclaim window for `'sending'` rows is
 * defined anywhere in this repository — see the delivery report for that gap, which 7-D reports rather
 * than papers over with an invented timeout.
 *
 * **Nothing here composes an email.** 0008's `queue_email` stored the finished subject, HTML and text,
 * and 0029's `attach_notification_email` decided the message deserved to exist and honoured the user's
 * `notify_email` setting before it did. `public.email_templates` holds no rows, so there is no template
 * to resolve and this relay resolves none: it is transport, and inventing copy here would be inventing
 * product language nobody approved.
 *
 * **What is never logged**: the recipient address, the recipient's user id, the subject, either body,
 * and any provider error text. A relay batch spans many people, so there is no single log identity for
 * the job, and the lines it writes carry counts and coarse error types only.
 */

/** Queue name. Lower-case and hyphenated, per `assertQueueName`. */
export const EMAIL_DELIVERY_QUEUE = 'email-delivery';

/** The repeatable job's name and the scheduler key that owns it. */
export const EMAIL_RELAY_JOB = 'relay';
export const EMAIL_RELAY_SCHEDULER_ID = 'email-relay';

/**
 * The relay's own identity.
 *
 * Job payloads are IDs only — `assertIdPayload` admits a non-empty flat object of `<name>Id` keys with
 * UUID values and nothing else — and a relay tick is not a business entity with an id of its own. This
 * constant names the relay rather than any message, person or batch, and it is deliberately **not**
 * called `userId`: the runtime reads that key to scope log identity, and a batch belongs to no one
 * person.
 */
export const EMAIL_RELAY_ID = '7d000000-0000-4000-8000-000000000001';
export const EMAIL_RELAY_PAYLOAD: IdPayload = Object.freeze({ relayId: EMAIL_RELAY_ID });

/**
 * How many messages one tick claims.
 *
 * 0008's own default for `claim_outbox_messages`, not a number chosen here. The function refuses
 * anything outside 1–500.
 */
export const EMAIL_RELAY_BATCH_SIZE = 50;

/** Recorded when a claimed row's payload is not the shape 0008 builds. Terminal: see {@link EmailDeliveryQueue}. */
export const MALFORMED_PAYLOAD_ERROR_TYPE = 'malformed_outbox_payload';

/** Recorded when an adapter returns an error type the database's own constraint would refuse. */
export const UNCLASSIFIED_ERROR_TYPE = 'provider_error_unclassified';

/**
 * The payload `claim_outbox_messages` builds for the email channel.
 *
 * Every field is `not null` in `email_outbox` except the last two, so a row that fails this parse is a
 * row the schema should not have been able to hold.
 */
const ClaimedEmailPayload = z
  .object({
    subject: z.string().min(1),
    body_html: z.string(),
    body_text: z.string(),
    template_key: z.string().nullable().default(null),
    locale_code: z.string().nullable().default(null),
  })
  .strip();

export interface EmailRelayResult {
  readonly claimed: number;
  readonly sent: number;
  readonly requeued: number;
  readonly failed: number;
  /** Rows a concurrent settle had already finished. */
  readonly unsettled: number;
}

export class EmailDeliveryQueue implements QueueDefinition {
  readonly name = EMAIL_DELIVERY_QUEUE;

  readonly schedule: { readonly jobName: string; readonly schedulerId: string; readonly everyMs: number; readonly data: IdPayload };

  constructor(
    private readonly store: EmailOutboxStore,
    private readonly transport: EmailTransport,
    private readonly logger: WorkerLogger,
    intervalMs: number,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {
    this.schedule = {
      jobName: EMAIL_RELAY_JOB,
      schedulerId: EMAIL_RELAY_SCHEDULER_ID,
      everyMs: intervalMs,
      data: EMAIL_RELAY_PAYLOAD,
    };
  }

  async process(): Promise<void> {
    await this.drain();
  }

  /**
   * One tick.
   *
   * A store error propagates: the batch may be half-settled, the job fails, and BullMQ retries it under
   * the policy in `queue/policy.ts`. That is the right outcome — an unreachable database is a condition
   * of the tick, not of any one message — and it does not double-count a message's own attempts,
   * because a message's attempts are counted by the claim and by nothing else.
   */
  async drain(): Promise<EmailRelayResult> {
    const claimed = await this.store.claimEmailBatch(EMAIL_RELAY_BATCH_SIZE);
    let sent = 0;
    let requeued = 0;
    let failed = 0;
    let unsettled = 0;

    for (const row of claimed) {
      const outcome = await this.deliver(row.id, row.destination, row.payload, row.attempts);
      if (!outcome.settled) unsettled += 1;
      else if (outcome.status === 'sent') sent += 1;
      else if (outcome.status === 'queued') requeued += 1;
      else failed += 1;
    }

    if (claimed.length > 0) {
      // Counts and the adapter's name only. No address, no subject, no body, no person.
      this.logger.info(
        { event: 'email_relay_tick', transport: this.transport.name, claimed: claimed.length, sent, requeued, failed, unsettled },
        'Email outbox relay tick',
      );
    }
    return { claimed: claimed.length, sent, requeued, failed, unsettled };
  }

  /**
   * One message.
   *
   * The retry decision is the only judgement in this file, and both halves of it come from the
   * repository rather than from here:
   *
   * * **Eligibility** is `settle_outbox_message`'s `'queued'` settlement with `p_retry_at`, which puts
   *   the row back with `available_at` in the future — the claim takes only rows whose `available_at`
   *   has passed. The adapter says whether the failure was transient; a permanent rejection is never
   *   requeued.
   * * **The schedule and the give-up point** are `queue/policy.ts`: `MAX_ATTEMPTS` and `backoffDelay`,
   *   the same jittered exponential curve every job in this worker already retries on. `attempts`
   *   arrives from the claim already counting this attempt, which is exactly what `backoffDelay`'s
   *   `attemptsMade` means.
   *
   * Only one of the two mechanisms counts a message's attempts. BullMQ's counter governs the **tick**;
   * `email_outbox.attempts` governs the **message**. Running both over one message would give it
   * twenty-five attempts instead of five.
   *
   * A row whose payload will not parse is terminal, not transient: retrying it would produce the same
   * unparseable row every time until the cap, and `'failed'` with `failed_at` and a coarse error type
   * is how this schema already represents a message that will not be delivered.
   */
  private async deliver(
    id: string,
    destination: string,
    payload: unknown,
    attempts: number,
  ): Promise<{ readonly settled: boolean; readonly status: 'sent' | 'failed' | 'queued' }> {
    const parsed = ClaimedEmailPayload.safeParse(payload);
    if (!parsed.success) {
      this.logger.warn({ event: 'email_relay_payload_rejected', errorType: MALFORMED_PAYLOAD_ERROR_TYPE }, 'Claimed email row is not deliverable');
      return {
        settled: await this.store.settleEmailMessage({ id, status: 'failed', providerMessageId: null, errorType: MALFORMED_PAYLOAD_ERROR_TYPE, retryAt: null }),
        status: 'failed',
      };
    }

    const message: EmailMessage = {
      to: destination,
      subject: parsed.data.subject,
      bodyHtml: parsed.data.body_html,
      bodyText: parsed.data.body_text,
      templateKey: parsed.data.template_key,
      localeCode: parsed.data.locale_code,
    };

    let outcome;
    try {
      outcome = await this.transport.send(message);
    } catch (error) {
      // An adapter that throws is an adapter misbehaving, and the message must not be abandoned in
      // 'sending'. Treated as a transient failure so the ordinary cap decides when to give up.
      // errorSummary yields a class name, never the message text.
      outcome = { status: 'failed' as const, errorType: errorSummary(error).errorType, retryable: true };
    }

    if (outcome.status === 'sent') {
      return {
        settled: await this.store.settleEmailMessage({ id, status: 'sent', providerMessageId: outcome.providerMessageId, errorType: null, retryAt: null }),
        status: 'sent',
      };
    }

    const errorType = isErrorType(outcome.errorType) ? outcome.errorType : UNCLASSIFIED_ERROR_TYPE;
    if (outcome.retryable && attempts < MAX_ATTEMPTS) {
      const retryAt = new Date(this.now().getTime() + backoffDelay(attempts, this.random));
      return {
        settled: await this.store.settleEmailMessage({ id, status: 'queued', providerMessageId: null, errorType, retryAt }),
        status: 'queued',
      };
    }
    return {
      settled: await this.store.settleEmailMessage({ id, status: 'failed', providerMessageId: null, errorType, retryAt: null }),
      status: 'failed',
    };
  }
}
