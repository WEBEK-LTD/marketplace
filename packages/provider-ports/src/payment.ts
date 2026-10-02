import type { ProviderAmountFormat, PaymentAttemptStatus, PaymentNextAction, RefundStatus } from './enums.js';
import type { ProviderError } from './errors.js';
import type { ProviderMoney } from './money.js';
import type { ProviderPaymentRef, ProviderRefundRef } from './references.js';
import type { RawWebhookRequest, VerifiedWebhookRequest, WebhookVerificationResult } from './webhooks.js';

/**
 * The provider-neutral payment port (Phase 8-C).
 *
 * The method names, their arity and their optionality are v5.2's, transcribed exactly. The field sets are
 * the smallest the spec's signatures and migrations 0019–0020 require, and nothing more: every field below
 * either appears as a column those migrations constrain, or is named by the spec itself.
 *
 * **No provider is chosen, and none is assumed.** There is no adapter, no credential, no environment
 * variable and no provider row anywhere in this package — B1-A stays open, and v5.2 is explicit that no
 * adapter exists until it closes and that no candidate is seeded or assumed. This package names none of
 * them, and a test asserts that it never will.
 */

// ---------------------------------------------------------------------------------------------------
// Capabilities (E-6)
// ---------------------------------------------------------------------------------------------------
/**
 * What an adapter reports it can do, per currency.
 *
 * **This is a discovery surface, not the platform's policy.** `public.payment_provider_capabilities` is
 * the persisted record and the source of truth for execution decisions; it carries an `evidence_url`
 * because its rows are what a provider's *documentation* states, reviewed by a person. An adapter's answer
 * here may inform a future, explicitly authorized refresh of those rows. It must never override them
 * during a business operation, and 8-C provides no polling, no refresh and no seed.
 *
 * Every field mirrors a column of that table. `evidence_url` and `recorded_at` deliberately do not appear:
 * they are facts about the platform's review, not about the provider.
 */
export interface PaymentProviderCurrencyCapability {
  readonly currencyCode: string;
  readonly supportsCharge: boolean;
  readonly supportsRefund: boolean;
  readonly supportsPartialRefund: boolean;
  readonly supportsCancel: boolean;
  readonly supportsStatusLookup: boolean;
  readonly supportsProviderIdempotency: boolean;
  readonly supportsWebhooks: boolean;
  readonly amountFormat: ProviderAmountFormat;
  /** Only meaningful for `major_decimal`; 0–4, as the column allows. */
  readonly amountDecimalPlaces: number | null;
  readonly minAmountMinor: string | null;
  readonly maxAmountMinor: string | null;
}

export interface PaymentProviderCapabilities {
  readonly currencies: readonly PaymentProviderCurrencyCapability[];
}

// ---------------------------------------------------------------------------------------------------
// Creating a payment
// ---------------------------------------------------------------------------------------------------
/**
 * One attempt to collect one amount.
 *
 * `idempotencyKey` is `payment_attempts.idempotency_key`, which 0019 documents as both our idempotency key
 * and our guaranteed-unique merchant reference — *"unique per provider either way"* — so it satisfies both
 * halves of B1-A's capability 8 and no second reference is needed or invented.
 *
 * `methodCode` stays opaque: no method enum exists in the platform, and D18's per-method capability model
 * is BLOCKED by B1-A.
 */
export interface CreatePaymentInput {
  readonly amount: ProviderMoney;
  readonly idempotencyKey: string;
  readonly methodCode: string | null;
}

/**
 * What creating a payment produced.
 *
 * **Not a confirmation.** Spec: status is confirmed only by a verified webhook or a server-side
 * `getPaymentStatus`. So `status` here is the provider's immediate answer — `pending` or
 * `requires_action` in practice — and the platform records it without treating it as settled.
 *
 * `expiresAt` is the provider's own expiry, which is where D18 says a delayed method's window comes from:
 * *"delayed methods extend to provider expiry, never beyond a configurable platform maximum."* Reporting
 * it is not implementing D18; applying a platform maximum to it is, and that is not done here.
 *
 * `nextAction` says **which kind** of action the buyer must take and carries no payload — no redirect URL,
 * no embedded token, no reference code. `payment_attempts.next_action` stores only the kind, and the spec
 * defines no payload shape for any of the four. That absence is reported rather than filled in.
 */
export type CreatePaymentResult =
  | {
      readonly outcome: 'created';
      readonly reference: ProviderPaymentRef;
      readonly status: PaymentAttemptStatus;
      readonly nextAction: PaymentNextAction;
      readonly expiresAt: Date | null;
    }
  | { readonly outcome: 'failed'; readonly error: ProviderError };

