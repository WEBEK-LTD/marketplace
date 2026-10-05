-- 0041 — Phone contact change: challenge verification and the security event (F4).
--
-- F4 changes one thing about an account — its phone — and the approved design deliberately reuses what
-- already exists rather than adding storage:
--
--   * the OTP challenge is an ordinary `phone_verify` challenge from 0004/0035, with the approved
--     digest, expiry, attempt cap, cooldowns and send limits;
--   * there is **no pending-contact table**. The approved state model says the confirmed phone becomes
--     the new phone immediately after a successful verification, so nothing needs to hold a half-changed
--     contact, and nothing here creates a place where one could accumulate;
--   * the provider is updated by the API through the Supabase Auth Admin API; this migration performs no
--     provider call and stores no phone of its own.
--
-- Two things did have to be added, and only these two.
--
-- **A verification that is bound to the account.** `app_private.verify_otp_challenge` (0035) checks the
-- code, the expiry, the attempts and the single consumption, but it knows nothing about *whose* challenge
-- it is or what it was for. A contact change must refuse a challenge belonging to another account or
-- issued for another purpose, so this file wraps that function with those two checks.
--
-- **The new number, without storing it here.** The clear phone is never written to `app_private`: 0004
-- stores destinations as digests on purpose. The clear value already exists in exactly one approved
-- place — `public.whatsapp_outbox.to_phone_e164`, where it must be in clear for the message to be sent —
-- so the verification resolves it by matching that row's digest against the challenge's
-- `destination_hash`. No new column, no new table, and no second copy of a personal detail.
--
-- The seventh security-event type, `auth.contact_change.success`, is added the way F3 added its own: by
-- replacing the C-20 writer with the same signature, the same payload, the same refusals and the same
-- `app_system`-only grant, changing only the approved list, and only by addition.

-- ---------------------------------------------------------------------------------------------------
-- Verifying a contact-change code
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.verify_contact_change_otp(
  p_challenge_id uuid,
  p_code_hash bytea,
  p_user_id uuid
) returns table (
  outcome text,
  new_phone_e164 text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_purpose text;
  v_owner uuid;
  v_destination bytea;
  v_outcome text;
  v_phone text;
begin
  if p_code_hash is null then
    raise exception 'code hash is required' using errcode = '22023';
  end if;
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;

  select c.purpose, c.user_id, c.destination_hash
    into v_purpose, v_owner, v_destination
    from app_private.otp_challenges c
   where c.id = p_challenge_id;

  -- A challenge of another purpose, or belonging to someone else, is reported as not found. Saying
  -- "wrong account" would confirm that a challenge exists under that id for somebody.
  if v_purpose is distinct from 'phone_verify' or v_owner is distinct from p_user_id then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- 0035 owns the comparison, the attempt count and the single consumption, under its own row lock.
  v_outcome := app_private.verify_otp_challenge(p_challenge_id, p_code_hash);
  if v_outcome <> 'verified' then
    return query select v_outcome, null::text;
    return;
  end if;

  -- The number the code was actually sent to, read back from the outbox row that carried it. Matching
  -- by digest means this function trusts the challenge, not the caller: a caller cannot name a different
  -- number than the one it proved control of.
  select w.to_phone_e164
    into v_phone
    from public.whatsapp_outbox w
   where w.recipient_user_id = p_user_id
     and sha256(convert_to(lower(btrim(w.to_phone_e164)), 'UTF8')) = v_destination
   order by w.created_at desc
   limit 1;

  if v_phone is null then
    -- The code was correct and is now spent, but the destination cannot be resolved, so the caller must
    -- not change anything. A fresh request starts a new challenge.
    return query select 'destination_unavailable'::text, null::text;
    return;
  end if;

  return query select 'verified'::text, v_phone;
end;
$$;

comment on function app_private.verify_contact_change_otp(uuid, bytea, uuid) is
  'Verifies a phone_verify OTP that belongs to the given account and returns the number it was sent to, read back from the outbox row (F4). A challenge of another purpose or another account is reported as not found.';

-- ---------------------------------------------------------------------------------------------------
-- The seventh C-20 event type
-- ---------------------------------------------------------------------------------------------------
-- Identical to 0040 in every other respect: same signature, same payload, same refusals, same grants.
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
    'auth.password_reset.success',
    'auth.contact_change.success'
  ) then
    raise exception 'unsupported authentication event type'
      using errcode = 'invalid_parameter_value',
            hint = 'C-20 approves the five auth.login types, auth.password_reset.success and auth.contact_change.success.';
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
  'Records one approved authentication security event (C-20, extended by F3 with auth.password_reset.success and by F4 with auth.contact_change.success). Every identifier arrives hashed; no credential, token, OTP, digest or cookie value can be passed in or stored. Callable by app_system only.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.verify_contact_change_otp(uuid, bytea, uuid) from public;
revoke execute on function app_private.record_auth_security_event(text, uuid, bytea, bytea, bytea, text, text) from public;

-- The API role alone, exactly as every other function in this chain. A browser that could call this
-- could verify a contact change it was never sent a code for.
grant execute on function
  app_private.verify_contact_change_otp(uuid, bytea, uuid),
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
