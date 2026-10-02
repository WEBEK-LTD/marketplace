import { describe, expect, it } from 'vitest';
import {
  DESTINATION_ACCESS_STATES,
  PROCESSING_PURPOSES,
  authorizedPayoutDestinationAccess,
  destinationDisclosurePermitted,
  isPending,
  processingPurpose,
} from '../src/index.js';

describe('the processing-purpose register', () => {
  it('records only purposes this system already has', () => {
    expect(PROCESSING_PURPOSES.map((purpose) => purpose.purposeId)).toEqual([
      'seller-payout-destination',
      'seller-balance-record',
      'withdrawal-request',
      'payout-record',
      'financial-audit-trail',
    ]);
  });

  it('leaves every lawful basis pending', () => {
    for (const purpose of PROCESSING_PURPOSES) {
      expect(isPending(purpose.legalBasis), purpose.purposeId).toBe(true);
      expect(purpose.legalBasis.pendingStatus, purpose.purposeId).toBe('PENDING_COUNSEL');
      expect(purpose.legalBasis.reason, purpose.purposeId).toContain('undetermined');
    }
  });

  it('names where the data actually lives, so a finding can be applied without searching', () => {
    for (const purpose of PROCESSING_PURPOSES) {
      expect(purpose.dataLocations.length, purpose.purposeId).toBeGreaterThan(0);
      for (const location of purpose.dataLocations) expect(location, purpose.purposeId).toMatch(/^(public|audit|auth)\./);
    }
  });

  it('is frozen and looks a purpose up by identifier', () => {
    expect(Object.isFrozen(PROCESSING_PURPOSES)).toBe(true);
    expect(processingPurpose('payout-record')?.dataLocations).toContain('public.payouts');
    expect(processingPurpose('nothing')).toBeUndefined();
  });
});

describe('authorized destination access', () => {
  it('has exactly one state, and it is disabled', () => {
    expect([...DESTINATION_ACCESS_STATES]).toEqual(['DISABLED_PENDING_COUNSEL']);
    expect(authorizedPayoutDestinationAccess.state).toBe('DISABLED_PENDING_COUNSEL');
  });

  it('invents no permission key', () => {
    expect(authorizedPayoutDestinationAccess.permissionKey).toBeNull();
  });

  it('leaves every condition of access pending', () => {
    for (const condition of ['stepUpRequirement', 'accessLogging', 'redaction', 'retention'] as const) {
      const policy = authorizedPayoutDestinationAccess[condition];
      expect(isPending(policy), condition).toBe(true);
      expect(policy.pendingStatus, condition).toBe('DISABLED_PENDING_COUNSEL');
    }
  });

  it('names the questions that would unlock it', () => {
    expect(authorizedPayoutDestinationAccess.counselDependency).toContain('BD-17');
    expect(authorizedPayoutDestinationAccess.counselDependency).toContain('MV1-09');
  });

  it('permits no disclosure, and is frozen so nothing can switch it on at runtime', () => {
    expect(destinationDisclosurePermitted()).toBe(false);
    expect(Object.isFrozen(authorizedPayoutDestinationAccess)).toBe(true);
  });

  it('exposes no plaintext destination field and no secret reader', () => {
    const keys = Object.keys(authorizedPayoutDestinationAccess).join(' ').toLowerCase();
    for (const forbidden of ['iban', 'account', 'plaintext', 'secret', 'vault', 'token', 'number']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});
