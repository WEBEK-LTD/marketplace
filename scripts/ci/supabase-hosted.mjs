// B10-hosted: migrations and verification against the NON-PRODUCTION hosted Supabase project.
//
//   node scripts/ci/supabase-hosted.mjs verify --result <file>
//
// Target and decisions come from policy/b10-hosted-decisions.json. The credential comes from the
// environment variable B10_HOSTED_DATABASE_URL and from nowhere else.
//
// ## How the credential is handled
//
// The password never becomes a command-line argument, so it cannot appear in a process listing, in
// `docker inspect`, in CI logs or in a shell trace. Concretely:
//
//   * `psql` is given no connection argument at all. Host, port, user and database travel as ordinary
//     environment variables (none of them secret), and the password is written to a 0600 `.pgpass`
//     file in a temporary directory outside the repository, pointed at by PGPASSFILE. libpq reads it.
//   * `pg_prove` runs in the approved image with that same directory mounted read-only and the
//     container running as this user, so the file keeps its 0600 semantics. The password is never a
//     `-e` value, which `docker inspect` would expose.
//   * `readSchema()` takes the connection string as a function argument — it is never serialised.
//   * Every error is reduced to a category before it is written or printed; provider errors are never
//     passed through verbatim, because a libpq failure can echo the connection it tried.
//
// `readSchema` is imported from scripts/db/generate-types.mjs deliberately. That module's CLI refuses a
// non-loopback DATABASE_TYPES_URL, and that guard is untouched: it protects the environment-variable
// path, which anyone can set. This caller is different — it is the approved hosted path, and it has
// already asserted the exact project ref, host, port and database before it gets here.
//
// ## What this proves about migration continuity, and what it does not
//
// Decision B keeps the Supabase CLI local-only, so the hosted database has no
// `supabase_migrations.schema_migrations` ledger and this runner deliberately does not fabricate one.
// Continuity is established instead by four facts recorded in the result file:
//
//   1. the committed set is contiguous 0001..NNNN with no gaps (checked from the repository),
//   2. each file was applied in numeric order, in one transaction, with ON_ERROR_STOP,
//   3. the run stopped at the first failure, and every file is listed with its SHA-256, so the result
//      states exactly which bytes were applied,
//   4. the resulting schema matches the committed packages/db/src/schema.ts, which is generated from
//      the schema these migrations produce.
//
// Limitations, stated because they matter: this proves what *this run* did. It does not prove that
// nothing else changed the database before or afterwards, it is not idempotent (the migrations are not
// written to be re-applied, so a second run against the same database will fail), and it is not a
// substitute for the Supabase CLI's own migration metadata, which this database does not have.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSchema, render, OUTPUT_PATH } from '../db/generate-types.mjs';
import { listMigrations, namingProblems } from '../policy/migrations.mjs';
import { readJson, REPO_ROOT } from '../policy/lib.mjs';
import { plannedPgtap, tapSummary, pgtapVerdict } from './supabase-local.mjs';

export class HostedError extends Error {}

export const DECISIONS_PATH = join(REPO_ROOT, 'policy/b10-hosted-decisions.json');
const CREDENTIAL_VARIABLE = 'B10_HOSTED_DATABASE_URL';
const PGTAP_IMAGE = 'public.ecr.aws/supabase/pg_prove:3.36';

/** The guard functions migration 0031 installs. All ten must report zero problems. */
export const GUARD_FUNCTIONS = Object.freeze([
  'security_contract_problems',
  'rls_problems',
  'grant_problems',
  'role_boundary_problems',
  'definer_problems',
  'anon_privilege_problems',
  'view_security_problems',
  'append_only_problems',
  'cron_job_problems',
  'storage_bucket_problems',
]);

export function target(path = DECISIONS_PATH) {
  return readJson(path).target;
}

/**
 * Checks the credential points at exactly the approved project, and returns the parts the tools need.
 * Fails closed on every mismatch, and never includes the credential in what it returns or throws.
 */
