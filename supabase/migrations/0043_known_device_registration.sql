-- 0043 — Recording a known device (flow F6, increment F6-A; owner decision C-15).
--
-- C-15 settles what a device *is*: a persistent random value this server issues to a browser in the
-- `__Host-mp_device_id` cookie, of which only a keyed HMAC-SHA-256 digest is ever stored. The raw value
-- never reaches PostgreSQL, Redis, a log, telemetry or a response body — so this function takes the
-- digest and has no way to learn the value behind it.
--
-- This is the provider-independent half of F6 and the only half that can be built today. The other half
-- reads `auth.sessions`, whose columns C-14 requires to be established by live observation before any
-- SQL is written against them; that observation is impossible from this environment, so nothing here
-- touches sessions, liveness or revocation.
--
-- 0004 created `known_devices` with two RLS policies, a self-read and a self-update for `authenticated`,
-- and no writer. As with every table since 0034, the writer is a named SECURITY DEFINER function granted
-- to `app_system` alone: no table privilege is added, and the 0004 policies are untouched.
--
-- **The upsert is the unique index.** 0004 declares `known_devices_user_device` on
-- `(user_id, device_hash)`, so "is this device known?" and "record that it was seen" are one statement
-- rather than a read followed by a write. Two concurrent logins from the same browser therefore produce
-- one row and one of them reports `registered`, never two rows or two registrations.
--
-- **What this function deliberately does not decide.** C-15 keeps `trusted_at` and `revoked_at` at their
-- existing schema meaning and decides no policy for them, so neither is written here and neither is
-- acted on. A device whose row carries `revoked_at` is reported as `revoked` and left exactly as it is:
-- reporting a state is not the same as deciding what to do about it, and what a revoked device may do
-- is an owner decision F6 has not made.

-- ---------------------------------------------------------------------------------------------------
-- The writer
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.register_known_device(
  p_user_id uuid,
  p_device_hash bytea,
  p_ip inet default null
) returns table (
  outcome text,
  device_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing public.known_devices%rowtype;
  v_id uuid;
begin
  -- A digest of the wrong size is not a device: C-15 fixes the construction at HMAC-SHA-256, so the
  -- only acceptable input is its 32 bytes. Reported rather than raised, like 0039 and 0042, because a
  -- caller must be able to handle it without losing its transaction.
  if p_device_hash is null or octet_length(p_device_hash) <> 32 then
    return query select 'invalid_digest'::text, null::uuid;
    return;
  end if;

  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    return query select 'no_user'::text, null::uuid;
    return;
  end if;

  -- Locked, so a concurrent login for the same browser waits here rather than racing the upsert below.
  select * into v_existing
    from public.known_devices d
   where d.user_id = p_user_id and d.device_hash = p_device_hash
     for update;

  if found and v_existing.revoked_at is not null then
    -- Left untouched on purpose. See the header: F6 decides no policy for a revoked device, so this
    -- reports the state and changes nothing, not even `last_seen_at`.
    return query select 'revoked'::text, v_existing.id;
    return;
  end if;

  insert into public.known_devices (user_id, device_hash, last_ip)
  values (p_user_id, p_device_hash, p_ip)
  on conflict (user_id, device_hash) do update
     set last_seen_at = now(),
         -- Only when this sign-in came with an address; an absent one must not erase the last known.
         last_ip = coalesce(excluded.last_ip, public.known_devices.last_ip)
  returning id into v_id;

  -- `found` was false before the insert exactly when the row did not exist, which is what makes this a
  -- first sighting. The login flow's "new device → security event and notification" (specification
  -- line 486) is the caller's business, not this function's, and is not implemented in F6-A.
  return query select case when v_existing.id is null then 'registered' else 'seen' end, v_id;
end;
$$;

comment on function app_private.register_known_device(uuid, bytea, inet) is
  'Records that a user signed in from a device, identified only by the keyed HMAC-SHA-256 digest of the C-15 device cookie. Inserts on first sighting and refreshes last_seen_at/last_ip afterwards. Reports a revoked device without altering it; writes neither trusted_at nor revoked_at.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.register_known_device(uuid, bytea, inet) from public;

-- The API role alone, as for every writer since 0034. `authenticated` keeps the 0004 self-read and
-- self-update policies and gains nothing: a browser that could call this could claim to be any device,
-- and the digest is the only thing standing between a device record and a forged one.
grant execute on function app_private.register_known_device(uuid, bytea, inet) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
