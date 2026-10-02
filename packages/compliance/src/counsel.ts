/**
 * Counsel override lifecycle and the evidence a written finding must carry.
 *
 * The point of this file is that **a provisional rule can only be replaced by evidence, never by a
 * configuration change.** `CounselEvidence` is the sole key that unlocks a resolved policy value in
 * `policy.ts`, and an incomplete or unaccepted record cannot construct one. That is the mechanism by which
 * "future counsel findings replace the provisional layer" is true in the type system rather than only in a
 * document.
 *
 * **No future answer is fabricated here.** There is no default evidence object, no sample finding and no
 * helper that invents a determination. Every field must come from a real written output.
 */

/** Whether a written finding has been received for a rule. */
export const COUNSEL_STATUSES = Object.freeze(['PENDING', 'RECEIVED', 'SUPERSEDED'] as const);
export type CounselStatus = (typeof COUNSEL_STATUSES)[number];

/** Whether a received finding has been accepted as replacing the provisional rule. */
export const COUNSEL_OVERRIDE_STATES = Object.freeze([
  'COUNSEL_OVERRIDE_PENDING',
  'COUNSEL_OVERRIDE_ACCEPTED',
  'COUNSEL_OVERRIDE_REJECTED',
] as const);
export type CounselOverrideState = (typeof COUNSEL_OVERRIDE_STATES)[number];

/** `YYYY-MM-DD`. Dates are recorded as given in the written output; nothing here reads a clock. */
export const ADVICE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A written counsel finding, with everything needed to audit where a resolved value came from.
 *
 * The project already requires a documentary basis in one comparable place — `evidence_url` on
 * `payment_provider_capabilities` is `not null` and must be an `https://` URL — and this mirrors that
 * requirement for legal and tax conclusions.
 */
export interface CounselEvidence {
  /** The written output: a document reference, an engagement letter clause, or a URL. */
  readonly evidenceReference: string;
  /** Who issued it. */
  readonly counselIdentity: string;
  /** Their qualification to issue it in the jurisdiction below. */
  readonly qualification: string;
  /** The jurisdiction addressed. A finding carries no weight outside the jurisdiction it names. */
  readonly jurisdiction: string;
  /** The date of the advice. */
  readonly adviceDate: string;
  /** The date from which the project may act on it. */
  readonly effectiveFrom: string;
  /** Set once a later finding replaces this one. */
  readonly supersededAt: string | null;
  /** What in the project depends on this finding. */
  readonly implementationDependency: string;
  readonly counselStatus: CounselStatus;
  readonly counselOverride: CounselOverrideState;
}

export type CounselEvidenceProblem = string;

/** Narrowed to the plain-string fields so indexing cannot widen into the nullable or enum members. */
const NON_EMPTY = Object.freeze([
  'evidenceReference',
  'counselIdentity',
  'qualification',
  'jurisdiction',
  'implementationDependency',
] as const satisfies readonly (keyof CounselEvidence)[]);

/**
 * Why this evidence may not be used to resolve a policy. An empty array means it may.
 *
 * Fails closed in every direction: a missing field, a malformed date, a finding not yet received, or an
 * override that has not been accepted all block the resolution.
 */
export function counselEvidenceProblems(evidence: CounselEvidence): readonly CounselEvidenceProblem[] {
  const problems: CounselEvidenceProblem[] = [];
  for (const field of NON_EMPTY) {
    if (evidence[field].trim().length === 0) problems.push(`${field} must not be empty`);
  }
  for (const field of ['adviceDate', 'effectiveFrom'] as const) {
    if (!ADVICE_DATE_PATTERN.test(evidence[field])) problems.push(`${field} must be a YYYY-MM-DD date`);
  }
  if (evidence.supersededAt !== null && !ADVICE_DATE_PATTERN.test(evidence.supersededAt)) {
    problems.push('supersededAt must be null or a YYYY-MM-DD date');
  }
  if (!(COUNSEL_STATUSES as readonly string[]).includes(evidence.counselStatus)) {
    problems.push(`counselStatus ${evidence.counselStatus} is not a known status`);
  }
  if (!(COUNSEL_OVERRIDE_STATES as readonly string[]).includes(evidence.counselOverride)) {
    problems.push(`counselOverride ${evidence.counselOverride} is not a known state`);
  }
  // An accepted override presupposes a received finding: accepting something that has not arrived is the
  // exact failure this package exists to make impossible.
  if (evidence.counselOverride === 'COUNSEL_OVERRIDE_ACCEPTED' && evidence.counselStatus !== 'RECEIVED') {
    problems.push('an accepted override requires counselStatus RECEIVED');
  }
  if (evidence.counselOverride === 'COUNSEL_OVERRIDE_ACCEPTED' && evidence.supersededAt !== null) {
    problems.push('a superseded finding may not be the accepted override');
  }
  return problems;
}

/** Whether this evidence is complete and accepted, and may therefore resolve a policy. */
export function isUsableCounselEvidence(evidence: CounselEvidence): boolean {
  return counselEvidenceProblems(evidence).length === 0 && evidence.counselOverride === 'COUNSEL_OVERRIDE_ACCEPTED';
}
