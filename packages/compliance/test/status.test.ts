import { describe, expect, it } from 'vitest';
import {
  DATA_RESIDENCY_STATUS,
  FORBIDDEN_RESOLVED_VALUES,
  LEGAL_BASIS_STATUS,
  LEGAL_REVIEW_STATUS,
  MANUAL_PAYOUT_STATUS,
  PAYMENT_REGULATORY_STATUS,
  SETTLEMENT_MODEL_STATUS,
  isForbiddenResolvedValue,
} from '../src/index.js';

describe('the provisional status constants', () => {
  it('records the approved values exactly', () => {
    expect(LEGAL_REVIEW_STATUS).toBe('PROVISIONAL_PENDING_EXTERNAL_COUNSEL');
    expect(MANUAL_PAYOUT_STATUS).toBe('PROVISIONAL_DESIGN_ONLY');
    expect(PAYMENT_REGULATORY_STATUS).toBe('COUNSEL_REVIEW_REQUIRED');
    expect(LEGAL_BASIS_STATUS).toBe('PENDING_COUNSEL');
    expect(DATA_RESIDENCY_STATUS).toBe('LEGAL_REVIEW_PENDING');
    expect([...SETTLEMENT_MODEL_STATUS]).toEqual(['PRODUCT_MODEL_SELECTED', 'LEGAL_REVIEW_PENDING']);
  });

  it('never encodes a legal conclusion as a status', () => {
    const statuses = [
      LEGAL_REVIEW_STATUS,
      MANUAL_PAYOUT_STATUS,
      PAYMENT_REGULATORY_STATUS,
      LEGAL_BASIS_STATUS,
      DATA_RESIDENCY_STATUS,
      ...SETTLEMENT_MODEL_STATUS,
    ];
    for (const status of statuses) {
      expect(isForbiddenResolvedValue(status), status).toBe(false);
      expect(status.toLowerCase()).not.toContain('licensed');
      expect(status.toLowerCase()).not.toContain('approved');
      expect(status.toLowerCase()).not.toContain('permitted');
      expect(status.toLowerCase()).not.toContain('compliant');
    }
  });

  it('recognises the verdict words in any casing or separator', () => {
    for (const value of FORBIDDEN_RESOLVED_VALUES) expect(isForbiddenResolvedValue(value)).toBe(true);
    expect(isForbiddenResolvedValue('Licensed')).toBe(true);
    expect(isForbiddenResolvedValue('  APPROVED  ')).toBe(true);
    expect(isForbiddenResolvedValue('legally permitted')).toBe(true);
    expect(isForbiddenResolvedValue('legally-permitted')).toBe(true);
    expect(isForbiddenResolvedValue('NOT APPLICABLE')).toBe(true);
  });

  it('does not refuse an ordinary determination sentence', () => {
    expect(isForbiddenResolvedValue('Counsel advises that the arrangement requires a written agreement.')).toBe(false);
  });
});
