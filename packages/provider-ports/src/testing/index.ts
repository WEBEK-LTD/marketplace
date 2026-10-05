import type {
  CancelPaymentResult,
  CreatePaymentInput,
  CreatePaymentResult,
  NormalizedPaymentEvent,
  NormalizedPaymentStatusResult,
  NormalizedRefundStatusResult,
  PaymentProvider,
  PaymentProviderCapabilities,
  RefundPaymentInput,
  RefundPaymentResult,
} from '../payment.js';
import type {
  CancelPayoutResult,
  CreatePayoutInput,
  CreatePayoutResult,
  DestinationValidationResult,
  NormalizedPayoutEvent,
  NormalizedPayoutStatusResult,
  PayoutProvider,
  PayoutProviderCapabilities,
  RegisteredDestinationResult,
  ReversePayoutResult,
} from '../payout.js';
import type { PayoutDestinationInput, ProviderPaymentRef, ProviderPayoutRef, ProviderRefundRef } from '../references.js';
import type { RawWebhookRequest, VerifiedWebhookRequest, WebhookVerificationResult } from '../webhooks.js';
import { providerError } from '../errors.js';
import { providerPaymentRef, providerPayoutRef, providerRefundRef } from '../references.js';

/**
 * Deterministic test doubles for both provider ports (Phase 8-C).
 *
 * **Never registered in production.** They live behind their own entry point,
 * `@repo/provider-ports/testing`, which production code cannot reach through the package root, and a
 * dependency-cruiser rule refuses any import of this directory from outside a test. G11 permits exactly
 * this — *"test doubles (never registered in production)"* — and nothing more.
 *
 * They contact nothing and hold nothing: no HTTP client, no socket, no credential, no base URL, no
 * environment variable, no randomness and no clock. Every answer is either fixed at construction or
 * derived from the input, so a test that passes once passes again.
 *
 * They are **not a simulated provider**. A double does not model a payment lifecycle, does not advance a
 * status over time and does not decide anything a real provider would decide: it returns the outcome a test
 * asked it for and records what it was called with. Nothing here is a claim about how any provider behaves.
 */

/** Every call a double received, in order. Amounts stay strings; nothing is converted or summed. */
export interface RecordedCall {
  readonly method: string;
  readonly idempotencyKey?: string;
  readonly amountMinor?: string;
  readonly currencyCode?: string;
  readonly reference?: string;
  /** How many bytes a webhook delivery carried. A count, never the bytes and never a header. */
  readonly bodyBytes?: number;
}

export interface PaymentProviderDoubleOptions {
  readonly name?: string;
  readonly capabilities?: PaymentProviderCapabilities;
  readonly createPayment?: CreatePaymentResult;
  readonly paymentStatus?: NormalizedPaymentStatusResult;
  readonly refund?: RefundPaymentResult;
  readonly refundStatus?: NormalizedRefundStatusResult;
  readonly cancel?: CancelPaymentResult;
  readonly verification?: WebhookVerificationResult;
  readonly events?: readonly NormalizedPaymentEvent[];
}

const NO_CAPABILITIES: PaymentProviderCapabilities = Object.freeze({ currencies: Object.freeze([]) });

/** A reference no provider could issue, so a test can never mistake a double's output for a real one. */
export const DOUBLE_PAYMENT_REFERENCE = 'test-double-payment-reference';
export const DOUBLE_REFUND_REFERENCE = 'test-double-refund-reference';
export const DOUBLE_PAYOUT_REFERENCE = 'test-double-payout-reference';

export class PaymentProviderDouble implements PaymentProvider {
  readonly name: string;
  readonly calls: RecordedCall[] = [];

  constructor(private readonly options: PaymentProviderDoubleOptions = {}) {
    this.name = options.name ?? 'test_double';
  }

  async getCapabilities(): Promise<PaymentProviderCapabilities> {
    this.calls.push({ method: 'getCapabilities' });
    return this.options.capabilities ?? NO_CAPABILITIES;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    this.calls.push({
      method: 'createPayment',
      idempotencyKey: input.idempotencyKey,
      amountMinor: input.amount.amountMinor,
      currencyCode: input.amount.currencyCode,
    });
    return (
      this.options.createPayment ?? {
        outcome: 'created',
        reference: providerPaymentRef(DOUBLE_PAYMENT_REFERENCE),
        status: 'pending',
        nextAction: 'none',
        expiresAt: null,
      }
    );
  }

  async getPaymentStatus(ref: ProviderPaymentRef): Promise<NormalizedPaymentStatusResult> {
    this.calls.push({ method: 'getPaymentStatus', reference: ref.providerPaymentRef });
    return this.options.paymentStatus ?? { outcome: 'unknown_reference' };
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    this.calls.push({
      method: 'refundPayment',
      idempotencyKey: input.idempotencyKey,
      amountMinor: input.amount.amountMinor,
      currencyCode: input.amount.currencyCode,
      reference: input.reference.providerPaymentRef,
    });
    // The default is `not_supported`, which is E-4's answer for a provider that cannot refund and the
    // safest default for a double: a test that means to exercise a refund must say so.
    return this.options.refund ?? { outcome: 'not_supported' };
  }

