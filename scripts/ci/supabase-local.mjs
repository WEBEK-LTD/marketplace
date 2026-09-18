// Local Supabase stack in CI (owner decisions E5, E7, E8; TOOL-3, B10-local, TOOL-7 pgTAP).
//   start | stop
//   tool3 --result <file>      TOOL-3 through the transaction pooler (connection values derived at runtime)
//   b10 --result <file>        B10-local: a temporary migration applied by the Supabase CLI, then removed
//   pgtap --result <file>      TOOL-7 pgTAP via `supabase test db --local`, then the pg_prove image digest
//   migrations --result <file> every committed migration is recorded as applied by the Supabase CLI
//   types --result <file>      packages/db/src/schema.ts matches the schema the migrations produced
//   record --output <file>     discovery for owner review (digests, service exclusions, pooler user format)
// Every CLI call goes through the V1 network policy wrapper. Connection values and passwords are never
// printed or written to result files. Result files must be outside the repository.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../toolchain/deno.mjs';
import { tool3StackSettings } from '../toolchain/supabase-config.mjs';
import { runSupabase } from '../toolchain/supabase-cli.mjs';
import {
  approvalProblems,
  EXCLUDABLE_SERVICES,
  ImageLockError,
  localImages,
  projectImages,
  proposeImages,
  pullApprovedImages,
  readLock,
  verifyImages,
  verifyTransient,
} from '../toolchain/supabase-images.mjs';

const pg = createRequire(join(REPO_ROOT, 'packages/db/package.json'))('pg');

export const B10_VERSION = '99991231235959';
export const B10_MIGRATION = `${B10_VERSION}_b10_local_probe.sql`;
export const B10_SQL = `-- B10-local probe (owner decision E5). Created in a temporary directory in CI only; never committed.
create schema b10_local_probe;
create table b10_local_probe.marker (id integer primary key, note text not null);
insert into b10_local_probe.marker (id, note) values (1, 'b10-local');
`;
const FIXTURE_ROLE = 'tool3_app_api';

export class CiError extends Error {}

/** Parses `supabase status -o env` output into a map (values stay in memory only). */
export function parseStatusEnv(text) {
  const values = new Map();
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(?:"(.*)"|(.*))$/.exec(line.trim());
    if (match) values.set(match[1], match[2] ?? match[3] ?? '');
  }
  return values;
}

export function poolerUser(format, role = FIXTURE_ROLE) {
  if (typeof format !== 'string' || !format.includes('{role}')) throw new CiError('pooler user format is not approved');
  return format.replace('{role}', role);
}

/** Candidate pooler user formats to probe during discovery. */
export function poolerUserCandidates(statusKeys) {
  const candidates = ['{role}', '{role}.pooler-dev', '{role}.marketplace'];
  for (const [key, value] of statusKeys) if (/TENANT/.test(key) && /^[a-z0-9-]+$/i.test(value)) candidates.push(`{role}.${value}`);
  return [...new Set(candidates)];
}

export function connectionUrls(status, format, settings) {
  const dbUrl = status.get('DB_URL');
  if (!dbUrl) throw new CiError(`supabase status did not provide DB_URL (keys: ${[...status.keys()].sort().join(', ') || 'none'})`);
  const admin = new URL(dbUrl);
  if (Number(admin.port) !== settings.dbPort) throw new CiError('DB_URL does not use the configured database port');
  const pooler = new URL(`postgresql://127.0.0.1:${settings.poolerPort}${admin.pathname}`);
  pooler.username = encodeURIComponent(poolerUser(format));
  return { adminUrl: admin.href, poolerUrl: pooler.href };
}

function outsideRepo(path) {
  if (!path || !isAbsolute(path)) return false;
  const rel = relative(REPO_ROOT, path);
  return rel.startsWith('..') || isAbsolute(rel);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!outsideRepo(value)) throw new CiError(`${name} needs an absolute path outside the repository`);
  return value;
}

async function cli(args, options = {}) {
  const result = await runSupabase(args, options);
  if (result.unreviewed.length > 0) throw new CiError(`Supabase CLI attempted an unreviewed outbound request: ${result.unreviewed.join(', ')}`);
  return result;
}

async function statusEnv() {
  const result = await cli(['status', '-o', 'env']);
  if (result.code !== 0) throw new CiError('the local Supabase stack is not running');
  return parseStatusEnv(result.output);
}

