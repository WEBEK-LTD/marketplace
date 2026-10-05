/**
 * The provider-neutral email delivery port (Phase 7-D).
 *
 * This is the whole boundary between this project and whatever eventually carries an email. It is
 * deliberately tiny and deliberately transport-shaped: it takes an already-rendered message and reports
 * how one attempt ended. It cannot be asked to compose, translate, template or address anything,
 * because none of those are delivery concerns and all of them already happened upstream — 0008's
 * `queue_email` stores the finished subject and bodies, and 0029's `attach_notification_email` is what
 * decides that a notification deserves an email at all.
 *
 * **No provider is chosen here.** v5.2 records the email provider as "SMTP-compatible provider behind a
 * mail adapter — Provider pending (value)", so this increment ships the port and no adapter. There is
 * no base URL, no API key, no SMTP credential and no environment variable for one anywhere in 7-D: the
 * strongest form of credential isolation is having no credential to isolate. When the provider decision
 * lands, its adapter implements this interface and brings its own configuration with it.
 *
 * The shape follows the one delivery adapter this repository already has — `WaabekClient` in the API,
 * whose outcome is `sent` with an optional provider message id or `failed` with a coarse error type.
 */

/** One rendered email, exactly as 0008 stored it. Nothing here is composed by the worker. */
export interface EmailMessage {
  /** The recipient address, already validated by `email_outbox_address_shape`. */
  readonly to: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodyText: string;
  /** Provenance, for adapters that can tag a send. Never used to look copy up: 0008 already rendered it. */
  readonly templateKey: string | null;
  readonly localeCode: string | null;
}

/**
 * How one delivery attempt ended.
 *
 * `errorType` is an **error class name, never provider text**: `email_outbox.last_error_type` is
 * constrained to `^[A-Za-z][A-Za-z0-9_]*$` and its column comment says "Error class name only; provider
 * error messages are never stored." {@link isErrorType} is the guard that keeps an adapter from
 * violating that from the outside.
 *
 * `retryable` exists here and deliberately does **not** exist on `WaabekOutcome`. That asymmetry is the
 * database's, not a preference: a WhatsApp OTP cannot be retried because the clear code is gone once the
 * attempt returns, while an email's subject and bodies are columns of `email_outbox` and survive. So
 * `settle_outbox_message`'s `'queued'` settlement — the repository's representation of retry
 * eligibility — is reachable for this channel and unreachable for that one. The adapter says whether
 * the failure was transient; how many times and how long to wait is not its business and is not its
 * decision (see `queue/policy.ts`).
 */
export type EmailDeliveryOutcome =
  | { readonly status: 'sent'; readonly providerMessageId: string | null }
  | { readonly status: 'failed'; readonly errorType: string; readonly retryable: boolean };

/** The database's own rule for `last_error_type`, applied before a value can reach it. */
const ERROR_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export function isErrorType(value: string): boolean {
  return ERROR_TYPE_PATTERN.test(value) && value.length <= 200;
}

/**
 * An email transport.
 *
 * Every implementation must be safe to call concurrently and must never throw for an ordinary delivery
 * failure — a rejected send is a `failed` outcome, not an exception, because an exception would abandon
 * a message that the database has already moved to `sending`.
 */
export interface EmailTransport {
  /** Adapter name for logs. Never a credential, a host or an account identifier. */
  readonly name: string;
  send(message: EmailMessage): Promise<EmailDeliveryOutcome>;
}

/** Injection token. Provided as `null` while no provider is approved. */
export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT');
