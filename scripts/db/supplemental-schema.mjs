// Sandbox supplemental schema run — NOT Supabase, NOT TOOL-3, NOT CI evidence.
//
// Applies supabase/migrations/*.sql in order to a plain local PostgreSQL server so the SQL can be
// exercised where Docker is unavailable. The authoritative run is the CI `supabase-local` job, which
// applies the same files through the Supabase CLI on the approved images.
//
//   node scripts/db/supplemental-schema.mjs [--baseline] [--reset] [--tests]
//
// Requires SUPPLEMENTAL_SCHEMA_URL (loopback only). The URL is never printed.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../toolchain/deno.mjs';

const pg = createRequire(join(REPO_ROOT, 'packages/db/package.json'))('pg');

export const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations');
export const TESTS_DIR = join(REPO_ROOT, 'supabase/tests');
const BANNER = '*** Sandbox supplemental schema run — NOT Supabase, NOT CI evidence ***';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class SupplementalError extends Error {}

/** Migration files in application order, validated by scripts/policy/migrations.mjs. */
export function migrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
}

function connectionUrl() {
  const raw = process.env.SUPPLEMENTAL_SCHEMA_URL;
  if (!raw) throw new SupplementalError('SUPPLEMENTAL_SCHEMA_URL is required.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SupplementalError('SUPPLEMENTAL_SCHEMA_URL is not a valid URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new SupplementalError('SUPPLEMENTAL_SCHEMA_URL must be a postgres URL.');
  if (!LOOPBACK.has(url.hostname)) throw new SupplementalError('SUPPLEMENTAL_SCHEMA_URL must point at a loopback host.');
  return url.href;
}

async function apply(client, label, sql) {
  const started = Date.now();
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw new SupplementalError(`${label}: ${error.message}${error.position ? ` (position ${error.position})` : ''}`);
  }
  return Date.now() - started;
}

async function main() {
  console.log(BANNER);
  const wantBaseline = process.argv.includes('--baseline');
  const wantReset = process.argv.includes('--reset');
  const wantTests = process.argv.includes('--tests');
  const client = new pg.Client({ connectionString: connectionUrl() });
  await client.connect();
  try {
    if (wantReset) {
      await client.query('drop schema if exists public, app_private, audit cascade');
      await client.query('create schema public');
      await client.query('drop table if exists supabase_migrations.schema_migrations');
    }
    if (wantBaseline) {
      const ms = await apply(client, 'sandbox-baseline.sql', readFileSync(join(REPO_ROOT, 'scripts/db/sandbox-baseline.sql'), 'utf8'));
      console.log(`baseline: applied in ${ms} ms`);
    }

    await client.query('create schema if not exists supabase_migrations');
    await client.query('create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[], inserted_at timestamptz not null default now())');
    const applied = new Set((await client.query('select version from supabase_migrations.schema_migrations')).rows.map((r) => r.version));

    for (const file of migrationFiles()) {
      const version = /^([0-9]+)_/.exec(file)?.[1];
      if (version === undefined) throw new SupplementalError(`${file} does not start with a numeric version`);
      if (applied.has(version)) {
        console.log(`${file}: already applied`);
        continue;
      }
      const ms = await apply(client, file, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      await client.query('insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)', [version, file]);
      console.log(`${file}: applied in ${ms} ms`);
    }

    if (wantTests) {
      const url = new URL(connectionUrl());
      const files = existsSync(TESTS_DIR) ? readdirSync(TESTS_DIR).filter((n) => n.endsWith('.sql')).sort() : [];
      if (files.length === 0) throw new SupplementalError('no pgTAP test files found');
      const args = ['--ext', '.sql', '-r', '--failures', ...files.map((f) => join(TESTS_DIR, f))];
      const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port, PGUSER: decodeURIComponent(url.username), PGDATABASE: url.pathname.slice(1) };
      console.log(execFileSync('pg_prove', args, { env, encoding: 'utf8' }));
    }
    console.log('*** End of sandbox supplemental schema run (not CI evidence) ***');
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof SupplementalError ? error.message : `failed: ${error.code ?? error.name}`);
      process.exit(1);
    },
  );
}
