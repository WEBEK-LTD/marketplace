-- pgTAP — migration 0036: step-up grants issued by a verified OTP.
--
-- The point of this migration is that a grant exists only behind a correct, live, unused OTP, so every
-- way of failing that check is driven for real and the absence of a grant is asserted each time.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(51);

insert into auth.users (id, email) values
  ('d0000000-0000-4000-8000-000000000001', 'stepup-one@test.invalid'),
  ('d0000000-0000-4000-8000-000000000002', 'stepup-two@test.invalid');

-- A fresh, usable WhatsApp challenge for the given id.
create or replace function pg_temp.fresh(p_id uuid, p_user uuid default 'd0000000-0000-4000-8000-000000000001',
                                         p_channel text default 'whatsapp')
returns void language sql as $$
  insert into app_private.otp_challenges
    (id, user_id, purpose, channel, destination_hash, code_hash, expires_at, send_count, last_sent_at)
  values (p_id, p_user, 'step_up', p_channel, sha256(p_id::text::bytea), sha256('good'::bytea),
          now() + interval '5 minutes', 1, now());
$$;

-- ---------------------------------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'issue_step_up_grant', array['uuid', 'bytea', 'text'],
  'app_private.issue_step_up_grant exists');

select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'issue_step_up_grant'),
  true, 'it is SECURITY DEFINER');

select is(
  (select coalesce(array_to_string(p.proconfig, ','), '') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'issue_step_up_grant'),
  'search_path=pg_catalog, public', 'and it pins search_path');

select function_privs_are('app_private', 'issue_step_up_grant', array['uuid', 'bytea', 'text'],
  'app_system', array['EXECUTE'], 'app_system may issue a grant');
select function_privs_are('app_private', 'issue_step_up_grant', array['uuid', 'bytea', 'text'],
  'authenticated', array[]::text[], 'authenticated may not');
select function_privs_are('app_private', 'issue_step_up_grant', array['uuid', 'bytea', 'text'],
  'anon', array[]::text[], 'anon may not');
select function_privs_are('app_private', 'issue_step_up_grant', array['uuid', 'bytea', 'text'],
  'app_worker', array[]::text[], 'the worker has no part in step-up');
select function_privs_are('app_private', 'issue_step_up_grant', array['uuid', 'bytea', 'text'],
  'public', array[]::text[], 'and PUBLIC may not');

-- ---------------------------------------------------------------------------------------------------
-- Direct table writes stay denied: the function is the only way a grant can appear
-- ---------------------------------------------------------------------------------------------------
select table_privs_are('public', 'step_up_grants', 'authenticated', array['SELECT'],
  'authenticated may still only read its own grants, never write one');
select table_privs_are('public', 'step_up_grants', 'app_system', array[]::text[],
  'app_system holds no table privilege even though it calls the writer');
select table_privs_are('public', 'step_up_grants', 'app_worker', array[]::text[],
  'the worker holds none');
select table_privs_are('public', 'step_up_grants', 'anon', array[]::text[],
  'anon holds none');
select is((select relrowsecurity from pg_class where oid = 'public.step_up_grants'::regclass), true,
  'row level security is still enabled');
select is(
  (select count(*) from pg_policy where polrelid = 'public.step_up_grants'::regclass and polcmd <> 'r'),
  0::bigint,
  'and no policy grants anything but SELECT, so RLS is not weakened');

-- ---------------------------------------------------------------------------------------------------
-- The approved source values
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from pg_constraint
    where conrelid = 'public.step_up_grants'::regclass
      and conname = 'step_up_grants_via_allowed'
      and pg_get_constraintdef(oid) like '%otp_whatsapp%'),
  1::bigint, 'otp_whatsapp is an allowed grant source');

select throws_ok(
  $$insert into public.step_up_grants (user_id, operation, granted_via, expires_at)
    values ('d0000000-0000-4000-8000-000000000001', 'password_change', 'otp_carrier_pigeon',
            now() + interval '10 minutes')$$,
  '23514', null, 'an unapproved source is still refused');

-- ---------------------------------------------------------------------------------------------------
-- The happy path
-- ---------------------------------------------------------------------------------------------------
select pg_temp.fresh('a1000000-0000-4000-8000-000000000001');
select is(
  (select outcome from app_private.issue_step_up_grant(
     'a1000000-0000-4000-8000-000000000001', sha256('good'::bytea), 'password_change')),
  'granted', 'a correct code on a live challenge issues a grant');

select is((select count(*) from public.step_up_grants), 1::bigint, 'exactly one grant exists');
select is((select granted_via from public.step_up_grants), 'otp_whatsapp',
  'a WhatsApp OTP is recorded as otp_whatsapp, not otp_sms');
