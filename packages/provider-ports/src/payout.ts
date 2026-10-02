import type { ProviderAmountFormat, PayoutDestinationKind, PayoutStatus } from './enums.js';
import type { ProviderError } from './errors.js';
import type { ProviderMoney } from './money.js';
import type { PayoutDestinationInput, ProviderPayoutRef } from './references.js';
import type { RawWebhookRequest, VerifiedWebhookRequest, WebhookVerificationResult } from './webhooks.js';

/**
 * The provider-neutral payout port (Phase 8-C).
 *
 * **Nine methods, not eight**, transcribed from v5.2 §PayoutProvider interface: two of them required and
 * seven optional. Payouts are a separate abstraction from payments and this is a separate port, because
 * *"payout providers live in their own tables and settings, separate from payment providers, even if one
 * company offers both"* and *"a payment provider's payout product is not assumed suitable for seller
 * settlement."*
 *
 * Webhooks are **optional** here where they are required for payments, and that asymmetry is C10's:
 * *"a payout provider is eligible only if it supports an idempotent payout reference **or** a reliable
 * status lookup by our reference, so worker retries can never pay twice."* Status lookup is therefore the
 * load-bearing method, and `getPayoutStatus` is one of the two that are not optional.
 */

// ---------------------------------------------------------------------------------------------------
// Capabilities (E-6)
// ---------------------------------------------------------------------------------------------------
/**
 * What an adapter reports it can do, per currency.
 *
 * A discovery surface, exactly as on the payment side: `public.payout_provider_capabilities` is the
 * persisted record and the source of truth for execution decisions. Every field mirrors one of its columns;
 * `evidence_url` and `recorded_at` are the platform's review and do not appear.
 */
export interface PayoutProviderCurrencyCapability {
  readonly currencyCode: string;
  readonly supportsPayout: boolean;
  readonly supportsDestinationValidation: boolean;
  readonly supportsDestinationRegistration: boolean;
  readonly supportsCancel: boolean;
  readonly supportsReverse: boolean;
  readonly supportsStatusLookup: boolean;
  readonly supportsProviderIdempotency: boolean;
  readonly supportsWebhooks: boolean;
  readonly destinationKinds: readonly PayoutDestinationKind[];
  readonly amountFormat: ProviderAmountFormat;
  readonly amountDecimalPlaces: number | null;
  readonly minAmountMinor: string | null;
  readonly maxAmountMinor: string | null;
}

export interface PayoutProviderCapabilities {
  readonly currencies: readonly PayoutProviderCurrencyCapability[];
}

// ---------------------------------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------------------------------
/**
 * Whether a destination can receive a payout.
 *
 * `maskedValue` is what the platform displays and stores: `payout_destinations.masked_value` is `not null`
 * and 1–64 characters, and the spec says *"only masked values are displayed."* A rejection carries the
 * reason the platform stores in `rejection_reason`, and nothing about the provider's own validation rules.
 */
export type DestinationValidationResult =
  | { readonly outcome: 'valid'; readonly maskedValue: string }
  | { readonly outcome: 'invalid'; readonly rejectionReason: string }
  | { readonly outcome: 'not_supported' }
  | { readonly outcome: 'failed'; readonly error: ProviderError };

/**
 * A destination the provider now holds for us.
 *
 * `providerToken` is the column of the same name, and registering is the alternative to holding the details
 * in Vault: 0022 allows exactly one of the two, *"never neither and never both."*
 */
export type RegisteredDestinationResult =
  | { readonly outcome: 'registered'; readonly providerToken: string; readonly maskedValue: string }
  | { readonly outcome: 'not_supported' }
  | { readonly outcome: 'failed'; readonly error: ProviderError };

// ---------------------------------------------------------------------------------------------------
// Creating and settling a payout
// ---------------------------------------------------------------------------------------------------
/**
 * One payout to one destination.
 *
 * `idempotencyKey` is `payouts.idempotency_key`, under the same 8–255 rule as the other two and unique per
 * provider, which is the first of C10's two acceptable retry-safety mechanisms.
 */