function node(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Keeps the JSON result block of the TOOL-3 harness (it never contains connection values). */
export function harnessResult(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end < start) return undefined;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

async function runTool3({ format, discovery }) {
  const settings = tool3StackSettings();
  const { adminUrl, poolerUrl } = connectionUrls(await statusEnv(), format, settings);
  const env = { TOOL3_POOLER_URL: poolerUrl, TOOL3_ADMIN_URL: adminUrl };
  const args = discovery
    ? [join(REPO_ROOT, 'packages/db/dist/tool3/run.js'), 'supabase', String(settings.poolerPort), String(settings.dbPort)]
    : [join(REPO_ROOT, 'scripts/tool3.mjs')];
  const run = await node(args, env);
  const verified = run.stdout.includes('TOOL-3 result: Local transaction-pooler behavior verified');
  const lastError = run.stderr.split('\n').filter((line) => line.startsWith('TOOL-3 not run') || line.startsWith('Run failed')).pop();
  return { passed: run.code === 0 && verified, exitCode: run.code, result: harnessResult(run.stdout) ?? null, message: lastError ?? null, discovery: Boolean(discovery) };
}

async function withAdmin(work) {
  const status = await statusEnv();
  const dbUrl = status.get('DB_URL');
  if (!dbUrl) throw new CiError('supabase status did not provide DB_URL');
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function realMigrationFiles() {
  return readdirSync(join(REPO_ROOT, 'supabase/migrations')).sort();
}

async function runB10() {
  const before = realMigrationFiles();
  // The probe must never collide with a real migration: its version is far in the future on purpose.
  if (before.some((name) => name.startsWith(B10_VERSION))) throw new CiError(`supabase/migrations already contains the B10 probe version ${B10_VERSION}`);
  const work = mkdtempSync(join(tmpdir(), 'b10-local-'));
  const result = { check: 'B10-local', temporaryMigration: B10_MIGRATION, applied: false, verified: false, removed: false, passed: false };
  try {
    mkdirSync(join(work, 'supabase'), { recursive: true });
    cpSync(join(REPO_ROOT, 'supabase/config.toml'), join(work, 'supabase/config.toml'));
    // The real migrations come along so the CLI sees the same history as the running stack and applies
    // only the probe; they are already applied, so nothing is re-run.
    cpSync(join(REPO_ROOT, 'supabase/migrations'), join(work, 'supabase/migrations'), { recursive: true });
    writeFileSync(join(work, 'supabase/migrations', B10_MIGRATION), B10_SQL);
    const up = await cli(['migration', 'up', '--local', '--workdir', work]);
    result.applied = up.code === 0;
    const list = await cli(['migration', 'list', '--local', '--workdir', work]);
    const listed = list.code === 0 && list.output.includes(B10_VERSION);
    const rows = await withAdmin(async (client) => (await client.query('select note from b10_local_probe.marker where id = 1')).rows);
    result.verified = listed && rows.length === 1 && rows[0].note === 'b10-local';
  } catch (error) {
    result.error = error instanceof CiError ? error.message : `${error.code ?? error.name}`;
  } finally {
    try {
      await withAdmin(async (client) => {
        await client.query('drop schema if exists b10_local_probe cascade');
        const history = await client.query("select to_regclass('supabase_migrations.schema_migrations') as t");
        if (history.rows[0].t) await client.query('delete from supabase_migrations.schema_migrations where version = $1', [B10_VERSION]);
        const left = await client.query("select count(*)::int as n from pg_namespace where nspname = 'b10_local_probe'");
        result.removed = left.rows[0].n === 0;
      });
    } catch {
      result.removed = false;
    }
    rmSync(work, { recursive: true, force: true });
  }
  const after = realMigrationFiles();
  result.repositoryMigrationsUnchanged = JSON.stringify(after) === JSON.stringify(before) && !existsSync(join(REPO_ROOT, 'supabase/migrations', B10_MIGRATION));
  result.passed = result.applied && result.verified && result.removed && result.repositoryMigrationsUnchanged;
  return result;
}

/**
 * Floor for the whole pgTAP suite. The planned total is read from the committed test files (so it can
 * never drift), but it must never fall below this: emptying the suite must not turn TOOL-7 green.
 */
export const TOOL7_MINIMUM_TESTS = 5;

/** Plan declared by the committed pgTAP files: how many files must run and how many assertions in total. */
export function plannedPgtap(dir = join(REPO_ROOT, 'supabase/tests')) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) throw new CiError('supabase/tests contains no pgTAP files');
  let tests = 0;
  for (const name of files) {
    const planned = /select\s+plan\((\d+)\)/.exec(readFileSync(join(dir, name), 'utf8'));
    if (planned === null) throw new CiError(`${name} does not declare a pgTAP plan`);
    tests += Number(planned[1]);
  }
  if (tests < TOOL7_MINIMUM_TESTS) throw new CiError(`the pgTAP suite plans ${tests} assertions, below the required minimum of ${TOOL7_MINIMUM_TESTS}`);
  return { files: files.length, tests };
}

/**
 * TAP summary without database content. `supabase test db` runs pg_prove without --verbose, so the run
 * reports itself through prove's summary line (`Files=N, Tests=N, ...`) and `Result:` rather than through
 * per-assertion `ok N` lines; those appear only in verbose output and are still counted as a fallback.
 */
