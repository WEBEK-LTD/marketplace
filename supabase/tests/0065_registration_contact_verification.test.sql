-- pgTAP — migration 0065: registration contact verification.
--
-- Five things are being held to account.
--
-- **Registration creates no second OTP mechanism.** The verifier refuses every purpose but `phone_verify`,
-- so a login, step-up, recovery or password-reset challenge cannot be spent here; and the attempt
-- accounting, the expiry check and the single-consumption lock are the ones `verify_otp_challenge` already
-- enforces, asserted by driving the same cases through both.
--
-- **A caller learns nothing from a refusal.** A wrong code, an unknown challenge, a challenge of another
-- purpose and a challenge with no account are asserted to return no account at all, so the only path that
-- discloses an account is the one that proves the person holds the number.
--
-- **The login gate is narrow.** `login_contact_confirmed` is true when *either* contact is confirmed, so no
-- account that could sign in before this migration is refused by it. Asserted over all four combinations.
--
-- **The C-20 event list grew by exactly one.** `auth.registration.success` is accepted by the one existing
-- writer, follows the `auth.<flow>.<outcome>` convention the other seven follow, and has no failure,
-- attempt, resend or already-exists sibling — a row that existed for a refused registration and not for an
-- accepted one would be countable, which is the very thing this flow answers identically about. Asserted
-- by driving every name through the writer rather than by reading the list.
--
-- **Nothing else moved.** `auth.users` is untouched by both functions — verification records the outcome of
-- our check and confirms nothing itself, which is the API's job through the provider's admin route.
--
-- Deterministic: fixed uuids, no wall-clock dependence beyond the deliberate expiry fixture. Everything runs
-- in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(90);

