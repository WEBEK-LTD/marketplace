import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { psqlMajor, psqlVersion, redisVersion, sanitizeE2eReport, sanitizeTool1 } from './checks.mjs';
import { assertTarget, categorise, GUARD_FUNCTIONS, plannedMigrations, sha256File, target } from './supabase-hosted.mjs';
import { B10_MIGRATION, B10_SQL, B10_VERSION, CiError, connectionUrls, harnessResult, parseStatusEnv, pgtapVerdict, plannedPgtap, poolerUser, poolerUserCandidates, tapSummary, TOOL7_MINIMUM_TESTS } from './supabase-local.mjs';
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

/** One file planning five assertions: the smallest suite the verdict may ever accept. */
const ONE_FILE = { files: 1, tests: 5 };

test('a real non-verbose passing run is accepted', () => {
  const tap = tapSummary(PASSING_OUTPUT);
  assert.deepEqual(tap, { ok: 0, notOk: 0, files: 1, tests: 5, result: 'Result: PASS' });
  assert.deepEqual(pgtapVerdict({ exitCode: 0, tap, planned: ONE_FILE }), { executedTests: 5, passed: true });
});

test('an empty or unexecuted suite is never evidence', () => {
  const notests = tapSummary('Files=0, Tests=0,  0 wallclock secs\nResult: NOTESTS\n');
  assert.equal(notests.result, 'Result: NOTESTS');
  assert.equal(pgtapVerdict({ exitCode: 0, tap: notests, planned: ONE_FILE }).passed, false);

  const zeroTests = tapSummary('Files=1, Tests=0,  0 wallclock secs\nResult: PASS\n');
  assert.equal(pgtapVerdict({ exitCode: 0, tap: zeroTests, planned: ONE_FILE }).passed, false);

  const noSummary = tapSummary('Result: PASS\n');
  assert.deepEqual([noSummary.files, noSummary.tests], [null, null]);
  assert.equal(pgtapVerdict({ exitCode: 0, tap: noSummary, planned: ONE_FILE }).passed, false);

  const noFiles = tapSummary('Files=0, Tests=5,  0 wallclock secs\nResult: PASS\n');
  assert.equal(pgtapVerdict({ exitCode: 0, tap: noFiles, planned: ONE_FILE }).passed, false);
});

test('fewer assertions than planned, failures and non-zero exits fail', () => {
  const fewer = tapSummary('Files=1, Tests=3,  0 wallclock secs\nResult: PASS\n');
  assert.deepEqual(pgtapVerdict({ exitCode: 0, tap: fewer, planned: ONE_FILE }), { executedTests: 3, passed: false });

  const failed = tapSummary('Files=1, Tests=5,  0 wallclock secs\nResult: FAIL\n');
  assert.equal(pgtapVerdict({ exitCode: 1, tap: failed, planned: ONE_FILE }).passed, false);
  assert.equal(pgtapVerdict({ exitCode: 0, tap: failed, planned: ONE_FILE }).passed, false);

  const notOk = tapSummary('ok 1\nnot ok 2 - the anon role exists\nFiles=1, Tests=5,  0 wallclock secs\nResult: PASS\n');
  assert.equal(pgtapVerdict({ exitCode: 0, tap: notOk, planned: ONE_FILE }).passed, false);

  assert.equal(pgtapVerdict({ exitCode: 1, tap: tapSummary(PASSING_OUTPUT), planned: ONE_FILE }).passed, false);
});

test('verbose output is still accepted through the ok-line fallback', () => {
  const verbose = tapSummary(['/tmp/tests/tool7_tooling.test.sql .. ', '1..5', 'ok 1 - pgTAP is installed', 'ok 2 - anon', 'ok 3 - authenticated', 'ok 4 - service_role', 'ok 5 - no fixture schema', 'ok', 'All tests successful.', 'Result: PASS', ''].join('\n'));
  assert.equal(verbose.ok, 5);
  assert.deepEqual([verbose.files, verbose.tests], [null, null]);
  // Without prove's summary the file count is unknown, so the verdict still fails closed.
  assert.equal(pgtapVerdict({ exitCode: 0, tap: verbose, planned: ONE_FILE }).passed, false);
  const withSummary = tapSummary(['ok 1', 'ok 2', 'ok 3', 'ok 4', 'ok 5', 'Files=1, Tests=5,  0 wallclock secs', 'Result: PASS'].join('\n'));
  assert.deepEqual(pgtapVerdict({ exitCode: 0, tap: withSummary, planned: ONE_FILE }), { executedTests: 5, passed: true });
});

