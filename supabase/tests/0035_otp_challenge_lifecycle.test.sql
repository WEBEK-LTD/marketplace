-- pgTAP — migration 0035: the OTP challenge lifecycle.
--
-- The approved limits are exercised by driving them to their exact boundary rather than by reading the
-- function source, and the privilege boundary is tested by observing the real catalogue. The repaired
-- `rate_limit_hit` is covered here because 0004 never invoked it: it had never run once.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(60);

insert into auth.users (id, email) values
  ('b0000000-0000-4000-8000-000000000001', 'otp-subject@test.invalid');

-- ---------------------------------------------------------------------------------------------------
-- The repaired counter (0004's version raised 42702 on every call)
-- ---------------------------------------------------------------------------------------------------
select lives_ok(
  $$select app_private.rate_limit_hit('otp.test.repair', sha256('r'::bytea), interval '1 hour', 3)$$,
  'rate_limit_hit runs at all, which it could not before this migration');

select is(app_private.rate_limit_hit('otp.test.window', sha256('w'::bytea), interval '1 hour', 3), true,
  'hit 1 of 3 is within the limit');
select is(app_private.rate_limit_hit('otp.test.window', sha256('w'::bytea), interval '1 hour', 3), true,
  'hit 2 of 3 is within the limit');
select is(app_private.rate_limit_hit('otp.test.window', sha256('w'::bytea), interval '1 hour', 3), true,
  'hit 3 of 3 is the last one allowed');
select is(app_private.rate_limit_hit('otp.test.window', sha256('w'::bytea), interval '1 hour', 3), false,
  'hit 4 is refused, so the boundary is exact');
select is(app_private.rate_limit_hit('otp.test.window', sha256('other'::bytea), interval '1 hour', 3), true,
  'a different subject has its own counter');
select throws_ok(
  $$select app_private.rate_limit_hit('otp.test.bad', sha256('x'::bytea), interval '1 hour', 0)$$,
  null, null, 'a limit below one is refused');

-- ---------------------------------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'issue_otp_challenge',
  array['text','text','bytea','bytea','text','text','text','uuid','inet','bytea'],
  'app_private.issue_otp_challenge exists');
select has_function('app_private', 'verify_otp_challenge', array['uuid','bytea'],
  'app_private.verify_otp_challenge exists');
select has_function('app_private', 'begin_otp_delivery', array['uuid'],
  'app_private.begin_otp_delivery exists');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('issue_otp_challenge','verify_otp_challenge','begin_otp_delivery','rate_limit_hit')
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'every OTP function is SECURITY DEFINER with a pinned search_path');

select function_privs_are('app_private', 'issue_otp_challenge',
  array['text','text','bytea','bytea','text','text','text','uuid','inet','bytea'], 'app_system', array['EXECUTE'],
  'app_system may issue a challenge');
select function_privs_are('app_private', 'issue_otp_challenge',
  array['text','text','bytea','bytea','text','text','text','uuid','inet','bytea'], 'authenticated', array[]::text[],
  'authenticated may not, so a browser cannot mint an OTP');
select function_privs_are('app_private', 'issue_otp_challenge',
  array['text','text','bytea','bytea','text','text','text','uuid','inet','bytea'], 'anon', array[]::text[],
  'anon may not');
select function_privs_are('app_private', 'verify_otp_challenge', array['uuid','bytea'], 'authenticated', array[]::text[],
  'authenticated may not verify directly either');
select function_privs_are('app_private', 'verify_otp_challenge', array['uuid','bytea'], 'app_worker', array[]::text[],
  'the worker has no business verifying an OTP');
select function_privs_are('app_private', 'issue_otp_challenge',
  array['text','text','bytea','bytea','text','text','text','uuid','inet','bytea'], 'public', array[]::text[],
  'and PUBLIC may not');

select table_privs_are('app_private', 'otp_challenges', 'app_system', array[]::text[],
  'app_system still holds no privilege on otp_challenges: the function is the only door');
select table_privs_are('app_private', 'otp_challenges', 'authenticated', array[]::text[],
  'authenticated still holds no privilege on otp_challenges');

-- ---------------------------------------------------------------------------------------------------
-- The approved resend schedule (C-10)
-- ---------------------------------------------------------------------------------------------------
select is(app_private.otp_resend_cooldown(1::smallint), interval '60 seconds', 'after one send: 60 s');
select is(app_private.otp_resend_cooldown(2::smallint), interval '120 seconds', 'after two sends: 120 s');
select is(app_private.otp_resend_cooldown(3::smallint), interval '300 seconds', 'after three sends: 300 s');
select is(app_private.otp_resend_cooldown(4::smallint), interval '300 seconds', 'and it stays at 300 s');
select is(app_private.otp_resend_cooldown(50::smallint), interval '300 seconds',
  'the tier never resets, however many resends happen');

