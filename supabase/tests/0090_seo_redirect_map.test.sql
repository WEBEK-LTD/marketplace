-- 0090 — The SEO redirect map: the named readers and writers.
--
-- What is proven here, in order: the nine functions exist, are definer functions with pinned search paths, and
-- are callable by `app_system` and by nobody else; nothing in 0030 was changed; the two permission predicates
-- apply 0003's own `requires_mfa` rule and are genuinely separate keys; every one of 0030's constraints still
-- raises — `from_path` unique, both sides relative, neither escaping with `//`, no entry pointing at itself,
-- and only the four allowed status codes; every writer refuses a caller without the manage key with 42501; the
-- public resolver follows a chain, stops at five hops, stops rather than looping on a cycle and answers nothing
-- for a cycle that returns to where it started, ignores an inactive entry, and reports the status code stored on
-- the last entry it followed; the staff list searches literally rather than by pattern and pages by cursor; the
-- detail reports the manage capability and where the chain actually ends; and 0030's audit trigger and outbox
-- announcement fire on insert, update and delete.
--
-- LIVE PAGE WINS is **not** asserted here, and that is deliberate: the precedence is the public web's, decided
-- in its own request path before any of this is reached, and is proven in the web suite. A reader in this schema
-- cannot know whether a path resolves to a live page without duplicating the catalogue's visibility rules.
--
-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(178);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'redirect_can_read', array['uuid', 'boolean'], 'the read predicate exists');
select has_function('app_private', 'redirect_can_manage', array['uuid', 'boolean'], 'the manage predicate exists');
select has_function('app_private', 'public_redirect_resolve', array['text'], 'the public resolver exists');
select has_function('app_private', 'redirects_for_staff',
  array['uuid', 'boolean', 'integer', 'text', 'boolean', 'timestamptz', 'uuid'], 'the staff list exists');
select has_function('app_private', 'redirect_for_staff', array['uuid', 'boolean', 'uuid'],
  'the staff detail exists');
select has_function('app_private', 'redirect_create_for_staff',
  array['uuid', 'boolean', 'text', 'text', 'integer', 'text', 'boolean'], 'the create writer exists');
select has_function('app_private', 'redirect_update_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'integer', 'text'], 'the update writer exists');
select has_function('app_private', 'redirect_state_for_staff', array['uuid', 'boolean', 'uuid', 'boolean'],
  'the state writer exists');
select has_function('app_private', 'redirect_delete_for_staff', array['uuid', 'boolean', 'uuid'],
  'the delete writer exists');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'redirect%' and p.prosecdef),
  8, 'the eight redirect_* functions are security definer');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'redirect%' or p.proname = 'public_redirect_resolve')
      and p.proconfig @> array['search_path=pg_catalog, public']),
  9, 'all nine pin search_path to pg_catalog, public');

select matches(pg_get_function_result(p.oid), 'can_manage boolean',
  'the staff detail reports the manage capability')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'redirect_for_staff';

select matches(pg_get_function_result(p.oid), 'resolved_to_path text',
  'the staff detail reports where the chain ends')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'redirect_for_staff';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select ok(has_function_privilege('app_system', p.oid, 'execute'),
    format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and (p.proname like 'redirect%' or p.proname = 'public_redirect_resolve')
 order by p.proname;

select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
    format('%s may not execute %s', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_worker')) as r(rolname)
 where n.nspname = 'app_private'
   and (p.proname like 'redirect%' or p.proname = 'public_redirect_resolve')
 order by r.rolname, p.proname;

-- ---------------------------------------------------------------------------------------------------
-- Nothing in 0030 was changed
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'redirects', 'the redirects table is untouched');
select has_function('public', 'resolve_redirect', array['text'], '0030''s resolver is untouched');
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'redirects'),
  9, 'the table still has exactly its nine 0030 columns');
select has_index('public', 'redirects', 'redirects_from_path', 'the unique index on from_path is untouched');
select ok(
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'redirects' and not t.tgisinternal) >= 3,
  '0030''s three redirect triggers are still installed');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- An operator holding both keys through the admin role (0033 grants every permission to admin and super_admin,
-- and both roles require MFA); a colleague holding the read key only; and a signed-in person holding neither.
--
-- The read-only colleague is made by granting `seo.redirect.read` to the seeded moderator role **inside this
-- transaction**. That is a fixture and is rolled back with everything else: 0033's own grants are not changed
-- and no permission is invented — the key exists in `public.permissions` already. It is the only way to prove
-- the two keys are genuinely separate, because the roles 0033 grants them to hold both.
insert into auth.users (id, email) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'redirect-operator@example.test'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'redirect-reader@example.test'),
  ('bbbbbbbb-0000-4000-8000-000000000003', 'redirect-nobody@example.test');