// ---------------------------------------------------------------------------------------------------
// Reading a payment's status
// ---------------------------------------------------------------------------------------------------
/**
 * What the provider says about one reference.
 *
 * `observedAmount` is what the provider reports having taken, and it is separate from what we asked for on
 * purpose: `settle_payment_attempt` accepts `p_observed_amount_minor` and `p_observed_currency_code` and
 * opens an `amount_mismatch` or `currency_mismatch` case when they disagree with ours. That comparison is
 * the database's; the port only reports.
 *
 * `unknown_reference` is a distinct outcome because it is a distinct fact — and one of 0020's five
 * exception cases. It is not an error the adapter classified; it is the provider saying it has never heard
 * of this reference.
 */
export type NormalizedPaymentStatusResult =
  | {
      readonly outcome: 'status';
      readonly reference: ProviderPaymentRef;
      readonly status: PaymentAttemptStatus;
      readonly observedAmount: ProviderMoney | null;
      readonly failureCode: string | null;
    }
  | { readonly outcome: 'unknown_reference' }
  | { readonly outcome: 'failed'; readonly error: ProviderError };

// ---------------------------------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------------------------------
/** `reason` is `public.refunds.reason`, which is `not null` and 1–1000 characters. */
export interface RefundPaymentInput {
  readonly reference: ProviderPaymentRef;
  readonly amount: ProviderMoney;
  readonly idempotencyKey: string;
  readonly reason: string;
}

/**
 * `refundPayment` is required of every adapter, and a provider that cannot refund says so here.
 *
 * `not_supported` is a normalized outcome rather than a thrown error or an invented refund status: the
 * interface stays uniform whatever the provider can do, and `payment_provider_capabilities.supports_refund`
 * remains the platform's persisted answer to whether a refund should be attempted at all.
 */
export type RefundPaymentResult =
  | { readonly outcome: 'accepted'; readonly reference: ProviderRefundRef; readonly status: RefundStatus }
  | { readonly outcome: 'not_supported' }
  | { readonly outcome: 'failed'; readonly error: ProviderError };

export type NormalizedRefundStatusResult =
  | {
      readonly outcome: 'status';
      readonly reference: ProviderRefundRef;
      readonly status: RefundStatus;
      readonly refundedAmount: ProviderMoney | null;
      readonly failureCode: string | null;
    }
  | { readonly outcome: 'not_supported' }
  | { readonly outcome: 'unknown_reference' }
  | { readonly outcome: 'failed'; readonly error: ProviderError };

/** Voiding a payment that was never collected. `supports_cancel` is the platform's persisted answer. */
export type CancelPaymentResult =
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'not_supported' }
  | { readonly outcome: 'failed'; readonly error: ProviderError };

// ---------------------------------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------------------------------
/**
 * One event, normalized.
 *
 * `eventKey` is the provider's own idempotency key for the delivery and is what `payment_events`' unique
 * index on `(payment_provider_id, event_key)` uses as replay protection. `eventType` is the provider's own
 * type string, which that table stores as `text` up to 120 characters — it is the one deliberately
 * provider-shaped value in this package, because it is the value the platform records verbatim.
 *
 * **No provider payload structure crosses.** There is no `raw`, no `data`, no `payload` field: the body is
 * reduced to a digest by `record_payment_event` and never stored, and a parsed event carries only the
 * fields below.
 */
export interface NormalizedPaymentEvent {
  readonly eventKey: string;
  readonly eventType: string;
  readonly reference: ProviderPaymentRef | null;
  readonly status: PaymentAttemptStatus | null;
  readonly observedAmount: ProviderMoney | null;
  readonly failureCode: string | null;
}

// ---------------------------------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------------------------------
/**
 * A payment provider.
 *
 * Eight methods, six of them required, transcribed from v5.2 §PaymentProvider interface. Every
 * implementation must be safe to call concurrently and must **never throw for an ordinary provider
 * failure** — a refusal is a result, because a thrown error abandons a `payment_attempts` row the database
 * has already created.
 */
export interface PaymentProvider {
  /** Adapter name for logs. Never a credential, a host or an account identifier. */
  readonly name: string;
  getCapabilities(): Promise<PaymentProviderCapabilities>;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  getPaymentStatus(ref: ProviderPaymentRef): Promise<NormalizedPaymentStatusResult>;
  refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult>;
  getRefundStatus?(ref: ProviderRefundRef): Promise<NormalizedRefundStatusResult>;
  cancelPayment?(ref: ProviderPaymentRef): Promise<CancelPaymentResult>;
  verifyWebhook(req: RawWebhookRequest): Promise<WebhookVerificationResult>;
  parseWebhook(req: VerifiedWebhookRequest): Promise<readonly NormalizedPaymentEvent[]>;
}

/** Injection token. Provided as `null` while no provider is approved, exactly as `EMAIL_TRANSPORT` is. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
