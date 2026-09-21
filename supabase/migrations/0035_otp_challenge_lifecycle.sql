-- 0035 — OTP challenge lifecycle: issue, deliver, verify (C21; OTP defaults; owner decisions C-9, C-10).
--
-- 0004 created `app_private.otp_challenges` but, like `login_attempts` before 0034, gave nothing a way
-- to write it. Verified against a live database before this file was written:
--
--   app_api / app_system / app_worker / authenticated / anon -> NONE on app_private.otp_challenges
--   functions touching it: app_private.verify_recovery_contact (recovery only, not a general writer)
--
-- The 0031 role-boundary contract forbids granting `app_system` table privileges, so the only route
-- that preserves every existing contract is the established pattern: named SECURITY DEFINER functions
-- with a pinned search_path, granted to `app_system` alone.
--
-- Approved values, none of them chosen here:
--
--   > 6 digits hashed; 10-min expiry; 5 attempts; resend 60/120/300 s; 5/h and 10/day per destination;
--   > 20/h per IP
--
--   Owner decision C-9: the stored value is HMAC-SHA-256(server-side pepper, OTP).
--   Owner decision C-10: cooldown 60 s after the first send, 120 s after the second, 300 s thereafter;
--   the tier never resets during the life of the challenge.
--
-- **The pepper never reaches this database.** These functions receive an already-computed digest and
-- never see the code or the pepper, which is what makes a database compromise insufficient to forge or
-- recover an OTP. That is also why the HMAC is not computed in SQL.
--
-- **The clear code never reaches this database either.** It is generated in the API, sent to the
-- delivery provider in the same call, and discarded. `whatsapp_outbox` already enforces this from the
-- other side: its `variables` column rejects the keys code, otp, password, token and secret.

-- ---------------------------------------------------------------------------------------------------
-- Resend state
-- ---------------------------------------------------------------------------------------------------
-- The approved cooldown is a function of how many times a challenge has been sent, and 0004 stored
-- neither the count nor the last send time. These two columns are the smallest representation of the
-- approved C-10 schedule; nothing else in the table changes.
alter table app_private.otp_challenges
  add column if not exists send_count smallint not null default 1,
  add column if not exists last_sent_at timestamptz not null default now();

alter table app_private.otp_challenges
  drop constraint if exists otp_challenges_send_count_positive;
alter table app_private.otp_challenges
  add constraint otp_challenges_send_count_positive check (send_count >= 1);

comment on column app_private.otp_challenges.send_count is
  'How many codes have been sent for this challenge. Drives the approved 60/120/300 s cooldown tier (C-10).';
comment on column app_private.otp_challenges.last_sent_at is
  'When the most recent code was sent. The next send is refused until the tier cooldown has elapsed.';

