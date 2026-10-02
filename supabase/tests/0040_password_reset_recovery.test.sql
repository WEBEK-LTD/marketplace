-- pgTAP — migration 0040: the password-reset recovery flow (F3).
--
-- What this file is really checking is that F3 joins the three existing primitives without loosening
-- any of them: the new OTP purpose is an addition and not a replacement, the D10 `recovery` purpose is
-- untouched, the reset token that a verification produces is still C-18's (15 minutes, digest-only,
-- single use), the status read does not consume, and the security-event writer accepts exactly one new
-- type and no more.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(58);

insert into auth.users (id, email, phone, phone_confirmed_at) values
  ('d0000000-0000-4000-8000-000000000001', 'reset-owner@test.invalid', '+201000000001', now()),
  ('d0000000-0000-4000-8000-000000000002', 'reset-unverified@test.invalid', '+201000000002', null),
  ('d0000000-0000-4000-8000-000000000003', 'reset-nophone@test.invalid', null, null);

-- ---------------------------------------------------------------------------------------------------
-- The new OTP purpose is an addition
-- ---------------------------------------------------------------------------------------------------
select lives_ok(
  $$insert into app_private.otp_challenges (id, user_id, purpose, channel, destination_hash, code_hash, expires_at)
    values ('e0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-000000000001', 'password_reset',
            'whatsapp', sha256('d1'::bytea), sha256('c1'::bytea), now() + interval '10 minutes')$$,
  'a password_reset challenge may now be written');

select lives_ok(
  $$insert into app_private.otp_challenges (id, user_id, purpose, channel, destination_hash, code_hash, expires_at)
    values ('e0000000-0000-4000-8000-00000000000b', 'd0000000-0000-4000-8000-000000000001', 'recovery',
            'whatsapp', sha256('d2'::bytea), sha256('c2'::bytea), now() + interval '10 minutes')$$,
  'and the D10 recovery purpose still may too');
select lives_ok(
  $$insert into app_private.otp_challenges (user_id, purpose, channel, destination_hash, code_hash, expires_at)
    values ('d0000000-0000-4000-8000-000000000001', 'login', 'whatsapp', sha256('d3'::bytea), sha256('c3'::bytea),
            now() + interval '10 minutes')$$,
  'as do the other four original purposes (login shown)');
select throws_ok(
  $$insert into app_private.otp_challenges (user_id, purpose, channel, destination_hash, code_hash, expires_at)
    values ('d0000000-0000-4000-8000-000000000001', 'password_change', 'whatsapp', sha256('d4'::bytea),
            sha256('c4'::bytea), now() + interval '10 minutes')$$,
  '23514', null, 'an unapproved purpose is still refused');

-- The D10 flow keys on its own purpose and must not have been widened.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'verify_recovery_contact'
      and pg_get_functiondef(p.oid) like '%''recovery''%'),
  1::bigint,
  'app_private.verify_recovery_contact still requires a recovery-purpose challenge');

-- ---------------------------------------------------------------------------------------------------
-- Contact resolution
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'password_reset_contact', array['text'],
  'app_private.password_reset_contact exists');
select is(
  (select phone_e164 from app_private.password_reset_contact('reset-owner@test.invalid')),
  '+201000000001',
  'a verified contact is resolved from the email identifier');
select is(
  (select user_id from app_private.password_reset_contact('RESET-OWNER@TEST.INVALID')),
  'd0000000-0000-4000-8000-000000000001'::uuid,
  'identifier matching is case-insensitive for email');
select is(
  (select phone_e164 from app_private.password_reset_contact('+201000000001')),
  '+201000000001',
  'and the phone itself resolves too');
select is(
  (select count(*) from app_private.password_reset_contact('reset-unverified@test.invalid')),
  0::bigint,
  'an unconfirmed phone yields no contact, so no OTP can be sent to it');
select is(
  (select count(*) from app_private.password_reset_contact('reset-nophone@test.invalid')),
  0::bigint,
  'an account with no phone yields no contact');
select is(
  (select count(*) from app_private.password_reset_contact('stranger@test.invalid')),
  0::bigint,
  'and an unknown identifier yields exactly the same: no row');
select is(
  (select count(*) from app_private.password_reset_contact(null)),
  0::bigint,
  'a null identifier resolves to nothing');

select is(
  app_private.verified_contact_for_user('d0000000-0000-4000-8000-000000000001'),
  '+201000000001',
  'the notification contact resolves from the account id');
