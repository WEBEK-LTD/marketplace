/**
 * The normalized enumerations both provider ports speak in (Phase 8-C).
 *
 * Every array here is the **exact** value list of a CHECK constraint that migrations 0019–0022 already
 * enforce. They are copied, never extended: a value that is not in the database cannot be stored, so a
 * port that offered one would be offering something the platform must refuse. `test/enums.test.ts`
 * asserts each array against the constraint it mirrors, by name, so a later migration cannot change one
 * without this package failing.
 *
 * No payment-method enum exists here, deliberately. `payment_attempts.method_code` carries no CHECK and
 * no foreign key, there is no methods table, and D18's per-method capability model is BLOCKED by B1-A —
 * so a method code stays an opaque string until that decision lands.
 */

/** `payment_attempts_status_allowed` (0019). */
export const PAYMENT_ATTEMPT_STATUSES = Object.freeze([
  'pending',
  'requires_action',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const);
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

/** `payment_attempts_next_action_allowed` (0019). What the buyer must do next, and nothing more. */
export const PAYMENT_NEXT_ACTIONS = Object.freeze(['redirect', 'embedded', 'reference_code', 'none'] as const);
export type PaymentNextAction = (typeof PAYMENT_NEXT_ACTIONS)[number];

/** `payment_exception_policies_case_type_allowed` and `payment_exception_cases_type_allowed` (0020). */
export const PAYMENT_EXCEPTION_CASES = Object.freeze([
  'late_success',
  'duplicate_success',
  'amount_mismatch',
  'currency_mismatch',
  'unknown_reference',
] as const);
export type PaymentExceptionCase = (typeof PAYMENT_EXCEPTION_CASES)[number];

/** `payouts_status_allowed` (0022). */
export const PAYOUT_STATUSES = Object.freeze([
  'pending',
  'processing',
  'paid',
  'failed',
  'cancelled',
  'reversed',
] as const);
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** `refunds_status_allowed` (0019). */
export const REFUND_STATUSES = Object.freeze([
  'requested',
  'approved',
  'pending',
  'succeeded',
  'failed',
  'cancelled',
] as const);
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** `payout_destinations_kind_allowed` (0022). */
export const PAYOUT_DESTINATION_KINDS = Object.freeze([
  'bank_account',
  'wallet',
  'card',
  'provider_token',
] as const);
export type PayoutDestinationKind = (typeof PAYOUT_DESTINATION_KINDS)[number];

/**
 * `payment_provider_capabilities_amount_format_allowed` and its payout twin (0019, 0022).
 *
 * How a provider wants the amount written. The platform always holds minor units; an adapter converts,
 * and the conversion is the adapter's business — which is why this value is reported here and applied
 * there, never the other way round.
 */
export const PROVIDER_AMOUNT_FORMATS = Object.freeze(['minor', 'major_decimal'] as const);
export type ProviderAmountFormat = (typeof PROVIDER_AMOUNT_FORMATS)[number];

function isMember<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export const isPaymentAttemptStatus = (v: unknown): v is PaymentAttemptStatus => isMember(PAYMENT_ATTEMPT_STATUSES, v);
export const isPaymentNextAction = (v: unknown): v is PaymentNextAction => isMember(PAYMENT_NEXT_ACTIONS, v);
export const isPaymentExceptionCase = (v: unknown): v is PaymentExceptionCase => isMember(PAYMENT_EXCEPTION_CASES, v);
export const isPayoutStatus = (v: unknown): v is PayoutStatus => isMember(PAYOUT_STATUSES, v);
export const isRefundStatus = (v: unknown): v is RefundStatus => isMember(REFUND_STATUSES, v);
export const isPayoutDestinationKind = (v: unknown): v is PayoutDestinationKind =>
  isMember(PAYOUT_DESTINATION_KINDS, v);
export const isProviderAmountFormat = (v: unknown): v is ProviderAmountFormat =>
  isMember(PROVIDER_AMOUNT_FORMATS, v);
