-- 0065 — Registration contact verification (Phase 7-A).
--
-- Three new functions, plus one existing function re-created by addition. Registration reuses the OTP
-- lifecycle 0006 already owns —
-- `issue_otp_challenge`, its send limits and resend cooldowns, `queue_whatsapp_otp`, `begin_otp_delivery`,
-- `settle_outbox_message` — and creates no second verification mechanism. What does not exist, and what
-- this migration adds, is the pair of reads those two moments need.
--
-- **Why `phone_verify` and not an email flow.** The canonical verified contact in this repository is the
-- phone: `app_private.verified_contact_for_user` returns `auth.users.phone` and only when
-- `phone_confirmed_at is not null`; `app_private.password_reset_contact` refuses an account without one;
-- the only contact-change surface in the API is the phone pair; and `otp_challenges_purpose_allowed`
-- already lists `phone_verify`. Registration therefore verifies the phone over the established WhatsApp
-- OTP path. No email delivery is involved, which matters because there is no email delivery worker yet —
-- that is 7-D, and 7-A does not depend on it.
--
-- **Why a new verify function rather than reusing the existing two.** `verify_otp_challenge(uuid, bytea)`
-- returns only an outcome, so the caller cannot learn which account the challenge belonged to;
-- `verify_contact_change_otp(uuid, bytea, uuid)` requires the account to be passed in, which a signed-in
-- caller has and a registering one does not — at this moment the person has no session, by decision
-- (VERIFY FIRST). `register_verify_contact` is the missing shape: verify with no session, and return the
-- account the challenge was issued for so the API can confirm that account's phone.
--
-- It is not a weaker check. It refuses a challenge of any other purpose, refuses one with no account, and
-- reports a wrong code, an expired one, a spent one, an exhausted one, a challenge of another purpose and
-- a challenge that never existed with outcomes the API collapses into a single answer — so a caller
-- learns nothing from the difference. The `for update` lock and the attempt accounting are copied from
-- `verify_otp_challenge` unchanged, which is what keeps "consumed exactly once" true.
--
-- **Why the login reader.** The approved decision is that a newly registered account verifies its contact
-- **before first sign-in**. This project does not leave such a rule to the provider: O-1 settled that the
-- durable lockout is enforced in NestJS rather than through a Supabase hook, and the same reasoning
-- applies here. `login_contact_confirmed` is the fact the login path needs, and it is deliberately
-- generous: it is true when **either** contact is confirmed. An account confirmed by either channel is
-- untouched by the gate, so no account that could sign in before this migration is locked out by it; only
-- an account with no confirmed contact at all — which is exactly what registration creates before its
-- code comes back — is refused.
--
-- Of the three new functions only the first writes, and only the attempt and consumption accounting that
-- verification *is* — which is `verify_otp_challenge`'s own established behaviour, and why that one is
-- `volatile` while the other two are `stable`. Nothing else in this migration writes at all, and nothing
-- in it sends anything: every send still goes through `issue_otp_challenge` and the approved limits it
-- enforces.
--
-- The fourth block re-creates `app_private.record_auth_security_event` to add one approved event type,
-- `auth.registration.success`. That is the only change to anything that existed before 7-A, it is purely
-- additive — one entry in one allowed list — and it is the same mechanism by which F3 and F4 each added
-- theirs. No column, constraint, index, signature, payload key or grant changes, and no new table is
-- created: there is one security-event store in this project and registration writes to it.

