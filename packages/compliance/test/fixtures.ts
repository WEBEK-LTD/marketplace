import type { CounselEvidence } from '../src/index.js';

/**
 * A structurally complete evidence record for exercising the override lifecycle.
 *
 * **This is not a legal finding and does not stand in for one.** Every field says so. Its only purpose is to
 * prove that the resolution path works and that the refusals fire; no test uses it to resolve a rule in the
 * real register, and the register itself remains entirely pending.
 */
export const TEST_EVIDENCE: CounselEvidence = Object.freeze({
  evidenceReference: 'test fixture — no written finding exists',
  counselIdentity: 'test fixture — not a real adviser',
  qualification: 'test fixture — not a real qualification',
  jurisdiction: 'test fixture — not a real jurisdiction',
  adviceDate: '2026-10-01',
  effectiveFrom: '2026-10-01',
  supersededAt: null,
  implementationDependency: 'test fixture only',
  counselStatus: 'RECEIVED',
  counselOverride: 'COUNSEL_OVERRIDE_ACCEPTED',
});

export function evidenceWith(overrides: Partial<CounselEvidence>): CounselEvidence {
  return Object.freeze({ ...TEST_EVIDENCE, ...overrides });
}
