-- pgTAP — migration 0003: the access-token hook (owner decision C8).
--
-- C8 approves a "minimal access-token hook with safe defaults, pgTAP, monitoring, alerting". The hook
-- has existed since 0003 with no test of its own; this file is the pgTAP half of that decision.
--
-- **Scope, stated precisely.** Everything here exercises *our* PL/pgSQL function by handing it an
-- `event` object and reading what comes back. Nothing asserts what Supabase actually sends, when it
-- calls the hook, how it signs anything, or what it does with the result — that is provider behaviour,
-- it is unverifiable from here, and it belongs to the live spike. What is testable locally is the whole
-- of the function's own contract, and that is what "safe defaults" has to mean in practice: the claim it
-- adds is computed from the database, never copied from the input, and nothing else in the token is
-- touched.
--
-- The three properties worth proving, in order of how much damage their absence would do:
--
--   1. only `supabase_auth_admin` can call it, and no browser role can reach it at all;
--   2. `app_roles` is derived from `public.user_roles` — a revoked or expired grant is not a role, and
--      an `app_roles` value present in the incoming event is replaced, not merged;
--   3. every other claim and every other field of the event survives untouched, and no claim the
--      function was not asked to add appears.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

insert into auth.users (id, email) values
  ('c0000000-0000-4000-8000-000000000001', 'hook-multi@test.invalid'),
  ('c0000000-0000-4000-8000-000000000002', 'hook-none@test.invalid'),
  ('c0000000-0000-4000-8000-000000000003', 'hook-lapsed@test.invalid');

-- Two live grants for the first account, deliberately inserted out of alphabetical order so that a
-- sorted result proves the ordering rather than the insertion order.
insert into public.user_roles (user_id, role_key) values
  ('c0000000-0000-4000-8000-000000000001', 'seller'),
  ('c0000000-0000-4000-8000-000000000001', 'buyer');

-- The third account's grants are all past their usefulness: one revoked, one expired. It must read as
-- having no roles at all.
insert into public.user_roles (user_id, role_key, revoked_at) values
  ('c0000000-0000-4000-8000-000000000003', 'admin', now() - interval '1 day');
-- Granted earlier than it expired, so the table's own `expires_at > granted_at` rule still holds.
insert into public.user_roles (user_id, role_key, granted_at, expires_at) values
  ('c0000000-0000-4000-8000-000000000003', 'moderator', now() - interval '2 days', now() - interval '1 hour');

/** The event Supabase-shaped callers pass in, reduced to the two fields this function reads. */
create or replace function pg_temp.event(p_user uuid, p_claims jsonb default '{}'::jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('user_id', p_user::text, 'claims', p_claims);
$$;

create or replace function pg_temp.app_roles(p_user uuid, p_claims jsonb default '{}'::jsonb)
returns jsonb language sql stable as $$
  select app_private.custom_access_token_hook(pg_temp.event(p_user, p_claims)) -> 'claims' -> 'app_roles';
$$;

-- ---------------------------------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'custom_access_token_hook', array['jsonb'],
  'app_private.custom_access_token_hook exists');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname = 'custom_access_token_hook'
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'it is SECURITY DEFINER with the pinned search_path');
select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'custom_access_token_hook'),
  's'::"char",
  'and STABLE: issuing a token reads the role grants, it does not change them');

select function_privs_are('app_private', 'custom_access_token_hook', array['jsonb'],
  'supabase_auth_admin', array['EXECUTE'], 'the Auth admin role may call the hook');
select function_privs_are('app_private', 'custom_access_token_hook', array['jsonb'],
  'authenticated', array[]::text[],
  'authenticated may not: a session must never be able to mint its own claims');
select function_privs_are('app_private', 'custom_access_token_hook', array['jsonb'],
  'anon', array[]::text[], 'anon may not');
select function_privs_are('app_private', 'custom_access_token_hook', array['jsonb'],
  'public', array[]::text[], 'and PUBLIC may not');
select function_privs_are('app_private', 'custom_access_token_hook', array['jsonb'],
  'app_api', array[]::text[], 'nor the API role, which has no business issuing tokens');

-- Even with a grant, the schema would be unreachable from a browser role.
select is(
  (select count(*) from pg_namespace n, aclexplode(n.nspacl) a
    where n.nspname = 'app_private' and a.grantee::regrole::text in ('anon', 'authenticated')),
  0::bigint,
  'no browser role holds USAGE on app_private');

