-- 0040 — The password-reset recovery flow: OTP purpose, contact resolution, verification and events (F3).
--
-- F3 joins three primitives that already exist and were built separately: the OTP challenge lifecycle
-- (0035), the reset-token lifecycle (0039, C-18) and the authentication security-event writer (0038,
-- C-20). This migration adds only what joining them requires, and adds it forward-only.
--
-- The approved decisions this file implements, and nothing beyond them:
--
--   * a new OTP purpose `password_reset`, because the D10 `recovery` purpose belongs to the
--     support-assisted privileged-recovery flow and `app_private.verify_recovery_contact` keys on it.
--     That flow is untouched here;
--   * `auth.password_reset.success` as a sixth C-20 event type;
--   * resolution of an identifier to the account's *verified* contact, so the OTP can only ever go to a
--     contact the account has already proven;
--   * verification of a password-reset OTP that issues the C-18 reset token in the same transaction;
--   * a read-only check of a reset token's status, so the completion step can validate the token and the
--     account binding **before** the password is changed and still consume it atomically afterwards.
--
-- C-18 is frozen: `issue_password_reset_token` and `consume_password_reset_token` are called here,
-- never altered. The 15-minute lifetime, the single-use rule and the digest-only storage all remain
-- exactly where 0039 put them.

-- ---------------------------------------------------------------------------------------------------
-- The new OTP purpose
-- ---------------------------------------------------------------------------------------------------
-- 0004's CHECK listed five purposes. This replaces it with the same five plus `password_reset`; no
-- existing value is removed, so every row that satisfied the old constraint still satisfies this one.
alter table app_private.otp_challenges
  drop constraint if exists otp_challenges_purpose_allowed;
alter table app_private.otp_challenges
  add constraint otp_challenges_purpose_allowed
  check (purpose in ('login', 'step_up', 'email_verify', 'phone_verify', 'recovery', 'password_reset'));

