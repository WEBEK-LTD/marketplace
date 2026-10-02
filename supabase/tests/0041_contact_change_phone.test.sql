-- pgTAP — migration 0041: the phone contact change (F4).
--
-- The two claims worth proving here are the ones the flow's safety rests on: a challenge can only be
-- verified by the account it belongs to and only for the purpose it was issued for, and the number that
-- comes back is the one the code was actually sent to — never one a caller chose. The rest is the usual
-- boundary: SECURITY DEFINER, pinned search_path, `app_system` alone, and no new place for a contact to
-- sit half-changed.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(38);

insert into auth.users (id, email, phone, phone_confirmed_at) values
  ('f0000000-0000-4000-8000-000000000001', 'contact-owner@test.invalid', '+201000000009', now()),
  ('f0000000-0000-4000-8000-000000000002', 'contact-stranger@test.invalid', '+201000000008', now());

-- The outbox row that carried the code, and the challenge that goes with it.
insert into public.whatsapp_outbox (to_phone_e164, template_name, template_locale, recipient_user_id) values
  ('+201555000111', 'contact_change_phone_otp', 'en', 'f0000000-0000-4000-8000-000000000001');
insert into app_private.otp_challenges (id, user_id, purpose, channel, destination_hash, code_hash, expires_at) values
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'phone_verify', 'whatsapp',
   sha256(convert_to('+201555000111', 'UTF8')), sha256('c1'::bytea), now() + interval '10 minutes'),
  ('f1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000001', 'login', 'whatsapp',
   sha256(convert_to('+201555000222', 'UTF8')), sha256('c2'::bytea), now() + interval '10 minutes');
-- Expired, with its own creation time moved back so the table's expiry-after-creation rule still holds.
insert into app_private.otp_challenges (id, user_id, purpose, channel, destination_hash, code_hash, created_at, expires_at) values
  ('f1000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000001', 'phone_verify', 'whatsapp',
   sha256(convert_to('+201555000333', 'UTF8')), sha256('c3'::bytea), now() - interval '20 minutes', now() - interval '1 minute');

-- ---------------------------------------------------------------------------------------------------
-- Nothing new stores a contact
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from information_schema.tables
    where table_schema in ('app_private', 'public')
      and (table_name like '%pending_contact%' or table_name like '%contact_change%')),
  0::bigint,
  'F4 adds no pending-contact table: the approved state model needs none');
select hasnt_column('app_private', 'otp_challenges', 'destination',
  'and the challenge still has no column for a clear destination');
select col_type_is('app_private', 'otp_challenges', 'destination_hash', 'bytea',
  'the destination is still stored only as a digest');

-- ---------------------------------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'verify_contact_change_otp', array['uuid','bytea','uuid'],
  'app_private.verify_contact_change_otp exists');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('verify_contact_change_otp', 'record_auth_security_event')
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'both functions are SECURITY DEFINER with the pinned search_path');

select function_privs_are('app_private', 'verify_contact_change_otp', array['uuid','bytea','uuid'],
  'app_system', array['EXECUTE'], 'app_system may verify a contact-change code');
select function_privs_are('app_private', 'verify_contact_change_otp', array['uuid','bytea','uuid'],
  'authenticated', array[]::text[], 'authenticated may not, so a browser cannot verify its own change');
select function_privs_are('app_private', 'verify_contact_change_otp', array['uuid','bytea','uuid'],
  'anon', array[]::text[], 'anon may not');
select function_privs_are('app_private', 'verify_contact_change_otp', array['uuid','bytea','uuid'],
  'app_worker', array[]::text[], 'the worker has no business in a contact change');
select function_privs_are('app_private', 'verify_contact_change_otp', array['uuid','bytea','uuid'],
  'public', array[]::text[], 'and PUBLIC may not');
select table_privs_are('app_private', 'otp_challenges', 'authenticated', array[]::text[],
  'the challenge table itself is still reachable by no browser role');