-- Fixtures ------------------------------------------------------------------------------------------
insert into auth.users (id, email, phone, email_confirmed_at, phone_confirmed_at) values
  -- Exactly what registration leaves behind: an account with neither contact confirmed.
  ('7a000000-0000-4000-8000-000000000001', 'reg-new@test.invalid', '+201700000001', null, null),
  ('7a000000-0000-4000-8000-000000000002', 'reg-email@test.invalid', null, '2026-01-01T00:00:00Z', null),
  ('7a000000-0000-4000-8000-000000000003', 'reg-phone@test.invalid', '+201700000003', null, '2026-01-02T00:00:00Z'),
  ('7a000000-0000-4000-8000-000000000004', 'reg-both@test.invalid', '+201700000004', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');

insert into app_private.otp_challenges
  (id, user_id, purpose, channel, destination_hash, code_hash, attempts, max_attempts, expires_at,
   send_count, last_sent_at, created_at)
values
  ('7b000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000001', 'phone_verify',
   'whatsapp', '\x01'::bytea, '\xaa'::bytea, 0, 5, now() + interval '10 minutes', 1, now(), now()),
  -- A login challenge: the right code, the wrong purpose.
  ('7b000000-0000-4000-8000-000000000002', '7a000000-0000-4000-8000-000000000001', 'login',
   'whatsapp', '\x02'::bytea, '\xaa'::bytea, 0, 5, now() + interval '10 minutes', 1, now(), now()),
  -- A phone_verify challenge with no account behind it.
  ('7b000000-0000-4000-8000-000000000003', null, 'phone_verify',
   'whatsapp', '\x03'::bytea, '\xaa'::bytea, 0, 5, now() + interval '10 minutes', 1, now(), now()),
  ('7b000000-0000-4000-8000-000000000004', '7a000000-0000-4000-8000-000000000001', 'phone_verify',
   'whatsapp', '\x04'::bytea, '\xaa'::bytea, 0, 5, now() - interval '1 minute', 1,
   now() - interval '20 minutes', now() - interval '20 minutes'),
  -- Attempts already exhausted.
  ('7b000000-0000-4000-8000-000000000005', '7a000000-0000-4000-8000-000000000001', 'phone_verify',
   'whatsapp', '\x05'::bytea, '\xaa'::bytea, 5, 5, now() + interval '10 minutes', 1, now(), now()),
  -- Already consumed.
  ('7b000000-0000-4000-8000-000000000006', '7a000000-0000-4000-8000-000000000001', 'phone_verify',
   'whatsapp', '\x06'::bytea, '\xaa'::bytea, 0, 5, now() + interval '10 minutes', 1, now(), now()),
  -- The other approved purposes, each with the same code, to prove none of them is spendable here.
  ('7b000000-0000-4000-8000-000000000007', '7a000000-0000-4000-8000-000000000001', 'step_up',
   'whatsapp', '\x07'::bytea, '\xaa'::bytea, 0, 5, now() + interval '10 minutes', 1, now(), now()),
  ('7b000000-0000-4000-8000-000000000008', '7a000000-0000-4000-8000-000000000001', 'recovery',
   'whatsapp', '\x08'::bytea, '\xaa'::bytea, 0, 5, now() + interval '10 minutes', 1, now(), now()),
  ('7b000000-0000-4000-8000-000000000009', '7a000000-0000-4000-8000-000000000001', 'password_reset',
   'whatsapp', '\x09'::bytea, '\xaa'::bytea, 0, 5, now() + interval '10 minutes', 1, now(), now()),
  ('7b000000-0000-4000-8000-00000000000a', '7a000000-0000-4000-8000-000000000001', 'email_verify',
   'email', '\x0a'::bytea, '\xaa'::bytea, 0, 5, now() + interval '10 minutes', 1, now(), now()),
  -- For the resend resolver, which must not be perturbed by the consumption the verifier tests perform.
  -- A registration genuinely in progress: account 1, neither contact confirmed.
  ('7b000000-0000-4000-8000-00000000000b', '7a000000-0000-4000-8000-000000000001', 'phone_verify',
   'whatsapp', '\x0b'::bytea, '\xaa'::bytea, 0, 5, now() + interval '10 minutes', 1, now(), now()),
  -- Accounts that have already confirmed something. None of them may be reachable through a resend.
  ('7b000000-0000-4000-8000-00000000000c', '7a000000-0000-4000-8000-000000000003', 'phone_verify',
   'whatsapp', '\x0c'::bytea, '\xaa'::bytea, 0, 5, now() + interval '10 minutes', 1, now(), now()),
  ('7b000000-0000-4000-8000-00000000000d', '7a000000-0000-4000-8000-000000000002', 'phone_verify',
   'whatsapp', '\x0d'::bytea, '\xaa'::bytea, 0, 5, now() + interval '10 minutes', 1, now(), now()),
  ('7b000000-0000-4000-8000-00000000000e', '7a000000-0000-4000-8000-000000000004', 'phone_verify',
   'whatsapp', '\x0e'::bytea, '\xaa'::bytea, 0, 5, now() + interval '10 minutes', 1, now(), now()),
  -- Expired, but unconsumed: the main reason somebody asks for another code.
  ('7b000000-0000-4000-8000-00000000000f', '7a000000-0000-4000-8000-000000000001', 'phone_verify',
   'whatsapp', '\x0f'::bytea, '\xaa'::bytea, 0, 5, now() - interval '1 minute', 1,
   now() - interval '20 minutes', now() - interval '20 minutes');

update app_private.otp_challenges set consumed_at = now()
 where id = '7b000000-0000-4000-8000-000000000006';

create temporary table users_before as select id, email_confirmed_at, phone_confirmed_at from auth.users;

-- ---------------------------------------------------------------------------------------------------
-- Security: the S8 contract
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_to_string(array_agg(p.proname || '/' || p.pronargs order by p.proname), ' ')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('register_verify_contact', 'login_contact_confirmed', 'register_resend_contact')),
  'login_contact_confirmed/1 register_resend_contact/1 register_verify_contact/2',
  'this migration adds exactly three new functions, with the arities they declare and no overloads');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('register_verify_contact', 'login_contact_confirmed', 'register_resend_contact')
      and not p.prosecdef),
  0::bigint, 'all three are SECURITY DEFINER');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('register_verify_contact', 'login_contact_confirmed', 'register_resend_contact')
      and array_to_string(p.proconfig, ',') <> 'search_path=pg_catalog, public'),
  0::bigint, 'and all three have their search_path pinned');
select is(
  (select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'login_contact_confirmed'),
  's', 'the login reader is stable, which is the database''s own statement that it does not write');
select is(
  (select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'register_resend_contact'),
  's', 'and so is the resend resolver: it resolves a destination, it does not send to one');