test('the planned total is read from the committed pgTAP files and cannot drift', () => {
  const planned = plannedPgtap();
  assert.ok(planned.files >= 1, 'at least one pgTAP file is committed');
  assert.ok(planned.tests >= TOOL7_MINIMUM_TESTS, 'the suite plans at least the required minimum');

  const dir = new URL('../../supabase/tests/', import.meta.url);
  const names = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  const total = names.reduce((sum, name) => sum + Number(/select\s+plan\((\d+)\)/.exec(readFileSync(new URL(name, dir), 'utf8'))[1]), 0);
  assert.deepEqual(planned, { files: names.length, tests: total });

  // A run that executes fewer assertions or fewer files than the committed suite is never evidence.
  const short = tapSummary(`Files=${planned.files - 1}, Tests=${planned.tests},  0 wallclock secs\nResult: PASS\n`);
  assert.equal(pgtapVerdict({ exitCode: 0, tap: short, planned }).passed, false);
  const fewer = tapSummary(`Files=${planned.files}, Tests=${planned.tests - 1},  0 wallclock secs\nResult: PASS\n`);
  assert.equal(pgtapVerdict({ exitCode: 0, tap: fewer, planned }).passed, false);
  const exact = tapSummary(`Files=${planned.files}, Tests=${planned.tests},  0 wallclock secs\nResult: PASS\n`);
  assert.equal(pgtapVerdict({ exitCode: 0, tap: exact, planned }).passed, true);
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

// ---------------------------------------------------------------- psql (O-22) and B10-hosted

test('psql version parsing and the approved major', () => {
  assert.equal(psqlVersion('psql (PostgreSQL) 16.10 (Ubuntu 16.10-0ubuntu0.24.04.1)'), '16.10');
  assert.equal(psqlMajor(psqlVersion('psql (PostgreSQL) 16.10 (Ubuntu 16.10-0ubuntu0.24.04.1)')), '16');
  assert.equal(psqlMajor(psqlVersion('psql (PostgreSQL) 17.2')), '17');
  assert.equal(psqlVersion('command not found'), undefined);
  assert.equal(psqlMajor(undefined), undefined);
  const system = JSON.parse(readFileSync(new URL('../../toolchain/ci-system.json', import.meta.url), 'utf8'));
  assert.equal(system.psql.expectedMajor, '16');
  assert.match(system.psql.source, /Ubuntu 24\.04 apt package postgresql-client-16/);
  // No second package source: the client comes from the Ubuntu archive and nowhere else.
  assert.doesNotMatch(system.psql.source, /pgdg|postgresql\.org|deb\s/i);
  assert.match(system.psql.source, /^Ubuntu 24\.04 apt package /);
});

test('B10-hosted: the target assertion fails closed and never echoes the credential', () => {
  const expected = target();
  assert.equal(expected.projectRef, 'slndmkpyakbaradiyaty');
  const good = `postgresql://postgres.${expected.projectRef}:PLACEHOLDER-NOT-A-SECRET@${expected.host}:${expected.port}/${expected.database}`;
  const parts = assertTarget(good, expected);
  assert.equal(parts.host, expected.host);
  assert.equal(parts.user, `postgres.${expected.projectRef}`);

  const rejects = (url, pattern) => assert.throws(() => assertTarget(url, expected), pattern);
  rejects(undefined, /is required/);
  rejects('nonsense', /not a valid URL/);
  rejects(good.replace('postgresql://', 'mysql://'), /must be a postgres URL/);
  rejects(good.replace(expected.host, 'db.slndmkpyakbaradiyaty.supabase.co'), /host is not/);
  rejects(good.replace(`:${expected.port}`, ':6543'), /port is not/);
  rejects(good.replace(new RegExp(`/${expected.database}$`), '/other'), /database is not/);
  rejects(good.replace(`postgres.${expected.projectRef}`, 'postgres.otherref'), /does not name project/);
  rejects(good.replace(`postgres.${expected.projectRef}`, 'someone'), /does not start with/);
  rejects(good.replace(':PLACEHOLDER-NOT-A-SECRET', ''), /no password is present/);

  // A rejection names what did not match, never the value that did not match.
  try {
    assertTarget(`postgresql://postgres.wrong:PLACEHOLDER-NOT-A-SECRET@${expected.host}:${expected.port}/${expected.database}`, expected);
    assert.fail('expected a rejection');
  } catch (error) {
    assert.doesNotMatch(error.message, /PLACEHOLDER-NOT-A-SECRET/);
  }
});

test('B10-hosted: failures are reduced to categories, never passed through', () => {
  assert.equal(categorise('FATAL: password authentication failed for user "postgres.x"'), 'authentication_failed');
  assert.equal(categorise('ERROR: permission denied to create role'), 'insufficient_privilege');
  assert.equal(categorise('could not connect to server: Connection timed out'), 'unreachable');
  assert.equal(categorise('ERROR: This database is not a Supabase database: missing schema auth'), 'baseline_assertion_failed');
  assert.equal(categorise('ERROR: extension "pgtap" is not available'), 'pgtap_extension_missing');
  assert.equal(categorise('ERROR: syntax error at or near "slect"'), 'sql_error');
});

test('B10-hosted: the planned migration set is the committed one, contiguous and ordered', () => {
  const names = plannedMigrations();
  assert.equal(names.length, 37);
  assert.equal(names[0], '0001_extensions_and_schemas.sql');
  assert.equal(names.at(-1), '0037_step_up_grant_consumption.sql');
  assert.ok(names.every((name) => name.endsWith('.sql')));
  names.forEach((name, index) => assert.equal(name.slice(0, 4), String(index + 1).padStart(4, '0')));
  assert.equal(GUARD_FUNCTIONS.length, 10);
  // The hash is of the committed bytes, so the result file states exactly what was applied.
  assert.match(sha256File(new URL('../../supabase/migrations/0001_extensions_and_schemas.sql', import.meta.url)), /^[0-9a-f]{64}$/);
});

test('B10-hosted: the runner never puts the credential where it could be read back', () => {
  const source = readFileSync(new URL('./supabase-hosted.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // No connection argument on the command line, for psql or for docker.
  assert.doesNotMatch(code, /PGPASSWORD/);
  assert.doesNotMatch(code, /'-d',|"--dbname"|--dbname=/);
  assert.doesNotMatch(code, /--verbose/);
  // The password reaches libpq only through a 0600 file outside the repository.
  assert.match(code, /mkdtempSync/);
  assert.match(code, /mode: 0o600/);
  assert.match(code, /PGPASSFILE/);
  assert.match(code, /rmSync\(dir, \{ recursive: true, force: true \}\)/);
  // Errors are categorised rather than passed through.
  assert.match(code, /categorise\(/);
});
