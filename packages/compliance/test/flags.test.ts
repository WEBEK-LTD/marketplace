import { describe, expect, it } from 'vitest';
import { PROVISIONAL_FEATURE_FLAGS, PROVISIONAL_FEATURE_FLAG_NAMES, anyFlagOpen, isFlagOpen } from '../src/index.js';

describe('the provisional feature flags', () => {
  it('are all closed', () => {
    expect(anyFlagOpen()).toBe(false);
    for (const flag of PROVISIONAL_FEATURE_FLAG_NAMES) {
      expect(isFlagOpen(flag), flag).toBe(false);
      expect(PROVISIONAL_FEATURE_FLAGS[flag], flag).toBe(false);
    }
  });

  it('are frozen, so nothing can open one at runtime', () => {
    expect(Object.isFrozen(PROVISIONAL_FEATURE_FLAGS)).toBe(true);
  });

  it('gate read surfaces only: no flag names a money-moving or disclosure operation', () => {
    const forbidden = [
      'payout',
      'payment',
      'settle',
      'settlement',
      'posting',
      'withdraw',
      'disburse',
      'ledger',
      'journal',
      'disclos',
      'vault',
      'secret',
      'destination',
      'reversal',
      'balance',
      'live',
    ];
    for (const flag of PROVISIONAL_FEATURE_FLAG_NAMES) {
      for (const word of forbidden) {
        expect(flag.toLowerCase(), `${flag} names a forbidden operation`).not.toContain(word);
      }
    }
  });

  it('names the four approved read surfaces', () => {
    expect([...PROVISIONAL_FEATURE_FLAG_NAMES].sort()).toEqual([
      'complianceRegisterReadSurface',
      'counselFindingIntakeSurface',
      'processingPurposeReadSurface',
      'retentionPolicyReadSurface',
    ]);
  });
});