insert into public.user_roles (user_id, role_key) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'admin'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'moderator');
insert into public.role_permissions (role_key, permission_key)
values ('moderator', 'seo.redirect.read')
on conflict (role_key, permission_key) do nothing;

create function pg_temp.operator() returns uuid language sql immutable as
  $f$ select 'bbbbbbbb-0000-4000-8000-000000000001'::uuid $f$;
create function pg_temp.reader() returns uuid language sql immutable as
  $f$ select 'bbbbbbbb-0000-4000-8000-000000000002'::uuid $f$;
create function pg_temp.nobody() returns uuid language sql immutable as
  $f$ select 'bbbbbbbb-0000-4000-8000-000000000003'::uuid $f$;

-- ---------------------------------------------------------------------------------------------------
-- The permission predicates
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.redirect_can_read(pg_temp.operator(), true), 'the operator may read at aal2');
select ok(app_private.redirect_can_manage(pg_temp.operator(), true), 'the operator may manage at aal2');
-- The admin role requires MFA, so 0003's own rule withholds both keys at aal1. Nothing here re-implements that
-- rule; the predicate reads `roles.requires_mfa` and applies it to the parameter.
select ok(not app_private.redirect_can_read(pg_temp.operator(), false), 'and neither key at aal1');
select ok(not app_private.redirect_can_manage(pg_temp.operator(), false), 'nor the manage key at aal1');
select ok(app_private.redirect_can_read(pg_temp.reader(), true), 'the read-only colleague may read');
select ok(not app_private.redirect_can_manage(pg_temp.reader(), true),
  'and may not manage: the two keys are separate');
select ok(not app_private.redirect_can_read(pg_temp.nobody(), true), 'somebody with neither key may not read');
select ok(not app_private.redirect_can_manage(pg_temp.nobody(), true), 'nor manage');
select ok(not app_private.redirect_can_read(null, true), 'and nor may nobody at all');

-- ---------------------------------------------------------------------------------------------------
-- Creating
-- ---------------------------------------------------------------------------------------------------
select lives_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '/old-offer', '/new-offer') $$,
  'the operator creates an entry');

select is(
  (select to_path from public.redirects where from_path = '/old-offer'),
  '/new-offer', 'the destination is stored');
select is(
  (select status_code from public.redirects where from_path = '/old-offer'),
  301, 'the status code defaults to 0030''s own column default');
select is(
  (select is_active from public.redirects where from_path = '/old-offer'),
  true, 'and an entry is born active');
select is(
  (select created_by from public.redirects where from_path = '/old-offer'),
  pg_temp.operator(), 'the author is recorded in 0030''s own created_by column');
select is(
  (select note from public.redirects where from_path = '/old-offer'),
  null, 'with no note when none was given');

-- Whitespace and a blank note: trimmed, and a blank note is absent rather than empty.
select lives_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '  /spaced  ', '  /tidy  ', 308, '   ') $$,
  'paths and notes are trimmed');
select is((select to_path from public.redirects where from_path = '/spaced'), '/tidy', 'the path is trimmed');
select is((select note from public.redirects where from_path = '/spaced'), null, 'and a blank note is absent');
select is((select status_code from public.redirects where from_path = '/spaced'), 308,
  'a given status code is stored');

-- An entry may be created switched off, which is how an operator stages one before turning it on.
select lives_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '/staged', '/live-target', 301, 'staged', false) $$,
  'an entry may be created inactive');
select is((select is_active from public.redirects where from_path = '/staged'), false, 'and stays off');
select is((select note from public.redirects where from_path = '/staged'), 'staged', 'with its note');

-- ---------------------------------------------------------------------------------------------------
-- 0030's constraints still decide every rule
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '/old-offer', '/somewhere-else') $$,
  '23505', null, 'a second entry for the same from_path is refused by the unique index');

select throws_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '/same', '/same') $$,
  '23514', null, 'an entry pointing at itself is refused');

