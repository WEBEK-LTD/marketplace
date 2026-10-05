// Tooling tests for the Phase 2 database scripts. No database is needed: everything under test is a
// pure function over file contents or catalog rows.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { columnType, interfaceName, render, TYPE_MAP, tsType, TypeGenError, OUTPUT_PATH } from './generate-types.mjs';
import { migrationFiles } from './supplemental-schema.mjs';
import {
  checkMigrations,
  contentProblems,
  FILE_NAME,
  headerProblems,
  namingProblems,
  looseBtrimCalls,
  PAGINATION_CEILING_EXEMPT,
  paginationCeilingProblems,
  paginationExemptionProblems,
  declaredMaxLimits,
  eventDedupClockProblems,
  readerCeilings,
  rlsProblems,
} from '../policy/migrations.mjs';
import { REPO_ROOT } from '../policy/lib.mjs';

// --- Migration policy ---------------------------------------------------------------------------
test('the committed migrations satisfy the migration policy', () => {
  const result = checkMigrations();
  assert.deepEqual(result.problems, []);
  assert.ok(result.migrations >= 37, 'the Phase 2 migrations and the Phase 3 migrations so far are present');
  // 35 active files: 0037's pgTAP file is archived in supabase/tests-disabled/ and is deliberately
  // not executed by the suite. Migration 0037 itself is unchanged and still applies.
  assert.ok(result.tests >= 35, 'the pgTAP suite is committed');
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

// --- 0105: btrim must name its character set -----------------------------------------------------
// `btrim(x)` trims spaces only. Two instances of that were proved reachable before 0105 — a
// whitespace-only category name on the public catalogue, and a report closed on a whitespace-only
// resolution note — so from 0106 on the policy rejects the loose form outright.
//
// This detector replaced a regex (`btrim\([^,)]*\)`) that reported success over work it had never
// looked at: it missed `btrim(coalesce(x, ''))` entirely, so 2 constraints and 1 function were still
// loose while the check passed. Every shape that defeated it is a case below.
test('looseBtrimCalls walks to the matching paren rather than guessing', () => {
  const one = (text) => looseBtrimCalls(text).length;

  assert.equal(one('length(btrim(name)) >= 1'), 1, 'a bare call is loose');
  assert.equal(one("length(btrim(name, E' \\t\\r\\n')) >= 1"), 0, 'naming the set is not');

  // The shape the regex missed: the first `)` belongs to coalesce, not to btrim.
  assert.equal(one("nullif(btrim(coalesce(p_a, '')), '')"), 1);
  assert.equal(one("nullif(btrim(coalesce(p_a, ''), E' \\t\\r\\n'), '')"), 0);

  // Nesting deeper, and a call whose argument is itself a call with two arguments.
  assert.equal(one("btrim(concat(a, coalesce(b, ''), c))"), 1);
  assert.equal(one("btrim(concat(a, coalesce(b, ''), c), E' \\t\\r\\n')"), 0);

  // A comma inside a quoted literal is not an argument separator, and a doubled quote is not a close.
  assert.equal(one("btrim(coalesce(a, 'x, y'))"), 1);
  assert.equal(one("btrim(coalesce(a, 'it''s, fine'))"), 1);
  assert.equal(one("btrim(a, ', ')"), 0, 'any second argument counts: the set itself is checked in SQL');

  // Mixtures, and text with nothing to find.
  assert.equal(one("btrim(a) || btrim(b, E' \\t\\r\\n') || btrim(c)"), 2);
  assert.equal(one('select 1'), 0);
  assert.equal(one(''), 0);

  // `rtrim`/`ltrim` and an identifier that merely ends in btrim are different functions.
  assert.equal(one('rtrim(a) || ltrim(b)'), 0);
  assert.equal(one('my_btrim(a)'), 0, 'a longer identifier ending in btrim is not btrim');
  assert.equal(one('btrim (a)'), 1, 'and whitespace before the parenthesis does not hide a call');
  assert.equal(one("btrim (a, E' \t\r\n')"), 0);
});

test('a migration from 0106 on may not introduce a loose btrim', () => {
  const loose = "create or replace function app_private.f(p_a text) returns text\nlanguage sql\nas $$ select nullif(btrim(coalesce(p_a, '')), '') $$;";
  const strict = "create or replace function app_private.f(p_a text) returns text\nlanguage sql\nas $$ select nullif(btrim(coalesce(p_a, ''), E' \\t\\r\\n'), '') $$;";

  const problems = contentProblems('0106_next.sql', loose);
  assert.equal(problems.length, 1);
  assert.match(problems.join(), /btrim\(\) must name its character set/);
  assert.match(problems.join(), /tabs and newlines survive it/);
  assert.deepEqual(contentProblems('0106_next.sql', strict), []);

  // Two loose calls are two problems, so a half-corrected migration cannot slip through.
  assert.equal(contentProblems('0200_later.sql', `${loose}\n${loose}`).length, 2);

  // 0105 itself holds the 64 original definitions quoted above their replacements, and everything
  // before it is history. Neither is rewritten to satisfy a rule that did not exist when it shipped.
  assert.deepEqual(contentProblems('0105_whitespace_normalisation.sql', loose), []);
  assert.deepEqual(contentProblems('0027_reports.sql', loose), []);
});

// --- 0106: a reader's limit ceiling may not equal a published maximum ----------------------------
// The API answers "is there another page?" by asking for `limit + 1` and looking for the extra row. Nine
// readers clamped `p_limit` at exactly the contract maximum, so at the maximum page size the probe row was
// removed and `nextCursor` came back null on a page that had more behind it. Proved on a table of 60 rows:
// asking the reader for 51 returned 50, and `50 > 50` is false.
//
// This check is what stops a tenth. It is narrow on purpose: it does not require a ceiling at all, because 37
// readers clamp only the floor and return exactly what they were asked for.
const reader = (name, clamp) =>
  `create or replace function app_private.${name}(p_user_id uuid, p_limit integer)\nreturns table (id uuid)\nlanguage sql\nstable\nas $function$\n  with bounds as (select ${clamp} as row_limit)\n  select u.id from public.u u limit (select row_limit from bounds);\n$function$;\n`;

const STANDARD = 'least(greatest(coalesce(p_limit, 20), 1), 51)';
const BROKEN = 'least(greatest(coalesce(p_limit, 20), 1), 50)';
const FLOOR_ONLY = 'greatest(coalesce(p_limit, 20), 1)';

test('a reader clamping at a published maximum is rejected; max + 1 is accepted', () => {
  const good = [{ name: '0106_a.sql', text: reader('widgets', STANDARD) }];
  assert.deepEqual(paginationCeilingProblems(good), [], 'max + 1 is the contract and must pass');

  const bad = [{ name: '0107_b.sql', text: reader('widgets', BROKEN) }];
  const problems = paginationCeilingProblems(bad);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /app_private\.widgets clamps p_limit at 50, which is a published \*_MAX_LIMIT/);
  assert.match(problems[0], /eats the probe row/);
  assert.match(problems[0], /Use 51/, 'the message says what to use instead');

  // Every published maximum, not just 50.
  for (const [max, next] of [[48, 49], [96, 97], [100, 101]]) {
    const at = [{ name: '0107_c.sql', text: reader('widgets', `least(greatest(coalesce(p_limit, 20), 1), ${max})`) }];
    assert.equal(paginationCeilingProblems(at).length, 1, `a ceiling of ${max} must be rejected`);
    const above = [{ name: '0107_d.sql', text: reader('widgets', `least(greatest(coalesce(p_limit, 20), 1), ${next})`) }];
    assert.deepEqual(paginationCeilingProblems(above), [], `a ceiling of ${next} must pass`);
  }
});

test('the ceiling check reports no false positives', () => {
  // A reader with no ceiling at all is correct — it returns exactly what it was asked for. 37 readers are
  // written this way and reporting them would make the check unusable.
  const floorOnly = [{ name: '0107_e.sql', text: reader('widgets', FLOOR_ONLY) }];
  assert.deepEqual(paginationCeilingProblems(floorOnly), []);

  // A ceiling that is not a published maximum is somebody's deliberate headroom, not this check's business.
  // `dispute_messages_for_staff` uses 201 against a maximum of 50.
  const headroom = [{ name: '0107_f.sql', text: reader('widgets', 'least(greatest(coalesce(p_limit, 20), 1), 201)') }];
  assert.deepEqual(paginationCeilingProblems(headroom), []);

  // A migration with no function in it at all.
  assert.deepEqual(paginationCeilingProblems([{ name: '0107_g.sql', text: 'select 1;' }]), []);

  // The latest definition wins, exactly as the database ends up: a reader corrected later is not reported for
  // the shape it used to have.
  const corrected = [
    { name: '0100_old.sql', text: reader('widgets', BROKEN) },
    { name: '0106_new.sql', text: reader('widgets', STANDARD) },
  ];
  assert.deepEqual(paginationCeilingProblems(corrected), [], 'a later correction supersedes the old ceiling');

  // ...and the reverse is caught, so a regression in a later migration is not masked by an earlier fix.
  const regressed = [
    { name: '0106_new.sql', text: reader('widgets', STANDARD) },
    { name: '0110_oops.sql', text: reader('widgets', BROKEN) },
  ];
  assert.equal(paginationCeilingProblems(regressed).length, 1);
  assert.match(paginationCeilingProblems(regressed)[0], /0110_oops\.sql/);
});

test('the ceiling check reads the function body and not the text around it', () => {
  // 0106's verification block carries the clamp pattern as a regular-expression *string*. Attributing it to the
  // function above would read a ceiling that does not exist, which the first version of this parser did.
  const withTrailingBlock =
    reader('widgets', STANDARD) +
    `do $$\nbegin\n  perform (regexp_match(p.prosrc, 'least\\(greatest\\(coalesce\\(p_limit[^)]*\\),\\s*1\\),\\s*([0-9]+)\\)'))[1];\n  if false then raise exception 'least(greatest(coalesce(p_limit, 20), 1), 50)'; end if;\nend $$;\n`;
  const ceilings = readerCeilings([{ name: '0107_h.sql', text: withTrailingBlock }]);
  assert.equal(ceilings.get('widgets')?.ceiling, 51, 'the trailing block must not overwrite the body reading');
  assert.deepEqual(paginationCeilingProblems([{ name: '0107_h.sql', text: withTrailingBlock }]), []);
});

test('the exemption list is three readers and cannot outlive its reason', () => {
  // Owner decision 3: seller_orders, seller_reviews and seller_promotions do not receive a probe row at all —
  // seller-read.service.ts sends `limit: size` and decides from `rows.length === size`. They lose no rows.
  assert.deepEqual([...PAGINATION_CEILING_EXEMPT], ['seller_orders', 'seller_reviews', 'seller_promotions']);

  const exempt = [{ name: '0107_i.sql', text: reader('seller_orders', BROKEN) }];
  assert.deepEqual(paginationCeilingProblems(exempt), [], 'an exempt reader may clamp at a maximum');

  // A stale exemption is reported, so the list cannot survive the reason for it.
  const noLongerColliding = [{ name: '0107_j.sql', text: reader('seller_orders', STANDARD) }];
  const stale = paginationCeilingProblems(noLongerColliding);
  assert.equal(stale.length, 1);
  assert.match(stale[0], /listed in PAGINATION_CEILING_EXEMPT but now clamps at 51/);
  assert.match(stale[0], /Remove the stale exemption/);

  // An exemption for a reader no migration defines is reported too — but only against the whole corpus, since
  // on any subset every absent reader looks deleted. That is why it is a separate function.
  const missing = paginationExemptionProblems([{ name: '0107_k.sql', text: reader('widgets', STANDARD) }]);
  assert.equal(missing.length, 3, 'all three absent exemptions are reported');
  assert.ok(missing.every((p) => /no migration defines it with a limit clamp/.test(p)));
});

test('the committed corpus has exactly three readers clamping at a maximum, and they are the exempt three', () => {
  const dir = join(REPO_ROOT, 'supabase/migrations');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));

  const maxima = new Set(declaredMaxLimits().values());
  const ceilings = readerCeilings(files);
  assert.ok(ceilings.size >= 41, 'every reader with a limit clamp is found');

  const colliding = [...ceilings]
    .filter(([, v]) => maxima.has(v.ceiling))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(colliding, ['seller_orders', 'seller_promotions', 'seller_reviews']);

  // The nine 0106 corrected, each at its contract maximum + 1.
  for (const [name, want] of [
    ['messaging_inbox', 51],
    ['messaging_conversation_messages', 101],
    ['notifications_inbox', 51],
    ['buyer_favorites', 51],
    ['buyer_saved_searches', 51],
    ['buyer_blocks', 51],
    ['seller_listings', 51],
    ['seller_services', 51],
    ['listing_analytics_page', 101],
  ]) {
    assert.equal(ceilings.get(name)?.ceiling, want, `${name} must clamp at ${want}`);
    assert.equal(ceilings.get(name)?.migration, '0106_pagination_probe_row.sql', `${name} is corrected by 0106`);
  }
});

