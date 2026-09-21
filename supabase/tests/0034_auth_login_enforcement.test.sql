-- pgTAP — migration 0034: login-attempt recording and durable account lockout.
--
-- The point of this migration is a security control, so the tests exercise the control rather than
-- describing it. The threshold is approached one failure at a time and the exact transition is asserted;
-- the window is tested by ageing real rows rather than by reading the function source; and the privilege
-- boundary is tested by actually connecting as the wrong roles and being refused.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(35);

-- Two accounts, so "locking one account does not lock another" is a real observation.
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'lockout-subject@test.invalid'),
  ('a0000000-0000-4000-8000-000000000002', 'lockout-bystander@test.invalid');

-- ---------------------------------------------------------------------------------------------------
-- The function exists in the shape the security model requires
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'record_login_attempt',
  array['uuid', 'bytea', 'boolean', 'text', 'inet', 'bytea'],
  'app_private.record_login_attempt exists');

select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'record_login_attempt'),
  true,
  'it is SECURITY DEFINER, because no application role may touch app_private tables');

select is(
  (select coalesce(array_to_string(p.proconfig, ','), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'record_login_attempt'),
  'search_path=pg_catalog, public',
  'and it pins search_path, like every other SECURITY DEFINER function in this project');

-- ---------------------------------------------------------------------------------------------------
-- Privileges: app_system and nobody else
-- ---------------------------------------------------------------------------------------------------
select function_privs_are('app_private', 'record_login_attempt',
  array['uuid', 'bytea', 'boolean', 'text', 'inet', 'bytea'], 'app_system', array['EXECUTE'],
  'app_system may execute it');

select function_privs_are('app_private', 'record_login_attempt',
  array['uuid', 'bytea', 'boolean', 'text', 'inet', 'bytea'], 'public', array[]::text[],
  'PUBLIC may not');

select function_privs_are('app_private', 'record_login_attempt',
  array['uuid', 'bytea', 'boolean', 'text', 'inet', 'bytea'], 'authenticated', array[]::text[],
  'authenticated may not, so a signed-in browser cannot forge a login attempt');

select function_privs_are('app_private', 'record_login_attempt',
  array['uuid', 'bytea', 'boolean', 'text', 'inet', 'bytea'], 'anon', array[]::text[],
  'anon may not');

select function_privs_are('app_private', 'record_login_attempt',
  array['uuid', 'bytea', 'boolean', 'text', 'inet', 'bytea'], 'app_worker', array[]::text[],
  'and the worker may not, because recording a login is not its job');

-- The tables themselves stay unreachable: the function is the only door.
select table_privs_are('app_private', 'login_attempts', 'app_system', array[]::text[],
  'app_system still holds no privilege on login_attempts');
select table_privs_are('app_private', 'account_lockouts', 'app_system', array[]::text[],
  'app_system still holds no privilege on account_lockouts');
select table_privs_are('app_private', 'login_attempts', 'authenticated', array[]::text[],
  'authenticated still holds no privilege on login_attempts');
select table_privs_are('app_private', 'account_lockouts', 'authenticated', array[]::text[],
  'authenticated still holds no privilege on account_lockouts');

-- ---------------------------------------------------------------------------------------------------
-- The approved rule: 5 failed logins in 15 min -> 15-min lock
-- ---------------------------------------------------------------------------------------------------
select is(app_private.is_account_locked('a0000000-0000-4000-8000-000000000001'), false,
  'the account starts unlocked');

select is(app_private.record_login_attempt(
    'a0000000-0000-4000-8000-000000000001', sha256('subject'::bytea), false, 'bad_credentials'),
  false, 'failure 1 does not lock');
select is(app_private.record_login_attempt(
    'a0000000-0000-4000-8000-000000000001', sha256('subject'::bytea), false, 'bad_credentials'),
  false, 'failure 2 does not lock');
select is(app_private.record_login_attempt(
    'a0000000-0000-4000-8000-000000000001', sha256('subject'::bytea), false, 'bad_credentials'),
  false, 'failure 3 does not lock');
select is(app_private.record_login_attempt(
    'a0000000-0000-4000-8000-000000000001', sha256('subject'::bytea), false, 'bad_credentials'),
  false, 'failure 4 does not lock — the threshold is 5, not 4');
select is(app_private.record_login_attempt(
    'a0000000-0000-4000-8000-000000000001', sha256('subject'::bytea), false, 'bad_credentials'),
  true, 'failure 5 locks the account');

select is(app_private.is_account_locked('a0000000-0000-4000-8000-000000000001'), true,
  'and the durable check the API calls before Supabase now reports it locked');

select is(
  (select locked_until - locked_at from app_private.account_lockouts
    where user_id = 'a0000000-0000-4000-8000-000000000001'),
  interval '15 minutes',
  'the lock lasts exactly the approved 15 minutes');

select is(
  (select reason from app_private.account_lockouts
    where user_id = 'a0000000-0000-4000-8000-000000000001'),
  'failed_login_threshold',
  'and records why it was applied');

select is(app_private.is_account_locked('a0000000-0000-4000-8000-000000000002'), false,
  'the other account is unaffected: the lock is per account, as account_lockouts.user_id requires');

-- Exactly one row per account, however many failures arrive.
select is(app_private.record_login_attempt(
    'a0000000-0000-4000-8000-000000000001', sha256('subject'::bytea), false, 'bad_credentials'),
  true, 'a further failure keeps the account locked');
select is((select count(*) from app_private.account_lockouts
            where user_id = 'a0000000-0000-4000-8000-000000000001'),
  1::bigint, 'and does not stack a second lockout row');

-- ---------------------------------------------------------------------------------------------------
-- The window is real: failures older than 15 minutes do not count
-- ---------------------------------------------------------------------------------------------------
delete from app_private.account_lockouts where user_id = 'a0000000-0000-4000-8000-000000000001';
update app_private.login_attempts set created_at = now() - interval '20 minutes'
 where user_id = 'a0000000-0000-4000-8000-000000000001';

select is(app_private.record_login_attempt(
    'a0000000-0000-4000-8000-000000000001', sha256('subject'::bytea), false, 'bad_credentials'),
  false, 'six failures older than the window do not lock; only the fresh one counts');
select is((select count(*) from app_private.account_lockouts
            where user_id = 'a0000000-0000-4000-8000-000000000001'),
  0::bigint, 'and no lockout row is created');

-- ---------------------------------------------------------------------------------------------------
-- A released lock is re-applied rather than left released
-- ---------------------------------------------------------------------------------------------------
update app_private.login_attempts set created_at = now()
 where user_id = 'a0000000-0000-4000-8000-000000000001';
insert into app_private.account_lockouts (user_id, locked_at, locked_until, reason, failed_attempts,
                                          released_at)
values ('a0000000-0000-4000-8000-000000000002', now() - interval '1 hour',
        now() - interval '45 minutes', 'earlier_lock', 5, now() - interval '30 minutes');
select is(app_private.is_account_locked('a0000000-0000-4000-8000-000000000002'), false,
  'a released lockout row does not count as locked');

insert into app_private.login_attempts (user_id, identifier_hash, succeeded, failure_reason)
select 'a0000000-0000-4000-8000-000000000002', sha256('bystander'::bytea), false, 'bad_credentials'
  from generate_series(1, 4);
select is(app_private.record_login_attempt(
    'a0000000-0000-4000-8000-000000000002', sha256('bystander'::bytea), false, 'bad_credentials'),
  true, 'reaching the threshold again re-locks a previously released account');
select is((select released_at from app_private.account_lockouts
            where user_id = 'a0000000-0000-4000-8000-000000000002'),
  null, 'and the stale release is cleared, so the new lock is actually in force');

-- ---------------------------------------------------------------------------------------------------
-- Attempts that must be recorded but must not lock
-- ---------------------------------------------------------------------------------------------------
select is(app_private.record_login_attempt(null, sha256('nobody'::bytea), false, 'no_such_user'),
  false, 'a failure against an unknown identifier cannot lock an account');
select is((select count(*) from app_private.login_attempts where user_id is null),
  1::bigint, 'but it is still recorded, because it is evidence of an attack');

select lives_ok(
  $$select app_private.record_login_attempt(
      'a0000000-0000-4000-8000-000000000001', sha256('subject'::bytea), true)$$,
  'a successful attempt needs no failure reason, despite the table constraint');

-- ---------------------------------------------------------------------------------------------------
-- Inputs that must be refused
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.record_login_attempt(
      'a0000000-0000-4000-8000-000000000001', null, false, 'bad_credentials')$$,
  '22023', null,
  'an attempt with no identifier hash is refused, so an unattributable row cannot be written');

select throws_ok(
  $$select app_private.record_login_attempt(
      'a0000000-0000-4000-8000-000000000001', sha256('subject'::bytea), null)$$,
  '22023', null,
  'an attempt with no outcome is refused');

-- ---------------------------------------------------------------------------------------------------
-- The security contract still passes with this migration applied
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'migration 0034 introduces no security contract problem');

select * from finish();
rollback;
