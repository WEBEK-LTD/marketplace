import { describe, expect, it } from 'vitest';
import { RETENTION_SUBJECTS, isPending, retentionSubject, unresolvedRetentionSubjects } from '../src/index.js';

describe('the retention policy layer', () => {
  it('covers the subjects this repository actually holds', () => {
    expect(RETENTION_SUBJECTS.map((subject) => subject.subjectId)).toEqual([
      'payout-destination',
      'payout-record',
      'ledger',
      'financial-audit-log',
      'provider-webhook-receipt',
      'unverified-account',
    ]);
  });

  it('leaves every period pending, and every subject unresolved', () => {
    for (const subject of RETENTION_SUBJECTS) {
      expect(isPending(subject.period), subject.subjectId).toBe(true);
      expect(subject.period.pendingStatus, subject.subjectId).toBe('PENDING_COUNSEL');
    }
    expect(unresolvedRetentionSubjects()).toHaveLength(RETENTION_SUBJECTS.length);
  });

  it('hard-codes no period anywhere: no number and no duration string', () => {
    const text = JSON.stringify(RETENTION_SUBJECTS);
    expect(text).not.toMatch(/\b\d+\s*(day|days|month|months|year|years)\b/i);
    for (const subject of RETENTION_SUBJECTS) {
      for (const entry of Object.values(subject.period)) expect(typeof entry, subject.subjectId).not.toBe('number');
    }
  });

  it('records which stores are append-only, so the erasure tension is visible rather than pre-empted', () => {
    const appendOnly = RETENTION_SUBJECTS.filter((subject) => subject.appendOnly).map((subject) => subject.subjectId);
    expect(appendOnly).toContain('ledger');
    expect(appendOnly).toContain('financial-audit-log');
    expect(appendOnly).toContain('payout-record');
    // A destination is disabled rather than deleted, which is not the same as append-only.
    expect(appendOnly).not.toContain('payout-destination');
  });

  it('names where each subject lives', () => {
    for (const subject of RETENTION_SUBJECTS) {
      expect(subject.dataLocations.length, subject.subjectId).toBeGreaterThan(0);
      for (const location of subject.dataLocations) expect(location, subject.subjectId).toMatch(/^(public|audit|auth)\./);
    }
  });

  it('is frozen and looks a subject up by identifier', () => {
    expect(Object.isFrozen(RETENTION_SUBJECTS)).toBe(true);
    expect(retentionSubject('ledger')?.appendOnly).toBe(true);
    expect(retentionSubject('nothing')).toBeUndefined();
  });
});
