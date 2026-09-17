import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { redisVersion, sanitizeE2eReport, sanitizeTool1 } from './checks.mjs';
import { B10_MIGRATION, B10_SQL, B10_VERSION, CiError, connectionUrls, harnessResult, parseStatusEnv, poolerUser, poolerUserCandidates, tapSummary } from './supabase-local.mjs';
import { approvalProblems, proposeImages, verifyImages, verifyTransient } from '../toolchain/supabase-images.mjs';

const settings = { dbPort: 54322, poolerPort: 54329 };
const status = parseStatusEnv('API_URL="http://127.0.0.1:54321"\nDB_URL="postgresql://postgres:placeholder-local-value@127.0.0.1:54322/postgres"\nPOOLER_TENANT="pooler-dev"\nnoise line\n');

test('status env parsing and runtime connection URLs', () => {
  assert.equal(status.get('API_URL'), 'http://127.0.0.1:54321');
  const urls = connectionUrls(status, '{role}.pooler-dev', settings);
  assert.equal(urls.poolerUrl, 'postgresql://tool3_app_api.pooler-dev@127.0.0.1:54329/postgres');
  assert.equal(new URL(urls.adminUrl).port, '54322');
  assert.equal(poolerUser('{role}'), 'tool3_app_api');
  assert.throws(() => poolerUser(null), CiError);
  assert.deepEqual(poolerUserCandidates(status), ['{role}', '{role}.pooler-dev', '{role}.marketplace']);
});

test('missing or unexpected status values fail without printing values', () => {
  const noDb = parseStatusEnv('API_URL="http://127.0.0.1:54321"\n');
  assert.throws(() => connectionUrls(noDb, '{role}', settings), /keys: API_URL/);
  try {
    connectionUrls(parseStatusEnv('DB_URL="postgresql://postgres:placeholder-local-value@127.0.0.1:5432/postgres"'), '{role}', settings);
    assert.fail('expected failure');
  } catch (error) {
    assert.match(error.message, /configured database port/);
    assert.doesNotMatch(error.message, /placeholder-local-value/);
  }
});

test('B10-local probe is far-future, self-contained and never committed', () => {
  assert.equal(B10_VERSION, '99991231235959');
  assert.equal(B10_MIGRATION, '99991231235959_b10_local_probe.sql');
  assert.match(B10_SQL, /create schema b10_local_probe/);
  assert.doesNotMatch(B10_SQL, /drop|alter role|grant|public\./i);
  const migrations = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.ok(typeof migrations === 'string');
});

test('TAP and harness summaries keep outcomes only', () => {
  const tap = tapSummary('supabase/tests/tool7_tooling.test.sql .. \n1..5\nok 1 - pgTAP is installed\nok 2\nnot ok 3 - x\nFiles=1, Tests=5\nResult: FAIL\n');
  assert.deepEqual(tap, { ok: 2, notOk: 1, result: 'Result: FAIL' });
  assert.deepEqual(harnessResult('== TOOL-3\n{\n  "result": "PASS"\n}\nTOOL-3 result: Local transaction-pooler behavior verified\n'), { result: 'PASS' });
  assert.equal(harnessResult('no json'), undefined);
});

const approved = {
  status: 'approved', approvedBy: 'owner', approvedOn: '2026-09-20',
  requiredServices: ['supabase/postgres', 'supabase/supavisor'],
  excludedServices: ['studio'], exclusionEvidence: 'record run 1',
  poolerUserFormat: '{role}.pooler-dev', poolerUserFormatEvidence: 'record run 1',
  images: [
    { reference: 'public.ecr.aws/supabase/postgres:17.6', digest: `sha256:${'a'.repeat(64)}` },
    { reference: 'public.ecr.aws/supabase/supavisor:2.9', digest: `sha256:${'b'.repeat(64)}` },
    { reference: 'public.ecr.aws/supabase/pg_prove:3.36', digest: `sha256:${'c'.repeat(64)}`, transient: true },
  ],
};
const running = [
  { container: 'db', reference: 'public.ecr.aws/supabase/postgres:17.6', repoDigests: [`public.ecr.aws/supabase/postgres@sha256:${'a'.repeat(64)}`] },
  { container: 'pooler', reference: 'public.ecr.aws/supabase/supavisor:2.9', repoDigests: [`public.ecr.aws/supabase/supavisor@sha256:${'b'.repeat(64)}`] },
];