select is(
  app_private.verified_contact_for_user('d0000000-0000-4000-8000-000000000002'),
  null,
  'an unconfirmed phone is not a notification contact either');

-- ---------------------------------------------------------------------------------------------------
-- Verification issues the C-18 token
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'verify_password_reset_otp', array['uuid','bytea','bytea'],
  'app_private.verify_password_reset_otp exists');

select is(
  (select outcome from app_private.verify_password_reset_otp(
     'e0000000-0000-4000-8000-00000000000a', sha256('wrong'::bytea), sha256('t1'::bytea))),
  'invalid',
  'a wrong code is invalid');
select is(
  (select attempts from app_private.otp_challenges where id = 'e0000000-0000-4000-8000-00000000000a'),
  1::smallint,
  'and the attempt was counted by the 0035 lifecycle, not bypassed');
select is(
  (select count(*) from app_private.password_reset_tokens where user_id = 'd0000000-0000-4000-8000-000000000001'),
  0::bigint,
  'a failed verification issues no token');

select is(
  (select outcome from app_private.verify_password_reset_otp(
     'e0000000-0000-4000-8000-00000000000b', sha256('c2'::bytea), sha256('t2'::bytea))),
  'not_found',
  'a D10 recovery challenge is reported as not found, whatever its code');
select is(
  (select consumed_at from app_private.otp_challenges where id = 'e0000000-0000-4000-8000-00000000000b'),
  null,
  'and it is left untouched, so the D10 flow is unaffected');

create temp table verified as
  select * from app_private.verify_password_reset_otp(
    'e0000000-0000-4000-8000-00000000000a', sha256('c1'::bytea), sha256('t3'::bytea));

select is((select outcome from verified), 'verified', 'the right code verifies');
select isnt((select token_id from verified), null, 'and a reset token comes back with it');
select is(
  (select (expires_at - created_at) from app_private.password_reset_tokens where id = (select token_id from verified)),
  interval '15 minutes',
  'the token is C-18''s: exactly 15 minutes');
select is(
  (select user_id from app_private.password_reset_tokens where id = (select token_id from verified)),
  'd0000000-0000-4000-8000-000000000001'::uuid,
  'bound to the account the challenge belonged to');
select is(
  (select token_hash from app_private.password_reset_tokens where id = (select token_id from verified)),
  sha256('t3'::bytea),
  'and stored as the digest that was passed in');
select isnt(
  (select consumed_at from app_private.otp_challenges where id = 'e0000000-0000-4000-8000-00000000000a'),
  null,
  'the OTP challenge is consumed by the verification');
select is(
  (select outcome from app_private.verify_password_reset_otp(
     'e0000000-0000-4000-8000-00000000000a', sha256('c1'::bytea), sha256('t4'::bytea))),
  'consumed',
  'so the same code cannot be replayed for a second token');
select is(
  (select count(*) from app_private.password_reset_tokens where user_id = 'd0000000-0000-4000-8000-000000000001'),
  1::bigint,
  'and exactly one token exists for that verification');

select throws_ok(
  $$select * from app_private.verify_password_reset_otp('e0000000-0000-4000-8000-00000000000a', sha256('c1'::bytea), '\x01'::bytea)$$,
  '22023', null, 'a digest narrower than 256 bits is refused');

-- ---------------------------------------------------------------------------------------------------
-- The non-consuming status read
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'password_reset_token_status', array['bytea'],
  'app_private.password_reset_token_status exists');

select is((select status from app_private.password_reset_token_status(sha256('t3'::bytea))), 'valid',
  'a live token reads as valid');
select is((select user_id from app_private.password_reset_token_status(sha256('t3'::bytea))),
  'd0000000-0000-4000-8000-000000000001'::uuid,
  'and names the account it is bound to, which the completion step needs before it changes a password');
select is(
  (select consumed_at from app_private.password_reset_tokens where id = (select token_id from verified)),
  null,
  'reading the status does not consume the token');
select is((select status from app_private.password_reset_token_status(sha256('nope'::bytea))), 'not_found',
  'an unknown digest reads as not found');
select is((select user_id from app_private.password_reset_token_status(sha256('nope'::bytea))), null,
  'and names nobody');

update app_private.password_reset_tokens
   set created_at = now() - interval '30 minutes', expires_at = now() - interval '15 minutes'
 where id = (select token_id from verified);
