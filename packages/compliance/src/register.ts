import type { PolicyValue } from './policy.js';
import { isResolved, pendingPolicy } from './policy.js';
import type { ComplianceSource } from './sources.js';
import { statesALegalRequirement } from './sources.js';
import type { CounselOverrideState, CounselStatus } from './counsel.js';
import { isForbiddenResolvedValue } from './status.js';

/**
 * The provisional compliance register: the twenty-two fail-closed rules the owner approved on 2026-10-01.
 *
 * Every row is a **posture**, never a requirement. Each one is conservative whichever way the corresponding
 * legal or tax question is answered, which is why building it asserts nothing. The `derivesFromLegalInterpretation`
 * field is typed as the literal `false` so a row that began interpreting law would not compile, and
 * `complianceRegisterProblems()` re-checks the same invariants at runtime in the style of the database's own
 * `security_contract_problems()` and `audit_attribution_problems()`.
 *
 * **What this register does not do:** it closes no blocker, it changes no status, it enables nothing, and it
 * is imported by no production code. A future counsel finding replaces a row's policy through the override
 * lifecycle in `counsel.ts`; nothing in the financial architecture has to be rewritten for that to happen.
 */

export const COMPLIANCE_CATEGORIES = Object.freeze([
  'PAYMENTS',
  'FUNDS_HOLDING',
  'PAYOUTS',
  'DATA_PROTECTION',
  'CROSS_BORDER',
  'TAX',
  'VAT',
  'INVOICING',
  'WITHHOLDING',
  'RECORD_RETENTION',
] as const);
export type ComplianceCategory = (typeof COMPLIANCE_CATEGORIES)[number];

/** The date the owner approved this baseline. Nothing in this package reads a clock. */
export const BASELINE_EFFECTIVE_FROM = '2026-10-01';

export interface ComplianceRule {
  readonly ruleId: string;
  readonly category: ComplianceCategory;
  /** The fail-closed posture, in one sentence. */
  readonly currentProvisionalRule: string;
  readonly source: ComplianceSource;
  /** Fixed. Nothing in this register is better than provisional. */
  readonly confidence: 'PROVISIONAL';
  /**
   * Typed as the literal `false`: a row that derived its posture from a reading of law could not be added
   * without changing this type, which is the point.
   */
  readonly derivesFromLegalInterpretation: false;
  /** Whether satisfying this rule is a precondition for moving real money. */
  readonly blocksLiveMoney: boolean;
  readonly counselStatus: CounselStatus;
  readonly counselOverride: CounselOverrideState;
  readonly effectiveFrom: string;
  /** `null` until a counsel finding supersedes the posture. */
  readonly effectiveUntil: string | null;
  /** What in the project is waiting on this. */
  readonly implementationDependency: string;
  /** The rule's value. Pending throughout the provisional baseline. */
  readonly policy: PolicyValue;
}

// ---------------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------------
// Egyptian instruments were existence-verified only; the Central Bank's own pages were unreachable when
// this baseline was prepared. They are therefore all SECONDARY_REPORTING_ONLY, and none of them is the
// basis of a rule — each is named so counsel knows which instrument the question belongs to.

// Both instruments the approved matrix cited for PAY-P01, in one source: the licensing rules are the
// operative instrument and the banking law is the framework they sit under. Neither was read.
const PAYMENT_LICENSING_RULES: ComplianceSource = Object.freeze({
  instrument:
    'Central Bank of Egypt, rules for the licensing and registration of payment system operators and payment service providers, under the framework of Central Bank and Banking System Law No. 194 of 2020',
  sourceDate: '2025-06',
  authoritativeReference:
    'https://www.cbe.org.eg/en/payment-systems-and-services/payment-systems-and-services-oversight/psos-and-psps-licensing-rules',
  verification: 'SECONDARY_REPORTING_ONLY',
});

const DATA_PROTECTION_LAW: ComplianceSource = Object.freeze({
  instrument: 'Egypt, Personal Data Protection Law No. 151 of 2020, with its executive regulations issued in 2025',
  sourceDate: '2025',
  authoritativeReference: 'https://www.dataguidance.com/jurisdictions/egypt',
  verification: 'SECONDARY_REPORTING_ONLY',
});