export function tapSummary(output) {
  const lines = output.split('\n').map((l) => l.trim());
  const summary = lines.map((l) => /^Files=(\d+), Tests=(\d+)\b/.exec(l)).find(Boolean);
  return {
    ok: lines.filter((l) => /^ok \d+/.test(l)).length,
    notOk: lines.filter((l) => /^not ok \d+/.test(l)).length,
    files: summary ? Number(summary[1]) : null,
    tests: summary ? Number(summary[2]) : null,
    result: lines.find((l) => /^Result: /.test(l)) ?? null,
  };
}

/**
 * TOOL-7's verdict (owner decision E6): pgTAP must really have executed the committed assertions. An empty
 * or partly executed suite is not evidence, so `Result: NOTESTS`, zero files and fewer than the planned
 * assertions all fail. The executed count comes from prove's summary, falling back to verbose ok lines.
 */
export function pgtapVerdict({ exitCode, tap, planned }) {
  const executed = tap.tests ?? (tap.ok > 0 ? tap.ok : null);
  return {
    executedTests: executed,
    passed:
      exitCode === 0 &&
      tap.result === 'Result: PASS' &&
      tap.notOk === 0 &&
      (tap.files ?? 0) >= planned.files &&
      (executed ?? 0) >= planned.tests,
  };
}

async function runPgtap({ verifyDigest }) {
  const planned = plannedPgtap();
  const run = await cli(['test', 'db', '--local']);
  const tap = tapSummary(run.output);
  const verdict = pgtapVerdict({ exitCode: run.code, tap, planned });
  const result = { check: 'TOOL-7 pgTAP', exitCode: run.code, tap, planned, executedTests: verdict.executedTests, passed: verdict.passed };
  if (verifyDigest) {
    const problems = verifyTransient();
    result.pgProveDigest = problems.length === 0 ? 'verified' : problems;
    result.passed = result.passed && problems.length === 0;
  }
  return result;
}


/** Every committed migration must be recorded as applied; a silently skipped file is a failure. */
async function runMigrationsApplied() {
  const files = realMigrationFiles().filter((name) => name.endsWith('.sql'));
  const versions = files.map((name) => /^([0-9]+)_/.exec(name)?.[1]).filter((v) => v !== undefined);
  if (versions.length !== files.length) throw new CiError('every migration file must start with a numeric version');
  const applied = await withAdmin(async (client) => {
    const history = await client.query("select to_regclass('supabase_migrations.schema_migrations') as t");
    if (!history.rows[0].t) return [];
    return (await client.query('select version from supabase_migrations.schema_migrations')).rows.map((r) => r.version);
  });
  const missing = versions.filter((version) => !applied.includes(version));
  return { check: 'migrations applied', committed: versions.length, missing, passed: versions.length > 0 && missing.length === 0 };
}

/** Generated Kysely types must match the schema the migrations actually produced (v5.2 S17). */
async function runTypeDrift() {
  const status = await statusEnv();
  const dbUrl = status.get('DB_URL');
  if (!dbUrl) throw new CiError('supabase status did not provide DB_URL');
  const { OUTPUT_PATH, readSchema, render } = await import('../db/generate-types.mjs');
  const tables = await readSchema(dbUrl);
  const current = render(tables);
  const committed = readFileSync(OUTPUT_PATH, 'utf8');
  return {
    check: 'Kysely type drift',
    relations: tables.length,
    passed: tables.length > 0 && committed === current,
    hint: committed === current ? null : 'run `pnpm run db:types` against the local stack and commit packages/db/src/schema.ts',
  };
}

async function start(excluded) {
  const args = ['start'];
  if (excluded.length > 0) args.push('-x', excluded.join(','));
  const result = await cli(args, { inheritOutput: true });
  if (result.code !== 0) throw new CiError('supabase start failed');
}

async function stop() {
  await cli(['stop', '--no-backup'], { inheritOutput: true });
}

async function probePoolerFormats(settings, status) {
  const password = randomBytes(24).toString('base64url');
  const probeRole = 'tool3_pooler_probe';
  const outcomes = [];
  await withAdmin(async (client) => {
    await client.query(`drop role if exists ${probeRole}`);
    await client.query(`create role ${probeRole} login password ${client.escapeLiteral(password)}`);
  });
  try {
    for (const format of poolerUserCandidates(status)) {
      const url = new URL(`postgresql://127.0.0.1:${settings.poolerPort}${new URL(status.get('DB_URL')).pathname}`);
      url.username = encodeURIComponent(poolerUser(format, probeRole));
      url.password = encodeURIComponent(password);
      const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
      try {
        await client.connect();
        await client.query('select 1');
        outcomes.push({ format, connected: true });
      } catch (error) {
        outcomes.push({ format, connected: false, error: error.code ?? error.name });
      } finally {
        await client.end().catch(() => undefined);
      }
    }
  } finally {
    await withAdmin(async (client) => {
      await client.query('select pg_terminate_backend(pid) from pg_stat_activity where usename = $1', [probeRole]);
      await client.query(`drop role if exists ${probeRole}`);
    });
  }
  return outcomes;
}

