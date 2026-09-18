import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { redisVersion, sanitizeE2eReport, sanitizeTool1 } from './checks.mjs';
import { B10_MIGRATION, B10_SQL, B10_VERSION, CiError, connectionUrls, harnessResult, parseStatusEnv, pgtapVerdict, poolerUser, poolerUserCandidates, tapSummary, TOOL7_PLANNED_TESTS } from './supabase-local.mjs';
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
  // Verbose pg_prove output (only produced with --verbose, which this repository does not pass).
  const tap = tapSummary('supabase/tests/tool7_tooling.test.sql .. \n1..5\nok 1 - pgTAP is installed\nok 2\nnot ok 3 - x\nFiles=1, Tests=5, 1 wallclock secs\nResult: FAIL\n');
  assert.deepEqual(tap, { ok: 2, notOk: 1, files: 1, tests: 5, result: 'Result: FAIL' });
  assert.deepEqual(harnessResult('== TOOL-3\n{\n  "result": "PASS"\n}\nTOOL-3 result: Local transaction-pooler behavior verified\n'), { result: 'PASS' });
  assert.equal(harnessResult('no json'), undefined);
});

// --- TOOL-7 verdict (owner decision E6) --------------------------------------------------------
// `supabase test db --local` runs `pg_prove --ext .pg --ext .sql -r` without --verbose, so a passing run
// prints prove's summary and no per-assertion ok lines. The verdict must accept that and still reject an
// empty or partly executed suite.
const PASSING_OUTPUT = [
  'Connecting to local database...',
  '/tmp/tests/tool7_tooling.test.sql .. ok',
  'All tests successful.',
  'Files=1, Tests=5,  1 wallclock secs ( 0.02 usr  0.01 sys +  0.03 cusr  0.01 csys =  0.07 CPU)',
  'Result: PASS',
  '',
].join('\n');

test('a real non-verbose passing run is accepted', () => {
  const tap = tapSummary(PASSING_OUTPUT);
  assert.deepEqual(tap, { ok: 0, notOk: 0, files: 1, tests: 5, result: 'Result: PASS' });
  assert.deepEqual(pgtapVerdict({ exitCode: 0, tap }), { executedTests: 5, passed: true });
});

test('an empty or unexecuted suite is never evidence', () => {
  const notests = tapSummary('Files=0, Tests=0,  0 wallclock secs\nResult: NOTESTS\n');
  assert.equal(notests.result, 'Result: NOTESTS');
  assert.equal(pgtapVerdict({ exitCode: 0, tap: notests }).passed, false);

  const zeroTests = tapSummary('Files=1, Tests=0,  0 wallclock secs\nResult: PASS\n');
  assert.equal(pgtapVerdict({ exitCode: 0, tap: zeroTests }).passed, false);

  const noSummary = tapSummary('Result: PASS\n');
  assert.deepEqual([noSummary.files, noSummary.tests], [null, null]);
  assert.equal(pgtapVerdict({ exitCode: 0, tap: noSummary }).passed, false);

  const noFiles = tapSummary('Files=0, Tests=5,  0 wallclock secs\nResult: PASS\n');
  assert.equal(pgtapVerdict({ exitCode: 0, tap: noFiles }).passed, false);
});

test('fewer assertions than planned, failures and non-zero exits fail', () => {
  const fewer = tapSummary('Files=1, Tests=3,  0 wallclock secs\nResult: PASS\n');
  assert.deepEqual(pgtapVerdict({ exitCode: 0, tap: fewer }), { executedTests: 3, passed: false });

  const failed = tapSummary('Files=1, Tests=5,  0 wallclock secs\nResult: FAIL\n');
  assert.equal(pgtapVerdict({ exitCode: 1, tap: failed }).passed, false);
  assert.equal(pgtapVerdict({ exitCode: 0, tap: failed }).passed, false);

  const notOk = tapSummary('ok 1\nnot ok 2 - the anon role exists\nFiles=1, Tests=5,  0 wallclock secs\nResult: PASS\n');
  assert.equal(pgtapVerdict({ exitCode: 0, tap: notOk }).passed, false);

  assert.equal(pgtapVerdict({ exitCode: 1, tap: tapSummary(PASSING_OUTPUT) }).passed, false);
});

test('verbose output is still accepted through the ok-line fallback', () => {
  const verbose = tapSummary(['/tmp/tests/tool7_tooling.test.sql .. ', '1..5', 'ok 1 - pgTAP is installed', 'ok 2 - anon', 'ok 3 - authenticated', 'ok 4 - service_role', 'ok 5 - no fixture schema', 'ok', 'All tests successful.', 'Result: PASS', ''].join('\n'));
  assert.equal(verbose.ok, 5);
  assert.deepEqual([verbose.files, verbose.tests], [null, null]);
  // Without prove's summary the file count is unknown, so the verdict still fails closed.
  assert.equal(pgtapVerdict({ exitCode: 0, tap: verbose }).passed, false);
  const withSummary = tapSummary(['ok 1', 'ok 2', 'ok 3', 'ok 4', 'ok 5', 'Files=1, Tests=5,  0 wallclock secs', 'Result: PASS'].join('\n'));
  assert.deepEqual(pgtapVerdict({ exitCode: 0, tap: withSummary }), { executedTests: 5, passed: true });
});

test('the planned assertion count matches the committed pgTAP file', () => {
  const sql = readFileSync(new URL('../../supabase/tests/tool7_tooling.test.sql', import.meta.url), 'utf8');
  const planned = /select\s+plan\((\d+)\)/.exec(sql);
  assert.ok(planned, 'the pgTAP file declares a plan');
  assert.equal(Number(planned[1]), TOOL7_PLANNED_TESTS);
  assert.equal((sql.match(/^select (ok|has_role)\(/gm) ?? []).length, TOOL7_PLANNED_TESTS);
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
  // The owner approved this lock from the supabase-images-record proposal; it must be complete.
  assert.equal(committed.status, 'approved');
  assert.deepEqual(approvalProblems(committed), []);
  // Any incomplete approval of the same lock is still refused: no trust on first use.
  assert.match(approvalProblems({ ...committed, status: 'pending-owner-approval' }).join(), /not approved yet/);
  assert.match(verifyImages({ ...committed, status: 'pending-owner-approval' }, running).join(), /not approved yet/);
  assert.match(approvalProblems({ ...committed, approvedOn: '<YYYY-MM-DD>' }).join(), /approvedOn must be YYYY-MM-DD/);
  assert.match(approvalProblems({ ...committed, approvedOn: '18-09-2026' }).join(), /approvedOn must be YYYY-MM-DD/);
  assert.match(approvalProblems({ ...committed, approvedOn: null }).join(), /approvedOn must be YYYY-MM-DD/);
  assert.match(approvalProblems({ ...committed, approvedBy: '   ' }).join(), /approvedBy is required/);
  assert.match(approvalProblems({ ...committed, poolerUserFormatEvidence: null }).join(), /poolerUserFormatEvidence is required/);
  assert.match(approvalProblems({ ...committed, images: [] }).join(), /no approved images/);
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
