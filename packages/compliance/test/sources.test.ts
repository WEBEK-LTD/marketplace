import { describe, expect, it } from 'vitest';
import {
  PROVISIONAL_BASELINE,
  SOURCE_VERIFICATION_LEVELS,
  isProjectSource,
  statesALegalRequirement,
} from '../src/index.js';

/**
 * The honesty tests.
 *
 * The baseline's safety rests on one admission: no Egyptian primary legal text was read, so no rule may claim
 * to state a legal requirement. If a later change quietly upgraded a source's verification level, the whole
 * layer would start asserting things nobody verified — so that upgrade is what these tests exist to catch.
 */

const EGYPTIAN_INSTRUMENT = /(Law No\.|Central Bank of Egypt|Egyptian Tax Authority|Personal Data Protection)/;

describe('source verification levels', () => {
  it('offers exactly the four approved levels', () => {
    expect([...SOURCE_VERIFICATION_LEVELS]).toEqual([
      'PRIMARY_TEXT_READ',
      'SECONDARY_REPORTING_ONLY',
      'PROJECT_CLAUSE_ONLY',
      'UNVERIFIED',
    ]);
  });

  it('treats only a primary text as stating a legal requirement', () => {
    expect(statesALegalRequirement({ instrument: 'x', sourceDate: 'x', authoritativeReference: 'x', verification: 'PRIMARY_TEXT_READ' })).toBe(true);
    for (const level of ['SECONDARY_REPORTING_ONLY', 'PROJECT_CLAUSE_ONLY', 'UNVERIFIED'] as const) {
      expect(
        statesALegalRequirement({ instrument: 'x', sourceDate: 'x', authoritativeReference: 'x', verification: level }),
        level,
      ).toBe(false);
    }
  });
});

describe('the register’s sources', () => {
  it('contains no rule claiming a primary text was read', () => {
    for (const rule of PROVISIONAL_BASELINE) {
      expect(rule.source.verification, rule.ruleId).not.toBe('PRIMARY_TEXT_READ');
    }
  });

  it('records every Egyptian instrument as secondary reporting only, never upgraded', () => {
    const egyptian = PROVISIONAL_BASELINE.filter((rule) => EGYPTIAN_INSTRUMENT.test(rule.source.instrument));
    expect(egyptian.length).toBeGreaterThan(0);
    for (const rule of egyptian) {
      expect(rule.source.verification, `${rule.ruleId} cites ${rule.source.instrument}`).toBe('SECONDARY_REPORTING_ONLY');
      expect(isProjectSource(rule.source), rule.ruleId).toBe(false);
    }
  });

  it('records every other rule against one of this project’s own clauses', () => {
    const projectRules = PROVISIONAL_BASELINE.filter((rule) => !EGYPTIAN_INSTRUMENT.test(rule.source.instrument));
    expect(projectRules.length).toBeGreaterThan(0);
    for (const rule of projectRules) {
      expect(rule.source.verification, rule.ruleId).toBe('PROJECT_CLAUSE_ONLY');
      expect(rule.source.sourceDate, rule.ruleId).toBe('v5.2 rev 144');
    }
  });

  it('leaves no source unverified', () => {
    for (const rule of PROVISIONAL_BASELINE) expect(rule.source.verification, rule.ruleId).not.toBe('UNVERIFIED');
  });
});