const TAX_FRAMEWORK: ComplianceSource = Object.freeze({
  instrument:
    'Egyptian Tax Authority framework: value added tax and unified tax procedures legislation, with the amendments enacted in 2025',
  sourceDate: '2025',
  authoritativeReference: 'https://taxsummaries.pwc.com/egypt/corporate/other-taxes',
  verification: 'SECONDARY_REPORTING_ONLY',
});

/** A rule whose basis is this project's own approved specification or schema. */
function projectSource(clause: string, reference: string): ComplianceSource {
  return Object.freeze({
    instrument: clause,
    sourceDate: 'v5.2 rev 144',
    authoritativeReference: reference,
    verification: 'PROJECT_CLAUSE_ONLY',
  });
}

// ---------------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------------
function rule(
  ruleId: string,
  category: ComplianceCategory,
  currentProvisionalRule: string,
  source: ComplianceSource,
  blocksLiveMoney: boolean,
  implementationDependency: string,
  policy: PolicyValue,
): ComplianceRule {
  return Object.freeze({
    ruleId,
    category,
    currentProvisionalRule,
    source,
    confidence: 'PROVISIONAL',
    derivesFromLegalInterpretation: false,
    blocksLiveMoney,
    counselStatus: 'PENDING',
    counselOverride: 'COUNSEL_OVERRIDE_PENDING',
    effectiveFrom: BASELINE_EFFECTIVE_FROM,
    effectiveUntil: null,
    implementationDependency,
    policy,
  });
}