export interface CreatePayoutInput {
  readonly amount: ProviderMoney;
  readonly idempotencyKey: string;
  readonly destination: PayoutDestinationInput;
}

/** Not a confirmation: `paid` is reached through `getPayoutStatus` or a verified webhook, never from here. */
export type CreatePayoutResult =
  | { readonly outcome: 'created'; readonly reference: ProviderPayoutRef; readonly status: PayoutStatus }
  | { readonly outcome: 'failed'; readonly error: ProviderError };

/**
 * What the provider says about one payout reference.
 *
 * This is the method C10 leans on. `observedAmount` is what the provider reports paying, which the platform
 * compares with `payouts.amount_minor`; the comparison is not the port's.
 */
export type NormalizedPayoutStatusResult =
  | {
      readonly outcome: 'status';
      readonly reference: ProviderPayoutRef;
      readonly status: PayoutStatus;
      readonly observedAmount: ProviderMoney | null;
      readonly failureCode: string | null;
    }
  | { readonly outcome: 'unknown_reference' }
  | { readonly outcome: 'failed'; readonly error: ProviderError };

export type CancelPayoutResult =
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'not_supported' }
  | { readonly outcome: 'failed'; readonly error: ProviderError };

/**
 * Pulling a payout back.
 *
 * A reversal is its own operation with its own row — `payout_reversals`, settled by
 * `settle_payout_reversal` — and never a negative payout, which is why no amount is negative anywhere in
 * this package. D21's recovery policy sits above this method and stays BLOCKED by B1-B and B1-D.
 */
export type ReversePayoutResult =
  | { readonly outcome: 'reversed'; readonly reference: ProviderPayoutRef }
  | { readonly outcome: 'not_supported' }
  | { readonly outcome: 'failed'; readonly error: ProviderError };

// ---------------------------------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------------------------------
/**
 * One payout event, normalized.
 *
 * `eventKey` is the replay-protection key behind `record_payout_event`'s unique
 * `(payout_provider_id, event_key)`. As on the payment side, no provider payload structure crosses: the
 * body becomes a digest and the event carries only these fields.
 */
export interface NormalizedPayoutEvent {
  readonly eventKey: string;
  readonly eventType: string;
  readonly reference: ProviderPayoutRef | null;
  readonly status: PayoutStatus | null;
  readonly observedAmount: ProviderMoney | null;
  readonly failureCode: string | null;
}

// ---------------------------------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------------------------------
/**
 * A payout provider.
 *
 * Every implementation must be safe to call concurrently and must never throw for an ordinary provider
 * failure: a refused payout is a result, because a thrown error abandons a `payouts` row whose withdrawal
 * has already moved to `processing`.
 */
export interface PayoutProvider {
  /** Adapter name for logs. Never a credential, a host or an account identifier. */
  readonly name: string;
  getCapabilities(): Promise<PayoutProviderCapabilities>;
  validateDestination(input: PayoutDestinationInput): Promise<DestinationValidationResult>;
  registerDestination?(input: PayoutDestinationInput): Promise<RegisteredDestinationResult>;
  createPayout(input: CreatePayoutInput): Promise<CreatePayoutResult>;
  getPayoutStatus(ref: ProviderPayoutRef): Promise<NormalizedPayoutStatusResult>;
  cancelPayout?(ref: ProviderPayoutRef): Promise<CancelPayoutResult>;
  reversePayout?(ref: ProviderPayoutRef): Promise<ReversePayoutResult>;
  verifyWebhook?(req: RawWebhookRequest): Promise<WebhookVerificationResult>;
  parseWebhook?(req: VerifiedWebhookRequest): Promise<readonly NormalizedPayoutEvent[]>;
}

/** Injection token. Provided as `null` while no provider is approved. */
export const PAYOUT_PROVIDER = Symbol('PAYOUT_PROVIDER');