select throws_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, 'no-leading-slash', '/target') $$,
  '23514', null, 'a from_path that is not relative is refused');

select throws_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '/from', 'no-leading-slash') $$,
  '23514', null, 'a to_path that is not relative is refused');

select throws_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '//evil.test', '/target') $$,
  '23514', null, 'a protocol-relative from_path cannot leave the site');

select throws_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '/from-here', '//evil.test') $$,
  '23514', null, 'nor can a protocol-relative destination');

select throws_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '/from-here', 'https://evil.test/path') $$,
  '23514', null, 'an external destination is refused: this map cannot send anybody off the site');

select throws_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '/from-here', '/target', 404) $$,
  '23514', null, 'a status code outside 0030''s four is refused');

-- The four 0030 allows, each accepted.
select lives_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '/code-301', '/t1', 301) $$, '301 is allowed');
select lives_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '/code-302', '/t2', 302) $$, '302 is allowed');
select lives_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '/code-307', '/t3', 307) $$, '307 is allowed');
select lives_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true, '/code-308', '/t4', 308) $$, '308 is allowed');

-- ---------------------------------------------------------------------------------------------------
-- Every writer refuses a caller without the manage key
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000002'::uuid, true, '/reader-tried', '/target') $$,
  '42501', null, 'the read-only colleague may not create');

select throws_ok(
  $$ select app_private.redirect_create_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, false, '/aal1-tried', '/target') $$,
  '42501', null, 'and neither may the operator at aal1');

select throws_ok(
  $$ select app_private.redirect_update_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000002'::uuid, true,
       (select id from public.redirects where from_path = '/old-offer'), null, '/hijacked') $$,
  '42501', null, 'the read-only colleague may not edit');

select throws_ok(
  $$ select app_private.redirect_state_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000002'::uuid, true,
       (select id from public.redirects where from_path = '/old-offer'), false) $$,
  '42501', null, 'the read-only colleague may not switch an entry off');

select throws_ok(
  $$ select app_private.redirect_delete_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000002'::uuid, true,
       (select id from public.redirects where from_path = '/old-offer')) $$,
  '42501', null, 'nor remove one');

select is(
  (select to_path from public.redirects where from_path = '/old-offer'),
  '/new-offer', 'and none of those refusals changed anything');

-- ---------------------------------------------------------------------------------------------------
-- Editing
-- ---------------------------------------------------------------------------------------------------
select is(
  (select app_private.redirect_update_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/old-offer'),
     null, '/newer-offer', 302, 'moved again')),
  true, 'the operator edits an entry');
select is((select to_path from public.redirects where from_path = '/old-offer'), '/newer-offer',
  'the destination changed');
select is((select status_code from public.redirects where from_path = '/old-offer'), 302,
  'the status code changed');
select is((select note from public.redirects where from_path = '/old-offer'), 'moved again', 'the note changed');

-- A null argument leaves that field alone, so an edit of one field is an edit of one field.
select is(
  (select app_private.redirect_update_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/old-offer'),
     null, null, null, null)),
  true, 'an edit with nothing in it succeeds');
select is((select to_path from public.redirects where from_path = '/old-offer'), '/newer-offer',
  'and changes nothing');
select is((select status_code from public.redirects where from_path = '/old-offer'), 302, 'nor the status code');
select is((select note from public.redirects where from_path = '/old-offer'), 'moved again', 'nor the note');

-- An empty note clears it; that is a different request from not sending the field.
select is(
  (select app_private.redirect_update_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/old-offer'),
     null, null, null, '')),
  true, 'an empty note is a request to clear it');
select is((select note from public.redirects where from_path = '/old-offer'), null, 'and clears it');

-- The edit cannot touch `is_active`. There is no parameter for it, so this proves the absence rather than a
-- behaviour: an entry switched off stays off across an edit of its destination.
select is(
  (select app_private.redirect_update_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/staged'),
     null, '/edited-target')),
  true, 'an inactive entry may be edited');
select is((select is_active from public.redirects where from_path = '/staged'), false,
  'and editing it did not switch it on');

select is(
  (select app_private.redirect_update_for_staff(
     pg_temp.operator(), true, '00000000-0000-4000-8000-000000000000'::uuid, null, '/target')),
  false, 'editing an entry that does not exist changes nothing and says so');

