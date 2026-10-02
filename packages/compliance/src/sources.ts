/**
 * Source-verification metadata.
 *
 * The distinction this file encodes is the one that makes the provisional baseline honest: **knowing that an
 * instrument exists is not knowing what it requires of this company.** Every rule in the register records how
 * well its source was actually verified, so a row sourced from secondary reporting can never be mistaken for
 * one read in the primary text.
 *
 * At the time this baseline was approved, **no Egyptian primary legal text had been read**, and the Central
 * Bank's own pages were unreachable. Every Egyptian-law row is therefore `SECONDARY_REPORTING_ONLY`, and the
 * test suite asserts that none has been quietly upgraded.
 */

export const SOURCE_VERIFICATION_LEVELS = Object.freeze([
  /** The primary instrument was read. No row in the provisional baseline carries this. */
  'PRIMARY_TEXT_READ',
  /** The instrument's existence and nominal domain were confirmed through reporting about it. */
  'SECONDARY_REPORTING_ONLY',
  /** The rule derives from this project's own approved specification or schema, not from external law. */
  'PROJECT_CLAUSE_ONLY',
  /** Neither confirmed nor read. */
  'UNVERIFIED',
] as const);
export type SourceVerification = (typeof SOURCE_VERIFICATION_LEVELS)[number];

/** Where a provisional rule's stated basis comes from. */
export interface ComplianceSource {
  /** The instrument or project clause, named as it is cited. */
  readonly instrument: string;
  /** As precise as is actually known. Never narrowed beyond what was verified. */
  readonly sourceDate: string;
  /** A URL or a specification reference. */
  readonly authoritativeReference: string;
  readonly verification: SourceVerification;
}

/** Whether a source is one of this project's own clauses rather than external law. */
export function isProjectSource(source: ComplianceSource): boolean {
  return source.verification === 'PROJECT_CLAUSE_ONLY';
}

/**
 * Whether a source may be relied on as stating a legal requirement.
 *
 * Only a primary text can, and no row in the provisional baseline has one — which is precisely why every
 * rule in the baseline is a fail-closed posture rather than a requirement.
 */
export function statesALegalRequirement(source: ComplianceSource): boolean {
  return source.verification === 'PRIMARY_TEXT_READ';
}