-- ---------------------------------------------------------------------------------------------------
-- Repair: app_private.rate_limit_hit could never run
-- ---------------------------------------------------------------------------------------------------
-- 0004 declared a PL/pgSQL variable named `window_start`, which shadows the column of the same name in
-- the `on conflict (bucket, subject_hash, window_start)` inference clause. PostgreSQL rejects that as
-- ambiguous, so **every call raised 42702** and the function had never actually been executed: no pgTAP
-- test invoked it, and no application code called it before this migration. It is the counter the
-- approved OTP limits are built on, so it is repaired here rather than worked around.
--
-- This replaces the function body only. The signature is unchanged, so the 0004 grants to `app_system`
-- and `app_worker` survive, and no Phase 2 migration file is edited. The only change is the variable
-- name; the fixed-window arithmetic and the return contract are exactly as approved.
create or replace function app_private.rate_limit_hit(
  p_bucket text,
  p_subject_hash bytea,
  p_window interval,
  p_limit integer
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_window_start timestamptz := to_timestamp(floor(extract(epoch from now()) / extract(epoch from p_window)) * extract(epoch from p_window));
  current_hits integer;
begin
  if p_limit < 1 then
    raise exception 'rate limit must be at least 1';
  end if;
  insert into app_private.rate_limits (bucket, subject_hash, window_start, hits, updated_at)
  values (p_bucket, p_subject_hash, v_window_start, 1, now())
  on conflict (bucket, subject_hash, window_start)
    do update set hits = app_private.rate_limits.hits + 1, updated_at = now()
  returning hits into current_hits;
  return current_hits <= p_limit;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- The approved cooldown schedule
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.otp_resend_cooldown(p_send_count smallint)
returns interval
language sql
immutable
set search_path = pg_catalog, public
as $$
  -- C-10: 60 s after the first send, 120 s after the second, 300 s after every send from the third on.
  -- Expressed as "given N sends so far, how long until the next one is allowed".
  select case
           when p_send_count <= 1 then interval '60 seconds'
           when p_send_count = 2 then interval '120 seconds'
           else interval '300 seconds'
         end;
$$;

comment on function app_private.otp_resend_cooldown(smallint) is
  'The approved C-10 resend cooldown for a challenge that has been sent p_send_count times. Never resets.';

-- ---------------------------------------------------------------------------------------------------
-- Issuing (and resending) a challenge
-- ---------------------------------------------------------------------------------------------------
-- One statement does the cooldown check, the three rate limits, the challenge write and the outbox row,
-- so two concurrent requests cannot both pass the limits: the challenge row is locked, and
-- `rate_limit_hit` counts through a primary-key upsert.
create or replace function app_private.issue_otp_challenge(
  p_purpose text,
  p_channel text,
  p_destination_hash bytea,
  p_code_hash bytea,
  p_to_phone_e164 text,
  p_template_name text,
  p_template_locale text,
  p_user_id uuid default null,
  p_request_ip inet default null,
  p_ip_hash bytea default null
) returns table (
  outcome text,
  challenge_id uuid,
  outbox_id uuid,
  send_count smallint,
  retry_after_seconds integer,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- Approved OTP defaults.
  c_ttl constant interval := interval '10 minutes';
  c_dest_hourly constant integer := 5;
  c_dest_daily constant integer := 10;
  c_ip_hourly constant integer := 20;
  v_existing app_private.otp_challenges%rowtype;
  v_cooldown interval;
  v_due timestamptz;
  v_new_count smallint;
  v_challenge_id uuid;
  v_outbox_id uuid;
  v_expires timestamptz;
begin
  if p_destination_hash is null or p_code_hash is null then
    raise exception 'destination hash and code hash are required' using errcode = '22023';
  end if;

  -- The newest challenge for this destination and purpose that is still usable. Locked so a concurrent
  -- issue for the same destination waits here rather than racing the cooldown.
  select * into v_existing
    from app_private.otp_challenges c
   where c.destination_hash = p_destination_hash
     and c.purpose = p_purpose
     and c.consumed_at is null
     and c.expires_at > now()
   order by c.created_at desc
   limit 1
   for update;

  if found then
    v_cooldown := app_private.otp_resend_cooldown(v_existing.send_count);
    v_due := v_existing.last_sent_at + v_cooldown;
    if now() < v_due then
      return query select 'cooldown'::text, v_existing.id, null::uuid, v_existing.send_count,
                          ceil(extract(epoch from (v_due - now())))::integer, v_existing.expires_at;
      return;
    end if;
  end if;

  -- Limits are enforced here, before anything is handed to the delivery provider. A rejected send still
  -- counts against the counters it already touched, which is the conservative direction.
  if not app_private.rate_limit_hit('otp.send.destination.hour', p_destination_hash, interval '1 hour', c_dest_hourly) then
    return query select 'rate_limited_destination_hour'::text, null::uuid, null::uuid, null::smallint, null::integer, null::timestamptz;
    return;
  end if;
  if not app_private.rate_limit_hit('otp.send.destination.day', p_destination_hash, interval '1 day', c_dest_daily) then
    return query select 'rate_limited_destination_day'::text, null::uuid, null::uuid, null::smallint, null::integer, null::timestamptz;
    return;
  end if;
  if p_ip_hash is not null
     and not app_private.rate_limit_hit('otp.send.ip.hour', p_ip_hash, interval '1 hour', c_ip_hourly) then
    return query select 'rate_limited_ip_hour'::text, null::uuid, null::uuid, null::smallint, null::integer, null::timestamptz;
    return;
  end if;

  v_expires := now() + c_ttl;

  if v_existing.id is not null then
    -- A resend replaces the code on the same challenge. `attempts` is deliberately NOT reset: resetting
    -- it would turn the five-attempt cap into "five attempts per resend", which is no cap at all.
    v_new_count := least(v_existing.send_count + 1, 32767)::smallint;
    update app_private.otp_challenges
       set code_hash = p_code_hash,
           expires_at = v_expires,
           send_count = v_new_count,
           last_sent_at = now(),
           request_ip = coalesce(p_request_ip, request_ip)
     where id = v_existing.id
    returning id into v_challenge_id;
  else
    v_new_count := 1;
    insert into app_private.otp_challenges
      (user_id, purpose, channel, destination_hash, code_hash, expires_at, request_ip,
       send_count, last_sent_at)
    values (p_user_id, p_purpose, p_channel, p_destination_hash, p_code_hash, v_expires, p_request_ip,
            1, now())
    returning id into v_challenge_id;
  end if;

  -- The outbox row carries no code; it is the durable record of the delivery attempt.
  v_outbox_id := app_private.queue_whatsapp_otp(
    p_to_phone_e164, p_template_name, p_template_locale, p_user_id, '{}'::jsonb, null);

  return query select 'issued'::text, v_challenge_id, v_outbox_id, v_new_count, null::integer, v_expires;
end;
$$;

comment on function app_private.issue_otp_challenge(text, text, bytea, bytea, text, text, text, uuid, inet, bytea) is
  'Issues or resends an OTP challenge, enforcing the approved cooldown and the 5/h, 10/day and 20/h-per-IP limits before any provider call. Receives a digest; never sees the code or the pepper.';

-- ---------------------------------------------------------------------------------------------------
-- Marking one queued message as being sent
-- ---------------------------------------------------------------------------------------------------
-- `claim_outbox_messages` claims a batch by availability, which is right for the worker relay and wrong
-- for a synchronous send of one known row. This moves exactly one row queued -> sending with the same
-- bookkeeping, so `settle_outbox_message` (which only settles a row in 'sending') works unchanged.
create or replace function app_private.begin_otp_delivery(p_outbox_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  update public.whatsapp_outbox
     set status = 'sending', attempts = attempts + 1
   where id = p_outbox_id and status = 'queued';
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.begin_otp_delivery(uuid) is
  'Moves one queued WhatsApp OTP message to sending. Returns false if it was already claimed, so a duplicate send is not attempted.';

-- ---------------------------------------------------------------------------------------------------
-- Verifying a submitted code
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.verify_otp_challenge(
  p_challenge_id uuid,
  p_code_hash bytea
) returns text
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
  -- correct code waits here, then sees consumed_at already set.
  select * into v from app_private.otp_challenges c where c.id = p_challenge_id for update;
  if not found then
    return 'not_found';
  end if;
  if v.consumed_at is not null then
    return 'consumed';
  end if;
  if v.expires_at <= now() then
    return 'expired';
  end if;
  if v.attempts >= v.max_attempts then
    return 'too_many_attempts';
  end if;

  if v.code_hash = p_code_hash then
    update app_private.otp_challenges set consumed_at = now() where id = v.id;
    return 'verified';
  end if;

  update app_private.otp_challenges set attempts = attempts + 1 where id = v.id;
  return 'invalid';
end;
$$;

comment on function app_private.verify_otp_challenge(uuid, bytea) is
  'Verifies a submitted code digest against a locked challenge row, consuming it exactly once on success and counting the attempt on failure.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.otp_resend_cooldown(smallint) from public;
revoke execute on function app_private.issue_otp_challenge(text, text, bytea, bytea, text, text, text, uuid, inet, bytea) from public;
revoke execute on function app_private.begin_otp_delivery(uuid) from public;
revoke execute on function app_private.verify_otp_challenge(uuid, bytea) from public;

-- The API role only. The worker does not issue or verify OTPs, and `authenticated` must never reach
-- app_private.
grant execute on function
  app_private.issue_otp_challenge(text, text, bytea, bytea, text, text, text, uuid, inet, bytea),
  app_private.begin_otp_delivery(uuid),
  app_private.verify_otp_challenge(uuid, bytea)
  to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