-- ---------------------------------------------------------------------------------------------------
-- Verify a registration contact code, with no session
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.register_verify_contact(
  p_challenge_id uuid,
  p_code_hash bytea
) returns table (
  outcome text,
  user_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v app_private.otp_challenges%rowtype;
begin
  if p_code_hash is null then
    raise exception 'code hash is required' using errcode = '22023';
  end if;

  -- The lock is what makes "consumed exactly once" true: a second concurrent verification of the same
  -- correct code waits here, then sees consumed_at already set. Copied from verify_otp_challenge.
  select * into v from app_private.otp_challenges c where c.id = p_challenge_id for update;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  -- A challenge issued for a login, a step-up, a recovery, a password reset or a contact change is not a
  -- registration verification, whatever its code says. Reported as not_found so the purposes a challenge
  -- can have are not enumerable through this surface.
  if v.purpose <> 'phone_verify' then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  -- A challenge with no account cannot confirm one.
  if v.user_id is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  if v.consumed_at is not null then
    return query select 'consumed'::text, null::uuid;
    return;
  end if;
  if v.expires_at <= now() then
    return query select 'expired'::text, null::uuid;
    return;
  end if;
  if v.attempts >= v.max_attempts then
    return query select 'too_many_attempts'::text, null::uuid;
    return;
  end if;

  if v.code_hash = p_code_hash then
    update app_private.otp_challenges set consumed_at = now() where id = v.id;
    -- The account is returned only on the one path that proves the person holds the number.
    return query select 'verified'::text, v.user_id;
    return;
  end if;

  update app_private.otp_challenges set attempts = attempts + 1 where id = v.id;
  return query select 'invalid'::text, null::uuid;
end;
$$;

comment on function app_private.register_verify_contact(uuid, bytea) is
  'Verifies a phone_verify OTP for an account that has no session yet, and returns the account the challenge was issued for so the caller can confirm its contact. Refuses a challenge of any other purpose and one with no account, both as not_found. Consumes the challenge exactly once under a row lock, and counts a wrong code as an attempt, exactly as verify_otp_challenge does. Creates no session and confirms nothing itself.';

revoke all on function app_private.register_verify_contact(uuid, bytea) from public;
grant execute on function app_private.register_verify_contact(uuid, bytea) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- Whether an account has any confirmed contact
-- ---------------------------------------------------------------------------------------------------
--
-- Read by the login path to enforce the approved VERIFY FIRST decision. True when **either** contact is
-- confirmed, which is what keeps the rule narrow: it refuses an account that has confirmed nothing, and
-- says nothing about an account that has confirmed one contact but not the other.
--
-- An account that does not exist answers false. The login path already treats an unknown identifier and a
-- known one identically up to the provider call, so this answer never reaches a response on its own.
create or replace function app_private.login_contact_confirmed(p_user_id uuid) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from auth.users u
     where u.id = p_user_id
       and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null)
  );
$$;

comment on function app_private.login_contact_confirmed(uuid) is
  'True when the account has at least one confirmed contact, email or phone. Read by the login path to refuse an account that has confirmed neither, which is the state registration leaves an account in until its code comes back. Deliberately generous: an account confirmed by either channel passes, so no account that could sign in before Phase 7-A is refused by it.';