-- ---------------------------------------------------------------------------------------------------
-- Issuing
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.issue_otp_challenge('phone_verify','whatsapp',
     sha256('d1'::bytea), sha256('c1'::bytea), '+201000000001','otp_login','en',
     'b0000000-0000-4000-8000-000000000001', '198.51.100.1'::inet, sha256('ip1'::bytea))),
  'issued', 'the first send is issued');

select is((select count(*) from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  1::bigint, 'exactly one challenge row exists');
select is((select send_count from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  1::smallint, 'its send count starts at one');
select is(
  (select round(extract(epoch from (expires_at - created_at)))::integer
     from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  600, 'and it expires after the approved ten minutes');

select is((select count(*) from public.whatsapp_outbox), 1::bigint, 'one message is queued');
select is((select variables from public.whatsapp_outbox limit 1), '{}'::jsonb,
  'the queued message carries no variables, so the code never reaches the database');

select is(
  (select outcome from app_private.issue_otp_challenge('phone_verify','whatsapp',
     sha256('d1'::bytea), sha256('c2'::bytea), '+201000000001','otp_login','en',
     null, null, sha256('ip1'::bytea))),
  'cooldown', 'an immediate resend is refused by the cooldown');
select is((select count(*) from public.whatsapp_outbox), 1::bigint,
  'and nothing further is queued, so the provider is never reached');

-- Age the send past the first tier and resend.
update app_private.otp_challenges set last_sent_at = now() - interval '61 seconds'
 where destination_hash = sha256('d1'::bytea);
select is(
  (select outcome from app_private.issue_otp_challenge('phone_verify','whatsapp',
     sha256('d1'::bytea), sha256('c2'::bytea), '+201000000001','otp_login','en',
     null, null, sha256('ip1'::bytea))),
  'issued', 'once the cooldown has elapsed the resend is issued');
select is((select send_count from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  2::smallint, 'the send count advances rather than restarting');
select is((select count(*) from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  1::bigint, 'a resend reuses the same challenge instead of creating a parallel one');

-- A resend must replace the stored digest, or the old code would still verify.
select isnt(
  (select code_hash from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  sha256('c1'::bytea),
  'the resend replaced the stored digest, so the superseded code no longer verifies');
select is(
  (select code_hash from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  sha256('c2'::bytea),
  'and the digest is the one the resend supplied');
select is(
  (select app_private.verify_otp_challenge(id, sha256('c1'::bytea))
     from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  'invalid', 'submitting the superseded code is refused');
update app_private.otp_challenges set attempts = 0 where destination_hash = sha256('d1'::bytea);

-- ---------------------------------------------------------------------------------------------------
-- Attempts are not reset by a resend
-- ---------------------------------------------------------------------------------------------------
update app_private.otp_challenges set attempts = 3, last_sent_at = now() - interval '600 seconds'
 where destination_hash = sha256('d1'::bytea);
select is(
  (select outcome from app_private.issue_otp_challenge('phone_verify','whatsapp',
     sha256('d1'::bytea), sha256('c3'::bytea), '+201000000001','otp_login','en', null, null, null)),
  'issued', 'a further resend is issued');
select is((select attempts from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  3::smallint,
  'and the failed-attempt count survives it, so resending cannot buy five more guesses');

-- ---------------------------------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------------------------------
update app_private.otp_challenges set attempts = 0 where destination_hash = sha256('d1'::bytea);

select is(
  (select app_private.verify_otp_challenge(id, sha256('wrong'::bytea))
     from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  'invalid', 'a wrong code is invalid');
select is((select attempts from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  1::smallint, 'and the attempt is counted');

select is(
  (select app_private.verify_otp_challenge(id, sha256('c3'::bytea))
     from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  'verified', 'the correct code verifies');
select isnt(
  (select consumed_at from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  null, 'and the challenge is consumed');
select is(
  (select app_private.verify_otp_challenge(id, sha256('c3'::bytea))
     from app_private.otp_challenges where destination_hash = sha256('d1'::bytea)),
  'consumed', 'replaying the same correct code is refused');

select is(app_private.verify_otp_challenge('00000000-0000-4000-8000-00000000dead'::uuid, sha256('x'::bytea)),
  'not_found', 'an unknown challenge is not found');

-- Expiry and the attempt ceiling, on fresh rows.
-- Backdated the way a real expired challenge is: created ten minutes ago, expired a second ago.
insert into app_private.otp_challenges (purpose, channel, destination_hash, code_hash, created_at, expires_at, send_count, last_sent_at)
values ('phone_verify','whatsapp', sha256('d2'::bytea), sha256('c'::bytea),
        now() - interval '11 minutes', now() - interval '1 second', 1, now() - interval '11 minutes');
select is(
  (select app_private.verify_otp_challenge(id, sha256('c'::bytea))
     from app_private.otp_challenges where destination_hash = sha256('d2'::bytea)),
  'expired', 'an expired challenge is refused even with the right code');

insert into app_private.otp_challenges (purpose, channel, destination_hash, code_hash, expires_at, attempts, send_count, last_sent_at)
values ('phone_verify','whatsapp', sha256('d3'::bytea), sha256('c'::bytea), now() + interval '5 minutes', 5, 1, now());
select is(
  (select app_private.verify_otp_challenge(id, sha256('c'::bytea))
     from app_private.otp_challenges where destination_hash = sha256('d3'::bytea)),
  'too_many_attempts', 'the fifth failed attempt closes the challenge, right code or not');

select throws_ok(
  $$select app_private.verify_otp_challenge('00000000-0000-4000-8000-00000000dead'::uuid, null)$$,
  '22023', null, 'verifying without a digest is refused');

-- ---------------------------------------------------------------------------------------------------
-- Rate limits: exact boundaries
-- ---------------------------------------------------------------------------------------------------
-- Five sends per destination per hour. The first is spent above, so drive a clean destination here and
-- clear the cooldown between sends.
do $$
declare i integer;
begin
  for i in 1..5 loop
    perform app_private.issue_otp_challenge('recovery','whatsapp', sha256('d4'::bytea), sha256('c'::bytea),
      '+201000000004','otp_login','en', null, null, null);
    update app_private.otp_challenges set last_sent_at = now() - interval '1 hour'
     where destination_hash = sha256('d4'::bytea);
  end loop;
end;
$$;
select is(
  (select outcome from app_private.issue_otp_challenge('recovery','whatsapp',
     sha256('d4'::bytea), sha256('c'::bytea), '+201000000004','otp_login','en', null, null, null)),
  'rate_limited_destination_hour', 'the sixth send in an hour to one destination is refused');

select is(
  (select hits from app_private.rate_limits
    where bucket = 'otp.send.destination.hour' and subject_hash = sha256('d4'::bytea)),
  6, 'the counter recorded every attempt, including the refused one');

-- Twenty per IP per hour: spend the budget on the IP bucket directly, then show a send is refused.
do $$
declare i integer;
begin
  for i in 1..20 loop
    perform app_private.rate_limit_hit('otp.send.ip.hour', sha256('ip9'::bytea), interval '1 hour', 20);
  end loop;
end;
$$;
select is(
  (select outcome from app_private.issue_otp_challenge('recovery','whatsapp',
     sha256('d5'::bytea), sha256('c'::bytea), '+201000000005','otp_login','en', null, null, sha256('ip9'::bytea))),
  'rate_limited_ip_hour', 'the twenty-first send from one IP in an hour is refused');

-- Ten per destination per day.
do $$
declare i integer;
begin
  for i in 1..10 loop
    perform app_private.rate_limit_hit('otp.send.destination.day', sha256('d6'::bytea), interval '1 day', 10);
  end loop;
end;
$$;
select is(
  (select outcome from app_private.issue_otp_challenge('recovery','whatsapp',
     sha256('d6'::bytea), sha256('c'::bytea), '+201000000006','otp_login','en', null, null, null)),
  'rate_limited_destination_day', 'the eleventh send in a day to one destination is refused');

-- ---------------------------------------------------------------------------------------------------
-- Delivery claiming
-- ---------------------------------------------------------------------------------------------------
-- A dedicated row with a known id: selecting "the first row" across several statements is not stable
-- once many messages share a timestamp, and this must test one row's transitions, not three rows'.
insert into public.whatsapp_outbox (id, to_phone_e164, template_name, template_locale)
values ('cccccccc-0000-4000-8000-00000000000c', '+201000000009', 'otp_login', 'en');

select is(app_private.begin_otp_delivery('cccccccc-0000-4000-8000-00000000000c'::uuid),
  true, 'a queued message can be claimed for sending');
select is((select status from public.whatsapp_outbox where id = 'cccccccc-0000-4000-8000-00000000000c'),
  'sending', 'and it moves to sending');
select is((select attempts from public.whatsapp_outbox where id = 'cccccccc-0000-4000-8000-00000000000c'),
  1, 'the attempt is counted');
select is(app_private.begin_otp_delivery('cccccccc-0000-4000-8000-00000000000c'::uuid),
  false, 'claiming it twice fails, so it is never sent twice');
select is(
  app_private.settle_outbox_message('whatsapp', 'cccccccc-0000-4000-8000-00000000000c'::uuid, 'sent', 'wam-1', null, null),
  true, 'and the existing settle function records the outcome');
select is((select status from public.whatsapp_outbox where id = 'cccccccc-0000-4000-8000-00000000000c'),
  'sent', 'leaving the message sent');

-- ---------------------------------------------------------------------------------------------------
-- The security contract still passes
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'migration 0035 introduces no security contract problem');

select * from finish();
rollback;