// --- 0107: a pgTAP de-duplication test may not rely on a frozen clock ----------------------------
// Every pgTAP file runs in one transaction and `now()` is constant inside it, so a test that delivers the same
// event twice with `now()` passes even when de-duplication is broken. That is how the `(event_id, occurred_at)`
// defect survived four increments behind a green assertion. This check is what stops the next one.
test('the frozen-clock check finds a vacuous de-duplication test', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dedup-clock-'));
  const tests = join(dir, 'supabase/tests');
  mkdirSync(tests, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name, body) => writeFileSync(join(tests, name), `select plan(1);\n${body}\n`);
  const problems = () => eventDedupClockProblems(dir);
  const ID = '11111111-2222-4222-8222-111111111111';
  const deliver = (stamp) =>
    `select app_private.record_listing_events(jsonb_build_array(jsonb_build_object(` +
    `'event_id', '${ID}', 'listing_id', 'aaaaaaaa-0000-4000-8000-000000000001', 'event_type', 'click'` +
    `${stamp === null ? '' : `, 'occurred_at', ${stamp}`})));`;

  // Two deliveries of one id, both omitting occurred_at: the writer's now() fallback, frozen, vacuous.
  write('0001_a.sql', `${deliver(null)}\n${deliver(null)}`);
  let found = problems();
  assert.equal(found.length, 1);
  assert.match(found[0], /event_id 11111111-2222-4222-8222-111111111111 is delivered 2 times/);
  assert.match(found[0], /now\(\) is transaction-stable inside a pgTAP file/);
  assert.match(found[0], /Use clock_timestamp\(\)/);

  // Both passing bare now(), and both passing now()::text — the form that escaped the first version of this
  // check, because its capture stopped at the opening parenthesis and read `now(`.
  write('0001_a.sql', `${deliver('now()')}\n${deliver('now()')}`);
  assert.equal(problems().length, 1, 'bare now() twice is reported');
  write('0001_a.sql', `${deliver('now()::text')}\n${deliver('now()::text')}`);
  assert.equal(problems().length, 1, 'now()::text twice is reported');

  // The fix, in both accepted forms.
  write('0001_a.sql', `${deliver('clock_timestamp()')}\n${deliver("clock_timestamp() + interval '1 second'")}`);
  assert.deepEqual(problems(), [], 'clock_timestamp() advances, so the test can observe a break');
  write('0001_a.sql', `${deliver("'2026-01-01T00:00:00Z'")}\n${deliver("'2026-01-02T00:00:00Z'")}`);
  assert.deepEqual(problems(), [], 'explicitly different values are fine too');
});