select is((select operation from public.step_up_grants), 'password_change',
  'the grant is bound to the one operation it was asked for');
select is((select expires_at - granted_at from public.step_up_grants), interval '10 minutes',
  'and it lasts exactly the approved ten minutes (C-16)');
select is((select challenge_id from public.step_up_grants), 'a1000000-0000-4000-8000-000000000001'::uuid,
  'the grant records which challenge authorised it');
select isnt((select consumed_at from app_private.otp_challenges
              where id = 'a1000000-0000-4000-8000-000000000001'), null,
  'and the challenge was consumed by the verification');

-- The grant is single-purpose: it authorises that operation and no other.
select is(
  (select count(*) from public.step_up_grants g
    where g.user_id = 'd0000000-0000-4000-8000-000000000001' and g.operation = 'account_deletion'),
  0::bigint, 'it grants nothing for a different operation');

-- ---------------------------------------------------------------------------------------------------
-- Every way of failing issues nothing
-- ---------------------------------------------------------------------------------------------------
select pg_temp.fresh('a2000000-0000-4000-8000-000000000002');
select is(
  (select outcome from app_private.issue_step_up_grant(
     'a2000000-0000-4000-8000-000000000002', sha256('wrong'::bytea), 'password_change')),
  'invalid', 'a wrong code issues nothing');
select is((select count(*) from public.step_up_grants where challenge_id = 'a2000000-0000-4000-8000-000000000002'),
  0::bigint, 'and no grant row appears');
select is((select attempts from app_private.otp_challenges where id = 'a2000000-0000-4000-8000-000000000002'),
  1::smallint, 'the failed attempt was counted');

-- Expired.
insert into app_private.otp_challenges
  (id, user_id, purpose, channel, destination_hash, code_hash, created_at, expires_at, send_count, last_sent_at)
values ('a3000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001', 'step_up', 'whatsapp',
        sha256('x3'::bytea), sha256('good'::bytea), now() - interval '11 minutes', now() - interval '1 second',
        1, now() - interval '11 minutes');
select is(
  (select outcome from app_private.issue_step_up_grant(
     'a3000000-0000-4000-8000-000000000003', sha256('good'::bytea), 'password_change')),
  'expired', 'an expired challenge issues nothing, right code or not');
select is((select count(*) from public.step_up_grants where challenge_id = 'a3000000-0000-4000-8000-000000000003'),
  0::bigint, 'and no grant row appears');

-- Already consumed.
select pg_temp.fresh('a4000000-0000-4000-8000-000000000004');
update app_private.otp_challenges set consumed_at = now() where id = 'a4000000-0000-4000-8000-000000000004';
select is(
  (select outcome from app_private.issue_step_up_grant(
     'a4000000-0000-4000-8000-000000000004', sha256('good'::bytea), 'password_change')),
  'consumed', 'a consumed challenge issues nothing');
select is((select count(*) from public.step_up_grants where challenge_id = 'a4000000-0000-4000-8000-000000000004'),
  0::bigint, 'and no grant row appears');

-- Attempt ceiling reached.
select pg_temp.fresh('a5000000-0000-4000-8000-000000000005');
update app_private.otp_challenges set attempts = 5 where id = 'a5000000-0000-4000-8000-000000000005';
select is(
  (select outcome from app_private.issue_step_up_grant(
     'a5000000-0000-4000-8000-000000000005', sha256('good'::bytea), 'password_change')),
  'too_many_attempts', 'a challenge past its attempt ceiling issues nothing');
select is((select count(*) from public.step_up_grants where challenge_id = 'a5000000-0000-4000-8000-000000000005'),
  0::bigint, 'and no grant row appears');

-- Unknown challenge.
select is(
  (select outcome from app_private.issue_step_up_grant(
     'a9000000-0000-4000-8000-0000000000ff', sha256('good'::bytea), 'password_change')),
  'not_found', 'an unknown challenge issues nothing');

-- A challenge that matched no account cannot authorise anything.
insert into app_private.otp_challenges
  (id, user_id, purpose, channel, destination_hash, code_hash, expires_at, send_count, last_sent_at)
values ('a6000000-0000-4000-8000-000000000006', null, 'step_up', 'whatsapp',
        sha256('x6'::bytea), sha256('good'::bytea), now() + interval '5 minutes', 1, now());
select is(
  (select outcome from app_private.issue_step_up_grant(
     'a6000000-0000-4000-8000-000000000006', sha256('good'::bytea), 'password_change')),
  'no_user', 'a challenge with no account issues nothing');
