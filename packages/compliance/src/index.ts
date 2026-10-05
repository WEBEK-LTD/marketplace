/**
 * `@repo/compliance` — the PROVISIONAL_EGYPT_COMPLIANCE_BASELINE layer (owner-approved 2026-10-01).
 *
 * A temporary engineering abstraction that lets development continue while external Egyptian legal, tax and
 * privacy counsel reviews the model. **It is not legal advice, not legal approval, not regulatory approval
 * and not tax approval.** It closes no blocker, changes no status, and authorizes no movement of real money.
 *
 * Nothing in the repository imports this package yet, deliberately: an unwired layer stays replaceable, and
 * keeping it unwired is how the financial architecture remains untouched by a provisional rule.
 *
 * See `README.md` for what this layer is, why each posture is safe to adopt without a legal conclusion, and
 * how a counsel finding replaces a rule without rewriting financial code.
 */

export {
  DATA_RESIDENCY_STATUS,
  FORBIDDEN_RESOLVED_VALUES,
  LEGAL_BASIS_STATUS,
  LEGAL_REVIEW_STATUS,
  MANUAL_PAYOUT_STATUS,
  SETTLEMENT_MODEL_STATUS,
  isForbiddenResolvedValue,
  type DataResidencyStatus,
  type ForbiddenResolvedValue,
  type LegalBasisStatus,
  type LegalReviewStatus,
  type ManualPayoutStatus,
  type SettlementModelStatus,
} from './status.js';

export {
  ADVICE_DATE_PATTERN,
  COUNSEL_OVERRIDE_STATES,
  COUNSEL_STATUSES,
  counselEvidenceProblems,
  isUsableCounselEvidence,
  type CounselEvidence,
  type CounselEvidenceProblem,
  type CounselOverrideState,
  type CounselStatus,
} from './counsel.js';

export {
  PENDING_STATUSES,
  PolicyEvidenceError,
  PolicyPendingError,
  isPending,
  isResolved,
  pendingPolicy,
  requirePolicyValue,
  resolvedPolicy,
  type CounselDetermination,
  type PendingPolicy,
  type PendingStatus,
  type PolicyValue,
  type ResolvedPolicy,
} from './policy.js';

export {
  SOURCE_VERIFICATION_LEVELS,
  isProjectSource,
  statesALegalRequirement,
  type ComplianceSource,
  type SourceVerification,
} from './sources.js';

export {
  BASELINE_EFFECTIVE_FROM,
  COMPLIANCE_CATEGORIES,
  PROVISIONAL_BASELINE,
  complianceRegisterProblems,
  complianceRule,
  rulesBlockingLiveMoney,
  rulesForCategory,
  type ComplianceCategory,
  type ComplianceRule,
} from './register.js';

export {
  TAX_POLICIES,
  buyerFeeTaxPolicy,
  commissionTaxPolicy,
  reportingPolicy,
  sellerProceedsTaxPolicy,
  taxDocumentPolicy,
  taxPolicy,
  vatPolicy,
  withholdingPolicy,
  type TaxPolicyName,
} from './tax.js';

export {
  PAYMENT_REGULATORY_STATES,
  PAYMENT_REGULATORY_STATUS,
  paymentRegulatoryPolicy,
  regulatoryPositionPermitsLiveMoney,
  type PaymentRegulatoryState,
} from './payments.js';

export {
  DESTINATION_ACCESS_STATES,
  PROCESSING_PURPOSES,
  authorizedPayoutDestinationAccess,
  destinationDisclosurePermitted,
  processingPurpose,
  type AuthorizedPayoutDestinationAccess,
  type DestinationAccessState,
  type ProcessingPurpose,
} from './dataProtection.js';

export {
  RETENTION_SUBJECTS,
  retentionSubject,
  unresolvedRetentionSubjects,
  type RetentionSubject,
} from './retention.js';

export {
  PROVISIONAL_FEATURE_FLAGS,
  PROVISIONAL_FEATURE_FLAG_NAMES,
  anyFlagOpen,
  isFlagOpen,
  type ProvisionalFeatureFlag,
} from './flags.js';

export {
  LIVE_MONEY_WRITERS,
  LiveMoneyBlockedError,
  assertLiveMoneyBlocked,
  isLiveMoneyWriter,
  liveMoneyPermitted,
  type LiveMoneyWriter,
} from './liveMoney.js';