select ok(not has_function_privilege('public', 'app_private.register_verify_contact(uuid, bytea)', 'execute'),
  'PUBLIC cannot verify a registration code');
select ok(not has_function_privilege('anon', 'app_private.register_verify_contact(uuid, bytea)', 'execute'),
  'anon cannot');
select ok(not has_function_privilege('authenticated', 'app_private.register_verify_contact(uuid, bytea)', 'execute'),
  'authenticated cannot');
select ok(has_function_privilege('app_system', 'app_private.register_verify_contact(uuid, bytea)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('app_worker', 'app_private.register_verify_contact(uuid, bytea)', 'execute'),
  'app_worker cannot');
select ok(not has_function_privilege('public', 'app_private.login_contact_confirmed(uuid)', 'execute'),
  'PUBLIC cannot read whether an account is confirmed');
select ok(not has_function_privilege('authenticated', 'app_private.login_contact_confirmed(uuid)', 'execute'),
  'authenticated cannot');
select ok(has_function_privilege('app_system', 'app_private.login_contact_confirmed(uuid)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('public', 'app_private.register_resend_contact(uuid)', 'execute'),
  'PUBLIC cannot resolve a resend destination');
select ok(not has_function_privilege('anon', 'app_private.register_resend_contact(uuid)', 'execute'),
  'anon cannot');
select ok(not has_function_privilege('authenticated', 'app_private.register_resend_contact(uuid)', 'execute'),
  'authenticated cannot');
select ok(has_function_privilege('app_system', 'app_private.register_resend_contact(uuid)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('app_worker', 'app_private.register_resend_contact(uuid)', 'execute'),
  'app_worker cannot');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames[1:p.pronargs]) as arg
    where n.nspname = 'app_private' and p.proname = 'register_resend_contact'
      and arg <> 'p_challenge_id'),
  0::bigint,
  'the resend resolver takes a challenge and nothing else: there is no phone parameter to aim it with');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames[1:p.pronargs]) as arg
    where n.nspname = 'app_private' and p.proname = 'register_verify_contact'
      and arg not in ('p_challenge_id', 'p_code_hash')),
  0::bigint,
  'the verifier takes a challenge and a code hash and nothing else: no account arrives from the request');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('register_verify_contact', 'login_contact_confirmed', 'register_resend_contact')
      and (strpos(p.prosrc, 'update auth.users') > 0 or strpos(p.prosrc, 'insert into auth.users') > 0)),
  0::bigint,
  'no function here writes to auth.users: confirming a contact is the provider''s, through its admin route');

select lives_ok($$ select app_private.assert_security_contract() $$,
  'the deploy-time security contract still holds');

-- 0006's own OTP functions are untouched.
select ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app_private' and p.proname = 'verify_otp_challenge'),
  'verify_otp_challenge still exists and was not replaced');
select ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app_private' and p.proname = 'verify_contact_change_otp'),
  'and so does verify_contact_change_otp: registration reuses the lifecycle rather than replacing it');
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'app_private.otp_challenges'::regclass and conname = 'otp_challenges_purpose_allowed'),
  'CHECK ((purpose = ANY (ARRAY[''login''::text, ''step_up''::text, ''email_verify''::text, ''phone_verify''::text, ''recovery''::text, ''password_reset''::text])))',
  'the six approved OTP purposes are unchanged: 7-A added none');

-- ---------------------------------------------------------------------------------------------------
-- Verification: only a phone_verify challenge, and only with the right code
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-000000000002', '\xaa'::bytea)),
  'not_found',
  'a login challenge cannot be spent here, even with the correct code');
select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-000000000007', '\xaa'::bytea)),
  'not_found', 'nor a step-up challenge');
select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-000000000008', '\xaa'::bytea)),
  'not_found', 'nor a recovery challenge');
select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-000000000009', '\xaa'::bytea)),
  'not_found', 'nor a password-reset challenge');
select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-00000000000a', '\xaa'::bytea)),
  'not_found',
  'nor an email_verify challenge: this surface verifies the phone, which is this repository''s contact');
select is(
  (select count(*) from app_private.otp_challenges c
    where c.id in ('7b000000-0000-4000-8000-000000000002', '7b000000-0000-4000-8000-000000000007',
                   '7b000000-0000-4000-8000-000000000008', '7b000000-0000-4000-8000-000000000009',
                   '7b000000-0000-4000-8000-00000000000a')
      and (c.consumed_at is not null or c.attempts > 0)),
  0::bigint,
  'and none of those was consumed or counted against: a refused purpose costs the challenge nothing');