export function assertTarget(raw, expected) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new HostedError(`${CREDENTIAL_VARIABLE} is required.`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HostedError(`${CREDENTIAL_VARIABLE} is not a valid URL.`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new HostedError(`${CREDENTIAL_VARIABLE} must be a postgres URL.`);

  const port = url.port === '' ? 5432 : Number(url.port);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(url.username);
  const mismatches = [];
  if (url.hostname !== expected.host) mismatches.push(`host is not ${expected.host}`);
  if (port !== expected.port) mismatches.push(`port is not ${expected.port}`);
  if (database !== expected.database) mismatches.push(`database is not ${expected.database}`);
  if (!user.startsWith(expected.userPrefix)) mismatches.push(`user does not start with ${expected.userPrefix}`);
  else if (user.slice(expected.userPrefix.length) !== expected.projectRef) mismatches.push(`user does not name project ${expected.projectRef}`);
  if (url.password === '') mismatches.push('no password is present');
  // Names only. The values that did not match are part of the credential and are never reported.
  if (mismatches.length > 0) throw new HostedError(`${CREDENTIAL_VARIABLE} does not match the approved target: ${mismatches.join('; ')}`);

  return { host: url.hostname, port, database, user, password: url.password, projectRef: expected.projectRef };
}

/** A 0600 .pgpass in a throwaway directory outside the repository. Removed by `dispose()`. */
function credentialFile(parts) {
  const dir = mkdtempSync(join(tmpdir(), 'b10-hosted-'));
  const file = join(dir, 'pgpass');
  const escape = (value) => value.replace(/([\\:])/g, '\\$1');
  writeFileSync(file, `${escape(parts.host)}:${parts.port}:${escape(parts.database)}:${escape(parts.user)}:${escape(parts.password)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { dir, file, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** libpq settings for a child process. Everything here is non-secret except the file's contents. */
function libpqEnv(parts, passFile) {
  return {
    PGHOST: parts.host,
    PGPORT: String(parts.port),
    PGUSER: parts.user,
    PGDATABASE: parts.database,
    PGPASSFILE: passFile,
    PGSSLMODE: 'require',
    PGCONNECT_TIMEOUT: '30',
  };
}

/** Reduces any failure to a category. Provider text can echo the connection it tried, so it is dropped. */
export function categorise(stderr) {
  const text = String(stderr ?? '');
  if (/password authentication failed|no password supplied|SASL/i.test(text)) return 'authentication_failed';
  if (/permission denied to create role|must have CREATEROLE|permission denied/i.test(text)) return 'insufficient_privilege';
  if (/could not connect|could not translate host|timeout expired|Connection refused/i.test(text)) return 'unreachable';
  if (/is not a Supabase database/i.test(text)) return 'baseline_assertion_failed';
  if (/type "pgtap"|extension "pgtap"|function .*pgtap|could not open extension control file/i.test(text)) return 'pgtap_extension_missing';
  if (/already exists/i.test(text)) return 'already_applied';
  return 'sql_error';
}

function psql(args, env, { input } = {}) {
  const result = spawnSync('psql', ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...env },
  });
  return { code: result.status ?? -1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

/** One scalar. Queries are written here, never built from database content. */
function scalar(sql, env) {
  const run = psql(['-At', '-c', sql], env);
  if (run.code !== 0) throw new HostedError(`query failed (${categorise(run.stderr)})`);
  return run.stdout;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Contiguous 0001..NNNN, in order, from the repository. Reuses the committed migration policy. */
export function plannedMigrations(root = REPO_ROOT) {
  const names = listMigrations(root);
  const { problems } = namingProblems(names);
  if (problems.length > 0) throw new HostedError(`the committed migrations are not a contiguous ordered set: ${problems.join('; ')}`);
  // Only .sql is applied. namingProblems has already proved the set is contiguous and ordered.
  return names.filter((name) => name.endsWith('.sql'));
}

function applyMigrations(names, env, root) {
  const files = [];
  for (const [index, name] of names.entries()) {
    const path = join(root, 'supabase/migrations', name);
    const entry = { ordinal: index + 1, name, sha256: sha256File(path) };
    // --single-transaction with ON_ERROR_STOP: a migration either applies whole or not at all, and the
    // run stops here rather than carrying on into the next file.
    const run = psql(['--single-transaction', '-q', '-f', path], env);
    if (run.code !== 0) {
      files.push({ ...entry, status: 'failed', failureCategory: categorise(run.stderr) });
      return { files, appliedAll: false, failedAt: entry.ordinal, failureCategory: categorise(run.stderr) };
    }
    files.push({ ...entry, status: 'applied' });
  }
  return { files, appliedAll: true, failedAt: null, failureCategory: null };
}

function verifyDatabase(env) {
  const list = (sql) => scalar(sql, env).split('\n').filter((line) => line !== '');
  const roles = list(`select rolname from pg_roles where rolname in ('app_api','app_system','app_worker') order by 1`);
  const schemas = list(`select nspname from pg_namespace where nspname in ('app_private','audit') order by 1`);
  const extensions = list(`select extname from pg_extension order by 1`);
  const guards = GUARD_FUNCTIONS.map((name) => ({
    guard: name,
    problems: Number(scalar(`select count(*) from public.${name}()`, env)),
  }));
  const contract = Number(scalar(`select count(*) from app_private.assert_security_contract()`, env));
  const definerWithoutSearchPath = Number(
    scalar(
      `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and n.nspname in ('public','app_private','audit')
         and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path%'`,
      env,
    ),
  );
  const publicExecute = Number(
    scalar(
      `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public','app_private') and has_function_privilege('public', p.oid, 'execute')`,
      env,
    ),
  );
  const tablesWithoutRls = Number(
    scalar(
      `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'r' and n.nspname in ('public','app_private','audit') and not c.relrowsecurity`,
      env,
    ),
  );
  const serverVersion = scalar('show server_version', env);

  return {
    serverVersion,
    roles: { found: roles, expected: ['app_api', 'app_system', 'app_worker'], ok: roles.length === 3 },
    schemas: { found: schemas, expected: ['app_private', 'audit'], ok: schemas.length === 2 },
    extensions: { found: extensions },
    guards,
    guardsClean: guards.every((guard) => guard.problems === 0),
    securityContractProblems: contract,
    definerWithoutSearchPath,
    publicExecute,
    tablesWithoutRls,
    ok:
      roles.length === 3 &&
      schemas.length === 2 &&
      guards.every((guard) => guard.problems === 0) &&
      contract === 0 &&
      definerWithoutSearchPath === 0 &&
      publicExecute === 0 &&
      tablesWithoutRls === 0,
  };
}