-- The constraints apply to an edit exactly as they apply to a creation.
select throws_ok(
  $$ select app_private.redirect_update_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true,
       (select id from public.redirects where from_path = '/old-offer'), null, 'https://evil.test') $$,
  '23514', null, 'an edit cannot point an entry off the site');

select throws_ok(
  $$ select app_private.redirect_update_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true,
       (select id from public.redirects where from_path = '/code-301'), '/code-302', null) $$,
  '23505', null, 'an edit cannot take a from_path another entry already holds');

-- ---------------------------------------------------------------------------------------------------
-- Switching on and off
-- ---------------------------------------------------------------------------------------------------
select is(
  (select app_private.redirect_state_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/staged'), true)),
  true, 'the operator switches a staged entry on');
select is((select is_active from public.redirects where from_path = '/staged'), true, 'and it is on');
select is(
  (select app_private.redirect_state_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/staged'), false)),
  true, 'and off again');
select is((select is_active from public.redirects where from_path = '/staged'), false, 'and it is off');
select is(
  (select app_private.redirect_state_for_staff(
     pg_temp.operator(), true, '00000000-0000-4000-8000-000000000000'::uuid, true)),
  false, 'switching an entry that does not exist says so');
select throws_ok(
  $$ select app_private.redirect_state_for_staff(
       'bbbbbbbb-0000-4000-8000-000000000001'::uuid, true,
       (select id from public.redirects where from_path = '/staged'), null) $$,
  '22004', null, 'and the state must actually be given');

-- ---------------------------------------------------------------------------------------------------
-- Removing
-- ---------------------------------------------------------------------------------------------------
select is(
  (select app_private.redirect_delete_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/code-308'))),
  true, 'the operator removes an entry');
select is((select count(*)::int from public.redirects where from_path = '/code-308'), 0, 'and it is gone');
select is(
  (select app_private.redirect_delete_for_staff(
     pg_temp.operator(), true, '00000000-0000-4000-8000-000000000000'::uuid)),
  false, 'removing an entry that does not exist says so');

-- ---------------------------------------------------------------------------------------------------
-- Resolution — composing 0030's resolver and adding nothing to it
-- ---------------------------------------------------------------------------------------------------
select is(
  (select to_path from app_private.public_redirect_resolve('/old-offer')),
  '/newer-offer', 'one hop resolves to its destination');
select is(
  (select status_code from app_private.public_redirect_resolve('/old-offer')),
  302, 'with the status code stored on the entry');

select is(
  (select count(*)::int from app_private.public_redirect_resolve('/nothing-here')),
  0, 'a path the map does not name resolves to nothing');
select is(
  (select count(*)::int from app_private.public_redirect_resolve('/newer-offer')),
  0, 'and so does a path that is only ever a destination');
select is(
  (select count(*)::int from app_private.public_redirect_resolve(null)),
  0, 'and so does no path at all');

-- An inactive entry is ignored, which is 0030's resolver's own predicate rather than a second rule here.
select is(
  (select count(*)::int from app_private.public_redirect_resolve('/staged')),
  0, 'an inactive entry does not redirect');
select is(
  (select app_private.redirect_state_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/staged'), true)),
  true, 'switching it on');
select is(
  (select to_path from app_private.public_redirect_resolve('/staged')),
  '/edited-target', 'makes it redirect');

-- A chain: the walk follows it to the end and reports the status code of the last entry it followed.
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/chain-a', '/chain-b', 302);
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/chain-b', '/chain-c', 301);
select is(
  (select to_path from app_private.public_redirect_resolve('/chain-a')),
  '/chain-c', 'a chain resolves to its end');
select is(
  (select status_code from app_private.public_redirect_resolve('/chain-a')),
  301, 'and reports the last followed entry''s status code, which is 0030''s own choice');
select is(
  (select to_path from app_private.public_redirect_resolve('/chain-b')),
  '/chain-c', 'and entering the chain in the middle still ends at the end');

-- An inactive link breaks a chain where it stands rather than being stepped over.
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/chain-c', '/chain-d', 301, null, false);
select is(
  (select to_path from app_private.public_redirect_resolve('/chain-a')),
  '/chain-c', 'an inactive link ends the walk rather than being skipped');

-- The five-hop limit: six active entries in a row, and the walk stops after five.
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/hop1', '/hop2');
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/hop2', '/hop3');
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/hop3', '/hop4');
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/hop4', '/hop5');
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/hop5', '/hop6');
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/hop6', '/hop7');
select is(
  (select to_path from app_private.public_redirect_resolve('/hop1')),
  '/hop6', 'the walk stops after five hops rather than following a sixth');
select is(
  (select to_path from app_private.public_redirect_resolve('/hop2')),
  '/hop7', 'and a shorter walk from the same chain reaches the end');

-- A cycle. 0030's resolver stops rather than looping, and because stopping inside a two-entry cycle leaves the
-- walk on the path it started from, this resolver answers nothing at all: a browser is never sent to the
-- address it just asked for.
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/loop-a', '/loop-b');
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/loop-b', '/loop-a');
select lives_ok(
  $$ select * from app_private.public_redirect_resolve('/loop-a') $$,
  'a cycle terminates rather than looping');
select is(
  (select count(*)::int from app_private.public_redirect_resolve('/loop-a')),
  0, 'and answers no redirect, because its destination is the path that was asked for');

-- A three-entry cycle behaves the same way, for the same reason.
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/ring-a', '/ring-b');
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/ring-b', '/ring-c');
select app_private.redirect_create_for_staff(pg_temp.operator(), true, '/ring-c', '/ring-a');
select is(
  (select count(*)::int from app_private.public_redirect_resolve('/ring-a')),
  0, 'a longer cycle answers no redirect either');

-- 0030's resolver is called rather than copied: the same two answers come out of both.
select is(
  (select to_path from public.resolve_redirect('/chain-a')),
  (select to_path from app_private.public_redirect_resolve('/chain-a')),
  'the public reader is 0030''s resolver, not a second copy of it');

-- ---------------------------------------------------------------------------------------------------
-- The staff list
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from app_private.redirects_for_staff(pg_temp.operator(), true, 100)) >= 10,
  'the operator sees the map');
select is(
  (select count(*)::int from app_private.redirects_for_staff(pg_temp.reader(), true, 100)) > 0,
  true, 'and so does the read-only colleague');
select is(
  (select count(*)::int from app_private.redirects_for_staff(pg_temp.nobody(), true, 100)),
  0, 'somebody without the read key sees nothing rather than being told so');
select is(
  (select count(*)::int from app_private.redirects_for_staff(pg_temp.operator(), false, 100)),
  0, 'and nor does the operator at aal1');

select is(
  (select count(*)::int from app_private.redirects_for_staff(pg_temp.operator(), true, 3)),
  3, 'the limit is honoured');

-- Newest edit first, which is the order the cursor pages through: the first row the list returns is the row the
-- whole table agrees is newest.
select is(
  (select redirect_id from app_private.redirects_for_staff(pg_temp.operator(), true, 1)),
  (select r.id from public.redirects r order by r.updated_at desc, r.id desc limit 1),
  'the list is newest edit first');

-- The search is a literal substring.
select is(
  (select count(*)::int from app_private.redirects_for_staff(pg_temp.operator(), true, 100, 'chain-a')),
  1, 'the search matches a from_path');
select is(
  (select count(*)::int from app_private.redirects_for_staff(pg_temp.operator(), true, 100, 'newer-offer')),
  1, 'and matches a destination too');
select is(
  (select count(*)::int from app_private.redirects_for_staff(pg_temp.operator(), true, 100, 'CHAIN-A')),
  1, 'and ignores case');
select is(
  (select count(*)::int from app_private.redirects_for_staff(pg_temp.operator(), true, 100, '%')),
  0, 'a percent sign matches a literal percent sign and nothing else: this is not a pattern');
select is(
  (select count(*)::int from app_private.redirects_for_staff(pg_temp.operator(), true, 100, '_')),
  0, 'and nor is an underscore a wildcard');
select ok(
  (select count(*) from app_private.redirects_for_staff(pg_temp.operator(), true, 100, '   ')) >= 10,
  'a blank search is no search');

-- The active filter is tri-state: on, off, or both.
select ok(
  (select count(*) from app_private.redirects_for_staff(pg_temp.operator(), true, 100, null, false)) >= 1,
  'the inactive entries can be listed alone');
select is(
  (select count(*)::int from app_private.redirects_for_staff(pg_temp.operator(), true, 100, null, false)
    where is_active),
  0, 'and nothing active appears among them');
select is(
  (select count(*)::int from app_private.redirects_for_staff(pg_temp.operator(), true, 100, null, true)
    where not is_active),
  0, 'nor anything inactive among the active ones');
select is(
  (select count(*)::int from app_private.redirects_for_staff(pg_temp.operator(), true, 100, null, null)),
  (select count(*)::int from public.redirects),
  'and no filter at all is the whole map');

-- The cursor pages without repeating or skipping a row.
select is(
  (select count(*)::int from (
     select redirect_id from app_private.redirects_for_staff(pg_temp.operator(), true, 4)
     union
     select redirect_id from app_private.redirects_for_staff(
       pg_temp.operator(), true, 100,
       null, null,
       (select updated_at from app_private.redirects_for_staff(pg_temp.operator(), true, 4) order by updated_at, redirect_id limit 1),
       (select redirect_id from app_private.redirects_for_staff(pg_temp.operator(), true, 4) order by updated_at, redirect_id limit 1))
   ) as everything),
  (select count(*)::int from public.redirects),
  'the first page and the rest after its cursor are the whole map exactly once');

-- ---------------------------------------------------------------------------------------------------
-- The staff detail
-- ---------------------------------------------------------------------------------------------------
select is(
  (select from_path from app_private.redirect_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/chain-a'))),
  '/chain-a', 'the operator reads one entry');
select is(
  (select can_manage from app_private.redirect_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/chain-a'))),
  true, 'and is told they may change it');
select is(
  (select can_manage from app_private.redirect_for_staff(
     pg_temp.reader(), true, (select id from public.redirects where from_path = '/chain-a'))),
  false, 'while the read-only colleague is told they may not');
select is(
  (select resolved_to_path from app_private.redirect_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/chain-a'))),
  '/chain-c', 'the detail shows where the chain actually ends, not just the next step');
select is(
  (select resolved_to_path from app_private.redirect_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/chain-c'))),
  null, 'and shows nothing for an entry that is switched off');
select is(
  (select created_by from app_private.redirect_for_staff(
     pg_temp.operator(), true, (select id from public.redirects where from_path = '/chain-a'))),
  pg_temp.operator(), 'the author comes back with it');
select is(
  (select count(*)::int from app_private.redirect_for_staff(
     pg_temp.nobody(), true, (select id from public.redirects where from_path = '/chain-a'))),
  0, 'somebody without the read key gets no row');
select is(
  (select count(*)::int from app_private.redirect_for_staff(
     pg_temp.operator(), true, '00000000-0000-4000-8000-000000000000'::uuid)),
  0, 'and so does an entry that does not exist: one answer for absence and for a missing permission');

-- ---------------------------------------------------------------------------------------------------
-- 0030's audit trigger and outbox announcement still fire
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from audit.audit_logs
    where table_name = 'redirects' and action = 'insert') >= 1,
  'creating an entry is audited');
select ok(
  (select count(*) from audit.audit_logs
    where table_name = 'redirects' and action = 'update') >= 1,
  'editing one is audited');
select ok(
  (select count(*) from audit.audit_logs
    where table_name = 'redirects' and action = 'delete') >= 1,
  'and so is removing one');
select ok(
  (select count(*) from public.outbox_events
    where aggregate_type = 'redirect' and event_type = 'redirect.map_changed') >= 3,
  'and every change republishes the map through 0030''s outbox announcement');
select ok(
  (select count(*) from public.outbox_events
    where event_type = 'redirect.map_changed'
      and payload ? 'from_path') >= 1,
  'the announcement carries the path that changed, as 0030 built it');

-- ---------------------------------------------------------------------------------------------------
-- Nothing financial, and nothing that reads a caller identity on the public path
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'redirect%' or p.proname = 'public_redirect_resolve')
      and pg_get_functiondef(p.oid) ~* 'ledger_entries|ledger_journals|seller_balances|payouts|payments|settlement|withdrawal|commission_rules|tax_rules|coupons'),
  0, 'no function here names a financial function or table');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_redirect_resolve'
      and pg_get_functiondef(p.oid) ~* 'current_user_id|auth\.uid|app\.user_id|audit_actor'),
  0, 'and the public resolver reads no caller identity: it answers the same for everybody');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'redirect%' or p.proname = 'public_redirect_resolve')
      and pg_get_functiondef(p.oid) ~* 'audit_actor'),
  0, 'and no writer names the 8-B attribution channel');

select * from finish();
rollback;
