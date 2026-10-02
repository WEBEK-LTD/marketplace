# `@repo/compliance` — PROVISIONAL_EGYPT_COMPLIANCE_BASELINE

A temporary engineering layer, owner-approved on **2026-10-01**, that lets development continue while
external Egyptian legal, tax and privacy counsel reviews the marketplace funds model.

> **This package is not legal advice, not legal approval, not regulatory approval and not tax approval.**
> It does not state that any licence, registration, tax treatment, rate, obligation, permission or exemption
> applies to this company. It closes no blocker, changes no status, and authorizes no movement of real money.

---

## What this layer is, and what makes it safe

The layer records **open questions** and the project's behaviour while they are open. Every rule in it is a
**fail-closed posture that is conservative whichever way the corresponding legal question is answered.**

That property is the whole reason the layer is safe to build. A posture that holds under every possible legal
answer cannot become a false legal fact. A permissive default could, and the owner's instruction was explicit:
*do not silently turn any provisional assumption into a permanent legal fact.*

### Where the postures come from — and where they do not

**They do not come from any reading of Egyptian law.** At the time this baseline was prepared:

- no Egyptian primary legal text had been read;
- the Central Bank of Egypt's own pages were unreachable, so its licensing rules were confirmed only through
  secondary reporting;
- the instruments named in `src/register.ts` were **existence-verified only**.

Every rule therefore carries `verification: 'SECONDARY_REPORTING_ONLY'` or `'PROJECT_CLAUSE_ONLY'`, and
`statesALegalRequirement()` returns `false` for all of them. `test/sources.test.ts` asserts that no rule has
been quietly upgraded to `'PRIMARY_TEXT_READ'`.

**They come from rules this project already approved for itself:**

| Existing project rule | What the layer reuses from it |
|---|---|
`app_system` and `app_worker` hold no table privileges; all access goes through named definer functions | Least-privilege access, server-side access control |
Row level security on every table | Server-side access control |
The ledger and the audit log are append-only; corrections are reversing journals | The retention tension in `RET-P02`, and the dry-run prohibition |
`finance.settlement_posting_enabled` ships `false` and `reconcile_settlement()` answers `posting_blocked` | The fail-closed pattern this package imitates |
`payment_provider_capabilities.evidence_url` is `not null` | A resolved value must cite written evidence |
D24: *"no hard-coded legal period"* | The whole retention layer |
Logs redact personal data and secrets | Secret redaction |

Naming an Egyptian instrument in the register tells counsel **which instrument a question belongs to**. It is
never the basis of a rule.

---

## The mechanism

### A policy is pending or resolved, and resolution needs evidence

```ts
type PolicyValue = PendingPolicy | ResolvedPolicy;
```

- `pendingPolicy(status, reason)` records an open question.
- `resolvedPolicy(determination, evidence)` records a determination counsel actually made. It **refuses**
  incomplete evidence, a finding that has not been received, an override that has not been accepted, a
  superseded finding, and a bare verdict word in place of a determination.
- `requirePolicyValue(policy, context)` is the **only** read path, and it **throws** on a pending policy.

There is deliberately **no accessor that returns a default**. A `requirePolicyValue(policy, context, fallback)`
signature is exactly what the owner's rule forbids, so the parameter does not exist — `test/policy.test.ts`
asserts the function's arity to keep it that way.

### Pending is a third state, never a number

A resolved policy carries a `determination` string and nothing else. **There is no rate, amount, percentage,
period or boolean field anywhere**, because adding one would presuppose the shape of an answer nobody has
given — that a tax question resolves to a percentage, or a retention question to a number of days.

`test/pending-cannot-become.test.ts` proves a pending policy cannot silently become **zero, exempt, taxable,
permitted, licensed or approved**, including through numeric coercion, truthiness, a JSON round trip, or a
value-shaped property name.

### Permissive states do not exist in the types

Two unions have exactly one member:

```ts
type PaymentRegulatoryState = 'COUNSEL_REVIEW_REQUIRED';
type DestinationAccessState = 'DISABLED_PENDING_COUNSEL';
```

