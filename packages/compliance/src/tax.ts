import type { PendingPolicy } from './policy.js';
import { pendingPolicy } from './policy.js';

/**
 * The eight tax policy abstractions, all pending review.
 *
 * **Every one of these is a pending policy, and none carries a number.** There is no rate field, no
 * percentage, no threshold and no boolean "applies" anywhere in this file, because supplying any of them
 * would be inventing the answer the review exists to produce. The owner's rule is explicit: an unresolved
 * value is not zero, is not silently exempt, and is not silently taxable.
 *
 * A caller that needs one of these values calls `requirePolicyValue`, which throws. That is the intended
 * behaviour: a checkout, a payout or a ledger posting that cannot determine its tax treatment must stop
 * rather than post a number nobody authorized.
 */

/** Treatment of tax across the flow generally. */
export const taxPolicy: PendingPolicy = pendingPolicy(
  'PENDING_TAX_REVIEW',
  'the tax treatment of the marketplace flow is undetermined (B1-D, BD-15)',
);

/** Value added tax. No rate exists anywhere in this project. */
export const vatPolicy: PendingPolicy = pendingPolicy(
  'PENDING_TAX_REVIEW',
  'no rate, scope or registration threshold has been determined (B1-D, BD-15)',
);

/** Characterisation and recognition point of marketplace commission. */
export const commissionTaxPolicy: PendingPolicy = pendingPolicy(
  'PENDING_TAX_REVIEW',
  'the characterisation and recognition point of commission are undetermined (B1-D, BD-11)',
);

/** Characterisation of fees charged to buyers. */
export const buyerFeeTaxPolicy: PendingPolicy = pendingPolicy(
  'PENDING_TAX_REVIEW',
  'the characterisation and correct recognition of buyer fees are undetermined (B1-D, BD-13)',
);

/** Characterisation of seller proceeds, and any obligation attaching to this company. */
export const sellerProceedsTaxPolicy: PendingPolicy = pendingPolicy(
  'PENDING_TAX_REVIEW',
  'the characterisation of seller proceeds is undetermined (B1-D, BD-12)',
);

/** Whether any withholding obligation arises. The scope question precedes the treatment question. */
export const withholdingPolicy: PendingPolicy = pendingPolicy(
  'PENDING_TAX_REVIEW',
  'whether withholding is in scope at all is undetermined, and no percentage exists (B1-D, BD-16)',
);

/** Whether any reporting or information-return obligation arises. */
export const reportingPolicy: PendingPolicy = pendingPolicy(
  'PENDING_TAX_REVIEW',
  'whether reporting is in scope at all is undetermined, and no threshold exists (B1-D, BD-16)',
);

/** Which tax documents must be issued, in what form, on what trigger. */
export const taxDocumentPolicy: PendingPolicy = pendingPolicy(
  'PROVISIONAL_PENDING_TAX_REVIEW',
  'no invoice or receipt type is assumed for any transaction (B1-D, BD-09 and BD-15)',
);

/** Every tax policy, by name, for the register surface and the test suite. */
export const TAX_POLICIES = Object.freeze({
  taxPolicy,
  vatPolicy,
  commissionTaxPolicy,
  buyerFeeTaxPolicy,
  sellerProceedsTaxPolicy,
  withholdingPolicy,
  reportingPolicy,
  taxDocumentPolicy,
} as const);

export type TaxPolicyName = keyof typeof TAX_POLICIES;