async function attempt(name, excluded) {
  const outcome = { configuration: name, excludedServices: excluded, passed: false };
  try {
    await start(excluded);
    const status = await statusEnv();
    const settings = tool3StackSettings();
    outcome.statusKeys = [...status.keys()].sort();
    outcome.poolerUserProbe = await probePoolerFormats(settings, status);
    const format = outcome.poolerUserProbe.find((p) => p.connected)?.format;
    if (!format) throw new CiError('no pooler user format connected');
    outcome.poolerUserFormat = format;
    outcome.tool3Discovery = await runTool3({ format, discovery: true });
    outcome.b10Discovery = await runB10();
    outcome.pgtapDiscovery = await runPgtap({ verifyDigest: false });
    outcome.images = proposeImages([...projectImages(), ...localImages('pg_prove')]);
    outcome.passed = outcome.tool3Discovery.passed && outcome.b10Discovery.passed && outcome.pgtapDiscovery.passed;
  } catch (error) {
    outcome.error = error instanceof CiError ? error.message : `${error.code ?? error.name}`;
  } finally {
    await stop().catch(() => undefined);
  }
  return outcome;
}

async function record(output) {
  const minimal = await attempt('minimal', [...EXCLUDABLE_SERVICES]);
  const attempts = [minimal];
  if (!minimal.passed) attempts.push(await attempt('full', []));
  const chosen = attempts.find((a) => a.passed);
  const proposal = {
    kind: 'supabase-images-proposal',
    note: 'DISCOVERY ONLY. Not TOOL-3 and not an approved lock. The owner reviews this file; only an approved lock committed to toolchain/supabase-images.json is trusted.',
    discoveredAt: new Date().toISOString(),
    cliVersion: readLock().cliVersion,
    attempts,
    proposedLock: chosen
      ? {
          status: 'approved',
          approvedBy: '<owner>',
          approvedOn: '<YYYY-MM-DD>',
          excludedServices: chosen.excludedServices,
          exclusionEvidence: chosen.excludedServices.length > 0 ? `supabase-images-record run at ${new Date().toISOString().slice(0, 10)}: TOOL-3, B10-local and pgTAP discovery runs passed with these services excluded` : null,
          poolerUserFormat: chosen.poolerUserFormat,
          poolerUserFormatEvidence: `supabase-images-record run at ${new Date().toISOString().slice(0, 10)}: only this format connected through the local pooler`,
          images: chosen.images,
        }
      : null,
  };
  writeFileSync(output, `${JSON.stringify(proposal, null, 2)}\n`);
  return chosen ? 0 : 1;
}

async function main() {
  const command = process.argv[2];
  const lock = readLock();
  if (command === 'record') return record(argValue('--output'));
  if (command === 'stop') {
    await stop();
    return 0;
  }
  const problems = approvalProblems(lock);
  if (problems.length > 0) throw new CiError(problems.join('; '));
  if (command === 'start') {
    console.log('Pulling approved images by digest...');
    console.log(`Pulled ${pullApprovedImages(lock)} approved image(s) by digest.`);
    await start(lock.excludedServices);
    const images = verifyImages(lock);
    if (images.length > 0) throw new CiError(`image digest verification failed: ${images.join('; ')}`);
    console.log('Local Supabase stack started with approved images.');
    return 0;
  }
  const writers = {
    tool3: async () => runTool3({ format: lock.poolerUserFormat, discovery: false }),
    b10: async () => runB10(),
    pgtap: async () => {
      pullApprovedImages(lock, { transient: true });
      return runPgtap({ verifyDigest: true });
    },
    migrations: async () => runMigrationsApplied(),
    types: async () => runTypeDrift(),
  };
  if (!writers[command]) throw new CiError('Usage: supabase-local.mjs <start|stop|tool3|b10|pgtap|migrations|types> [--result <file>] | record --output <file>');
  const file = argValue('--result');
  const result = await writers[command]();
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${command}: ${result.passed ? 'PASS' : 'FAIL'}`);
  return result.passed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    // CiError and ImageLockError messages are written by this repository and carry no credentials
    // (docker details pass through sanitizeToolError first); anything else stays reduced to its name.
    const known = error instanceof CiError || error instanceof ImageLockError;
    console.error(known ? error.message : `failed: ${error.code ?? error.name}`);
    process.exit(1);
  });
}