-- ---------------------------------------------------------------------------------------------------
-- The verified contact a recovery OTP may be sent to
-- ---------------------------------------------------------------------------------------------------
-- Delivery is Waabek only, so the contact that matters is a confirmed phone number. An account without
-- one is not eligible, and the caller cannot tell that apart from "no such account": both come back as
-- no row, which is what keeps the public response identical either way.
create or replace function app_private.password_reset_contact(p_identifier text)
returns table (
  user_id uuid,
  phone_e164 text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select u.id, u.phone
    from auth.users u
   where p_identifier is not null
     and p_identifier <> ''
     and (lower(u.email) = lower(p_identifier) or u.phone = p_identifier)
     and u.phone is not null
     and u.phone_confirmed_at is not null
   limit 1;
$$;

comment on function app_private.password_reset_contact(text) is
  'Resolves a login identifier to the account and the confirmed phone a password-reset OTP may be sent to (F3). No row means either no such account or no verified contact; the caller must not be able to tell which.';

-- The same rule, keyed by account rather than by identifier: the post-reset notification goes to the
-- contact the account has verified, and to nowhere else.
create or replace function app_private.verified_contact_for_user(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select u.phone
    from auth.users u
   where u.id = p_user_id
     and u.phone is not null
     and u.phone_confirmed_at is not null;
$$;

comment on function app_private.verified_contact_for_user(uuid) is
  'The confirmed phone of one account, for the post-reset notification (F3). Null when the account has no verified contact.';

-- ---------------------------------------------------------------------------------------------------
-- Verifying the recovery OTP and issuing the reset token
-- ---------------------------------------------------------------------------------------------------
-- One call, one transaction: the OTP is consumed and the reset token is created together, so there is no
-- window in which a verified challenge exists without its token, and no way to mint a second token from
-- one verification.
create or replace function app_private.verify_password_reset_otp(
  p_challenge_id uuid,
  p_code_hash bytea,
  p_token_hash bytea
) returns table (
  outcome text,
  token_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_purpose text;
  v_user_id uuid;
  v_outcome text;
  v_issued record;
begin
  if p_code_hash is null then
    raise exception 'code hash is required' using errcode = '22023';
  end if;
  if p_token_hash is null or octet_length(p_token_hash) < 32 then
    raise exception 'token digest is required and must be at least 32 bytes' using errcode = '22023';
  end if;

  select c.purpose, c.user_id into v_purpose, v_user_id
    from app_private.otp_challenges c
   where c.id = p_challenge_id;

  -- A challenge issued for anything else is reported as not found. Saying "wrong purpose" would tell a
  -- caller that some other flow's challenge exists under that id.
  if v_purpose is distinct from 'password_reset' then
    return query select 'not_found'::text, null::uuid, null::timestamptz;
    return;
  end if;
  if v_user_id is null then
    return query select 'not_found'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- 0035 owns the comparison, the attempt count and the single consumption, under its own row lock.
  v_outcome := app_private.verify_otp_challenge(p_challenge_id, p_code_hash);
  if v_outcome <> 'verified' then
    return query select v_outcome, null::uuid, null::timestamptz;
    return;
  end if;

  -- C-18, unchanged: the 15-minute lifetime and the digest-only storage are that function's.
  select * into v_issued
    from app_private.issue_password_reset_token(v_user_id, p_token_hash, null);

  if v_issued.outcome <> 'issued' then
    -- The account vanished between the two statements. The OTP has been consumed either way, which is
    -- the safe direction: a code is never reusable.
    return query select 'not_found'::text, null::uuid, null::timestamptz;
    return;
  end if;

  return query select 'verified'::text, v_issued.token_id, v_issued.expires_at;
end;
$$;

comment on function app_private.verify_password_reset_otp(uuid, bytea, bytea) is
  'Verifies a password_reset OTP and, in the same transaction, issues the C-18 reset token for the account the challenge belongs to (F3). Never returns the account, and reports a challenge of any other purpose as not found.';

-- ---------------------------------------------------------------------------------------------------
-- Reading a reset token's status without consuming it
-- ---------------------------------------------------------------------------------------------------
-- The approved completion ordering validates the token and the account binding before the password is
-- changed, and consumes the token afterwards. That needs a read that does not consume, which C-18
-- deliberately does not provide — so it is added here rather than by changing a frozen function.
--
-- This grants nothing: it returns a status and the bound account for a caller that already holds the
-- token, and it is callable by `app_system` alone. Consumption remains the single atomic write in
-- `app_private.consume_password_reset_token`, and a status read never makes a token usable twice.
create or replace function app_private.password_reset_token_status(p_token_hash bytea)
returns table (
  status text,
  user_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v app_private.password_reset_tokens%rowtype;
begin
  if p_token_hash is null or octet_length(p_token_hash) < 32 then
    raise exception 'token digest is required and must be at least 32 bytes' using errcode = '22023';
  end if;

  select * into v from app_private.password_reset_tokens t where t.token_hash = p_token_hash;

  if not found then
    return query select 'not_found'::text, null::uuid;
  elsif v.consumed_at is not null then
    return query select 'already_consumed'::text, null::uuid;
  elsif v.expires_at <= now() then
    return query select 'expired'::text, null::uuid;
  else
    return query select 'valid'::text, v.user_id;
  end if;
end;
$$;

comment on function app_private.password_reset_token_status(bytea) is
  'Reports whether a reset token is currently usable, and for which account, without consuming it (F3). Consumption stays the single atomic write in app_private.consume_password_reset_token.';

-- ---------------------------------------------------------------------------------------------------
-- The sixth C-20 event type
-- ---------------------------------------------------------------------------------------------------
-- Identical to 0038 in every other respect: same signature, same payload, same refusals, same grants.
-- Only the approved list changes, and it changes by addition.
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
    'auth.password_reset.success'
  ) then
    raise exception 'unsupported authentication event type'
      using errcode = 'invalid_parameter_value',
            hint = 'C-20 approves auth.login.success, .failure, .locked, .throttled, .provider_error and auth.password_reset.success.';
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
  'Records one approved authentication security event (C-20, extended by F3 with auth.password_reset.success). Every identifier arrives hashed; no credential, token, OTP, digest or cookie value can be passed in or stored. Callable by app_system only.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.password_reset_contact(text) from public;
revoke execute on function app_private.verified_contact_for_user(uuid) from public;
revoke execute on function app_private.verify_password_reset_otp(uuid, bytea, bytea) from public;
revoke execute on function app_private.password_reset_token_status(bytea) from public;
revoke execute on function app_private.record_auth_security_event(text, uuid, bytea, bytea, bytea, text, text) from public;

-- The API role alone, exactly as every other function in this chain. A browser that could call any of
-- these could start, verify or inspect a reset it was never sent.
grant execute on function
  app_private.password_reset_contact(text),
  app_private.verified_contact_for_user(uuid),
  app_private.verify_password_reset_otp(uuid, bytea, bytea),
  app_private.password_reset_token_status(bytea),
  app_private.record_auth_security_event(text, uuid, bytea, bytea, bytea, text, text)
  to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
