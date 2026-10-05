import type { PendingPolicy } from './policy.js';
import { pendingPolicy } from './policy.js';

/**
 * The central retention policy layer.
 *
 * **No period exists anywhere in this file.** Not a number of days, not a number of years, not a default.
 * This is the strongest-grounded part of the provisional baseline, because it is not a new posture at all:
 * the project already requires that retention values come from the legal review, and D24 already forbids a
 * hard-coded legal period. Centralising the question therefore asserts nothing new.
 *
 * Only subjects the repository actually holds are listed. Each names the store it concerns so that a finding
 * can be applied without searching for what it covers.
 */

export interface RetentionSubject {
  readonly subjectId: string;
  /** What is retained. */
  readonly description: string;
  /** Where it lives today. */
  readonly dataLocations: readonly string[];
  /**
   * Whether the store is append-only as built. Recorded because an erasure obligation, if one is found, would
   * meet an append-only financial record — a tension BD-19 resolves and this layer must not pre-empt.
   */
  readonly appendOnly: boolean;
  /** Pending throughout the provisional baseline. */
  readonly period: PendingPolicy;
}

function subject(
  subjectId: string,
  description: string,
  dataLocations: readonly string[],
  appendOnly: boolean,
  reason: string,
): RetentionSubject {
  return Object.freeze({
    subjectId,
    description,
    dataLocations: Object.freeze([...dataLocations]),
    appendOnly,
    period: pendingPolicy('PENDING_COUNSEL', reason),
  });
}

export const RETENTION_SUBJECTS: readonly RetentionSubject[] = Object.freeze([
  subject(
    'payout-destination',
    'Seller payout destination records, held as an encrypted secret reference or an opaque provider token with a masked display form.',
    ['public.payout_destinations'],
    false,
    'no retention period has been determined (BD-19); the schema grants no delete, so a destination is disabled rather than removed',
  ),
  subject(
    'payout-record',
    'Disbursement records, including the masked destination snapshot kept so the historical record stays accurate.',
    ['public.payouts', 'public.payout_transactions'],
    true,
    'no retention period has been determined (BD-19); the snapshot is retained indefinitely by design',
  ),
  subject(
    'ledger',
    'Double-entry journals and entries, corrected only by reversing journals.',
    ['public.ledger_journals', 'public.ledger_entries'],
    true,
    'no retention period has been determined (BD-19); an erasure obligation would meet an append-only record',
  ),
  subject(
    'financial-audit-log',
    'The audit trail of every change to a financial record.',
    ['audit.audit_logs'],
    true,
    'no retention period has been determined (BD-19)',
  ),
  subject(
    'provider-webhook-receipt',
    'Verified webhook receipts, stored as a digest of the body and never the body itself.',
    ['public.payment_events', 'public.payout_events'],
    true,
    'no retention period has been determined (BD-19)',
  ),
  subject(
    'unverified-account',
    'Accounts that were never verified, which the project purges on an administrator-configured schedule with no hard-coded legal period.',
    ['auth.users'],
    false,
    'the purge schedule depends on the retention values, which are undetermined (D24, C18, BD-19)',
  ),
]);

export function retentionSubject(subjectId: string): RetentionSubject | undefined {
  return RETENTION_SUBJECTS.find((entry) => entry.subjectId === subjectId);
}

/** The subjects whose retention period is still unanswered. Currently every one of them. */
export function unresolvedRetentionSubjects(): readonly RetentionSubject[] {
  return RETENTION_SUBJECTS.filter((entry) => entry.period.state === 'pending');
}
