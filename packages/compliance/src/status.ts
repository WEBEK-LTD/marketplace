/**
 * Provisional compliance status constants (PROVISIONAL_EGYPT_COMPLIANCE_BASELINE, owner-approved
 * 2026-10-01).
 *
 * **None of these is a legal conclusion.** Each records that a question is open and that the project's
 * behaviour while it is open is fail-closed. No constant here states that any licence, registration, tax
 * treatment, rate, obligation, permission or exemption applies to this company, and none may be read that
 * way.
 *
 * The baseline exists so engineering can continue while external Egyptian legal, tax and privacy counsel
 * reviews the model. It does not close B1-C, does not close B1-D, does not release UB8, does not close D20
 * or D21, and authorizes no movement of real money.
 *
 * **Where the fail-closed behaviour comes from.** Not from any reading of Egyptian law: no primary text was
 * read, and the instruments named in this package were existence-verified only. Every posture here is
 * derived from rules the project already approved for itself — the S8 privilege model, row level security on
 * every table, the append-only ledger and audit log, `finance.settlement_posting_enabled` shipping `false`,
 * `payment_provider_capabilities.evidence_url` being `not null`, and D24's rule that no legal period is ever
 * hard-coded. A posture that is conservative under every possible legal answer cannot become a false legal
 * fact, which is the only reason a provisional layer is safe to build at all.
 */

/** Development may continue; no real-money execution is authorized; no legal conclusion is implied. */
export const LEGAL_REVIEW_STATUS = 'PROVISIONAL_PENDING_EXTERNAL_COUNSEL' as const;
export type LegalReviewStatus = typeof LEGAL_REVIEW_STATUS;

/**
 * BC-01 (platform-held balances) is a product decision whose legal character is undetermined.
 *
 * Both parts are recorded together and deliberately: the model is selected, and the review is pending. The
 * words "legally permitted", "licensed" and "approved" appear nowhere in this package as a status value,
 * and `FORBIDDEN_RESOLVED_VALUES` below exists to keep it that way.
 */
export const SETTLEMENT_MODEL_STATUS = Object.freeze(['PRODUCT_MODEL_SELECTED', 'LEGAL_REVIEW_PENDING'] as const);
export type SettlementModelStatus = (typeof SETTLEMENT_MODEL_STATUS)[number];

/** The V1 payout direction is a design, not an executable capability. */
export const MANUAL_PAYOUT_STATUS = 'PROVISIONAL_DESIGN_ONLY' as const;
export type ManualPayoutStatus = typeof MANUAL_PAYOUT_STATUS;

/** No lawful basis is asserted for any processing purpose. */
export const LEGAL_BASIS_STATUS = 'PENDING_COUNSEL' as const;
export type LegalBasisStatus = typeof LEGAL_BASIS_STATUS;

/** No residency is assumed, no region is selected, no transfer mechanism is asserted. */
export const DATA_RESIDENCY_STATUS = 'LEGAL_REVIEW_PENDING' as const;
export type DataResidencyStatus = typeof DATA_RESIDENCY_STATUS;

/**
 * Vocabulary that may never appear as a resolved policy value produced by this package.
 *
 * This is the machine-checkable form of the owner's instruction that a pending value must not silently
 * become zero, exempt, taxable, permitted, licensed or approved. `register.ts` and the test suite both
 * assert against it. It is a guard on *our own* output, not a claim about what any of these words would mean
 * in law.
 */
export const FORBIDDEN_RESOLVED_VALUES = Object.freeze([
  'zero',
  'exempt',
  'taxable',
  'permitted',
  'legally_permitted',
  'licensed',
  'approved',
  'authorized',
  'compliant',
  'exemption',
  'not_applicable',
] as const);
export type ForbiddenResolvedValue = (typeof FORBIDDEN_RESOLVED_VALUES)[number];

/** Whether a string is one of the values this package refuses to emit as a resolved determination. */
export function isForbiddenResolvedValue(value: string): value is ForbiddenResolvedValue {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (FORBIDDEN_RESOLVED_VALUES as readonly string[]).includes(normalized);
}
