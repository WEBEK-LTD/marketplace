// Tooling tests for the Phase 2 database scripts. No database is needed: everything under test is a
// pure function over file contents or catalog rows.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { columnType, interfaceName, render, TYPE_MAP, tsType, TypeGenError, OUTPUT_PATH } from './generate-types.mjs';
import { migrationFiles } from './supplemental-schema.mjs';
import {
  checkMigrations,
  contentProblems,
  FILE_NAME,
  headerProblems,
  namingProblems,
  rlsProblems,
} from '../policy/migrations.mjs';

// --- Migration policy ---------------------------------------------------------------------------
test('the committed migrations satisfy the migration policy', () => {
  const result = checkMigrations();
  assert.deepEqual(result.problems, []);
  assert.ok(result.migrations >= 11, 'the Phase 2 migrations committed so far are present');
  assert.ok(result.tests >= 10, 'the pgTAP suite is committed');
});

test('migration names must be NNNN_lower_snake_case.sql', () => {
  assert.ok(FILE_NAME.test('0001_extensions_and_schemas.sql'));
  assert.ok(!FILE_NAME.test('001_extensions.sql'));
  assert.ok(!FILE_NAME.test('0001-extensions.sql'));
  assert.ok(!FILE_NAME.test('0001_Extensions.sql'));
  assert.ok(!FILE_NAME.test('20260918000001_extensions.sql'));
});

test('versions must be contiguous, in order, and start at 0001', () => {
  assert.deepEqual(namingProblems(['0001_a.sql', '0002_b.sql']).problems, []);
  assert.match(namingProblems(['0001_a.sql', '0003_b.sql']).problems.join(), /expected migration 0002/);
  assert.match(namingProblems(['0002_a.sql']).problems.join(), /expected migration 0001/);
  assert.match(namingProblems(['0002_b.sql', '0001_a.sql']).problems.join(), /not in version order/);
  assert.match(namingProblems(['notes.sql']).problems.join(), /NNNN_lower_snake_case/);
  assert.deepEqual(namingProblems(['.gitkeep']).problems, []);
});