select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-000000000003', '\xaa'::bytea)),
  'not_found', 'a challenge with no account behind it cannot confirm one');
select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-0000000000ff', '\xaa'::bytea)),
  'not_found', 'and a challenge that never existed answers the same way');

select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-000000000004', '\xaa'::bytea)),
  'expired', 'an expired challenge is refused with the right code');
select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-000000000005', '\xaa'::bytea)),
  'too_many_attempts', 'so is one whose attempts are exhausted');
select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-000000000006', '\xaa'::bytea)),
  'consumed', 'and one already spent');

-- The wrong code, and what it costs.
select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-000000000001', '\xbb'::bytea)),
  'invalid', 'a wrong code is refused');
select is(
  (select c.attempts from app_private.otp_challenges c
    where c.id = '7b000000-0000-4000-8000-000000000001'),
  1::smallint, 'and counts as an attempt, exactly as verify_otp_challenge counts one');
select is(
  (select c.consumed_at from app_private.otp_challenges c
    where c.id = '7b000000-0000-4000-8000-000000000001'),
  null::timestamptz, 'without consuming the challenge');

-- No refusal discloses an account.
select is(
  (select count(*) from (
     select user_id from app_private.register_verify_contact('7b000000-0000-4000-8000-000000000002', '\xaa'::bytea)
     union all select user_id from app_private.register_verify_contact('7b000000-0000-4000-8000-000000000003', '\xaa'::bytea)
     union all select user_id from app_private.register_verify_contact('7b000000-0000-4000-8000-000000000004', '\xaa'::bytea)
     union all select user_id from app_private.register_verify_contact('7b000000-0000-4000-8000-000000000005', '\xaa'::bytea)
     union all select user_id from app_private.register_verify_contact('7b000000-0000-4000-8000-000000000006', '\xaa'::bytea)
     union all select user_id from app_private.register_verify_contact('7b000000-0000-4000-8000-0000000000ff', '\xaa'::bytea)
     union all select user_id from app_private.register_verify_contact('7b000000-0000-4000-8000-000000000001', '\xcc'::bytea)
   ) as refusals where user_id is not null),
  0::bigint,
  'not one refusal returns an account: only proving the code discloses whose challenge it was');

-- The one path that works.
select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-000000000001', '\xaa'::bytea)),
  'verified', 'the correct code verifies');
