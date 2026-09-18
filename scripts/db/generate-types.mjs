// Kysely type generation from the live schema (v5.2 S17: type drift is a Phase 2 concern, once real
// migrations exist). No code generator dependency is added: the schema is read from the catalog through
// the `pg` client the database package already uses, and the output is deterministic.
//
//   node scripts/db/generate-types.mjs            # write packages/db/src/schema.ts
//   node scripts/db/generate-types.mjs --check    # fail if the committed file is out of date
//
// Requires DATABASE_TYPES_URL (loopback only). The URL is never printed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../toolchain/deno.mjs';

const pg = createRequire(join(REPO_ROOT, 'packages/db/package.json'))('pg');

export const OUTPUT_PATH = join(REPO_ROOT, 'packages/db/src/schema.ts');
export const SCHEMAS = ['public', 'app_private', 'audit'];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class TypeGenError extends Error {}

/**
 * PostgreSQL type → TypeScript type, as node-postgres actually returns it.
 * bigint, numeric and interval arrive as strings; bytea as Buffer; PostGIS values as WKB hex text.
 */
export const TYPE_MAP = Object.freeze({
  bool: 'boolean',
  bytea: 'Buffer',
  char: 'string',
  bpchar: 'string',
  citext: 'string',
  date: 'Timestamp',
  float4: 'number',
  float8: 'number',
  geography: 'string',
  geometry: 'string',
  inet: 'string',
  int2: 'number',
  int4: 'number',
  int8: 'string',
  interval: 'string',
  json: 'Json',
  jsonb: 'Json',
  name: 'string',
  numeric: 'string',
  oid: 'number',
  text: 'string',
  time: 'string',
  timestamp: 'Timestamp',
  timestamptz: 'Timestamp',
  timetz: 'string',
  uuid: 'string',
  varchar: 'string',
});

export function tsType(udtName) {
  if (udtName.startsWith('_')) {
    const inner = tsType(udtName.slice(1));
    return `${inner}[]`;
  }
  const mapped = TYPE_MAP[udtName];
  if (mapped === undefined) throw new TypeGenError(`no TypeScript mapping for PostgreSQL type ${udtName}`);
  return mapped;
}

/** `public.locales` → `PublicLocales`. */
export function interfaceName(schema, table) {
  const words = `${schema}_${table}`.split(/[^a-z0-9]+/i).filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

export function columnType(column) {
  const base = tsType(column.udt_name);
  const nullable = column.is_nullable ? `${base} | null` : base;
  if (column.is_identity) return `Generated<${nullable}>`;
  if (column.has_default) return `Generated<${nullable}>`;
  return nullable;
}

const HEADER = `// GENERATED FILE — do not edit.
// Produced by scripts/db/generate-types.mjs from the schema in supabase/migrations/.
// Regenerate with \`pnpm run db:types\`; CI fails when this file and the migrations disagree.

import type { ColumnType } from 'kysely';

/** A column the database fills in: optional on insert, not updatable by default. */
export type Generated<T> = T extends ColumnType<infer S, infer I, infer U> ? ColumnType<S, I | undefined, U> : ColumnType<T, T | undefined, T>;

/** \`timestamptz\`/\`timestamp\`/\`date\`: read as Date, written as Date or ISO string. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

/** \`json\`/\`jsonb\`. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
`;

export function render(tables) {
  const parts = [HEADER];
  for (const table of tables) {
    const name = interfaceName(table.schema, table.name);
    parts.push(`\nexport interface ${name} {`);
    for (const column of table.columns) {
      parts.push(`  ${JSON.stringify(column.name)}: ${columnType(column)};`);
    }
    parts.push('}');
  }
  parts.push('\nexport interface Database {');
  for (const table of tables) {
    parts.push(`  ${JSON.stringify(`${table.schema}.${table.name}`)}: ${interfaceName(table.schema, table.name)};`);
  }
  parts.push('}\n');
  return `${parts.join('\n')}`;
}

const QUERY = `
select
  c.table_schema as schema,
  c.table_name as name,
  c.column_name as column_name,
  c.udt_name as udt_name,
  c.is_nullable = 'YES' as is_nullable,
  c.column_default is not null as has_default,
  c.is_identity = 'YES' as is_identity,
  c.ordinal_position as position
from information_schema.columns c
join pg_class rel on rel.relname = c.table_name
join pg_namespace ns on ns.oid = rel.relnamespace and ns.nspname = c.table_schema
where c.table_schema = any($1::text[])
  and rel.relkind in ('r', 'p', 'v', 'm')
  and rel.relispartition = false
order by c.table_schema, c.table_name, c.ordinal_position
`;

export async function readSchema(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(QUERY, [SCHEMAS]);
    const byTable = new Map();
    for (const row of rows) {
      const key = `${row.schema}.${row.name}`;
      if (!byTable.has(key)) byTable.set(key, { schema: row.schema, name: row.name, columns: [] });
      byTable.get(key).columns.push({
        name: row.column_name,
        udt_name: row.udt_name,
        is_nullable: row.is_nullable,
        has_default: row.has_default,
        is_identity: row.is_identity,
      });
    }
    return [...byTable.values()].sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
  } finally {
    await client.end().catch(() => undefined);
  }
}

function connectionUrl() {
  const raw = process.env.DATABASE_TYPES_URL;
  if (!raw) throw new TypeGenError('DATABASE_TYPES_URL is required.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeGenError('DATABASE_TYPES_URL is not a valid URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new TypeGenError('DATABASE_TYPES_URL must be a postgres URL.');
  if (!LOOPBACK.has(url.hostname)) throw new TypeGenError('DATABASE_TYPES_URL must point at a loopback host.');
  return url.href;
}

async function main() {
  const check = process.argv.includes('--check');
  const tables = await readSchema(connectionUrl());
  if (tables.length === 0) throw new TypeGenError('the database has no tables in public, app_private or audit; migrations are missing');
  const generated = render(tables);
  if (!check) {
    writeFileSync(OUTPUT_PATH, generated);
    console.log(`wrote packages/db/src/schema.ts (${tables.length} relations)`);
    return 0;
  }
  const committed = readFileSync(OUTPUT_PATH, 'utf8');
  if (committed !== generated) {
    console.error('packages/db/src/schema.ts is out of date: run `pnpm run db:types` and commit the result.');
    return 1;
  }
  console.log(`packages/db/src/schema.ts is current (${tables.length} relations).`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof TypeGenError ? error.message : `failed: ${error.code ?? error.name}`);
      process.exit(1);
    },
  );
}