test('each migration introduces itself with its own number', () => {
  assert.deepEqual(headerProblems('0004_auth.sql', '-- 0004 — Auth security state\n'), []);
  assert.match(headerProblems('0004_auth.sql', '-- 0003 — Copied header\n').join(), /must start with "-- 0004 —/);
  assert.match(headerProblems('0004_auth.sql', 'create table x();\n').join(), /must start with/);
});

test('a table created without row level security is rejected', () => {
  const withRls = [{ name: '0001_a.sql', text: 'create table public.a (id int);\nalter table public.a enable row level security;' }];
  assert.deepEqual(rlsProblems(withRls), []);

  const across = [
    { name: '0001_a.sql', text: 'create table public.a (id int);' },
    { name: '0002_b.sql', text: 'alter table public.a enable row level security;' },
  ];
  assert.deepEqual(rlsProblems(across), [], 'RLS may be enabled by a later migration');

  const missing = [{ name: '0001_a.sql', text: 'create table public.a (id int);' }];
  assert.match(rlsProblems(missing).join(), /public\.a is created but row level security is never enabled/);

  const ifNotExists = [{ name: '0001_a.sql', text: 'create table if not exists app_private.b (id int);' }];
  assert.match(rlsProblems(ifNotExists).join(), /app_private\.b/);
});

test('grants to anon, password literals and unpinned SECURITY DEFINER functions are rejected', () => {
  assert.match(contentProblems('0001_a.sql', 'grant select on public.a to anon;').join(), /granted to anon/);
  assert.match(contentProblems('0001_a.sql', 'grant select on public.a to authenticated, anon;').join(), /granted to anon/);
  assert.deepEqual(contentProblems('0001_a.sql', 'grant select on public.a to authenticated;'), []);

  assert.match(contentProblems('0003_r.sql', "create role app_api login password 'hunter2';").join(), /password literal/);
  assert.deepEqual(contentProblems('0003_r.sql', 'create role app_api login noinherit;'), []);

  const unpinned = 'create or replace function public.f() returns boolean\nlanguage sql\nsecurity definer\nas $$ select true $$;';
  assert.match(contentProblems('0003_r.sql', unpinned).join(), /does not pin search_path/);

  const pinned = 'create or replace function public.f() returns boolean\nlanguage sql\nsecurity definer\nset search_path = pg_catalog, public\nas $$ select true $$;';
  assert.deepEqual(contentProblems('0003_r.sql', pinned), []);

  // A function body mentioning `security definer` in a comment must not be mistaken for a declaration.
  const invoker = 'create or replace function public.g() returns boolean\nlanguage sql\nas $$ select true -- security definer\n$$;';
  assert.deepEqual(contentProblems('0003_r.sql', invoker), []);
});

test('the supplemental runner applies exactly the committed migrations, in order', () => {
  const files = migrationFiles();
  assert.deepEqual(files, [...files].sort());
  assert.ok(files.every((name) => FILE_NAME.test(name)));
});

// --- Type generation ----------------------------------------------------------------------------
test('PostgreSQL types map to what node-postgres actually returns', () => {
  assert.equal(tsType('uuid'), 'string');
  assert.equal(tsType('int8'), 'string', 'bigint arrives as a string');
  assert.equal(tsType('numeric'), 'string', 'numeric arrives as a string');
  assert.equal(tsType('int4'), 'number');
  assert.equal(tsType('bytea'), 'Buffer');
  assert.equal(tsType('timestamptz'), 'Timestamp');
  assert.equal(tsType('jsonb'), 'Json');
  assert.equal(tsType('_text'), 'string[]');
  assert.equal(tsType('_int4'), 'number[]');
  assert.equal(tsType('tsvector'), 'string', 'search vectors are read as text');
  assert.equal(tsType('geography'), 'string', 'PostGIS values arrive as WKB hex text');
  assert.throws(() => tsType('money'), TypeGenError, 'an unmapped type fails instead of guessing');
  assert.ok(Object.isFrozen(TYPE_MAP));
});

test('nullability and defaults shape the column type', () => {
  assert.equal(columnType({ udt_name: 'text', is_nullable: false, has_default: false, is_identity: false }), 'string');
  assert.equal(columnType({ udt_name: 'text', is_nullable: true, has_default: false, is_identity: false }), 'string | null');
  assert.equal(columnType({ udt_name: 'text', is_nullable: false, has_default: true, is_identity: false }), 'Generated<string>');
  assert.equal(columnType({ udt_name: 'int8', is_nullable: false, has_default: false, is_identity: true }), 'Generated<string>');
  assert.equal(columnType({ udt_name: 'timestamptz', is_nullable: true, has_default: true, is_identity: false }), 'Generated<Timestamp | null>');
  // A generated column is computed by PostgreSQL and must never be insertable or updatable.
  assert.equal(
    columnType({ udt_name: 'tsvector', is_nullable: true, has_default: false, is_identity: false, is_generated: true }),
    'GeneratedAlways<string | null>',
  );
});

test('interface names are derived from the qualified table name', () => {
  assert.equal(interfaceName('public', 'locales'), 'PublicLocales');
  assert.equal(interfaceName('app_private', 'otp_challenges'), 'AppPrivateOtpChallenges');
  assert.equal(interfaceName('audit', 'audit_logs'), 'AuditAuditLogs');
});

test('the rendered module is deterministic and keys tables by qualified name', () => {
  const tables = [
    { schema: 'public', name: 'locales', columns: [{ name: 'code', udt_name: 'text', is_nullable: false, has_default: false, is_identity: false }] },
  ];
  const once = render(tables);
  assert.equal(once, render(tables), 'rendering twice produces the same text');
  assert.match(once, /export interface PublicLocales \{/);
  assert.match(once, /"public\.locales": PublicLocales;/);
  assert.match(once, /GENERATED FILE/);
});

test('the committed schema module is the generator output, not hand-written', () => {
  const committed = readFileSync(OUTPUT_PATH, 'utf8');
  assert.match(committed, /^\/\/ GENERATED FILE/);
  assert.match(committed, /export interface Database \{/);
  // Spot-check tables from each schema so a truncated regeneration is noticed here.
  for (const key of [
    '"public.outbox_events": PublicOutboxEvents;',
    '"app_private.rate_limits": AppPrivateRateLimits;',
    '"audit.audit_logs": AuditAuditLogs;',
    '"public.listings": PublicListings;',
    '"public.categories": PublicCategories;',
    '"public.seller_profiles": PublicSellerProfiles;',
    '"public.media_variants": PublicMediaVariants;',
  ]) {
    assert.ok(committed.includes(key), `${key} is present`);
  }
});