select is((select status from app_private.password_reset_token_status(sha256('t3'::bytea))), 'expired',
  'an expired token reads as expired');
update app_private.password_reset_tokens
   set created_at = now(), expires_at = now() + interval '15 minutes', consumed_at = now()
 where id = (select token_id from verified);
select is((select status from app_private.password_reset_token_status(sha256('t3'::bytea))), 'already_consumed',
  'and a spent one reads as already consumed');
select is((select user_id from app_private.password_reset_token_status(sha256('t3'::bytea))), null,
  'neither of which names an account');

-- ---------------------------------------------------------------------------------------------------
-- The sixth security-event type
-- ---------------------------------------------------------------------------------------------------
create temp table reset_event as
  select app_private.record_auth_security_event(
    'auth.password_reset.success', 'd0000000-0000-4000-8000-000000000001',
    sha256('identifier'::bytea), sha256('ip'::bytea), sha256('ua'::bytea), 'req-f3', 'password_reset_completed') as id;

select is(
  (select event_type from public.security_events where id = (select id from reset_event)),
  'auth.password_reset.success',
  'the approved F3 event type is accepted');
select is(
  (select user_id from public.security_events where id = (select id from reset_event)),
  'd0000000-0000-4000-8000-000000000001'::uuid,
  'it records the resolved account');
select is(
  (select details from public.security_events where id = (select id from reset_event)),
  jsonb_build_object(
    'identifier_hash', encode(sha256('identifier'::bytea), 'hex'),
    'ip_hash', encode(sha256('ip'::bytea), 'hex'),
    'user_agent_hash', encode(sha256('ua'::bytea), 'hex'),
    'request_id', 'req-f3',
    'reason_code', 'password_reset_completed'),
  'the payload is hashes, a request id and a reason code, and nothing else');
select is(
  (select request_ip from public.security_events where id = (select id from reset_event)),
  null,
  'no address is stored in the clear');

select lives_ok(
  $$select app_private.record_auth_security_event('auth.login.success', null, '\x01'::bytea, null, null, null, 'password_accepted')$$,
  'the five C-20 login types still work');
select throws_ok(
  $$select app_private.record_auth_security_event('auth.password_reset.failure', null, '\x01'::bytea, null, null, null, 'x')$$,
  '22023', null, 'a failure type nobody approved is still refused');
select throws_ok(
  $$select app_private.record_auth_security_event('auth.password_reset.success', null, null, null, null, null, 'ok_reason')$$,
  '22023', null, 'and the event still needs a hashed identifier');

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('password_reset_contact', 'verified_contact_for_user', 'verify_password_reset_otp',
                        'password_reset_token_status', 'record_auth_security_event')
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'every F3 function is SECURITY DEFINER with the pinned search_path');

select function_privs_are('app_private', 'password_reset_contact', array['text'], 'app_system', array['EXECUTE'],
  'app_system may resolve a recovery contact');
select function_privs_are('app_private', 'password_reset_contact', array['text'], 'authenticated', array[]::text[],
  'authenticated may not, so a browser cannot ask whether an account exists');
select function_privs_are('app_private', 'password_reset_contact', array['text'], 'anon', array[]::text[],
  'and anon may not');
select function_privs_are('app_private', 'verified_contact_for_user', array['uuid'], 'app_system', array['EXECUTE'],
  'app_system may resolve the notification contact');
select function_privs_are('app_private', 'verified_contact_for_user', array['uuid'], 'authenticated', array[]::text[],
  'authenticated may not read another account''s contact');
select function_privs_are('app_private', 'verify_password_reset_otp', array['uuid','bytea','bytea'],
  'app_system', array['EXECUTE'], 'app_system may verify a recovery OTP');
select function_privs_are('app_private', 'verify_password_reset_otp', array['uuid','bytea','bytea'],
  'authenticated', array[]::text[], 'authenticated may not');
select function_privs_are('app_private', 'password_reset_token_status', array['bytea'],
  'app_system', array['EXECUTE'], 'app_system may read a token status');
select function_privs_are('app_private', 'password_reset_token_status', array['bytea'],
  'anon', array[]::text[], 'anon may not');
select function_privs_are('app_private', 'password_reset_token_status', array['bytea'],
  'app_worker', array[]::text[], 'and the worker has no business in the recovery flow');
select table_privs_are('app_private', 'otp_challenges', 'authenticated', array[]::text[],
  'the challenge table itself is still reachable by no browser role');

select * from finish();
rollback;