revoke all on function app_private.login_contact_confirmed(uuid) from public;
grant execute on function app_private.login_contact_confirmed(uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- Resolve a registration in progress, so its code can be sent again
-- ---------------------------------------------------------------------------------------------------
--
-- A code that never arrives is the ordinary case this has to handle, and it has to handle it without
-- becoming a second way in. So this function resolves nothing but what a resend needs — the account and
-- the number to send to — and it resolves it only for an account that is **mid-registration**: one whose
-- email and phone are both unconfirmed, which is exactly the state `login_contact_confirmed` refuses and
-- exactly the state a person waiting for their first code is in.
--
-- Three consequences worth stating, because each closes a door.
--
--   * A verified account cannot be reached through here at all. Once either contact is confirmed the
--     account stops matching, so this can never be used to spray codes at somebody who finished
--     registering — nor at somebody's number after a contact change, which has its own authenticated flow.
--   * The number comes from the account, never from the caller. There is no phone parameter, so a caller
--     cannot aim a resend at a number of its choosing; the only number that can be reached is the one the
--     account already holds.
--   * The caller must already hold the challenge identifier, which this project only ever puts in an
--     `HttpOnly` cookie it set itself. Anything else is reported as `not_found`, in the same words a
--     challenge of another purpose gets, so the surface says nothing about which challenges exist.
--
-- Expiry is deliberately **not** checked: a code that has expired is the main reason to ask for another
-- one. Consumption is checked, belt and braces — a consumed challenge means the contact was verified,
-- which the account test already excludes.
--
-- This function sends nothing and writes nothing. The send that follows goes through
-- `issue_otp_challenge` like every other, which is where the approved per-destination and per-IP limits
-- and the 60/120/300 s cooldowns are applied. A resend is therefore bounded by the same numbers as a
-- first send, and this migration introduces no limit of its own.
create or replace function app_private.register_resend_contact(p_challenge_id uuid)
returns table (
  outcome text,
  user_id uuid,
  to_phone_e164 text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    case when u.id is null then 'not_found' else 'resend' end,
    u.id,
    u.phone
    from app_private.otp_challenges c
    left join auth.users u
      on u.id = c.user_id
     and u.phone is not null
     and u.phone_confirmed_at is null
     and u.email_confirmed_at is null
   where c.id = p_challenge_id
     and c.purpose = 'phone_verify'
     and c.consumed_at is null
  union all
  select 'not_found', null::uuid, null::text
   where not exists (
     select 1
       from app_private.otp_challenges c
      where c.id = p_challenge_id
        and c.purpose = 'phone_verify'
        and c.consumed_at is null
   )
$$;

comment on function app_private.register_resend_contact(uuid) is
  'Resolves the account and phone number behind a registration still in progress, so its verification code can be sent again. Matches only an account whose email and phone are both unconfirmed, so a verified account can never be reached through it, and takes no phone parameter, so a caller cannot aim a resend anywhere. Reports anything else as not_found. Sends nothing and writes nothing: the send itself goes through issue_otp_challenge and its approved limits.';

revoke all on function app_private.register_resend_contact(uuid) from public;
grant execute on function app_private.register_resend_contact(uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The eighth C-20 event type
-- ---------------------------------------------------------------------------------------------------
-- Identical to 0041 in every other respect: same signature, same seven parameters, same `details`
-- payload, same refusals, same grants, same table. Only the approved list changes, and it changes by
-- addition — the third time this list has grown, after F3 added `auth.password_reset.success` and F4
-- added `auth.contact_change.success`.
--
-- **The name follows the convention rather than inventing one.** Every approved type is
-- `auth.<flow>.<outcome>`, with the flow in snake_case — `login`, `password_reset`, `contact_change` —
-- and the outcome drawn from the set C-20 established. Registration is a flow beside those, so its type
-- is `auth.registration.success`: the same three segments, the same prefix, the same `success` outcome
-- word that F3's and F4's single types use. Nothing about the shape of an event type changes.
--
-- **One type, and only success.** There is deliberately no `auth.registration.failure`. A failure type
-- would be counted: a row for a refused registration is a row that exists for an address that is taken
-- and does not exist for one that is free, which is the very thing registration answers identically
-- about. F3 and F4 declined a failure type for the same reason, and this declines it for theirs. The
-- login gate's refusal of an unverified account is already recorded, under the existing
-- `auth.login.failure` with the reason code `contact_unverified`, and is untouched here.
--
-- **Nothing secret can reach the row, and that is enforced by the signature, not by care.** The function
-- takes seven parameters and not one of them is a password, a code, a digest of a code, a token or a
-- cookie; there is no parameter a caller could put one in. What does travel is already pseudonymous
-- before it arrives: `p_identifier_hash`, `p_ip_hash` and `p_user_agent_hash` are sha256 digests
-- produced in the API by `subject-hash.ts`, and the `details` object stores their hex encodings and a
-- short reason code. The existing privacy and minimisation model is inherited exactly, because this is
-- the same function.
create or replace function app_private.record_auth_security_event(
  p_event_type text,
  p_user_id uuid,
  p_identifier_hash bytea,
  p_ip_hash bytea,
  p_user_agent_hash bytea,
  p_request_id text,
  p_reason_code text
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id bigint;
begin
  if p_event_type is null or p_event_type not in (
    'auth.login.success',
    'auth.login.failure',
    'auth.login.locked',
    'auth.login.throttled',
    'auth.login.provider_error',
    'auth.password_reset.success',
    'auth.contact_change.success',
    'auth.registration.success'
  ) then
    raise exception 'unsupported authentication event type'
      using errcode = 'invalid_parameter_value',
            hint = 'C-20 approves the five auth.login types, auth.password_reset.success, auth.contact_change.success and auth.registration.success.';
  end if;

  if p_reason_code is null or p_reason_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid reason code' using errcode = 'invalid_parameter_value';
  end if;

  if p_identifier_hash is null or octet_length(p_identifier_hash) = 0 then
    raise exception 'identifier hash is required' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.security_events (user_id, event_type, device_id, request_ip, details)
  values (
    p_user_id,
    p_event_type,
    null,
    null,
    jsonb_strip_nulls(
      jsonb_build_object(
        'identifier_hash', encode(p_identifier_hash, 'hex'),
        'ip_hash', case when p_ip_hash is null then null else encode(p_ip_hash, 'hex') end,
        'user_agent_hash', case when p_user_agent_hash is null then null else encode(p_user_agent_hash, 'hex') end,
        'request_id', p_request_id,
        'reason_code', p_reason_code
      )
    )
  )
  returning id into new_id;

  return new_id;
end;
$$;

comment on function app_private.record_auth_security_event(text, uuid, bytea, bytea, bytea, text, text) is
  'Records one approved authentication security event (C-20, extended by F3 with auth.password_reset.success, by F4 with auth.contact_change.success and by Phase 7-A with auth.registration.success). Every identifier arrives hashed; no credential, token, OTP, digest or cookie value can be passed in or stored. Callable by app_system only.';

revoke execute on function app_private.record_auth_security_event(text, uuid, bytea, bytea, bytea, text, text) from public;
grant execute on function app_private.record_auth_security_event(text, uuid, bytea, bytea, bytea, text, text)
  to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
