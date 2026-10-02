import { describe, expect, it } from 'vitest';
import {
  BASELINE_EFFECTIVE_FROM,
  COMPLIANCE_CATEGORIES,
  PROVISIONAL_BASELINE,
  complianceRegisterProblems,
  complianceRule,
  isPending,
  rulesBlockingLiveMoney,
  rulesForCategory,
  statesALegalRequirement,
} from '../src/index.js';

describe('the compliance register', () => {
  it('holds the twenty-two approved rules, each exactly once', () => {
    expect(PROVISIONAL_BASELINE).toHaveLength(22);
    const ids = PROVISIONAL_BASELINE.map((rule) => rule.ruleId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the rule identifiers from the approved matrix', () => {
    expect(PROVISIONAL_BASELINE.map((rule) => rule.ruleId)).toEqual([
      'PAY-P01',
      'PAY-P02',
      'FUND-P01',
      'FUND-P02',
      'FUND-P03',
      'FUND-P04',
      'POUT-P01',
      'POUT-P02',
      'POUT-P03',
      'POUT-P04',
      'DATA-P01',
      'DATA-P02',
      'DATA-P03',
      'DATA-P04',
      'XB-P01',
      'TAX-P01',
      'TAX-P02',
      'VAT-P01',
      'INV-P01',
      'WHT-P01',
      'RET-P01',
      'RET-P02',
    ]);
  });

  it('uses exactly the ten approved categories, each with at least one rule', () => {
    expect([...COMPLIANCE_CATEGORIES]).toEqual([
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
    ]);
    for (const category of COMPLIANCE_CATEGORIES) expect(rulesForCategory(category).length, category).toBeGreaterThan(0);
  });

  it('reports no problems', () => {
    expect(complianceRegisterProblems()).toEqual([]);
  });

  it('looks a rule up by identifier', () => {
    expect(complianceRule('XB-P01')?.category).toBe('CROSS_BORDER');
    expect(complianceRule('does-not-exist')).toBeUndefined();
  });
});

describe('every rule', () => {
  it('is provisional, interprets no law, and is still pending', () => {
    for (const rule of PROVISIONAL_BASELINE) {
      expect(rule.confidence, rule.ruleId).toBe('PROVISIONAL');
      expect(rule.derivesFromLegalInterpretation, rule.ruleId).toBe(false);
      expect(isPending(rule.policy), rule.ruleId).toBe(true);
      expect(rule.counselStatus, rule.ruleId).toBe('PENDING');
      expect(rule.counselOverride, rule.ruleId).toBe('COUNSEL_OVERRIDE_PENDING');
      expect(rule.effectiveUntil, rule.ruleId).toBeNull();
      expect(rule.effectiveFrom, rule.ruleId).toBe(BASELINE_EFFECTIVE_FROM);
    }
  });

  it('states a rule, a dependency and a cited source', () => {
    for (const rule of PROVISIONAL_BASELINE) {
      expect(rule.currentProvisionalRule.length, rule.ruleId).toBeGreaterThan(20);
      expect(rule.implementationDependency.length, rule.ruleId).toBeGreaterThan(0);
      expect(rule.source.instrument.length, rule.ruleId).toBeGreaterThan(0);
      expect(rule.source.authoritativeReference.length, rule.ruleId).toBeGreaterThan(0);
      expect(rule.source.sourceDate.length, rule.ruleId).toBeGreaterThan(0);
    }
  });

  it('claims no legal requirement, because no primary text was read for this baseline', () => {
    for (const rule of PROVISIONAL_BASELINE) {
      expect(statesALegalRequirement(rule.source), rule.ruleId).toBe(false);
      expect(rule.source.verification, rule.ruleId).not.toBe('PRIMARY_TEXT_READ');
    }
  });

  it('is frozen, so the register cannot be edited at runtime', () => {
    expect(Object.isFrozen(PROVISIONAL_BASELINE)).toBe(true);
    for (const rule of PROVISIONAL_BASELINE) expect(Object.isFrozen(rule), rule.ruleId).toBe(true);
  });

  it('never asserts a verdict in its rule text', () => {
    // A verdict phrase is allowed only inside a negation: "no artefact states that holding seller funds is
    // permitted" is the posture, while "holding seller funds is permitted" would be the legal conclusion
    // this layer must never contain. So the test looks for the phrase and then requires the sentence around
    // it to be negated, rather than banning the words outright.
    const verdicts = ['is legally', 'is licensed', 'is permitted', 'is exempt', 'is compliant', 'are permitted'];
    const negation = /\b(no|not|never|neither|nor|without)\b/;
    for (const rule of PROVISIONAL_BASELINE) {
      for (const sentence of rule.currentProvisionalRule.toLowerCase().split('.')) {
        for (const verdict of verdicts) {
          if (!sentence.includes(verdict)) continue;
          expect(negation.test(sentence), `${rule.ruleId} asserts "${verdict}" without a negation: ${sentence.trim()}`).toBe(true);
        }
      }
    }
  });
});

describe('the live-money rules', () => {
  it('names the rules that must be satisfied before real money moves, and none is satisfied', () => {
    const blocking = rulesBlockingLiveMoney();
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking.length).toBeLessThan(PROVISIONAL_BASELINE.length);
    for (const rule of blocking) expect(isPending(rule.policy), rule.ruleId).toBe(true);
  });

  it('includes the settlement-posting and funds-holding rules', () => {
    const ids = rulesBlockingLiveMoney().map((rule) => rule.ruleId);
    expect(ids).toContain('POUT-P04');
    expect(ids).toContain('FUND-P01');
    expect(ids).toContain('PAY-P01');
  });
});