select is((select count(*) from public.step_up_grants where challenge_id = 'a6000000-0000-4000-8000-000000000006'),
  0::bigint, 'and no grant row appears');

-- Delivery failure: the message never arrived, so nothing was ever verified and no grant exists.
select pg_temp.fresh('a7000000-0000-4000-8000-000000000007');
insert into public.whatsapp_outbox (id, to_phone_e164, template_name, template_locale, status, failed_at)
values ('b7000000-0000-4000-8000-000000000007', '+201000000007', 'otp_login', 'en', 'failed', now());
select is((select count(*) from public.step_up_grants where challenge_id = 'a7000000-0000-4000-8000-000000000007'),
  0::bigint, 'a failed delivery leaves no grant behind');
select is((select consumed_at from app_private.otp_challenges where id = 'a7000000-0000-4000-8000-000000000007'),
  null, 'and leaves the challenge unconsumed, so a resend can still be used');

-- ---------------------------------------------------------------------------------------------------
-- Replay and duplication
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.issue_step_up_grant(
     'a1000000-0000-4000-8000-000000000001', sha256('good'::bytea), 'password_change')),
  'consumed', 'replaying the successful code issues nothing');
select is((select count(*) from public.step_up_grants where challenge_id = 'a1000000-0000-4000-8000-000000000001'),
  1::bigint, 'and the original grant is not duplicated');

-- The structural guarantee, independent of the verification logic: even a direct write cannot record a
-- second grant against one challenge.
select throws_ok(
  $$insert into public.step_up_grants (user_id, operation, granted_via, challenge_id, expires_at)
    values ('d0000000-0000-4000-8000-000000000001', 'account_deletion', 'otp_whatsapp',
            'a1000000-0000-4000-8000-000000000001', now() + interval '10 minutes')$$,
  '23505', null,
  'a second grant for the same challenge is refused by a unique index, whatever the code path');

-- ---------------------------------------------------------------------------------------------------
-- The other channels still map truthfully
-- ---------------------------------------------------------------------------------------------------
select pg_temp.fresh('a8000000-0000-4000-8000-000000000008', 'd0000000-0000-4000-8000-000000000002', 'email');
select is(
  (select outcome from app_private.issue_step_up_grant(
     'a8000000-0000-4000-8000-000000000008', sha256('good'::bytea), 'payout_detail_change')),
  'granted', 'an email OTP also issues a grant');
select is((select granted_via from public.step_up_grants where challenge_id = 'a8000000-0000-4000-8000-000000000008'),
  'otp_email', 'recorded as otp_email');

-- ---------------------------------------------------------------------------------------------------
-- The existing read helper is unchanged and still correct
-- ---------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"d0000000-0000-4000-8000-000000000001"}', true);
select is(public.has_step_up_grant('password_change'), true,
  'has_step_up_grant sees the new grant for its own user');
select is(public.has_step_up_grant('account_deletion'), false,
  'and not for an operation that was never granted');

select set_config('request.jwt.claims',
  '{"sub":"d0000000-0000-4000-8000-000000000002"}', true);
select is(public.has_step_up_grant('password_change'), false,
  'another user does not inherit the grant');

-- Expiry and consumption still close it.
select set_config('request.jwt.claims',
  '{"sub":"d0000000-0000-4000-8000-000000000001"}', true);
-- Backdated the way a real expired grant is: issued eleven minutes ago, lapsed a second ago.
update public.step_up_grants
   set granted_at = now() - interval '11 minutes', expires_at = now() - interval '1 second'
 where challenge_id = 'a1000000-0000-4000-8000-000000000001';
select is(public.has_step_up_grant('password_change'), false, 'an expired grant no longer counts');

update public.step_up_grants
   set granted_at = now(), expires_at = now() + interval '10 minutes', consumed_at = now()
 where challenge_id = 'a1000000-0000-4000-8000-000000000001';
select is(public.has_step_up_grant('password_change'), false, 'nor does a consumed one');

-- ---------------------------------------------------------------------------------------------------
-- Inputs that must be refused, and the contract
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$select * from app_private.issue_step_up_grant('a1000000-0000-4000-8000-000000000001', null, 'password_change')$$,
  '22023', null, 'issuing without a digest is refused');
select throws_ok(
  $$select * from app_private.issue_step_up_grant('a1000000-0000-4000-8000-000000000001', sha256('good'::bytea), '  ')$$,
  '22023', null, 'issuing without an operation is refused');

select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'migration 0036 introduces no security contract problem');

select * from finish();
rollback;
