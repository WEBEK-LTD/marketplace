-- pgTAP — migration 0037: consuming a step-up grant (C-19).
--
-- A single session cannot observe two simultaneous callers, so this file proves the *semantics* — every
-- predicate, single use, and that a rolled-back operation gives the grant back — and the genuinely
-- concurrent proof lives in scripts/db/step-up-concurrency.mjs, which races real connections.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(45);

insert into auth.users (id, email) values
  ('f0000000-0000-4000-8000-000000000001', 'consume-one@test.invalid'),
  ('f0000000-0000-4000-8000-000000000002', 'consume-two@test.invalid');

-- A live grant with a known id, for the given user and operation.
create or replace function pg_temp.grant_for(p_id uuid,
                                             p_user uuid default 'f0000000-0000-4000-8000-000000000001',
                                             p_operation text default 'password_change')
returns void language sql as $$
  insert into public.step_up_grants (id, user_id, operation, granted_via, expires_at)
  values (p_id, p_user, p_operation, 'otp_whatsapp', now() + interval '10 minutes');
$$;

-- ---------------------------------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'consume_step_up_grant', array['uuid', 'uuid', 'text'],
  'app_private.consume_step_up_grant exists');
select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'consume_step_up_grant'),
  true, 'it is SECURITY DEFINER');
select is(
  (select coalesce(array_to_string(p.proconfig, ','), '') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'consume_step_up_grant'),
  'search_path=pg_catalog, public', 'and it pins search_path');

select function_privs_are('app_private', 'consume_step_up_grant', array['uuid', 'uuid', 'text'],
  'app_system', array['EXECUTE'], 'app_system may consume a grant');
select function_privs_are('app_private', 'consume_step_up_grant', array['uuid', 'uuid', 'text'],
  'authenticated', array[]::text[], 'authenticated may not');
select function_privs_are('app_private', 'consume_step_up_grant', array['uuid', 'uuid', 'text'],
  'anon', array[]::text[], 'anon may not');
select function_privs_are('app_private', 'consume_step_up_grant', array['uuid', 'uuid', 'text'],
  'app_worker', array[]::text[], 'the worker may not');
select function_privs_are('app_private', 'consume_step_up_grant', array['uuid', 'uuid', 'text'],
  'public', array[]::text[], 'and PUBLIC may not');

-- Only this path can spend a grant: nobody may write the table directly.
select table_privs_are('public', 'step_up_grants', 'authenticated', array['SELECT'],
  'authenticated may still only read, so it cannot mark its own authorisation spent');
select table_privs_are('public', 'step_up_grants', 'app_system', array[]::text[],
  'app_system holds no table privilege even though it calls the consumer');
select table_privs_are('public', 'step_up_grants', 'app_worker', array[]::text[], 'the worker holds none');
-- Same invariant as the three above, read straight from the catalogue rather than through
-- `table_privs_are`. That wrapper resolves the role by name and the table by text inside
-- `_get_table_privs`, and on the real Supabase stack this one call raises instead of returning a
-- result, which aborts the file before pgTAP can report anything. Passing the role's oid and a
-- regclass removes both lookups, and selecting from pg_roles means a missing role yields no rows
-- rather than an error — which is the same verdict, since a role that does not exist holds nothing.
-- The other three keep `table_privs_are`: they return results on the real stack, so nothing about
-- them needs changing.
select is(
  (select coalesce(string_agg(p.privilege, ', ' order by p.privilege), '')
     from pg_roles r
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
      as p(privilege)
    where r.rolname = 'anon'
      and has_table_privilege(r.oid, 'public.step_up_grants'::regclass, p.privilege)),
  '',
  'anon holds none'
);
select is((select relrowsecurity from pg_class where oid = 'public.step_up_grants'::regclass), true,
  'row level security is still enabled');
select is(
  (select count(*) from pg_policy where polrelid = 'public.step_up_grants'::regclass and polcmd <> 'r'),
  0::bigint, 'and no policy grants anything but SELECT, so RLS is unchanged');

-- ---------------------------------------------------------------------------------------------------
-- The happy path
-- ---------------------------------------------------------------------------------------------------
select pg_temp.grant_for('c1000000-0000-4000-8000-000000000001');
select is(
  app_private.consume_step_up_grant('c1000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000001', 'password_change'),
  true, 'a live grant for the right user and operation is consumed');
select isnt((select consumed_at from public.step_up_grants where id = 'c1000000-0000-4000-8000-000000000001'),
  null, 'and consumed_at is set');
select is(
  (select expires_at - granted_at from public.step_up_grants where id = 'c1000000-0000-4000-8000-000000000001'),
  interval '10 minutes', 'the ten-minute validity is unchanged by consumption');

-- Single use.
select is(
  app_private.consume_step_up_grant('c1000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000001', 'password_change'),
  false, 'the same grant cannot be consumed twice');
select is((select count(*) from public.step_up_grants
            where id = 'c1000000-0000-4000-8000-000000000001' and consumed_at is not null),
  1::bigint, 'and it stays consumed exactly once');

-- ---------------------------------------------------------------------------------------------------
-- Every way of failing leaves the grant alone
-- ---------------------------------------------------------------------------------------------------
select pg_temp.grant_for('c2000000-0000-4000-8000-000000000002');

select is(
  app_private.consume_step_up_grant('c2000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000002', 'password_change'),
  false, 'the wrong user is refused');
