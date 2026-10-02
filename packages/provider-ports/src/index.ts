/**
 * Provider-neutral payment and payout ports (Phase 8-C).
 *
 * The whole boundary between this platform and whatever eventually moves money. It contains no adapter, no
 * provider name, no credential, no environment variable, no HTTP client and no database access — the
 * strongest form of credential isolation is having no credential to isolate, which is the same argument
 * 7-D makes for the email transport this package is shaped after.
 *
 * Test doubles live behind a separate entry point, `@repo/provider-ports/testing`, so production code that
 * imports this one cannot reach them. A dependency-cruiser rule enforces that, and a second rule keeps
 * domain code from importing an adapter when adapters eventually exist.
 *
 * B1-A, B1-B, B1-C, B1-D, D20 and RAM-1…RAM-6 all remain open. Nothing here resolves any of them.
 */

export {
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_EXCEPTION_CASES,
  PAYMENT_NEXT_ACTIONS,
  PAYOUT_DESTINATION_KINDS,
  PAYOUT_STATUSES,
  PROVIDER_AMOUNT_FORMATS,
  REFUND_STATUSES,
  isPaymentAttemptStatus,
  isPaymentExceptionCase,
  isPaymentNextAction,
  isPayoutDestinationKind,
  isPayoutStatus,
  isProviderAmountFormat,
  isRefundStatus,
  type PaymentAttemptStatus,
  type PaymentExceptionCase,
  type PaymentNextAction,
  type PayoutDestinationKind,
  type PayoutStatus,
  type ProviderAmountFormat,
  type RefundStatus,
} from './enums.js';

export {
  CURRENCY_CODE_PATTERN,
  MINOR_AMOUNT_PATTERN,
  ProviderMoneyError,
  isCurrencyCodeString,
  isMinorAmountString,
  isProviderMoney,
  moneyJsonFromProviderMoney,
  providerMoney,
  providerMoneyFromMoneyJson,
  type MoneyJsonLike,
  type ProviderMoney,
} from './money.js';

export {
  PROVIDER_ERROR_CODE_MAX_LENGTH,
  PROVIDER_ERROR_CODE_PATTERN,
  UNCLASSIFIED_PROVIDER_ERROR_CODE,
  isProviderError,
  isProviderErrorCode,
  providerError,
  type ProviderError,
} from './errors.js';

export {
  COUNTRY_CODE_PATTERN,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  PROVIDER_NAME_PATTERN,
  ProviderReferenceError,
  isIdempotencyKey,
  isPayoutDestinationInput,
  isProviderName,
  isProviderReference,
  providerPaymentRef,
  providerPayoutRef,
  providerRefundRef,
  type PayoutDestinationInput,
  type ProviderPaymentRef,
  type ProviderPayoutRef,
  type ProviderRefundRef,
} from './references.js';

export {
  isRawWebhookRequest,
  isVerifiedWebhookRequest,
  type RawWebhookRequest,
  type VerifiedWebhookRequest,
  type WebhookVerificationResult,
} from './webhooks.js';

export {
  PAYMENT_PROVIDER,
  type CancelPaymentResult,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type NormalizedPaymentEvent,
  type NormalizedPaymentStatusResult,
  type NormalizedRefundStatusResult,
  type PaymentProvider,
  type PaymentProviderCapabilities,
  type PaymentProviderCurrencyCapability,
  type RefundPaymentInput,
  type RefundPaymentResult,
} from './payment.js';

export {
  PAYOUT_PROVIDER,
  type CancelPayoutResult,
  type CreatePayoutInput,
  type CreatePayoutResult,
  type DestinationValidationResult,
  type NormalizedPayoutEvent,
  type NormalizedPayoutStatusResult,
  type PayoutProvider,
  type PayoutProviderCapabilities,
  type PayoutProviderCurrencyCapability,
  type RegisteredDestinationResult,
  type ReversePayoutResult,
} from './payout.js';
