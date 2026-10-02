-- 0038 — The authentication security-event writer (owner decision C-20, F2).
--
-- `public.record_security_event` (0004) takes its actor from the verified claims and refuses a caller
-- that has none. That is right for a user recording an event about themselves, and useless for login:
-- at the moment a login is recorded there is no session, and for a failure there may be no account at
-- all. F2 therefore needs one more writer, and C-20 scopes it precisely: server-only, callable by
-- `app_system` alone, and unable to write anything but the five approved login event types.
--
-- What it stores is as important as what it records. The identifier, the client IP and the user agent
-- arrive already hashed and are written as hex text; the plaintext identifier, the password, the access
-- and refresh tokens, any OTP, any cookie value and any provider secret have no parameter here and no
-- column to reach. `security_events.request_ip` is deliberately left null: C-20 asks for a pseudonymous
-- IP, and an inet column cannot hold one.
--
-- No table privilege is granted. `app_system` reaches `public.security_events` only by calling this
-- function, exactly as it reaches everything else (0031 role boundary).

do $$
begin
  if to_regclass('public.security_events') is null then
    raise exception 'public.security_events is missing'
      using hint = 'Migration 0038 adds the authentication writer for the table 0004 creates.';
  end if;
end;
$$;

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
  -- Fail closed on an unapproved type: this function is not a general-purpose event writer, and the
  -- five names below are the whole of C-20.
  if p_event_type is null or p_event_type not in (
    'auth.login.success',
    'auth.login.failure',
    'auth.login.locked',
    'auth.login.throttled',
    'auth.login.provider_error'
  ) then
    raise exception 'unsupported authentication event type'
      using errcode = 'invalid_parameter_value',
            hint = 'C-20 approves auth.login.success, .failure, .locked, .throttled and .provider_error.';
  end if;

  -- An internal reason code, not a message: short, lower-case, and never carrying a value.
  if p_reason_code is null or p_reason_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid reason code' using errcode = 'invalid_parameter_value';
  end if;

  -- The identifier is always known to the caller and always arrives hashed. Rejecting a null here is
  -- what stops a caller from quietly recording an event with no subject at all.
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
  'Records one approved login security event (C-20). Every identifier arrives hashed; no credential, token, OTP or cookie value can be passed in or stored. Callable by app_system only.';

revoke execute on function app_private.record_auth_security_event(text, uuid, bytea, bytea, bytea, text, text) from public;
grant execute on function app_private.record_auth_security_event(text, uuid, bytea, bytea, bytea, text, text)
  to app_system;

-- ---------------------------------------------------------------------------------------------------
-- Resolving a login identifier to an account
-- ---------------------------------------------------------------------------------------------------
-- 0034's lockout is keyed by user id, and F2 must apply it *before* Supabase is called. The API knows
-- the identifier the person typed, not the account it belongs to, and `app_system` holds no table
-- privileges, so it cannot look one up. This is that lookup and nothing else: one uuid or null.
--
-- It is not a second lockout mechanism. It answers "which account is this?"; `is_account_locked` and
-- `record_login_attempt` remain the only places the lockout rule lives.
--
-- The answer never leaves the server. A caller that learns "this identifier has no account" must not
-- turn that into a different status, body or timing — the endpoint continues to the provider with a
-- null user id and fails exactly as a wrong password does.
create or replace function app_private.user_id_for_login_identifier(p_identifier text)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select u.id
    from auth.users u
   where p_identifier is not null
     and p_identifier <> ''
     and (lower(u.email) = lower(p_identifier) or u.phone = p_identifier)
   limit 1;
$$;

comment on function app_private.user_id_for_login_identifier(text) is
  'Resolves a login identifier to its account id so the durable lockout (0034) can be applied before any provider call. Server-only; the result is never exposed to a caller.';

revoke execute on function app_private.user_id_for_login_identifier(text) from public;
grant execute on function app_private.user_id_for_login_identifier(text) to app_system;
