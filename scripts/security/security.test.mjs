import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeFindings } from './gitleaks.mjs';
import { evaluateFindings, osvFindings } from './osv.mjs';

const report = {
  results: [{ source: { path: 'pnpm-lock.yaml' }, packages: [
    { package: { name: 'a', version: '1.0.0', ecosystem: 'npm' }, vulnerabilities: [{ id: 'GHSA-aaaa', aliases: ['CVE-2026-1'] }] },
    { package: { name: 'b', version: '2.0.0', ecosystem: 'npm' }, vulnerabilities: [{ id: 'GHSA-bbbb' }] },
  ] }],
};
const entry = { id: 'CVE-2026-1', package: 'a', version: '1.0.0', ecosystem: 'npm', justification: 'not reachable', approvedBy: 'owner', approvedOn: '2026-09-16', expires: '2026-10-16' };

test('osv: findings are flattened and fail by default', () => {
  const findings = osvFindings(report);
  assert.equal(findings.length, 2);
  assert.deepEqual(evaluateFindings(findings, { exceptions: [] }, '2026-09-17').problems, ['vulnerability GHSA-aaaa in a@1.0.0', 'vulnerability GHSA-bbbb in b@2.0.0']);
});

test('osv: an exception matches id (or alias), package and version exactly', () => {
  const findings = osvFindings(report);
  const result = evaluateFindings(findings, { exceptions: [entry] }, '2026-09-17');
  assert.deepEqual(result.accepted, ['GHSA-aaaa a@1.0.0']);
  assert.deepEqual(result.problems, ['vulnerability GHSA-bbbb in b@2.0.0']);
  assert.match(evaluateFindings(findings, { exceptions: [{ ...entry, version: '1.0.1' }] }, '2026-09-17').problems.join(), /GHSA-aaaa in a@1.0.0/);
  assert.deepEqual(evaluateFindings([], { exceptions: [entry] }, '2026-09-17').unused, ['CVE-2026-1 a@1.0.0']);
});

test('osv: expired or incomplete exceptions fail', () => {
  const findings = osvFindings(report);
  assert.match(evaluateFindings(findings, { exceptions: [entry] }, '2026-10-17').problems.join(), /expired/);
  assert.match(evaluateFindings(findings, { exceptions: [{ ...entry, justification: '' }] }, '2026-09-17').problems.join(), /missing justification/);
});

test('gitleaks: summaries keep no secret material', () => {
  const findings = [{ RuleID: 'generic-api-key', File: 'a.ts', StartLine: 3, Commit: 'abcdef0123456789abcdef', Secret: 'REDACTED-canary', Match: 'key = canary', Fingerprint: 'x' }];
  const out = JSON.stringify(sanitizeFindings(findings));
  assert.equal(out, '[{"rule":"generic-api-key","file":"a.ts","line":3,"commit":"abcdef012345"}]');
  assert.doesNotMatch(out, /canary|Secret|Match/);
});
