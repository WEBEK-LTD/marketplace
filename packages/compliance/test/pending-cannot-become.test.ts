import { describe, expect, it } from 'vitest';
import {
  PROVISIONAL_BASELINE,
  PROCESSING_PURPOSES,
  RETENTION_SUBJECTS,
  TAX_POLICIES,
  authorizedPayoutDestinationAccess,
  destinationDisclosurePermitted,
  isPending,
  isResolved,
  liveMoneyPermitted,
  paymentRegulatoryPolicy,
  regulatoryPositionPermitsLiveMoney,
  requirePolicyValue,
} from '../src/index.js';

/**
 * The owner's scope item 16: proof that PENDING_COUNSEL cannot silently become zero, exempt, taxable,
 * permitted, licensed or approved.
 *
 * "Silently" is the operative word, so these tests attack the quiet paths: numeric coercion, truthiness,
 * JSON round-tripping, property access and the absence of a rate field. A loud failure is the correct
 * behaviour everywhere.
 */

const EVERY_PENDING_POLICY = [
  ...PROVISIONAL_BASELINE.map((rule) => rule.policy),
  ...Object.values(TAX_POLICIES),
  paymentRegulatoryPolicy,
  ...PROCESSING_PURPOSES.map((purpose) => purpose.legalBasis),
  ...RETENTION_SUBJECTS.map((subject) => subject.period),
  authorizedPayoutDestinationAccess.stepUpRequirement,
  authorizedPayoutDestinationAccess.accessLogging,
  authorizedPayoutDestinationAccess.redaction,
  authorizedPayoutDestinationAccess.retention,
];

describe('nothing in the provisional baseline is resolved', () => {
  it('has at least one policy to check', () => {
    expect(EVERY_PENDING_POLICY.length).toBeGreaterThan(30);
  });

  it('holds no resolved policy anywhere', () => {
    for (const policy of EVERY_PENDING_POLICY) {
      expect(isResolved(policy)).toBe(false);
      expect(isPending(policy)).toBe(true);
    }
  });
});

describe('a pending policy cannot silently become zero', () => {
  it('refuses to be read at all', () => {
    for (const policy of EVERY_PENDING_POLICY) {
      expect(() => requirePolicyValue(policy, 'a computation')).toThrow();
    }
  });

  it('is not a number and does not coerce to one', () => {
    for (const policy of EVERY_PENDING_POLICY) {
      expect(Number.isNaN(Number(policy))).toBe(true);
      expect(Number(policy)).not.toBe(0);
    }
  });

  it('carries no rate, amount, percentage, period or day field that could be read as a value', () => {
    const numericNames = ['rate', 'amount', 'percentage', 'percent', 'value', 'days', 'months', 'years', 'period', 'threshold'];
    for (const policy of EVERY_PENDING_POLICY) {
      for (const key of Object.keys(policy)) {
        expect(numericNames, `${key} looks like a value field`).not.toContain(key.toLowerCase());
      }
      for (const entry of Object.values(policy)) expect(typeof entry).not.toBe('number');
    }
  });

  it('survives a JSON round trip still pending, with no value introduced', () => {
    for (const policy of EVERY_PENDING_POLICY) {
      const round = JSON.parse(JSON.stringify(policy)) as Record<string, unknown>;
      expect(round.state).toBe('pending');
      expect(round).not.toHaveProperty('determination');
      expect(round).not.toHaveProperty('value');
    }
  });
});

describe('a pending policy cannot silently become exempt or taxable', () => {
  it('says neither, in any field', () => {
    for (const policy of EVERY_PENDING_POLICY) {
      const text = JSON.stringify(policy).toLowerCase();
      expect(text).not.toContain('"exempt"');
      expect(text).not.toContain('"taxable"');
      expect(text).not.toContain('is exempt');
      expect(text).not.toContain('is taxable');
    }
  });

  it('keeps all eight tax policies pending and distinct from a determination', () => {
    expect(Object.keys(TAX_POLICIES).sort()).toEqual(
      [
        'buyerFeeTaxPolicy',
        'commissionTaxPolicy',
        'reportingPolicy',
        'sellerProceedsTaxPolicy',
        'taxDocumentPolicy',
        'taxPolicy',
        'vatPolicy',
        'withholdingPolicy',
      ].sort(),
    );
    for (const [name, policy] of Object.entries(TAX_POLICIES)) {
      expect(isPending(policy), name).toBe(true);
    }
  });
});

describe('a pending policy cannot silently become permitted, licensed or approved', () => {
  it('permits no live money by any accessor', () => {
    expect(liveMoneyPermitted()).toBe(false);
    expect(regulatoryPositionPermitsLiveMoney()).toBe(false);
    expect(destinationDisclosurePermitted()).toBe(false);
  });

  it('exposes no truthy permission flag anywhere in the baseline', () => {
    for (const policy of EVERY_PENDING_POLICY) {
      for (const [key, entry] of Object.entries(policy)) {
        if (typeof entry === 'boolean') {
          expect(entry, `${key} is a truthy permission on a pending policy`).toBe(false);
        }
      }
    }
  });

  it('keeps destination access in its single disabled state with no permission key invented', () => {
    expect(authorizedPayoutDestinationAccess.state).toBe('DISABLED_PENDING_COUNSEL');
    expect(authorizedPayoutDestinationAccess.permissionKey).toBeNull();
  });

  it('offers no function that enables anything', () => {
    // A module that could enable disclosure or live money would defeat the whole layer. The export surface
    // is checked by name: nothing is called enable*, allow*, permit* or grant*.
    const surface = Object.keys({
      liveMoneyPermitted,
      regulatoryPositionPermitsLiveMoney,
      destinationDisclosurePermitted,
      requirePolicyValue,
    });
    for (const name of surface) expect(/^(enable|allow|permit|grant)/i.test(name)).toBe(false);
  });
});
