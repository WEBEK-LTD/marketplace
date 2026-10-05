import { describe, expect, it } from 'vitest';
import {
  PENDING_STATUSES,
  PolicyEvidenceError,
  PolicyPendingError,
  isPending,
  isResolved,
  pendingPolicy,
  requirePolicyValue,
  resolvedPolicy,
} from '../src/index.js';
import { TEST_EVIDENCE, evidenceWith } from './fixtures.js';

describe('a pending policy', () => {
  it('is pending, frozen, and says what is unanswered', () => {
    const policy = pendingPolicy('PENDING_COUNSEL', 'the holding arrangement is undetermined');
    expect(isPending(policy)).toBe(true);
    expect(isResolved(policy)).toBe(false);
    expect(policy.reason).toContain('undetermined');
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('refuses to exist without a reason', () => {
    expect(() => pendingPolicy('PENDING_COUNSEL', '   ')).toThrow(PolicyEvidenceError);
  });

  it('covers every approved pending status', () => {
    expect([...PENDING_STATUSES]).toEqual([
      'PENDING_COUNSEL',
      'PENDING_TAX_REVIEW',
      'PROVISIONAL_PENDING_TAX_REVIEW',
      'COUNSEL_REVIEW_REQUIRED',
      'LEGAL_REVIEW_PENDING',
      'DISABLED_PENDING_COUNSEL',
    ]);
  });
});

describe('reading a policy', () => {
  it('throws rather than returning a default when the question is open', () => {
    const policy = pendingPolicy('PENDING_TAX_REVIEW', 'no rate has been determined');
    expect(() => requirePolicyValue(policy, 'computing tax')).toThrow(PolicyPendingError);
    try {
      requirePolicyValue(policy, 'computing tax');
      expect.unreachable('a pending policy must never return a value');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyPendingError);
      expect((error as PolicyPendingError).pendingStatus).toBe('PENDING_TAX_REVIEW');
      expect((error as Error).message).toContain('computing tax');
    }
  });

  it('has no fallback parameter: the only read path is the one that can throw', () => {
    // A `requirePolicyValue(policy, context, fallback)` signature is exactly what the owner's rule rules out.
    expect(requirePolicyValue.length).toBe(2);
  });

  it('returns the determination once resolved', () => {
    const policy = resolvedPolicy({ determination: 'counsel advises a written seller agreement is required' }, TEST_EVIDENCE);
    expect(requirePolicyValue(policy, 'reading').determination).toContain('written seller agreement');
  });
});

describe('resolving a policy', () => {
  it('requires a determination', () => {
    expect(() => resolvedPolicy({ determination: '  ' }, TEST_EVIDENCE)).toThrow(PolicyEvidenceError);
  });

  it('refuses a verdict word in place of a determination', () => {
    for (const verdict of ['permitted', 'LICENSED', 'exempt', 'zero', 'approved']) {
      expect(() => resolvedPolicy({ determination: verdict }, TEST_EVIDENCE), verdict).toThrow(PolicyEvidenceError);
    }
  });

  it('refuses evidence that has not been received', () => {
    expect(() =>
      resolvedPolicy({ determination: 'a determination' }, evidenceWith({ counselStatus: 'PENDING', counselOverride: 'COUNSEL_OVERRIDE_PENDING' })),
    ).toThrow(PolicyEvidenceError);
  });

  it('refuses evidence whose override has not been accepted', () => {
    for (const override of ['COUNSEL_OVERRIDE_PENDING', 'COUNSEL_OVERRIDE_REJECTED'] as const) {
      expect(() => resolvedPolicy({ determination: 'a determination' }, evidenceWith({ counselOverride: override })), override).toThrow(
        PolicyEvidenceError,
      );
    }
  });

  it('refuses incomplete evidence', () => {
    for (const field of ['evidenceReference', 'counselIdentity', 'qualification', 'jurisdiction', 'implementationDependency'] as const) {
      expect(() => resolvedPolicy({ determination: 'a determination' }, evidenceWith({ [field]: '' })), field).toThrow(
        PolicyEvidenceError,
      );
    }
  });

  it('refuses a superseded finding as the accepted override', () => {
    expect(() => resolvedPolicy({ determination: 'a determination' }, evidenceWith({ supersededAt: '2026-11-01' }))).toThrow(
      PolicyEvidenceError,
    );
  });

  it('freezes what it produces, so a resolved value cannot be edited afterwards', () => {
    const policy = resolvedPolicy({ determination: 'a determination' }, TEST_EVIDENCE);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.determination)).toBe(true);
  });
});