-- The hook reads `user_roles`; that table is not readable by the roles the hook protects against.
select table_privs_are('public', 'user_roles', 'anon', array[]::text[],
  'anon cannot read the role grants the hook is built from');

-- ---------------------------------------------------------------------------------------------------
-- What the claim contains
-- ---------------------------------------------------------------------------------------------------
select is(
  pg_temp.app_roles('c0000000-0000-4000-8000-000000000002'),
  '[]'::jsonb,
  'an account with no roles gets an empty array, not a missing claim');
select is(
  pg_temp.app_roles('c0000000-0000-4000-8000-000000000001'),
  '["buyer", "seller"]'::jsonb,
  'active grants appear, sorted by key rather than by insertion order');
select is(
  pg_temp.app_roles('c0000000-0000-4000-8000-000000000003'),
  '[]'::jsonb,
  'a revoked grant and an expired grant are both absent: neither is a role any more');

insert into public.user_roles (user_id, role_key, expires_at) values
  ('c0000000-0000-4000-8000-000000000002', 'support_agent', now() + interval '1 day');
select is(
  pg_temp.app_roles('c0000000-0000-4000-8000-000000000002'),
  '["support_agent"]'::jsonb,
  'a grant that has not expired yet does appear');

select is(
  pg_temp.app_roles('c0000000-0000-4000-8000-0000000000ff'),
  '[]'::jsonb,
  'an account that does not exist gets an empty array rather than an error');
select is(
  app_private.custom_access_token_hook('{"claims":{}}'::jsonb) -> 'claims' -> 'app_roles',
  '[]'::jsonb,
  'an event with no user_id at all gets an empty array');

-- ---------------------------------------------------------------------------------------------------
-- Safe defaults: the claim is computed, never accepted
-- ---------------------------------------------------------------------------------------------------
select is(
  pg_temp.app_roles('c0000000-0000-4000-8000-000000000002', '{"app_roles": ["super_admin"]}'::jsonb),
  '["support_agent"]'::jsonb,
  'an app_roles value already in the event is replaced by the database''s answer, never merged');
select is(
  pg_temp.app_roles('c0000000-0000-4000-8000-000000000003', '{"app_roles": ["admin", "moderator"]}'::jsonb),
  '[]'::jsonb,
  'and a forged claim cannot revive grants that are revoked or expired');

-- ---------------------------------------------------------------------------------------------------
-- Everything else survives untouched
-- ---------------------------------------------------------------------------------------------------
create temporary table answered on commit drop as
  select app_private.custom_access_token_hook(
    jsonb_build_object(
      'user_id', 'c0000000-0000-4000-8000-000000000001',
      'authentication_method', 'password',
      'claims', jsonb_build_object(
        'sub', 'c0000000-0000-4000-8000-000000000001',
        'role', 'authenticated',
        'aal', 'aal1',
        'session_id', 'a-session-identifier',
        'email', 'hook-multi@test.invalid'))) as out;

select is((select out -> 'claims' ->> 'sub' from answered), 'c0000000-0000-4000-8000-000000000001',
  'the subject claim is untouched');
select is((select out -> 'claims' ->> 'role' from answered), 'authenticated', 'the role claim is untouched');
select is((select out -> 'claims' ->> 'aal' from answered), 'aal1',
  'the aal claim is passed through exactly as it arrived: this hook neither reads nor decides it');
select is((select out -> 'claims' ->> 'session_id' from answered), 'a-session-identifier',
  'and any other claim the caller sent survives');
select is((select out ->> 'authentication_method' from answered), 'password',
  'fields of the event outside `claims` are preserved too');
select is((select out ->> 'user_id' from answered), 'c0000000-0000-4000-8000-000000000001',
  'including the user the event names');

select is(
  (select array(select jsonb_object_keys(out -> 'claims') order by 1) from answered),
  array['aal', 'app_roles', 'email', 'role', 'session_id', 'sub'],
  'exactly one claim is added and none is removed — the hook stays minimal (C8)');
select is(
  (select array(select jsonb_object_keys(out) order by 1) from answered),
  array['authentication_method', 'claims', 'user_id'],
  'and the event keeps its own shape');

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
select lives_ok($$select app_private.assert_security_contract()$$,
  'the security contract holds with the hook in place');

select * from finish();
rollback;