So "no reachable permissive state" is structural, not a default: a caller **cannot write** a permissive value,
and no configuration can select one. Widening either union is a code change in a future increment, made
against a written finding. `authorizedPayoutDestinationAccess.permissionKey` is `null` rather than a guessed
name, and there is no `enable`, `allow`, `permit` or `grant` function anywhere in the package.

### Flags are code, not settings

`PROVISIONAL_FEATURE_FLAGS` are TypeScript constants, all `false`. They are **not** `site_settings` rows,
because a seeded settings key is effectively permanent — removing one is a contract migration — and adding one
here would pre-empt **BC-06 Part 2**, the open question of who may authorise the settlement posting gate.
Flags in code can be deleted in a single commit.

No flag gates a money-moving or disclosure operation; `test/flags.test.ts` asserts that no flag name even
matches the vocabulary of one.

---

## How a counsel finding replaces a rule

Nothing in the financial architecture has to be rewritten.

1. The written finding arrives. It is recorded as a `CounselEvidence` object carrying the evidence reference,
   counsel identity, qualification, jurisdiction, advice date, effective date, superseded date and the
   implementation it unblocks.
2. `counselStatus` moves `PENDING → RECEIVED`.
3. `counselOverride` moves `COUNSEL_OVERRIDE_PENDING → COUNSEL_OVERRIDE_ACCEPTED` (or `REJECTED`).
4. The rule's `policy` becomes `resolvedPolicy(determination, evidence)`. That call fails unless the evidence
   is complete and accepted, so a resolved value is always traceable to a written output.
5. Callers that previously threw on `requirePolicyValue` now receive the determination. **Their code does not
   change.**

If a finding requires a schema or behaviour change — a negative balance, a disclosure flow, a retention
period — that is a separate increment behind its own blocker, not something this layer performs.

---

## What this layer deliberately does not contain

No bank, no payout instrument, no payment provider, no payout provider, no account structure beyond the
existing ledger accounts, no segregation arrangement, no reconciliation mechanism, no cross-border transfer
mechanism, no permission key, no tax rate, no value-added-tax rate, no withholding percentage, no reporting
threshold, no retention period, no invoice or proof-of-payment format, no negative-balance representation, and
no lawful basis.

Each of those is either an open owner decision or a question for counsel. The register names which.

---

## No database access, and why that matters

The package imports nothing — not a workspace package, not a framework, not a driver. The
`compliance-standalone` rule in `.dependency-cruiser.cjs` enforces it, and `test/liveMoney.test.ts` asserts
that every import is relative and that no clock, environment variable, network call or driver appears in the
source.

That is not tidiness. **A dry run that reached a money-moving writer would create a permanent record**, because
the ledger is append-only. Worse, a disbursement driven to `paid` credits `payout_clearing`, and the only
writer that discharges that account cannot post while the settlement gate is closed — so test traffic alone
could leave an undischargeable balance. That is the open **BC-07** problem, and it is why this layer is
structurally incapable of reaching those writers rather than merely configured not to.

`LIVE_MONEY_WRITERS` names the fifteen writers concerned, and `assertLiveMoneyBlocked()` refuses
unconditionally. Both are **declarations for a future caller to assert against, not controls**: the real
controls are the database privilege model, the append-only ledger, and
`finance.settlement_posting_enabled`, which remains `false`.

---

## Status at the time of writing

Unchanged by this package, and not changeable by it:

```
B1-A OPEN   B1-B OPEN   B1-C OPEN   B1-D OPEN   UB8 OPEN
D20  OPEN   D21  OPEN   RAM-1…RAM-6 OPEN
O-2  OPEN   O-3  OPEN   O-8  OPEN   O-9  OPEN   staging NOT PROVISIONED

finance.settlement_posting_enabled = FALSE

Recorded owner decisions: BC-01 platform-held balances · BC-02 existing checkout journal retained
                          BC-08 existing hold and reservation retained · BC-09 existing account meanings retained
Open owner decisions:     BC-03 holding arrangement · BC-04 reconciliation source · BC-05 cadence
                          BC-06 Part 2 posting-gate authority · BC-07 accumulated payout clearing
```

Nothing in the repository imports this package, deliberately: an unwired layer stays replaceable, and keeping
it unwired is how the financial architecture remains untouched by a provisional rule.