function runPgtap(parts, passDir, passFile) {
  const lock = readJson(join(REPO_ROOT, 'toolchain/supabase-images.json'));
  const image = lock.images.find((entry) => entry.reference === PGTAP_IMAGE);
  if (!image || lock.status !== 'approved') throw new HostedError('the approved pg_prove image is not available in toolchain/supabase-images.json');
  const pinned = `${PGTAP_IMAGE.split(':')[0]}@${image.digest}`;

  const pull = spawnSync('docker', ['pull', pinned], { encoding: 'utf8' });
  if ((pull.status ?? -1) !== 0) throw new HostedError('could not pull the approved pg_prove image');

  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  // Host, port, user and database are not secret and may be -e values. The password never is: it stays
  // in the mounted 0600 file, so it is absent from `docker inspect` and from the process listing.
  const run = spawnSync(
    'docker',
    [
      'run', '--rm',
      '--user', `${uid}:${gid}`,
      '-v', `${join(REPO_ROOT, 'supabase/tests')}:/tests:ro`,
      '-v', `${passDir}:/pgpass:ro`,
      '-e', `PGHOST=${parts.host}`,
      '-e', `PGPORT=${parts.port}`,
      '-e', `PGUSER=${parts.user}`,
      '-e', `PGDATABASE=${parts.database}`,
      '-e', `PGPASSFILE=/pgpass/${passFile}`,
      '-e', 'PGSSLMODE=require',
      pinned,
      // No --verbose: per-assertion output would carry database content into the log.
      'pg_prove', '--ext', '.sql', '-r', '/tests',
    ],
    { encoding: 'utf8' },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const planned = plannedPgtap();
  const tap = tapSummary(output);
  const verdict = pgtapVerdict({ exitCode: run.status ?? -1, tap, planned });
  return {
    image: pinned,
    planned,
    tap,
    executedTests: verdict.executedTests,
    passed: verdict.passed,
    failureCategory: verdict.passed ? null : categorise(output),
  };
}

function checkSchemaDrift(raw) {
  return readSchema(raw).then((tables) => {
    const rendered = render(tables);
    const committed = readFileSync(OUTPUT_PATH, 'utf8');
    return { relations: tables.length, matchesCommittedSchema: rendered === committed };
  });
}

export async function verify({ raw = process.env[CREDENTIAL_VARIABLE], root = REPO_ROOT } = {}) {
  const expected = target();
  const parts = assertTarget(raw, expected);
  const result = {
    check: 'B10-hosted',
    environment: expected.environment,
    projectRef: parts.projectRef,
    region: expected.region,
    host: parts.host,
    port: parts.port,
    database: parts.database,
    poolerMode: expected.poolerMode,
    targetAsserted: true,
    passed: false,
    failureCategory: null,
  };

  const credential = credentialFile(parts);
  try {
    const env = libpqEnv(parts, credential.file);

    const names = plannedMigrations(root);
    const applied = applyMigrations(names, env, root);
    result.migrations = {
      planned: names.length,
      applied: applied.files.filter((file) => file.status === 'applied').length,
      appliedInOrder: true,
      stoppedAtFirstFailure: !applied.appliedAll,
      failedAt: applied.failedAt,
      files: applied.files,
    };
    result.continuity = {
      contiguousCommittedSet: true,
      everyMigrationConsidered: applied.files.length === names.length || !applied.appliedAll,
      ledger: 'none: Decision B keeps the Supabase CLI local-only, so supabase_migrations.schema_migrations does not exist here and no substitute ledger is written',
      provenBy: [
        'the committed set is contiguous 0001..NNNN (repository check)',
        'each file applied in numeric order, single transaction, ON_ERROR_STOP',
        'the run stops at the first failure; every file is listed with its SHA-256',
        'the resulting schema matches the committed packages/db/src/schema.ts',
      ],
      limitations: [
        'proves what this run did, not that nothing else changed the database',
        'not idempotent: the migrations are not written to be re-applied',
        'not a substitute for Supabase CLI migration metadata',
      ],
    };
    if (!applied.appliedAll) {
      result.failureCategory = applied.failureCategory;
      return result;
    }

    result.verification = verifyDatabase(env);
    result.schema = await checkSchemaDrift(raw);
    result.pgtap = runPgtap(parts, credential.dir, 'pgpass');

    result.passed = result.verification.ok && result.schema.matchesCommittedSchema && result.pgtap.passed;
    if (!result.passed) {
      result.failureCategory = !result.verification.ok
        ? 'security_verification_failed'
        : !result.schema.matchesCommittedSchema
          ? 'schema_drift'
          : (result.pgtap.failureCategory ?? 'pgtap_failed');
    }
    return result;
  } finally {
    credential.dispose();
  }
}

function argValue(name) {
  const value = process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes(name) || !value) throw new HostedError(`missing ${name}`);
  return value;
}

async function main() {
  if (process.argv[2] !== 'verify') throw new HostedError('Usage: supabase-hosted.mjs verify --result <file>');
  const file = argValue('--result');
  const result = await verify();
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`b10-hosted: ${result.passed ? 'PASS' : `FAIL (${result.failureCategory ?? 'unknown'})`}`);
  return result.passed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      // HostedError messages are written here and carry no credential. Anything else is reduced to its
      // name, because a libpq or provider error can echo the connection it tried.
      console.error(error instanceof HostedError ? error.message : `b10-hosted failed: ${error.code ?? error.name}`);
      process.exit(1);
    },
  );
}