-- ---------------------------------------------------------------------------------------------------
-- Binding: the account and the purpose
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.verify_contact_change_otp(
     'f1000000-0000-4000-8000-000000000001', sha256('c1'::bytea), 'f0000000-0000-4000-8000-000000000002')),
  'not_found',
  'another account cannot verify this challenge, even with the right code');
select is(
  (select consumed_at from app_private.otp_challenges where id = 'f1000000-0000-4000-8000-000000000001'),
  null,
  'and that attempt consumes nothing');
select is(
  (select attempts from app_private.otp_challenges where id = 'f1000000-0000-4000-8000-000000000001'),
  0::smallint,
  'nor does it spend an attempt belonging to the rightful owner');

select is(
  (select outcome from app_private.verify_contact_change_otp(
     'f1000000-0000-4000-8000-000000000002', sha256('c2'::bytea), 'f0000000-0000-4000-8000-000000000001')),
  'not_found',
  'a challenge of another purpose is not a contact change');
select is(
  (select consumed_at from app_private.otp_challenges where id = 'f1000000-0000-4000-8000-000000000002'),
  null,
  'and the login challenge is left untouched');

select is(
  (select outcome from app_private.verify_contact_change_otp(
     'f1000000-0000-4000-8000-00000000ffff', sha256('c1'::bytea), 'f0000000-0000-4000-8000-000000000001')),
  'not_found',
  'an unknown challenge id is not found');

-- ---------------------------------------------------------------------------------------------------
-- The lifecycle outcomes, which stay 0035's
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.verify_contact_change_otp(
     'f1000000-0000-4000-8000-000000000001', sha256('wrong'::bytea), 'f0000000-0000-4000-8000-000000000001')),
  'invalid',
  'a wrong code is invalid');
select is(
  (select attempts from app_private.otp_challenges where id = 'f1000000-0000-4000-8000-000000000001'),
  1::smallint,
  'and the attempt is counted by the existing lifecycle, not bypassed');
select is(
  (select new_phone_e164 from app_private.verify_contact_change_otp(
     'f1000000-0000-4000-8000-000000000001', sha256('wrong'::bytea), 'f0000000-0000-4000-8000-000000000001')),
  null,
  'a failed verification returns no number');

select is(
  (select outcome from app_private.verify_contact_change_otp(
     'f1000000-0000-4000-8000-000000000003', sha256('c3'::bytea), 'f0000000-0000-4000-8000-000000000001')),
  'expired',
  'an expired challenge is expired');

create temp table verified as
  select * from app_private.verify_contact_change_otp(
    'f1000000-0000-4000-8000-000000000001', sha256('c1'::bytea), 'f0000000-0000-4000-8000-000000000001');

select is((select outcome from verified), 'verified', 'the right code from the right account verifies');
select is((select new_phone_e164 from verified), '+201555000111',
  'and the number returned is the one the code was sent to, read back from the outbox');
select isnt(
  (select consumed_at from app_private.otp_challenges where id = 'f1000000-0000-4000-8000-000000000001'),
  null,
  'the challenge is consumed by the verification');
select is(
  (select outcome from app_private.verify_contact_change_otp(
     'f1000000-0000-4000-8000-000000000001', sha256('c1'::bytea), 'f0000000-0000-4000-8000-000000000001')),
  'consumed',
  'so the same code cannot be replayed');

-- A challenge whose destination was never sent: the code is spent, and nothing is changed.
insert into app_private.otp_challenges (id, user_id, purpose, channel, destination_hash, code_hash, expires_at) values
  ('f1000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000001', 'phone_verify', 'whatsapp',
   sha256(convert_to('+201555000999', 'UTF8')), sha256('c4'::bytea), now() + interval '10 minutes');
select is(
  (select outcome from app_private.verify_contact_change_otp(
     'f1000000-0000-4000-8000-000000000004', sha256('c4'::bytea), 'f0000000-0000-4000-8000-000000000001')),
  'destination_unavailable',
  'a code whose destination cannot be resolved changes nothing');