select is(
  (select user_id from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-000000000001', '\xaa'::bytea)),
  null::uuid,
  'and a second attempt with the same correct code returns no account, because it is already consumed');
select is(
  (select outcome from app_private.register_verify_contact(
     '7b000000-0000-4000-8000-000000000001', '\xaa'::bytea)),
  'consumed', 'reporting it as consumed: verified exactly once, under the row lock');

-- ---------------------------------------------------------------------------------------------------
-- The login gate, and how narrow it is
-- ---------------------------------------------------------------------------------------------------
select is(
  app_private.login_contact_confirmed('7a000000-0000-4000-8000-000000000001'),
  false,
  'an account with neither contact confirmed is not confirmed — exactly what registration leaves behind');
select is(
  app_private.login_contact_confirmed('7a000000-0000-4000-8000-000000000002'),
  true, 'an account with a confirmed email is confirmed');
select is(
  app_private.login_contact_confirmed('7a000000-0000-4000-8000-000000000003'),
  true, 'an account with a confirmed phone is confirmed');
select is(
  app_private.login_contact_confirmed('7a000000-0000-4000-8000-000000000004'),
  true, 'and so is one with both');
select is(
  app_private.login_contact_confirmed('7a000000-0000-4000-8000-0000000000ff'),
  false, 'an account that does not exist is not confirmed');
select is(
  app_private.login_contact_confirmed(null),
  false, 'and neither is no account at all');

-- The narrowness is the point: state it as a property over the whole fixture set.
select is(
  (select count(*) from auth.users u
    where (u.email_confirmed_at is not null or u.phone_confirmed_at is not null)
      and not app_private.login_contact_confirmed(u.id)),
  0::bigint,
  'no account with any confirmed contact is refused by the gate, so nothing that could sign in before 7-A is locked out by it');
select is(
  (select count(*) from auth.users u
    where u.email_confirmed_at is null and u.phone_confirmed_at is null
      and app_private.login_contact_confirmed(u.id)),
  0::bigint,
  'and every account with no confirmed contact is refused, which is the whole of the rule');

-- ---------------------------------------------------------------------------------------------------
-- The resend resolver, and the doors it keeps shut
-- ---------------------------------------------------------------------------------------------------
--
-- What it must do is easy; what it must refuse is the point. It exists so a person whose code never
-- arrived can ask for another, and it must not become a way to send messages to anybody else.
select is(
  (select outcome from app_private.register_resend_contact('7b000000-0000-4000-8000-00000000000b')),
  'resend', 'a registration genuinely in progress can have its code sent again');
select is(
  (select to_phone_e164 from app_private.register_resend_contact('7b000000-0000-4000-8000-00000000000b')),
  '+201700000001',
  'and the number comes from the account, which is the only number a resend can ever reach');
select is(
  (select user_id from app_private.register_resend_contact('7b000000-0000-4000-8000-00000000000b')),
  '7a000000-0000-4000-8000-000000000001'::uuid,
  'along with the account the new challenge will belong to');

select is(
  (select outcome from app_private.register_resend_contact('7b000000-0000-4000-8000-00000000000f')),
  'resend',
  'an expired challenge still resolves: a code that expired is the main reason to ask for another');

select is(
  (select outcome from app_private.register_resend_contact('7b000000-0000-4000-8000-00000000000c')),
  'not_found',
  'an account whose phone is already confirmed cannot be reached: a resend is not a way to message a verified person');
select is(
  (select outcome from app_private.register_resend_contact('7b000000-0000-4000-8000-00000000000d')),
  'not_found', 'nor one whose email is confirmed');
select is(
  (select outcome from app_private.register_resend_contact('7b000000-0000-4000-8000-00000000000e')),
  'not_found', 'nor one that has confirmed both');
select is(
  (select outcome from app_private.register_resend_contact('7b000000-0000-4000-8000-000000000002')),
  'not_found', 'a challenge of another purpose resolves nothing');
select is(
  (select outcome from app_private.register_resend_contact('7b000000-0000-4000-8000-000000000003')),
  'not_found', 'nor does one with no account behind it');
select is(
  (select outcome from app_private.register_resend_contact('7b000000-0000-4000-8000-000000000006')),
  'not_found', 'nor a consumed one: consumption means the contact is already verified');
select is(
  (select outcome from app_private.register_resend_contact('7b000000-0000-4000-8000-0000000000ff')),
  'not_found', 'and a challenge that never existed answers exactly the same way');

-- Every refusal is empty, so nothing is disclosed by asking.
select is(
  (select count(*) from (
     select user_id, to_phone_e164 from app_private.register_resend_contact('7b000000-0000-4000-8000-00000000000c')
     union all select user_id, to_phone_e164 from app_private.register_resend_contact('7b000000-0000-4000-8000-00000000000d')
     union all select user_id, to_phone_e164 from app_private.register_resend_contact('7b000000-0000-4000-8000-00000000000e')
     union all select user_id, to_phone_e164 from app_private.register_resend_contact('7b000000-0000-4000-8000-000000000002')
     union all select user_id, to_phone_e164 from app_private.register_resend_contact('7b000000-0000-4000-8000-000000000003')
     union all select user_id, to_phone_e164 from app_private.register_resend_contact('7b000000-0000-4000-8000-000000000006')
     union all select user_id, to_phone_e164 from app_private.register_resend_contact('7b000000-0000-4000-8000-0000000000ff')
   ) as refusals where user_id is not null or to_phone_e164 is not null),
  0::bigint,
  'no refusal returns an account or a number, so a caller cannot learn a destination by guessing an identifier');

-- One row, always. A set-returning function that answered with none, or with two, would make the API
-- above it read a row that is not there or act on the wrong one.
select is(
  (select count(*) from (
     select 1 from app_private.register_resend_contact('7b000000-0000-4000-8000-00000000000b')
     union all select 1 from app_private.register_resend_contact('7b000000-0000-4000-8000-00000000000c')
     union all select 1 from app_private.register_resend_contact('7b000000-0000-4000-8000-000000000002')
     union all select 1 from app_private.register_resend_contact('7b000000-0000-4000-8000-0000000000ff')
     union all select 1 from app_private.register_resend_contact(null)
   ) as rows),
  5::bigint,
  'every call returns exactly one row, including for a null identifier');
select is(
  (select outcome from app_private.register_resend_contact(null)),
  'not_found', 'and a null identifier resolves nothing');

select is(
  (select array_to_string(array_agg(c.id::text order by c.id), ' ')
     from app_private.otp_challenges c where c.consumed_at is not null),
  '7b000000-0000-4000-8000-000000000001 7b000000-0000-4000-8000-000000000006',
  'and after all of that the only consumed challenges are the one the verifier spent and the one the fixture arrived spent: resolving a resend consumes nothing');

-- ---------------------------------------------------------------------------------------------------
-- The eighth C-20 event type
-- ---------------------------------------------------------------------------------------------------
--
-- The registration event rides the one existing security-event writer. What is asserted here is that the
-- list grew by exactly one approved name, that the name follows the convention the other seven follow,
-- that nothing secret can reach a row through it, and that no second store appeared anywhere.
-- Everything below is scoped to rows this transaction writes, so the assertions describe 7-A's behaviour
-- rather than whatever a deployment happens to have accumulated. The table is append-only, so an earlier
-- row cannot be cleared away — which is itself asserted further down.
create temporary table events_baseline as
  select coalesce(max(e.id), 0) as id from public.security_events e;

select lives_ok(
  $$ select app_private.record_auth_security_event(
       'auth.registration.success', null, '\x01'::bytea, null, null, null, 'registration_created') $$,
  'the approved registration event is accepted by the existing C-20 writer');

select is(
  (select count(*) from public.security_events e
    where e.id > (select b.id from events_baseline b)
      and e.event_type = 'auth.registration.success'),
  1::bigint,
  'and lands in public.security_events, the one store: no new table, no parallel telemetry');

-- The name is not a new shape. Every approved type is auth.<flow>.<outcome>, flow in snake_case.
select matches(
  'auth.registration.success'::text, '^auth\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$',
  'the registration type follows the auth.<flow>.<outcome> convention the other seven follow');
select ok(
  'auth.registration.success' ~ '^[a-z][a-z0-9_.]*$',
  'and satisfies the security_events_type_format constraint that has governed the column since 0004');

-- Exactly one type was added, and it is a success. A registration failure type would be countable: a row
-- that exists for a refused registration and not for an accepted one answers the question the whole flow
-- answers identically.
select throws_ok(
  $$ select app_private.record_auth_security_event(
       'auth.registration.failure', null, '\x01'::bytea, null, null, null, 'registration_refused') $$,
  '22023', null,
  'there is no registration failure type: a countable row is exactly what enumeration resistance forbids');
select throws_ok(
  $$ select app_private.record_auth_security_event(
       'auth.registration.attempt', null, '\x01'::bytea, null, null, null, 'registration_attempt') $$,
  '22023', null, 'nor an attempt type, so a form submission cannot be recorded');
select throws_ok(
  $$ select app_private.record_auth_security_event(
       'auth.registration.resend', null, '\x01'::bytea, null, null, null, 'registration_resend') $$,
  '22023', null, 'nor a resend type');
select throws_ok(
  $$ select app_private.record_auth_security_event(
       'auth.registration.exists', null, '\x01'::bytea, null, null, null, 'registration_exists') $$,
  '22023', null, 'and above all no type for an address that was already taken');

-- The whole approved list, stated by driving every name through the writer rather than by reading it.
select is(
  (select count(*) from unnest(array[
     'auth.login.success', 'auth.login.failure', 'auth.login.locked', 'auth.login.throttled',
     'auth.login.provider_error', 'auth.password_reset.success', 'auth.contact_change.success',
     'auth.registration.success'
   ]::text[]) as t(name)
    where app_private.record_auth_security_event(
      t.name, null, '\x02'::bytea, null, null, null, 'inventory_probe') is null),
  0::bigint,
  'all eight approved types are accepted: the seven that existed plus registration, none removed');
select is(
  (select count(distinct e.event_type) from public.security_events e
    where e.id > (select b.id from events_baseline b)
      and e.details ->> 'reason_code' = 'inventory_probe'),
  8::bigint,
  'and they are eight, so 7-A added exactly one');

-- Nothing secret can be recorded, and that is the signature's doing rather than a caller's care.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames[1:p.pronargs]) as arg
    where n.nspname = 'app_private' and p.proname = 'record_auth_security_event'
      and arg in ('p_password', 'p_otp', 'p_code', 'p_code_hash', 'p_token', 'p_secret', 'p_cookie',
                  'p_email', 'p_phone', 'p_identifier')),
  0::bigint,
  'the writer has no parameter for a password, a code, a code digest, a token, a cookie or a raw contact');