export const PROVISIONAL_BASELINE: readonly ComplianceRule[] = Object.freeze([
  // --- PAYMENTS -----------------------------------------------------------------------------------
  rule(
    'PAY-P01',
    'PAYMENTS',
    'The regulatory classification of this company is recorded as requiring counsel review. No code asserts that the company is, or is not, a payment service provider or payment system operator, and none declares an exemption.',
    PAYMENT_LICENSING_RULES,
    true,
    'B1-D (BD-01, BD-02); UB8',
    pendingPolicy('COUNSEL_REVIEW_REQUIRED', 'whether and how the licensing regime reaches this marketplace is undetermined'),
  ),
  rule(
    'PAY-P02',
    'PAYMENTS',
    'No payment provider, payout provider, bank or instrument is selected, referenced or configured; provider injection tokens stay provided as null.',
    projectSource('B1-A and B1-B remain OPEN; no adapter exists until B1-A closes', 'spec v5.2 rev 144, B1-A and B1-B'),
    true,
    'B1-A; B1-B',
    pendingPolicy('COUNSEL_REVIEW_REQUIRED', 'no provider is selected and none may be assumed'),
  ),

  // --- FUNDS_HOLDING ------------------------------------------------------------------------------
  rule(
    'FUND-P01',
    'FUNDS_HOLDING',
    'The platform-held-balances decision is recorded as a selected product model with its legal review pending. No artefact states that holding seller funds is permitted, licensed or approved.',
    projectSource('BC-01 recorded; "Nothing in this specification is legal approval"', 'spec v5.2 rev 144, B1-D'),
    true,
    'B1-C; B1-D (BD-01, BD-02); UB8',
    pendingPolicy('LEGAL_REVIEW_PENDING', 'the legal character of holding funds owed to sellers is undetermined'),
  ),
  rule(
    'FUND-P02',
    'FUNDS_HOLDING',
    'The holding arrangement and segregation remain undefined. No account, field, flag or configuration representing a segregation arrangement is introduced.',
    projectSource('BC-03 is an open owner decision', 'spec v5.2 rev 144, B1-C'),
    true,
    'BC-03; B1-D (BD-03)',
    pendingPolicy('PENDING_COUNSEL', 'whether segregation or safeguarding is required, and to what standard, is undetermined'),
  ),
  rule(
    'FUND-P03',
    'FUNDS_HOLDING',
    'Seller balances remain non-negative. The three existing zero-floor constraints are not removed, relaxed or bypassed, and no negative-balance representation is introduced.',
    projectSource('migration 0021 zero-floor constraints; D21 BLOCKED', 'supabase/migrations/0021_ledger_balances_withdrawals.sql'),
    true,
    'D21; B1-B; B1-D (BD-21, BD-22)',
    pendingPolicy('PENDING_COUNSEL', 'whether a negative seller balance is permissible and enforceable is undetermined'),
  ),
  rule(
    'FUND-P04',
    'FUNDS_HOLDING',
    'The pending-to-available-to-reserved progression, the configurable completion hold and the withdrawal reservation mechanics are retained unchanged, with no production hold value set.',
    projectSource('BC-08 and BC-09 recorded', 'supabase/migrations/0021_ledger_balances_withdrawals.sql'),
    true,
    'B1-C; B1-D (BD-04, BD-05)',
    pendingPolicy('LEGAL_REVIEW_PENDING', 'the permissible holding duration and the adequacy of a ledger-derived balance are undetermined'),
  ),

  // --- PAYOUTS ------------------------------------------------------------------------------------
  rule(
    'POUT-P01',
    'PAYOUTS',
    'The manual payout direction is a design only. No payout executes, no funds move, no bank or provider is contacted and no live instrument is exposed.',
    projectSource('G11 financial boundary; UB8', 'spec v5.2 rev 144, G11'),
    true,
    'B1-B; UB8; B1-D (BD-07, BD-08, BD-10)',
    pendingPolicy('PENDING_COUNSEL', 'the obligations arising from company-executed disbursement are undetermined'),
  ),
  rule(
    'POUT-P02',
    'PAYOUTS',
    'No payout mechanism row, provider row or capability row is created; the payout provider table stays empty and no placeholder documentary reference is written.',
    projectSource(
      'migration 0022: empty until B1-B closes; capability evidence_url is not null and must be an https reference',
      'supabase/migrations/0022_payouts.sql',
    ),
    false,
    'B1-B (MV1-03, MV1-04)',
    pendingPolicy('PENDING_COUNSEL', 'how an internal mechanism would be represented is an open owner decision, not a legal one'),
  ),
  rule(
    'POUT-P03',
    'PAYOUTS',
    'The authoritative payout reconciliation source remains undefined; no reconciliation source, statement format, period or cadence is introduced.',
    projectSource('BC-04 and BC-05 are open owner decisions', 'supabase/migrations/0023_provider_settlements.sql'),
    true,
    'BC-04; BC-05; B1-C',
    pendingPolicy('PENDING_COUNSEL', 'no counterparty statement exists for a company-executed disbursement'),
  ),
  rule(
    'POUT-P04',
    'PAYOUTS',
    'The settlement posting gate stays off, so no settlement journal posts. No scaffolding may reach a writer that creates a permanent financial journal.',
    projectSource('finance.settlement_posting_enabled ships false; reconcile_settlement answers posting_blocked', 'supabase/migrations/0023_provider_settlements.sql'),
    true,
    'B1-C (BC-06, BC-07); UB8',
    pendingPolicy('LEGAL_REVIEW_PENDING', 'the settlement model and its review are both open'),
  ),

  // --- DATA_PROTECTION ----------------------------------------------------------------------------
  rule(
    'DATA-P01',
    'DATA_PROTECTION',
    'Privacy-by-design postures are the provisional default: data minimisation, purpose limitation, least-privilege access, server-side access control, auditability, secret redaction in logs, retention as configuration and erasure as configuration.',
    projectSource(
      'the S8 privilege model, row level security on every table, audit redaction, and the rule that retention is configurable',
      'spec v5.2 rev 144, privilege model and logging rules',
    ),
    false,
    'B1-D (BD-17, BD-18, BD-19); C18',
    pendingPolicy('PENDING_COUNSEL', 'the specific obligations of the data-protection regime are undetermined'),
  ),
  rule(
    'DATA-P02',
    'DATA_PROTECTION',
    'No lawful basis is asserted for any processing purpose. The purpose register records what is processed and why, and leaves the basis pending.',
    DATA_PROTECTION_LAW,
    false,
    'B1-D (BD-17)',
    pendingPolicy('PENDING_COUNSEL', 'which lawful basis applies to each processing purpose is undetermined'),
  ),
  rule(
    'DATA-P03',
    'DATA_PROTECTION',
    'Authorized access to payout destination details is disabled. No plaintext destination field is added, no encrypted secret is exposed, and the capability has no state that configuration alone can open.',
    projectSource(
      'migration 0022 holds destination details as a vault secret or a provider token, and only masked values are displayed',
      'supabase/migrations/0022_payouts.sql',
    ),
    true,
    'MV1-09; MV1-15; B1-D (BD-17, BD-18)',
    pendingPolicy('DISABLED_PENDING_COUNSEL', 'the basis and conditions for operator access to destination details are undetermined'),
  ),
  rule(
    'DATA-P04',
    'DATA_PROTECTION',
    'Access to destination records is recorded as requiring a read log. The project currently audits changes to those records and does not log reads.',
    projectSource('migration 0022 audits changes with both secret references redacted', 'supabase/migrations/0022_payouts.sql'),
    false,
    'B1-D (BD-18, BD-19); C18',
    pendingPolicy('PENDING_COUNSEL', 'what must be logged about an access, and for how long it is kept, is undetermined'),
  ),

  // --- CROSS_BORDER ------------------------------------------------------------------------------
  rule(
    'XB-P01',
    'CROSS_BORDER',
    'No data residency is assumed and no region is selected. No adequacy finding and no transfer mechanism is asserted or implied; hosting region and cross-border policy are configuration with no default.',
    projectSource(
      'the specification records that proximity is not residency, and that the residency input is required before Phase 2',
      'spec v5.2 rev 144, O-2 and Gate C',
    ),
    false,
    'O-2; C18; B1-D (BD-20); Gate C',
    pendingPolicy('LEGAL_REVIEW_PENDING', 'permissible processing locations and any transfer mechanism are undetermined'),
  ),

  // --- TAX ---------------------------------------------------------------------------------------
  rule(
    'TAX-P01',
    'TAX',
    'Tax, commission-tax, seller-proceeds and buyer-fee policies are pending review. An unresolved value is neither zero, nor exempt, nor taxable, and a computation that reaches one refuses rather than producing a number.',
    TAX_FRAMEWORK,
    true,
    'B1-D (BD-11, BD-12, BD-13, BD-15)',
    pendingPolicy('PENDING_TAX_REVIEW', 'no rate, characterisation, recognition point or treatment has been determined'),
  ),
  rule(
    'TAX-P02',
    'TAX',
    'Recognition timing is not fixed. That the existing checkout journal recognises commission, tax and buyer fees at fulfilment is recorded as the current implementation, not as a determined treatment.',
    projectSource('BC-02 retained the existing checkout journal', 'supabase/migrations/0021_ledger_balances_withdrawals.sql'),
    true,
    'B1-C; B1-D (BD-11, BD-15)',
    pendingPolicy('PENDING_TAX_REVIEW', 'whether the current recognition points are correct is undetermined'),
  ),

  // --- VAT ---------------------------------------------------------------------------------------
  rule(
    'VAT-P01',
    'VAT',
    'The value-added-tax policy is pending review. No rate is hard-coded, defaulted or seeded anywhere.',
    TAX_FRAMEWORK,
    true,
    'B1-D (BD-15)',
    pendingPolicy('PENDING_TAX_REVIEW', 'no rate, scope, sector treatment or registration threshold has been determined'),
  ),

  // --- INVOICING ---------------------------------------------------------------------------------
  rule(
    'INV-P01',
    'INVOICING',
    'The tax-document policy is provisional and pending review. No invoice or receipt type is assumed for any transaction, and no proof-of-payment format is designed.',
    TAX_FRAMEWORK,
    false,
    'MV1-08; B1-D (BD-09, BD-15, BD-16)',
    pendingPolicy('PROVISIONAL_PENDING_TAX_REVIEW', 'which documents must be issued, to whom, in what form and on what trigger is undetermined'),
  ),

  // --- WITHHOLDING -------------------------------------------------------------------------------
  rule(
    'WHT-P01',
    'WITHHOLDING',
    'Withholding and reporting policies are pending review. No percentage and no threshold exists in any form, and whether these questions are even in scope is itself undetermined.',
    projectSource(
      "the project's own review scope names commission treatment and taxes, and names neither withholding nor reporting",
      'spec v5.2 rev 144, B1-D',
    ),
    false,
    'B1-D (BD-16, scope first)',
    pendingPolicy('PENDING_TAX_REVIEW', 'the scope question precedes the treatment question and neither is answered'),
  ),

  // --- RECORD_RETENTION --------------------------------------------------------------------------
  rule(
    'RET-P01',
    'RECORD_RETENTION',
    'Retention is a central policy layer in which every unresolved value is pending. No legal retention period is hard-coded.',
    projectSource(
      "C18's retention values come from the legal review, and D24 forbids a hard-coded legal period",
      'spec v5.2 rev 144, C18 and D24',
    ),
    false,
    'C18; D24; B1-D (BD-19)',
    pendingPolicy('PENDING_COUNSEL', 'no retention period has been determined for any category'),
  ),
  rule(
    'RET-P02',
    'RECORD_RETENTION',
    'The existing no-delete design is retained: destinations are disabled rather than deleted, the ledger and audit log remain append-only, and the masked destination snapshot is kept against each payout record.',
    projectSource(
      'migration 0022 grants no delete on destinations; the ledger corrects by reversing journals and the audit log is append-only',
      'supabase/migrations/0021_ledger_balances_withdrawals.sql',
    ),
    false,
    'C18; B1-D (BD-19)',
    pendingPolicy('PENDING_COUNSEL', 'whether an erasure obligation meets these append-only records is undetermined'),
  ),
]);