test('the frozen-clock check reports no false positives', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dedup-clock-ok-'));
  const tests = join(dir, 'supabase/tests');
  mkdirSync(tests, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const write = (body) => writeFileSync(join(tests, '0001_a.sql'), `select plan(1);\n${body}\n`);
  const problems = () => eventDedupClockProblems(dir);
  const event = (id, stamp) =>
    `jsonb_build_object('event_id', '${id}', 'listing_id', 'aaaaaaaa-0000-4000-8000-000000000001', ` +
    `'event_type', 'click'${stamp === null ? '' : `, 'occurred_at', ${stamp}`})`;
  const call = (...objects) => `select app_private.record_listing_events(jsonb_build_array(${objects.join(',')}));`;

  const A = '11111111-2222-4222-8222-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  // A single delivery using now() is not vacuous — there is nothing for it to be vacuous about. Five such
  // inserts exist in 0101's suite and reporting them would have made this check unusable.
  write(call(event(A, 'now()::text')));
  assert.deepEqual(problems(), [], 'one delivery with now() is fine');

  // Different ids, each once, all frozen.
  write(call(event(A, 'now()::text'), event(B, 'now()::text')));
  assert.deepEqual(problems(), [], 'different ids are different events');

  // The same id twice with *different* frozen offsets. Both are transaction-stable, but they are not the same
  // value, so the deliveries genuinely differ and the assertion can still fail.
  write(call(event(A, 'now()')) + '\n' + call(event(A, "now() - interval '2 days'")));
  assert.deepEqual(problems(), [], 'two different now() offsets are two different timestamps');

  // A file that never calls an event writer is not this check's business, whatever it does with now().
  write(`select is((select count(*) from public.listing_events where occurred_at = now()), 0::bigint, 'x');`);
  assert.deepEqual(problems(), [], 'a file with no event writer call is ignored');

  // And the committed suite is clean, which is the assertion that matters after the three narrowings in 0107.
  assert.deepEqual(eventDedupClockProblems(), []);
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
    '"public.conversations": PublicConversations;',
    '"public.offers": PublicOffers;',
    '"public.commission_rules": PublicCommissionRules;',
    '"public.listing_events": PublicListingEvents;',
    '"public.checkouts": PublicCheckouts;',
    '"public.orders": PublicOrders;',
    '"public.inventory_reservations": PublicInventoryReservations;',
    '"public.payments": PublicPayments;',
    '"public.payment_attempts": PublicPaymentAttempts;',
    '"public.payment_exception_cases": PublicPaymentExceptionCases;',
    '"public.payment_fee_allocations": PublicPaymentFeeAllocations;',
    '"public.ledger_journals": PublicLedgerJournals;',
    '"public.ledger_entries": PublicLedgerEntries;',
    '"public.seller_balances": PublicSellerBalances;',
    '"public.wallet_transactions": PublicWalletTransactions;',
    '"public.withdrawals": PublicWithdrawals;',
    '"public.commissions": PublicCommissions;',
    '"public.payout_providers": PublicPayoutProviders;',
    '"public.payout_destinations": PublicPayoutDestinations;',
    '"public.payouts": PublicPayouts;',
    '"public.payout_events": PublicPayoutEvents;',
    '"public.payout_reversals": PublicPayoutReversals;',
    '"public.provider_settlements": PublicProviderSettlements;',
    '"public.provider_settlement_items": PublicProviderSettlementItems;',
    '"public.coupons": PublicCoupons;',
    '"public.coupon_amounts": PublicCouponAmounts;',
    '"public.coupon_usage": PublicCouponUsage;',
    '"public.promotion_packages": PublicPromotionPackages;',
    '"public.promotions": PublicPromotions;',
    '"public.promotion_events": PublicPromotionEvents;',
    '"public.promotion_analytics": PublicPromotionAnalytics;',
    '"public.promotion_ranking_settings": PublicPromotionRankingSettings;',
    '"public.reviews": PublicReviews;',
    '"public.review_replies": PublicReviewReplies;',
    '"public.seller_ratings": PublicSellerRatings;',
    '"public.reports": PublicReports;',
    '"public.moderation_actions": PublicModerationActions;',
    '"public.listing_moderation_actions": PublicListingModerationActions;',
    '"public.disputes": PublicDisputes;',
    '"public.dispute_messages": PublicDisputeMessages;',
    '"public.dispute_evidence": PublicDisputeEvidence;',
    '"public.support_tickets": PublicSupportTickets;',
    '"public.support_messages": PublicSupportMessages;',
    '"public.support_internal_notes": PublicSupportInternalNotes;',
    '"public.support_ticket_events": PublicSupportTicketEvents;',
    '"public.account_recovery_requests": PublicAccountRecoveryRequests;',
    '"public.account_recovery_approvals": PublicAccountRecoveryApprovals;',
    '"public.notifications": PublicNotifications;',
    '"public.pages": PublicPages;',
    '"public.page_translations": PublicPageTranslations;',
    '"public.blog_posts": PublicBlogPosts;',
    '"public.cms_media": PublicCmsMedia;',
    '"public.navigation_items": PublicNavigationItems;',
    '"public.seo_metadata": PublicSeoMetadata;',
    '"public.redirects": PublicRedirects;',
    '"app_private.append_only_contract": AppPrivateAppendOnlyContract;',
    '"app_private.scheduled_job_contract": AppPrivateScheduledJobContract;',
  ]) {
    assert.ok(committed.includes(key), `${key} is present`);
  }
});