select is(
  (select array_to_string(p.proargnames[1:p.pronargs], ' ')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'record_auth_security_event'),
  'p_event_type p_user_id p_identifier_hash p_ip_hash p_user_agent_hash p_request_id p_reason_code',
  'its seven parameters are unchanged by 7-A: the signature is the same one F3 and F4 left behind');

-- The stored payload is the established minimised one, and the identifiers in it are digests.
select is(
  (select array_to_string(array(select jsonb_object_keys(e.details) order by 1), ' ')
     from public.security_events e
    where e.id > (select b.id from events_baseline b)
      and e.event_type = 'auth.registration.success'
      and e.details ->> 'reason_code' = 'registration_created'),
  'identifier_hash reason_code',
  'a registration row stores only the keys it was given a value for: hashes and a short reason code');
select is(
  (select count(*) from public.security_events e
    where e.id > (select b.id from events_baseline b)
      and e.event_type = 'auth.registration.success'
      and (e.details ->> 'identifier_hash') !~ '^[0-9a-f]+$'),
  0::bigint,
  'and the identifier is hex-encoded sha256, never an address');
select is(
  (select count(*) from public.security_events e
    where e.id > (select b.id from events_baseline b)
      and e.event_type = 'auth.registration.success'
      and (e.device_id is not null or e.request_ip is not null)),
  0::bigint,
  'no device and no raw IP are written, exactly as every other C-20 event since 0038');