// ---------------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------------
export function complianceRule(ruleId: string): ComplianceRule | undefined {
  return PROVISIONAL_BASELINE.find((entry) => entry.ruleId === ruleId);
}

export function rulesForCategory(category: ComplianceCategory): readonly ComplianceRule[] {
  return PROVISIONAL_BASELINE.filter((entry) => entry.category === category);
}

/** The rules that must be satisfied before real money may move. None is satisfied. */
export function rulesBlockingLiveMoney(): readonly ComplianceRule[] {
  return PROVISIONAL_BASELINE.filter((entry) => entry.blocksLiveMoney);
}

// ---------------------------------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------------------------------
/**
 * Everything wrong with the register, in the style of the database's own `*_problems()` guards: an empty
 * array is the only acceptable answer, and the test suite asserts it.
 *
 * These are not stylistic checks. Each one corresponds to a way the provisional layer could silently become
 * a permanent legal fact.
 */
export function complianceRegisterProblems(): readonly string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const entry of PROVISIONAL_BASELINE) {
    if (seen.has(entry.ruleId)) problems.push(`${entry.ruleId} is listed more than once`);
    seen.add(entry.ruleId);

    if (entry.confidence !== 'PROVISIONAL') problems.push(`${entry.ruleId} claims a confidence above provisional`);
    if (entry.derivesFromLegalInterpretation !== false) {
      problems.push(`${entry.ruleId} derives from a legal interpretation`);
    }
    if (entry.currentProvisionalRule.trim().length === 0) problems.push(`${entry.ruleId} states no rule`);
    if (entry.implementationDependency.trim().length === 0) problems.push(`${entry.ruleId} names no dependency`);
    if (entry.source.instrument.trim().length === 0) problems.push(`${entry.ruleId} names no source`);
    if (entry.source.authoritativeReference.trim().length === 0) problems.push(`${entry.ruleId} cites no reference`);

    // A rule may not claim to state a legal requirement: no primary text was read for this baseline.
    if (statesALegalRequirement(entry.source)) {
      problems.push(`${entry.ruleId} claims a primary text was read`);
    }

    // A pending question may not be recorded as resolved while its counsel status is still pending.
    if (isResolved(entry.policy) && entry.counselStatus !== 'RECEIVED') {
      problems.push(`${entry.ruleId} is resolved without a received finding`);
    }
    if (isResolved(entry.policy) && entry.counselOverride !== 'COUNSEL_OVERRIDE_ACCEPTED') {
      problems.push(`${entry.ruleId} is resolved without an accepted override`);
    }
    if (isResolved(entry.policy) && isForbiddenResolvedValue(entry.policy.determination.determination)) {
      problems.push(`${entry.ruleId} records a verdict word as its determination`);
    }
    if (entry.effectiveUntil !== null && entry.counselStatus === 'PENDING') {
      problems.push(`${entry.ruleId} has been superseded without a finding`);
    }
  }

  for (const category of COMPLIANCE_CATEGORIES) {
    if (rulesForCategory(category).length === 0) problems.push(`category ${category} has no rule`);
  }

  return problems;
}
