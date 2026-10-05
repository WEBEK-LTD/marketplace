-- pgTAP — migration 0042: the TOTP step-up grant writer (F5-A).
--
-- What has to be true here is narrow, because the function is narrow. It may issue one kind of grant,
-- for one user, for one operation, for one duration, and it may be called by one role. Everything it
-- writes must then be spendable by the **unmodified** C-19 consumer under the same rules an OTP grant
-- obeys — no weaker, and with no second way in.
--
-- The tests therefore fall into four groups: the boundary (shape, privileges, and that 0036 and 0037 are
-- untouched), what a granted row actually contains, what the two refusals do, and how the grant behaves
-- when it is spent.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(37);

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'totp-owner@test.invalid'),
  ('a0000000-0000-4000-8000-000000000002', 'totp-stranger@test.invalid');

-- ---------------------------------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'issue_totp_step_up_grant', array['uuid','text'],
  'app_private.issue_totp_step_up_grant exists');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname = 'issue_totp_step_up_grant'
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'it is SECURITY DEFINER with the pinned search_path');

select function_privs_are('app_private', 'issue_totp_step_up_grant', array['uuid','text'],
  'app_system', array['EXECUTE'], 'app_system may issue a TOTP step-up grant');
select function_privs_are('app_private', 'issue_totp_step_up_grant', array['uuid','text'],
  'authenticated', array[]::text[],
  'authenticated may not, so a browser cannot mint its own step-up authorisation');
select function_privs_are('app_private', 'issue_totp_step_up_grant', array['uuid','text'],
  'anon', array[]::text[], 'anon may not');
select function_privs_are('app_private', 'issue_totp_step_up_grant', array['uuid','text'],
  'app_worker', array[]::text[], 'the worker has no part in step-up');
select function_privs_are('app_private', 'issue_totp_step_up_grant', array['uuid','text'],
  'public', array[]::text[], 'and PUBLIC may not');

-- The writer holds no table privilege of its own; it works only because it is SECURITY DEFINER.
select table_privs_are('public', 'step_up_grants', 'app_system', array[]::text[],
  'app_system still has no privilege on step_up_grants itself');
select table_privs_are('public', 'step_up_grants', 'anon', array[]::text[],
  'and anon still has none');

-- ---------------------------------------------------------------------------------------------------
-- 0036 and 0037 are untouched
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'issue_step_up_grant', array['uuid','bytea','text'],
  'the OTP issuer from 0036 still exists with its original signature');
select has_function('app_private', 'consume_step_up_grant', array['uuid','uuid','text'],
  'the C-19 consumer from 0037 still exists with its original signature');
select is(
  (select count(*) from pg_indexes
    where schemaname = 'public' and indexname = 'step_up_grants_one_per_challenge'
      and indexdef like '%challenge_id IS NOT NULL%'),
  1::bigint,
  'the 0036 one-grant-per-challenge index is still partial, which is what lets a TOTP grant have none');
select col_is_null('public', 'step_up_grants', 'challenge_id',
  'and challenge_id is still nullable');

-- ---------------------------------------------------------------------------------------------------
-- What a granted row contains
-- ---------------------------------------------------------------------------------------------------
create temporary table issued on commit drop as
  select * from app_private.issue_totp_step_up_grant(
    'a0000000-0000-4000-8000-000000000001', 'password_change');

select is((select outcome from issued), 'granted', 'a known user and a named operation are granted');
select isnt((select grant_id from issued), null, 'and the grant id comes back');

select is(
  (select g.granted_via from public.step_up_grants g where g.id = (select grant_id from issued)),
  'totp',
  'the row records granted_via = totp, which no caller supplied');
select is(
  (select g.challenge_id from public.step_up_grants g where g.id = (select grant_id from issued)),
  null,
  'and no challenge id, because a TOTP proof leaves no challenge row');
select is(
  (select g.user_id from public.step_up_grants g where g.id = (select grant_id from issued)),
  'a0000000-0000-4000-8000-000000000001'::uuid,
  'it names the user it was issued for');
select is(
  (select g.operation from public.step_up_grants g where g.id = (select grant_id from issued)),
  'password_change',
  'and the one operation it authorises');
select is(
  (select g.expires_at - g.granted_at from public.step_up_grants g
    where g.id = (select grant_id from issued)),
  interval '10 minutes',
  'validity is exactly ten minutes (C-16), fixed inside the function');