  async getRefundStatus(ref: ProviderRefundRef): Promise<NormalizedRefundStatusResult> {
    this.calls.push({ method: 'getRefundStatus', reference: ref.providerRefundRef });
    return this.options.refundStatus ?? { outcome: 'not_supported' };
  }

  async cancelPayment(ref: ProviderPaymentRef): Promise<CancelPaymentResult> {
    this.calls.push({ method: 'cancelPayment', reference: ref.providerPaymentRef });
    return this.options.cancel ?? { outcome: 'not_supported' };
  }

  async verifyWebhook(req: RawWebhookRequest): Promise<WebhookVerificationResult> {
    this.calls.push({ method: 'verifyWebhook', bodyBytes: req.body.byteLength });
    // Rejecting by default is the only safe default: a double that verified anything would let a test pass
    // while asserting nothing about verification.
    return (
      this.options.verification ?? {
        outcome: 'rejected',
        error: providerError('test_double_not_configured', false),
      }
    );
  }

  async parseWebhook(req: VerifiedWebhookRequest): Promise<readonly NormalizedPaymentEvent[]> {
    this.calls.push({ method: 'parseWebhook', bodyBytes: req.body.byteLength });
    return this.options.events ?? [];
  }

  /** Builds a verified result over the given bytes, for a test that needs to reach `parseWebhook`. */
  static verified(req: RawWebhookRequest): WebhookVerificationResult {
    return { outcome: 'verified', request: { body: req.body, headers: req.headers } };
  }
}

export interface PayoutProviderDoubleOptions {
  readonly name?: string;
  readonly capabilities?: PayoutProviderCapabilities;
  readonly validation?: DestinationValidationResult;
  readonly registration?: RegisteredDestinationResult;
  readonly createPayout?: CreatePayoutResult;
  readonly payoutStatus?: NormalizedPayoutStatusResult;
  readonly cancel?: CancelPayoutResult;
  readonly reversal?: ReversePayoutResult;
  readonly verification?: WebhookVerificationResult;
  readonly events?: readonly NormalizedPayoutEvent[];
}

const NO_PAYOUT_CAPABILITIES: PayoutProviderCapabilities = Object.freeze({ currencies: Object.freeze([]) });

export class PayoutProviderDouble implements PayoutProvider {
  readonly name: string;
  readonly calls: RecordedCall[] = [];

  constructor(private readonly options: PayoutProviderDoubleOptions = {}) {
    this.name = options.name ?? 'test_double';
  }

  async getCapabilities(): Promise<PayoutProviderCapabilities> {
    this.calls.push({ method: 'getCapabilities' });
    return this.options.capabilities ?? NO_PAYOUT_CAPABILITIES;
  }

  async validateDestination(input: PayoutDestinationInput): Promise<DestinationValidationResult> {
    this.calls.push({ method: 'validateDestination', currencyCode: input.currencyCode });
    return this.options.validation ?? { outcome: 'not_supported' };
  }

  async registerDestination(input: PayoutDestinationInput): Promise<RegisteredDestinationResult> {
    this.calls.push({ method: 'registerDestination', currencyCode: input.currencyCode });
    return this.options.registration ?? { outcome: 'not_supported' };
  }

  async createPayout(input: CreatePayoutInput): Promise<CreatePayoutResult> {
    this.calls.push({
      method: 'createPayout',
      idempotencyKey: input.idempotencyKey,
      amountMinor: input.amount.amountMinor,
      currencyCode: input.amount.currencyCode,
    });
    return (
      this.options.createPayout ?? {
        outcome: 'created',
        reference: providerPayoutRef(DOUBLE_PAYOUT_REFERENCE),
        status: 'pending',
      }
    );
  }

  async getPayoutStatus(ref: ProviderPayoutRef): Promise<NormalizedPayoutStatusResult> {
    this.calls.push({ method: 'getPayoutStatus', reference: ref.providerPayoutRef });
    return this.options.payoutStatus ?? { outcome: 'unknown_reference' };
  }

  async cancelPayout(ref: ProviderPayoutRef): Promise<CancelPayoutResult> {
    this.calls.push({ method: 'cancelPayout', reference: ref.providerPayoutRef });
    return this.options.cancel ?? { outcome: 'not_supported' };
  }

  async reversePayout(ref: ProviderPayoutRef): Promise<ReversePayoutResult> {
    this.calls.push({ method: 'reversePayout', reference: ref.providerPayoutRef });
    return this.options.reversal ?? { outcome: 'not_supported' };
  }

  async verifyWebhook(req: RawWebhookRequest): Promise<WebhookVerificationResult> {
    this.calls.push({ method: 'verifyWebhook', bodyBytes: req.body.byteLength });
    return (
      this.options.verification ?? {
        outcome: 'rejected',
        error: providerError('test_double_not_configured', false),
      }
    );
  }

  async parseWebhook(req: VerifiedWebhookRequest): Promise<readonly NormalizedPayoutEvent[]> {
    this.calls.push({ method: 'parseWebhook', bodyBytes: req.body.byteLength });
    return this.options.events ?? [];
  }
}

/** A refund reference a test can hand to `getRefundStatus` without inventing a provider format. */
export const doubleRefundRef = (): ProviderRefundRef => providerRefundRef(DOUBLE_REFUND_REFERENCE);
