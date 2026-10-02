import { describe, expect, it } from 'vitest';
import {
  ADVICE_DATE_PATTERN,
  COUNSEL_OVERRIDE_STATES,
  COUNSEL_STATUSES,
  counselEvidenceProblems,
  isUsableCounselEvidence,
} from '../src/index.js';
import { TEST_EVIDENCE, evidenceWith } from './fixtures.js';

describe('the counsel override lifecycle', () => {
  it('has the three approved states and the three approved statuses', () => {
    expect([...COUNSEL_OVERRIDE_STATES]).toEqual([
      'COUNSEL_OVERRIDE_PENDING',
      'COUNSEL_OVERRIDE_ACCEPTED',
      'COUNSEL_OVERRIDE_REJECTED',
    ]);
    expect([...COUNSEL_STATUSES]).toEqual(['PENDING', 'RECEIVED', 'SUPERSEDED']);
  });

  it('accepts a structurally complete, received and accepted record', () => {
    expect(counselEvidenceProblems(TEST_EVIDENCE)).toEqual([]);
    expect(isUsableCounselEvidence(TEST_EVIDENCE)).toBe(true);
  });
});

describe('evidence completeness', () => {
  it('requires every identifying field', () => {
    for (const field of ['evidenceReference', 'counselIdentity', 'qualification', 'jurisdiction', 'implementationDependency'] as const) {
      const problems = counselEvidenceProblems(evidenceWith({ [field]: '   ' }));
      expect(problems, field).toContain(`${field} must not be empty`);
      expect(isUsableCounselEvidence(evidenceWith({ [field]: '' })), field).toBe(false);
    }
  });

  it('requires a jurisdiction, because a finding carries no weight outside the one it names', () => {
    expect(isUsableCounselEvidence(evidenceWith({ jurisdiction: '' }))).toBe(false);
  });

  it('requires well-formed dates', () => {
    expect(counselEvidenceProblems(evidenceWith({ adviceDate: '1 October 2026' }))).toContain('adviceDate must be a YYYY-MM-DD date');
    expect(counselEvidenceProblems(evidenceWith({ effectiveFrom: '2026-10' }))).toContain('effectiveFrom must be a YYYY-MM-DD date');
    expect(counselEvidenceProblems(evidenceWith({ supersededAt: 'later' }))).toContain(
      'supersededAt must be null or a YYYY-MM-DD date',
    );
    expect(ADVICE_DATE_PATTERN.test('2026-10-01')).toBe(true);
    expect(ADVICE_DATE_PATTERN.test('2026-1-1')).toBe(false);
  });

  it('refuses an accepted override for a finding that has not been received', () => {
    expect(counselEvidenceProblems(evidenceWith({ counselStatus: 'PENDING' }))).toContain(
      'an accepted override requires counselStatus RECEIVED',
    );
    expect(counselEvidenceProblems(evidenceWith({ counselStatus: 'SUPERSEDED' }))).toContain(
      'an accepted override requires counselStatus RECEIVED',
    );
  });

  it('refuses a superseded finding as the accepted override', () => {
    expect(counselEvidenceProblems(evidenceWith({ supersededAt: '2026-12-01' }))).toContain(
      'a superseded finding may not be the accepted override',
    );
  });

  it('treats a pending or rejected override as unusable even when the record is complete', () => {
    for (const override of ['COUNSEL_OVERRIDE_PENDING', 'COUNSEL_OVERRIDE_REJECTED'] as const) {
      const evidence = evidenceWith({ counselOverride: override });
      expect(counselEvidenceProblems(evidence), override).toEqual([]);
      expect(isUsableCounselEvidence(evidence), override).toBe(false);
    }
  });

  it('rejects an unknown status or override state', () => {
    expect(counselEvidenceProblems(evidenceWith({ counselStatus: 'MAYBE' as never }))).toContain(
      'counselStatus MAYBE is not a known status',
    );
    expect(counselEvidenceProblems(evidenceWith({ counselOverride: 'OVERRIDDEN' as never }))).toContain(
      'counselOverride OVERRIDDEN is not a known state',
    );
  });
});
