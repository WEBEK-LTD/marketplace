import type { PendingPolicy } from './policy.js';
import { pendingPolicy } from './policy.js';

/**
 * The replaceable payment regulatory policy layer.
 *
 * **There is no reachable permissive state, and that is enforced by the type rather than by a default.**
 * `PaymentRegulatoryState` is a one-member union: the value `'COUNSEL_REVIEW_REQUIRED'` is the only state
 * that exists, so no caller can write a permissive one and no configuration can select one. Widening the
 * union is a code change in a future increment, made against a written finding — which is the gate the owner
 * asked for.
 *
 * Nothing here infers that the marketplace is a regulated payment service, and nothing here declares it
 * exempt. Both would be legal conclusions, and both are BD-01 and BD-02's to make.
 */

export const PAYMENT_REGULATORY_STATES = Object.freeze(['COUNSEL_REVIEW_REQUIRED'] as const);
export type PaymentRegulatoryState = (typeof PAYMENT_REGULATORY_STATES)[number];

export const PAYMENT_REGULATORY_STATUS: PaymentRegulatoryState = 'COUNSEL_REVIEW_REQUIRED';

export const paymentRegulatoryPolicy: PendingPolicy = pendingPolicy(
  'COUNSEL_REVIEW_REQUIRED',
  'whether and how the payment licensing regime reaches this marketplace is undetermined (B1-D, BD-01 and BD-02)',
);

/**
 * Whether the regulatory position permits a real-money operation.
 *
 * Returns `false` unconditionally while the only state that exists is the one requiring review. It is written
 * as a function rather than a constant so that a future increment can replace its body against a written
 * finding without any caller changing.
 */
export function regulatoryPositionPermitsLiveMoney(): false {
  return false;
}