select is(
  (select g.expires_at from public.step_up_grants g where g.id = (select grant_id from issued)),
  (select expires_at from issued),
  'and the expiry reported to the caller is the one that was stored');
select is(
  (select g.consumed_at from public.step_up_grants g where g.id = (select grant_id from issued)),
  null,
  'a fresh grant is unconsumed');

-- ---------------------------------------------------------------------------------------------------
-- The two refusals — outcomes, not exceptions
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.issue_totp_step_up_grant(
     'a0000000-0000-4000-8000-00000000dead', 'password_change')),
  'no_user',
  'an account that does not exist is refused by outcome, not by a foreign-key error');
select is(
  (select outcome from app_private.issue_totp_step_up_grant(null, 'password_change')),
  'no_user',
  'and so is a null user');
select is(
  (select outcome from app_private.issue_totp_step_up_grant(
     'a0000000-0000-4000-8000-000000000001', null)),
  'invalid_operation',
  'a null operation is refused');
select is(
  (select outcome from app_private.issue_totp_step_up_grant(
     'a0000000-0000-4000-8000-000000000001', '   ')),
  'invalid_operation',
  'and so is a blank one, which would otherwise authorise an operation with no name');
select is(
  (select count(*) from public.step_up_grants g
    where g.user_id = 'a0000000-0000-4000-8000-000000000001' and g.operation is not distinct from null),
  0::bigint,
  'no refusal leaves a grant behind');
select is(
  (select count(*) from public.step_up_grants), 1::bigint,
  'so after four refusals exactly the one granted row exists');

-- ---------------------------------------------------------------------------------------------------
-- Spending it, through the unmodified C-19 consumer
-- ---------------------------------------------------------------------------------------------------
select ok(
  not app_private.consume_step_up_grant(
    (select grant_id from issued), 'a0000000-0000-4000-8000-000000000002', 'password_change'),
  'another account cannot spend this grant');
select ok(
  not app_private.consume_step_up_grant(
    (select grant_id from issued), 'a0000000-0000-4000-8000-000000000001', 'account_deletion'),
  'and it does not authorise a different operation');
select is(
  (select g.consumed_at from public.step_up_grants g where g.id = (select grant_id from issued)),
  null,
  'neither refusal consumed it');

select ok(
  app_private.consume_step_up_grant(
    (select grant_id from issued), 'a0000000-0000-4000-8000-000000000001', 'password_change'),
  'its own user and operation spend it');
select isnt(
  (select g.consumed_at from public.step_up_grants g where g.id = (select grant_id from issued)),
  null,
  'which marks it consumed');
select ok(
  not app_private.consume_step_up_grant(
    (select grant_id from issued), 'a0000000-0000-4000-8000-000000000001', 'password_change'),
  'and it is single-use: a second attempt authorises nothing');

-- Expiry is the consumer's rule, but a grant written here has to obey it like any other.
create temporary table stale on commit drop as
  select * from app_private.issue_totp_step_up_grant(
    'a0000000-0000-4000-8000-000000000001', 'revoke_all_sessions');
-- `granted_at` moves back with it: the table's own `expires_at > granted_at` rule holds for every row,
-- including one a test ages deliberately.
update public.step_up_grants
   set granted_at = now() - interval '20 minutes', expires_at = now() - interval '1 second'
 where id = (select grant_id from stale);
select ok(
  not app_private.consume_step_up_grant(
    (select grant_id from stale), 'a0000000-0000-4000-8000-000000000001', 'revoke_all_sessions'),
  'an expired TOTP grant authorises nothing');

-- ---------------------------------------------------------------------------------------------------
-- Several TOTP grants coexist
-- ---------------------------------------------------------------------------------------------------
-- The partial unique index stops two grants sharing one challenge id. All TOTP grants have none, so it
-- must not stop them existing side by side — otherwise a second step-up in the same ten minutes would
-- fail on an index that was never meant to apply to them.
select lives_ok($$
  select app_private.issue_totp_step_up_grant('a0000000-0000-4000-8000-000000000001', 'payout_detail_change');
  select app_private.issue_totp_step_up_grant('a0000000-0000-4000-8000-000000000001', 'payout_detail_change');
$$, 'two TOTP grants for the same user and operation both record, null challenge id and all');
select is(
  (select count(*) from public.step_up_grants g where g.granted_via = 'totp' and g.challenge_id is null),
  4::bigint,
  'and every grant this migration writes is a null-challenge TOTP grant');

select * from finish();
rollback;
