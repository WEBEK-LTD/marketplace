import type { CounselEvidence } from './counsel.js';
import { isUsableCounselEvidence } from './counsel.js';
import { isForbiddenResolvedValue } from './status.js';

/**
 * The fail-closed policy value. This is the mechanism the whole provisional baseline rests on.
 *
 * A policy is either **pending** — a question counsel has not answered — or **resolved**, and a resolved
 * value cannot be constructed without usable written evidence. There is deliberately **no accessor that
 * returns a default**: `requirePolicyValue` throws on a pending policy rather than yielding zero, exempt,
 * taxable, permitted or anything else. A caller must branch on the state explicitly, which is what stops a
 * pending answer from quietly becoming a financial fact.
 *
 * The owner's instruction was that an unresolved value must not be treated as zero, nor silently as exempt,
 * nor silently as taxable. Three states are therefore represented, not two: pending is its own state and is
 * never a number.
 */

/** Why a policy has no value yet. These are statuses, not placeholders for an answer. */
export const PENDING_STATUSES = Object.freeze([
  'PENDING_COUNSEL',
  'PENDING_TAX_REVIEW',
  'PROVISIONAL_PENDING_TAX_REVIEW',
  'COUNSEL_REVIEW_REQUIRED',
  'LEGAL_REVIEW_PENDING',
  'DISABLED_PENDING_COUNSEL',
] as const);
export type PendingStatus = (typeof PENDING_STATUSES)[number];

/**
 * What a resolved policy carries.
 *
 * **There is no rate, amount, period or boolean field here, and that absence is deliberate.** Adding one
 * would presuppose the shape of an answer nobody has given — that a tax question resolves to a percentage,
 * or a retention question to a number of days. Counsel's determination is recorded as the text they wrote,
 * and a later increment may narrow the shape once the shape is known.
 */
export interface CounselDetermination {
  /** The determination, as written in the evidence. Never a value this package derived. */
  readonly determination: string;
}

export interface PendingPolicy {
  readonly state: 'pending';
  readonly pendingStatus: PendingStatus;
  /** What is unanswered, and which question answers it. */
  readonly reason: string;
}

export interface ResolvedPolicy {
  readonly state: 'resolved';
  readonly determination: CounselDetermination;
  readonly evidence: CounselEvidence;
}

export type PolicyValue = PendingPolicy | ResolvedPolicy;

export function isPending(policy: PolicyValue): policy is PendingPolicy {
  return policy.state === 'pending';
}

export function isResolved(policy: PolicyValue): policy is ResolvedPolicy {
  return policy.state === 'resolved';
}

/** Records an unanswered question. The only constructor the provisional baseline uses. */
export function pendingPolicy(pendingStatus: PendingStatus, reason: string): PendingPolicy {
  if (reason.trim().length === 0) throw new PolicyEvidenceError('a pending policy must say what is unanswered');
  return Object.freeze({ state: 'pending', pendingStatus, reason });
}

/**
 * Records a determination counsel actually made.
 *
 * Refuses incomplete or unaccepted evidence, and refuses a determination that is one of the words this
 * package may never emit as a conclusion. Both refusals are deliberate: the first keeps a resolved value
 * traceable to a written finding, the second keeps a one-word "permitted" out of the register even if a
 * caller passes it.
 */
export function resolvedPolicy(determination: CounselDetermination, evidence: CounselEvidence): ResolvedPolicy {
  if (determination.determination.trim().length === 0) {
    throw new PolicyEvidenceError('a resolved policy must record the determination');
  }
  if (isForbiddenResolvedValue(determination.determination)) {
    throw new PolicyEvidenceError(
      `"${determination.determination}" is not a determination: record what counsel wrote, not a verdict word`,
    );
  }
  if (!isUsableCounselEvidence(evidence)) {
    throw new PolicyEvidenceError('a policy may only be resolved by complete, received and accepted evidence');
  }
  return Object.freeze({ state: 'resolved', determination: Object.freeze(determination), evidence });
}

/** A policy was asked for its value while the question is still open. */
export class PolicyPendingError extends Error {
  readonly pendingStatus: PendingStatus;
  readonly reason: string;

  constructor(policy: PendingPolicy, context: string) {
    super(`${context}: ${policy.pendingStatus} — ${policy.reason}`);
    this.name = 'PolicyPendingError';
    this.pendingStatus = policy.pendingStatus;
    this.reason = policy.reason;
  }
}

/** Evidence or a determination was rejected. */
export class PolicyEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyEvidenceError';
  }
}

/**
 * Reads a policy's determination, or throws.
 *
 * This is the only read path, and it has no second parameter. A `requirePolicyValue(policy, fallback)`
 * signature is exactly what the owner's instruction rules out, so the fallback does not exist.
 */
export function requirePolicyValue(policy: PolicyValue, context: string): CounselDetermination {
  if (isPending(policy)) throw new PolicyPendingError(policy, context);
  return policy.determination;
}