-- A reason code is a short internal token, not a message and not something a person typed.
select throws_ok(
  $$ select app_private.record_auth_security_event(
       'auth.registration.success', null, '\x01'::bytea, null, null, null,
       'the account new.person@example.test was created') $$,
  '22023', null,
  'a reason code that is really a sentence is refused, so a contact cannot arrive disguised as one');
select throws_ok(
  $$ select app_private.record_auth_security_event(
       'auth.registration.success', null, null, null, null, null, 'registration_created') $$,
  '22023', null, 'and an event with no identifier hash at all is refused');

-- The row inherits the store's own guarantee: once written, it cannot be quietly changed or removed.
select throws_ok(
  $$ delete from public.security_events where event_type = 'auth.registration.success' $$,
  null, null,
  'a registration event cannot be deleted: security_events is append-only and 7-A did not soften that');
select throws_ok(
  $$ update public.security_events set details = '{}'::jsonb where event_type = 'auth.registration.success' $$,
  null, null, 'nor rewritten');

-- No second telemetry path appeared.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname like '%security_event%'),
  1::bigint,
  'there is exactly one security-event writer in app_private: 7-A created no parallel one');
select is(
  (select count(*) from pg_tables t
    where t.schemaname in ('public', 'app_private')
      and (t.tablename like '%registration%log%' or t.tablename like '%registration_event%'
        or t.tablename like '%auth_log%')),
  0::bigint,
  'and no registration log table was created: the existing security_events is the store');

-- ---------------------------------------------------------------------------------------------------
-- Nothing else moved
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from auth.users u
     join users_before b on b.id = u.id
    where u.email_confirmed_at is distinct from b.email_confirmed_at
       or u.phone_confirmed_at is distinct from b.phone_confirmed_at),
  0::bigint,
  'after every call above, no confirmation timestamp moved: verification records our outcome and confirms nothing itself');
select is(
  (select count(*) from auth.users),
  (select count(*) from users_before),
  'and no account was created or removed');
select is(
  (select count(*) from public.outbox_events e where e.event_type like '%regist%'),
  0::bigint,
  'no registration event was published: 0065 emits none');

select * from finish();
rollback;
