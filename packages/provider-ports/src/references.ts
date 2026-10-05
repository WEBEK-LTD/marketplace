import { PAYOUT_DESTINATION_KINDS, type PayoutDestinationKind, isPayoutDestinationKind } from './enums.js';
import { CURRENCY_CODE_PATTERN, isCurrencyCodeString } from './money.js';

/**
 * Identifiers that cross a provider port (Phase 8-C).
 *
 * Each reference is the provider's own string, held in the column that already exists for it —
 * `payment_attempts.provider_payment_ref`, `payouts.provider_payout_ref`, a refund's provider reference.
 * They are opaque: nothing here parses, splits or interprets one, because its format belongs to whichever
 * provider issued it and no provider is chosen.
 *
 * Each is a one-field object rather than a bare string on purpose. The spec's signatures take
 * `ProviderPaymentRef`, `ProviderRefundRef` and `ProviderPayoutRef` as distinct types, and three bare
 * strings would be mutually assignable — a payout reference could be passed where a payment reference was
 * meant and nothing would notice.
 */

export interface ProviderPaymentRef {
  readonly providerPaymentRef: string;
}

export interface ProviderRefundRef {
  readonly providerRefundRef: string;
}

export interface ProviderPayoutRef {
  readonly providerPayoutRef: string;
}

/** A reference is a non-empty string once trimmed. Nothing else about its shape is ours to assert. */
export function isProviderReference(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class ProviderReferenceError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderReferenceError';
  }
}

function reference<K extends string>(key: K, value: string): Readonly<Record<K, string>> {
  if (!isProviderReference(value)) {
    throw new ProviderReferenceError('A provider reference must be a non-empty string.');
  }
  return Object.freeze({ [key]: value } as Record<K, string>);
}

export const providerPaymentRef = (value: string): ProviderPaymentRef =>
  reference('providerPaymentRef', value) as ProviderPaymentRef;
export const providerRefundRef = (value: string): ProviderRefundRef =>
  reference('providerRefundRef', value) as ProviderRefundRef;
export const providerPayoutRef = (value: string): ProviderPayoutRef =>
  reference('providerPayoutRef', value) as ProviderPayoutRef;

/**
 * Our own key for an operation, which is also our guaranteed-unique merchant reference.
 *
 * 0019's column comment settles both halves of B1-A's capability 8 with one value: *"Our key for this
 * attempt, sent to the provider when it supports provider idempotency (C10); unique per provider either
 * way."* The same is true of `refunds.idempotency_key` and `payouts.idempotency_key`, and all three are
 * constrained to the same length, which is where these bounds come from.
 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export function isIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= IDEMPOTENCY_KEY_MIN_LENGTH &&
    value.length <= IDEMPOTENCY_KEY_MAX_LENGTH
  );
}

/**
 * An adapter's own name, for logs.
 *
 * The same rule `payment_providers.key` and `payout_providers.key` apply, so a name here can be the key a
 * provider row will eventually carry. Never a credential, a host or an account identifier — the one rule
 * `EmailTransport.name` already states.
 */
export const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function isProviderName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && PROVIDER_NAME_PATTERN.test(value);
}

/**
 * Where a payout is sent.
 *
 * The identity of a destination and nothing more: its kind, the currency it settles in, the country when
 * one applies, and the provider's own token when the provider holds the details instead of us. 0022
 * keeps the details themselves in Vault or replaces them with that token — `payout_destinations` allows
 * exactly one of `vault_secret_id` and `provider_token`, *"never neither and never both"* — so the
 * readable details are deliberately not a field of this contract.
 *
 * **The details payload an adapter would need to validate a brand-new destination is not defined here,
 * because it is not defined anywhere**: it varies by kind, by country and by provider, and inventing a
 * shape would be inventing provider behaviour. See the delivery report's capability gaps.
 */
export interface PayoutDestinationInput {
  readonly destinationKind: PayoutDestinationKind;
  readonly currencyCode: string;
  /** ISO 3166-1 alpha-2, where the kind implies one. `payout_destinations.country_code` is nullable. */
  readonly countryCode: string | null;
  /** The provider's own token, when it holds the details. Null when they are held in Vault. */
  readonly providerToken: string | null;
}

export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

export function isPayoutDestinationInput(value: unknown): value is PayoutDestinationInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const input = value as Partial<PayoutDestinationInput>;
  if (!isPayoutDestinationKind(input.destinationKind)) return false;
  if (!isCurrencyCodeString(input.currencyCode)) return false;
  if (input.countryCode !== null && !(typeof input.countryCode === 'string' && COUNTRY_CODE_PATTERN.test(input.countryCode))) {
    return false;
  }
  return input.providerToken === null || (typeof input.providerToken === 'string' && input.providerToken.length > 0);
}

export { PAYOUT_DESTINATION_KINDS, CURRENCY_CODE_PATTERN };