test('image lock: only a complete owner approval is usable (no trust on first use)', () => {
  const committed = JSON.parse(readFileSync(new URL('../../toolchain/supabase-images.json', import.meta.url), 'utf8'));
  assert.equal(committed.status, 'pending-owner-approval');
  assert.match(approvalProblems(committed).join(), /not approved yet/);
  assert.match(verifyImages(committed, running).join(), /not approved yet/);
  assert.deepEqual(approvalProblems(approved), []);
  assert.match(approvalProblems({ ...approved, approvedBy: '' }).join(), /approvedBy/);
  assert.match(approvalProblems({ ...approved, excludedServices: ['supavisor'] }).join(), /may not be excluded/);
  assert.match(approvalProblems({ ...approved, exclusionEvidence: null }).join(), /exclusionEvidence/);
  assert.match(approvalProblems({ ...approved, poolerUserFormat: 'tool3' }).join(), /poolerUserFormat/);
  assert.match(approvalProblems({ ...approved, images: [{ reference: 'x', digest: 'sha256:short' }] }).join(), /invalid image entry/);
});

test('image lock: running and transient images must match approved digests', () => {
  assert.deepEqual(verifyImages(approved, running), []);
  const tampered = structuredClone(running);
  tampered[0].repoDigests = [`public.ecr.aws/supabase/postgres@sha256:${'f'.repeat(64)}`];
  assert.match(verifyImages(approved, tampered).join(), /digest mismatch/);
  assert.match(verifyImages(approved, [running[0]]).join(), /supavisor is not running/);
  assert.match(verifyImages(approved, [...running, { container: 'studio', reference: 'public.ecr.aws/supabase/studio:1', repoDigests: [] }]).join(), /not approved/);
  const prove = [{ container: 'transient', reference: 'public.ecr.aws/supabase/pg_prove:3.36', repoDigests: [`public.ecr.aws/supabase/pg_prove@sha256:${'c'.repeat(64)}`] }];
  assert.deepEqual(verifyTransient(approved, prove), []);
  assert.match(verifyTransient(approved, []).join(), /no pg_prove image/);
});

test('image proposals list each image once and refuse ambiguous digests', () => {
  const proposal = proposeImages([...running, running[0], { container: 'transient', reference: 'public.ecr.aws/supabase/pg_prove:3.36', repoDigests: [`x@sha256:${'c'.repeat(64)}`] }]);
  assert.equal(proposal.length, 3);
  assert.equal(proposal.find((p) => p.reference.includes('pg_prove')).transient, true);
  assert.throws(() => proposeImages([{ container: 'db', reference: 'x', repoDigests: ['x@sha256:1', 'x@sha256:2'] }]), /exactly one/);
});

test('sanitised CI summaries', () => {
  assert.equal(redisVersion('Redis server v=7.0.15 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=1'), '7.0.15');
  const tool1 = sanitizeTool1({ app: 'web', result: 'PASS', log: '/tmp/x.log', denoBinary: '/root/.cache/deno', freshXdgConfigHome: '/tmp/y', exitCode: 0 });
  assert.deepEqual(tool1, { app: 'web', result: 'PASS', exitCode: 0 });
  const e2e = sanitizeE2eReport({ stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 }, suites: [{ title: 'smoke.spec.ts', suites: [{ title: 'web', specs: [{ title: 'home', tests: [{ projectName: 'chromium', status: 'expected', results: [{ stdout: ['secret-looking output'], error: { message: 'x' } }] }] }] }] }] });
  assert.deepEqual(e2e.tests, [{ title: 'smoke.spec.ts › web › home', project: 'chromium', status: 'expected' }]);
  assert.doesNotMatch(JSON.stringify(e2e), /secret-looking/);
});