select is((select consumed_at from public.step_up_grants where id = 'c2000000-0000-4000-8000-000000000002'),
  null, 'and the grant is untouched');

select is(
  app_private.consume_step_up_grant('c2000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000001', 'account_deletion'),
  false, 'a different operation is refused: a grant authorises only its own');
select is((select consumed_at from public.step_up_grants where id = 'c2000000-0000-4000-8000-000000000002'),
  null, 'and the grant is still untouched');

select is(
  app_private.consume_step_up_grant('c9000000-0000-4000-8000-0000000000ff',
    'f0000000-0000-4000-8000-000000000001', 'password_change'),
  false, 'a grant that does not exist is refused');

-- Expired, backdated the way a real lapsed grant is.
insert into public.step_up_grants (id, user_id, operation, granted_via, granted_at, expires_at)
values ('c3000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000001', 'password_change',
        'otp_whatsapp', now() - interval '11 minutes', now() - interval '1 second');
select is(
  app_private.consume_step_up_grant('c3000000-0000-4000-8000-000000000003',
    'f0000000-0000-4000-8000-000000000001', 'password_change'),
  false, 'an expired grant is refused');
select is((select consumed_at from public.step_up_grants where id = 'c3000000-0000-4000-8000-000000000003'),
  null, 'and expiry does not silently consume it');

-- Already consumed by someone else.
select pg_temp.grant_for('c4000000-0000-4000-8000-000000000004');
update public.step_up_grants set consumed_at = now() where id = 'c4000000-0000-4000-8000-000000000004';
select is(
  app_private.consume_step_up_grant('c4000000-0000-4000-8000-000000000004',
    'f0000000-0000-4000-8000-000000000001', 'password_change'),
  false, 'an already-consumed grant is refused');

-- The grant survives every refusal above.
select is((select count(*) from public.step_up_grants
            where id = 'c2000000-0000-4000-8000-000000000002' and consumed_at is null),
  1::bigint, 'after three refused attempts the grant is still available to its rightful use');
select is(
  app_private.consume_step_up_grant('c2000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000001', 'password_change'),
  true, 'and it can then be consumed properly');

-- ---------------------------------------------------------------------------------------------------
-- A failed protected operation gives the grant back
-- ---------------------------------------------------------------------------------------------------
-- This is rule 4, simulated the way the application does it: consume and operate in one transaction, and
-- let the failure roll both back. A savepoint stands in for that transaction.
select pg_temp.grant_for('c5000000-0000-4000-8000-000000000005');
savepoint protected_operation;
select is(
  app_private.consume_step_up_grant('c5000000-0000-4000-8000-000000000005',
    'f0000000-0000-4000-8000-000000000001', 'password_change'),
  true, 'the consume succeeds inside the operation transaction');
-- ... and now the protected operation fails.
rollback to savepoint protected_operation;

select is((select consumed_at from public.step_up_grants where id = 'c5000000-0000-4000-8000-000000000005'),
  null, 'when the operation fails the consumption is rolled back with it');
select is(
  app_private.consume_step_up_grant('c5000000-0000-4000-8000-000000000005',
    'f0000000-0000-4000-8000-000000000001', 'password_change'),
  true, 'so the grant is still available for a later attempt');
select isnt((select consumed_at from public.step_up_grants where id = 'c5000000-0000-4000-8000-000000000005'),
  null, 'and that attempt consumes it');

-- ---------------------------------------------------------------------------------------------------
-- Checking is not consuming
-- ---------------------------------------------------------------------------------------------------
select pg_temp.grant_for('c6000000-0000-4000-8000-000000000006');
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-000000000001"}', true);

select is(public.has_step_up_grant('password_change'), true,
  'has_step_up_grant sees the live grant');
select is((select consumed_at from public.step_up_grants where id = 'c6000000-0000-4000-8000-000000000006'),
  null, 'and checking it did not consume it (C-19 rule 3)');
select is(public.has_step_up_grant('password_change'), true,
  'checking twice still does not consume it');
select is((select consumed_at from public.step_up_grants where id = 'c6000000-0000-4000-8000-000000000006'),
  null, 'the grant remains unconsumed after repeated checks');

select is(public.has_step_up_grant('account_deletion'), false,
  'and it reports nothing for an operation that was never granted');

-- Once consumed, the helper stops seeing it.
select is(
  app_private.consume_step_up_grant('c6000000-0000-4000-8000-000000000006',
    'f0000000-0000-4000-8000-000000000001', 'password_change'),
  true, 'the grant is consumed');
select is(public.has_step_up_grant('password_change'), false,
  'and has_step_up_grant no longer reports it');

-- Another user never inherits it.
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-000000000002"}', true);
select is(public.has_step_up_grant('password_change'), false,
  'a different user sees no grant');

-- ---------------------------------------------------------------------------------------------------
-- Inputs that must be refused, and the contract
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.consume_step_up_grant(null, 'f0000000-0000-4000-8000-000000000001', 'password_change')$$,
  '22023', null, 'a null grant id is refused');
select throws_ok(
  $$select app_private.consume_step_up_grant('c1000000-0000-4000-8000-000000000001', null, 'password_change')$$,
  '22023', null, 'a null user id is refused');
select throws_ok(
  $$select app_private.consume_step_up_grant('c1000000-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000001', '   ')$$,
  '22023', null, 'a blank operation is refused');

select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'migration 0037 introduces no security contract problem');

select * from finish();
rollback;
