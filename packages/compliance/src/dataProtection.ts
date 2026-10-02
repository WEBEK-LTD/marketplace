import type { PendingPolicy } from './policy.js';
import { pendingPolicy } from './policy.js';

/**
 * The processing-purpose register, and the permanently disabled destination-access capability.
 *
 * **Every purpose's lawful basis is pending.** The register records *what* is processed and *why the project
 * processes it* — both facts about this system, already true of the schema — and leaves the legal basis to
 * BD-17. Inventing a basis is the one thing this file must not do, so there is no constructor that supplies
 * one.
 *
 * Only purposes the repository already has are listed. No purpose was added to anticipate a future feature.
 */

/** A purpose this system already processes personal data for. */
export interface ProcessingPurpose {
  readonly purposeId: string;
  /** What is processed, and why this system does it. A fact about the schema, not a legal basis. */
  readonly description: string;
  /** The tables or stores involved, as they exist today. */
  readonly dataLocations: readonly string[];
  /** Pending throughout the provisional baseline. */
  readonly legalBasis: PendingPolicy;
}

function purpose(
  purposeId: string,
  description: string,
  dataLocations: readonly string[],
  reason: string,
): ProcessingPurpose {
  return Object.freeze({
    purposeId,
    description,
    dataLocations: Object.freeze([...dataLocations]),
    legalBasis: pendingPolicy('PENDING_COUNSEL', reason),
  });
}

export const PROCESSING_PURPOSES: readonly ProcessingPurpose[] = Object.freeze([
  purpose(
    'seller-payout-destination',
    'Holding where a seller is to be paid, as an encrypted secret reference or an opaque provider token, with only a masked form readable.',
    ['public.payout_destinations'],
    'the lawful basis for holding destination details, and for any access to them, is undetermined (BD-17)',
  ),
  purpose(
    'seller-balance-record',
    'Recording what the platform owes each seller, per currency, as a cache of the ledger.',
    ['public.seller_balances', 'public.ledger_entries', 'public.ledger_journals'],
    'the lawful basis and any seller disclosure requirement are undetermined (BD-05, BD-17)',
  ),
  purpose(
    'withdrawal-request',
    'Recording a seller withdrawal request, its review and its approval, including who reviewed and who approved it.',
    ['public.withdrawals'],
    'the lawful basis and the obligations attaching to review are undetermined (BD-06, BD-17)',
  ),
  purpose(
    'payout-record',
    'Recording a disbursement against an approved withdrawal, including the masked destination as it read at the time.',
    ['public.payouts', 'public.payout_transactions'],
    'the lawful basis and the records required for a disbursement are undetermined (BD-08, BD-09, BD-17)',
  ),
  purpose(
    'financial-audit-trail',
    'Recording every change to a financial record in an append-only audit log, with secret references redacted.',
    ['audit.audit_logs'],
    'the lawful basis, and the retention of the trail, are undetermined (BD-18, BD-19)',
  ),
]);

export function processingPurpose(purposeId: string): ProcessingPurpose | undefined {
  return PROCESSING_PURPOSES.find((entry) => entry.purposeId === purposeId);
}

// ---------------------------------------------------------------------------------------------------
// Authorized destination access — the hook, permanently disabled
// ---------------------------------------------------------------------------------------------------
/**
 * The architectural hook for an authorised disclosure flow, in its only state.
 *
 * **A hook that a setting can switch on is not a hook; it is a disclosure mechanism with a default.** So the
 * state union has one member, there is no enable function, and `permissionKey` is `null` rather than a guessed
 * name — inventing a permission key would pre-empt MV1-15 and, because a seeded key is effectively permanent,
 * would be very hard to withdraw.
 *
 * What the capability records is the *shape of the conditions* a future flow would have to satisfy, every one
 * of which is itself pending: which permission, which assurance level, what is logged, what is redacted, how
 * long the log is kept.
 */
export const DESTINATION_ACCESS_STATES = Object.freeze(['DISABLED_PENDING_COUNSEL'] as const);
export type DestinationAccessState = (typeof DESTINATION_ACCESS_STATES)[number];

export interface AuthorizedPayoutDestinationAccess {
  readonly state: DestinationAccessState;
  /** Null until MV1-15 names one. Never a guessed key. */
  readonly permissionKey: null;
  /** Whether a step-up grant at the higher assurance level would be required. Pending. */
  readonly stepUpRequirement: PendingPolicy;
  /** What must be logged about an access. Pending. */
  readonly accessLogging: PendingPolicy;
  /** What must be redacted. Pending. */
  readonly redaction: PendingPolicy;
  /** How long an access record is kept. Pending. */
  readonly retention: PendingPolicy;
  /** The question whose answer would unlock this. */
  readonly counselDependency: string;
}

export const authorizedPayoutDestinationAccess: AuthorizedPayoutDestinationAccess = Object.freeze({
  state: 'DISABLED_PENDING_COUNSEL',
  permissionKey: null,
  stepUpRequirement: pendingPolicy('DISABLED_PENDING_COUNSEL', 'the assurance level required for access is undetermined (BD-18)'),
  accessLogging: pendingPolicy('DISABLED_PENDING_COUNSEL', 'what must be recorded about an access is undetermined (BD-18)'),
  redaction: pendingPolicy('DISABLED_PENDING_COUNSEL', 'what must be redacted is undetermined (BD-18)'),
  retention: pendingPolicy('DISABLED_PENDING_COUNSEL', 'how long an access record is kept is undetermined (BD-19)'),
  counselDependency: 'B1-D (BD-17, BD-18, BD-19); owner decisions MV1-09 and MV1-15',
});

/**
 * Whether destination details may be disclosed to an operator. Always `false`.
 *
 * Written as a function so a future increment can replace its body against a written finding, and so that no
 * caller reads a mutable flag. There is no counterpart that enables disclosure.
 */
export function destinationDisclosurePermitted(): false {
  return false;
}