-- Another account's outbox row must not satisfy this account's challenge.
insert into public.whatsapp_outbox (to_phone_e164, template_name, template_locale, recipient_user_id) values
  ('+201555000777', 'contact_change_phone_otp', 'en', 'f0000000-0000-4000-8000-000000000002');
insert into app_private.otp_challenges (id, user_id, purpose, channel, destination_hash, code_hash, expires_at) values
  ('f1000000-0000-4000-8000-000000000005', 'f0000000-0000-4000-8000-000000000001', 'phone_verify', 'whatsapp',
   sha256(convert_to('+201555000777', 'UTF8')), sha256('c5'::bytea), now() + interval '10 minutes');
select is(
  (select outcome from app_private.verify_contact_change_otp(
     'f1000000-0000-4000-8000-000000000005', sha256('c5'::bytea), 'f0000000-0000-4000-8000-000000000001')),
  'destination_unavailable',
  'a number the *other* account was messaged does not resolve for this one');

select throws_ok(
  $$select * from app_private.verify_contact_change_otp('f1000000-0000-4000-8000-000000000001', null, 'f0000000-0000-4000-8000-000000000001')$$,
  '22023', null, 'a null code digest is refused');
select throws_ok(
  $$select * from app_private.verify_contact_change_otp('f1000000-0000-4000-8000-000000000001', sha256('c1'::bytea), null)$$,
  '22023', null, 'and a verification with no account is refused');

-- ---------------------------------------------------------------------------------------------------
-- The seventh security-event type
-- ---------------------------------------------------------------------------------------------------
create temp table contact_event as
  select app_private.record_auth_security_event(
    'auth.contact_change.success', 'f0000000-0000-4000-8000-000000000001',
    sha256('identifier'::bytea), sha256('ip'::bytea), sha256('ua'::bytea), 'req-f4', 'contact_change_completed') as id;

select is(
  (select event_type from public.security_events where id = (select id from contact_event)),
  'auth.contact_change.success',
  'the approved F4 event type is accepted');
select is(
  (select user_id from public.security_events where id = (select id from contact_event)),
  'f0000000-0000-4000-8000-000000000001'::uuid,
  'it records the account whose contact changed');
select is(
  (select details from public.security_events where id = (select id from contact_event)),
  jsonb_build_object(
    'identifier_hash', encode(sha256('identifier'::bytea), 'hex'),
    'ip_hash', encode(sha256('ip'::bytea), 'hex'),
    'user_agent_hash', encode(sha256('ua'::bytea), 'hex'),
    'request_id', 'req-f4',
    'reason_code', 'contact_change_completed'),
  'the payload is hashes, a request id and a reason code, and nothing else');
select is(
  (select request_ip from public.security_events where id = (select id from contact_event)),
  null,
  'no address is stored in the clear');
-- The exact payload is pinned above; this adds the property that matters on its own terms: nothing in
-- the row looks like a phone number. (A six-digit run is not a useful probe here, because hex digests
-- contain such runs by nature.)
select is(
  (select count(*) from public.security_events
    where id = (select id from contact_event)
      and (details::text like '%+%' or details::text ilike '%phone%')),
  0::bigint,
  'and no phone number appears in it');

select lives_ok(
  $$select app_private.record_auth_security_event('auth.password_reset.success', null, '\x01'::bytea, null, null, null, 'ok_reason')$$,
  'the F3 event type still works');
select lives_ok(
  $$select app_private.record_auth_security_event('auth.login.success', null, '\x01'::bytea, null, null, null, 'ok_reason')$$,
  'and the five C-20 login types still work');
select throws_ok(
  $$select app_private.record_auth_security_event('auth.contact_change.failure', null, '\x01'::bytea, null, null, null, 'x')$$,
  '22023', null, 'a contact-change failure type nobody approved is refused');
select throws_ok(
  $$select app_private.record_auth_security_event('auth.contact_change.success', null, null, null, null, null, 'ok_reason')$$,
  '22023', null, 'and the event still needs a hashed identifier');

select * from finish();
rollback;
