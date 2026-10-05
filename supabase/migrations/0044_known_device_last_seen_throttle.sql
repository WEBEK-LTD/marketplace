-- 0044 — Throttling the device sighting write (flow F6, increment F6-B; owner decision C-15 §3).
--
-- 0043 refreshed `last_seen_at` on every sighting. C-15 §3 settles the rule that increment could not:
--
--   > A successful authenticated request from a known device may update last_seen_at.
--   > Do not write on every request.
--   > Throttle last_seen_at persistence to at most once every 15 minutes per device row.
--
-- So the refresh becomes conditional, and the condition lives in the statement rather than in the
-- caller. Two reasons. A caller-side check would be a read, a decision and a write, which two concurrent
-- requests could interleave into two writes; and every future caller would have to remember the rule.
-- Here the `on conflict … where` clause is the rule: the row is refreshed only if its last sighting is
-- already older than the window, so a burst of requests from one device costs one write at most.
--
-- **The window covers `last_ip` as well.** C-15 §3 names `last_seen_at` and says plainly not to write on
-- every request; the two columns describe one sighting and are written together, so throttling one and
-- not the other would be a second, invented rule. An address that changes inside the window is simply
-- recorded at the next sighting past it.
--
-- **Registration is never throttled.** A device seen for the first time is inserted immediately: the
-- window governs how often a *known* device's row is rewritten, not whether a new one is recorded.
--
-- C-15 §4 is unchanged from 0043 and restated here because this function is being replaced: a row with
-- `revoked_at` set is reported and left exactly as it is. It is not re-trusted, its `revoked_at` is not
-- cleared, and its sighting is not refreshed. A later login with a device value this server has not seen
-- registers a fresh row through the ordinary path above; nothing here revives a revoked one.
--
-- Everything else about 0043 stands: same name, same signature, same outcomes, same privileges. Only the
-- refresh condition changes, so `app_system` keeps the single EXECUTE grant it already had.

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
  -- Owner decision C-15 §3. Fixed here, like C-16's ten minutes in 0036: how often a device's
  -- whereabouts are written down is not something a caller may choose.
  c_last_seen_window constant interval := interval '15 minutes';
  v_existing public.known_devices%rowtype;
  v_id uuid;
begin
  if p_device_hash is null or octet_length(p_device_hash) <> 32 then
    return query select 'invalid_digest'::text, null::uuid;
    return;
  end if;

  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    return query select 'no_user'::text, null::uuid;
    return;
  end if;

  select * into v_existing
    from public.known_devices d
   where d.user_id = p_user_id and d.device_hash = p_device_hash
     for update;

  if found and v_existing.revoked_at is not null then
    return query select 'revoked'::text, v_existing.id;
    return;
  end if;

  insert into public.known_devices (user_id, device_hash, last_ip)
  values (p_user_id, p_device_hash, p_ip)
  on conflict (user_id, device_hash) do update
     set last_seen_at = now(),
         -- Only when this sign-in came with an address; an absent one must not erase the last known.
         last_ip = coalesce(excluded.last_ip, public.known_devices.last_ip)
   -- The throttle, as a predicate: inside the window the UPDATE matches no row and nothing is written.
   where public.known_devices.last_seen_at <= now() - c_last_seen_window
  returning id into v_id;

  -- A first sighting always inserted, so `v_id` is set. A repeat sighting inside the window wrote
  -- nothing and left `v_id` null, which is not an error: the row the caller asked about is the one it
  -- already had, and the outcome is still `seen`.
  if v_existing.id is null then
    return query select 'registered'::text, v_id;
  else
    return query select 'seen'::text, v_existing.id;
  end if;
end;
$$;

comment on function app_private.register_known_device(uuid, bytea, inet) is
  'Records that a user signed in from a device, identified only by the keyed HMAC-SHA-256 digest of the C-15 device cookie. Inserts on first sighting; afterwards refreshes last_seen_at/last_ip at most once every 15 minutes per row (C-15 §3). Reports a revoked device without altering it; writes neither trusted_at nor revoked_at.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- `create or replace` keeps the existing grants, but they are restated so that this file alone shows
-- who may call the function it defines.
revoke execute on function app_private.register_known_device(uuid, bytea, inet) from public;
grant execute on function app_private.register_known_device(uuid, bytea, inet) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
