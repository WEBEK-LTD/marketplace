-- 0004 — Auth security state (v5.2 migration plan: `app_private` auth tables, known_devices,
-- security_events, step_up_grants; `mfa_backup_codes` is conditional on O-1).
--
-- `app_private` holds everything an attacker must never reach: challenge and reset material, rate-limit
-- counters, login attempts and lockouts. No application role is granted anything in this schema; the API
-- reaches it only through the SECURITY DEFINER functions defined here.
--
-- Nothing in this migration stores a secret in clear. Codes, tokens, destinations, devices and rate-limit
-- subjects are stored as hashes produced by the API; the column types say `bytea` to make that explicit.
--
-- NOT BUILT HERE: `mfa_backup_codes`. v5.2 marks it conditional on O-1, and D9's implementation is
-- BLOCKED by the AUTH-4/AUTH-5 spikes. Per the data-architecture rule, conditional tables are not built
-- until the item closes.

-- ---------------------------------------------------------------------------------------------------
-- One-time codes and password resets
-- ---------------------------------------------------------------------------------------------------
create table app_private.otp_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  purpose text not null,
  channel text not null,
  destination_hash bytea not null,
  code_hash bytea not null,
  attempts smallint not null default 0,
  max_attempts smallint not null default 5,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  request_ip inet,
  constraint otp_challenges_purpose_allowed check (purpose in ('login', 'step_up', 'email_verify', 'phone_verify', 'recovery')),
  constraint otp_challenges_channel_allowed check (channel in ('email', 'sms', 'whatsapp')),
  constraint otp_challenges_attempts_range check (attempts >= 0 and attempts <= max_attempts),
  constraint otp_challenges_max_attempts_range check (max_attempts between 1 and 10),
  constraint otp_challenges_expiry_after_creation check (expires_at > created_at)
);
comment on table app_private.otp_challenges is 'One-time codes. Destination and code are stored hashed; the clear values never reach the database.';
create index otp_challenges_open on app_private.otp_challenges (user_id, purpose, expires_at) where consumed_at is null;
create index otp_challenges_expiry on app_private.otp_challenges (expires_at);

create table app_private.password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash bytea not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  request_ip inet,
  constraint password_reset_tokens_expiry_after_creation check (expires_at > created_at)
);
create unique index password_reset_tokens_hash on app_private.password_reset_tokens (token_hash);
create index password_reset_tokens_open on app_private.password_reset_tokens (user_id, expires_at) where consumed_at is null;

-- ---------------------------------------------------------------------------------------------------
-- Rate limits
-- ---------------------------------------------------------------------------------------------------
create table app_private.rate_limits (
  bucket text not null,
  subject_hash bytea not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (bucket, subject_hash, window_start),
  constraint rate_limits_bucket_format check (bucket ~ '^[a-z][a-z0-9_.]*$'),
  constraint rate_limits_hits_positive check (hits >= 0)
);
comment on table app_private.rate_limits is 'Fixed-window counters for auth-sensitive operations. Redis is a cache, never the source of truth.';
create index rate_limits_window on app_private.rate_limits (window_start);

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
  window_start timestamptz := to_timestamp(floor(extract(epoch from now()) / extract(epoch from p_window)) * extract(epoch from p_window));
  current_hits integer;
begin
  if p_limit < 1 then
    raise exception 'rate limit must be at least 1';
  end if;
  insert into app_private.rate_limits (bucket, subject_hash, window_start, hits, updated_at)
  values (p_bucket, p_subject_hash, window_start, 1, now())
  on conflict (bucket, subject_hash, window_start)
    do update set hits = app_private.rate_limits.hits + 1, updated_at = now()
  returning hits into current_hits;
  return current_hits <= p_limit;
end;
$$;
comment on function app_private.rate_limit_hit(text, bytea, interval, integer) is
  'Counts one attempt in the current fixed window and reports whether it is still within the limit.';

-- ---------------------------------------------------------------------------------------------------
-- Login attempts and lockouts
-- ---------------------------------------------------------------------------------------------------
create table app_private.login_attempts (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  identifier_hash bytea not null,
  succeeded boolean not null,
  failure_reason text,
  request_ip inet,
  user_agent_hash bytea,
  created_at timestamptz not null default now(),
  constraint login_attempts_failure_reason_only_on_failure check (succeeded or failure_reason is not null)
);
create index login_attempts_identifier on app_private.login_attempts (identifier_hash, created_at desc);
create index login_attempts_user on app_private.login_attempts (user_id, created_at desc);

create table app_private.account_lockouts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  locked_at timestamptz not null default now(),
  locked_until timestamptz,
  reason text not null,
  failed_attempts integer not null default 0,
  released_at timestamptz,
  released_by uuid references auth.users (id) on delete set null,
  constraint account_lockouts_reason_present check (length(btrim(reason)) > 0),
  constraint account_lockouts_release_order check (released_at is null or released_at >= locked_at),
  constraint account_lockouts_until_after_lock check (locked_until is null or locked_until > locked_at)
);
comment on table app_private.account_lockouts is 'Active lockouts. A row with released_at set is history; absence of a row means the account is not locked.';

create or replace function app_private.is_account_locked(p_user_id uuid) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from app_private.account_lockouts l
    where l.user_id = p_user_id
      and l.released_at is null
      and (l.locked_until is null or l.locked_until > now())
  );
$$;

-- ---------------------------------------------------------------------------------------------------
-- Known devices
-- ---------------------------------------------------------------------------------------------------
create table public.known_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_hash bytea not null,
  label text,
  platform text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_ip inet,
  trusted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint known_devices_label_length check (label is null or length(label) <= 100),
  constraint known_devices_seen_order check (last_seen_at >= first_seen_at)
);
comment on table public.known_devices is 'Devices a user has signed in from. The device identifier is stored hashed.';
create unique index known_devices_user_device on public.known_devices (user_id, device_hash);
create index known_devices_active on public.known_devices (user_id, last_seen_at desc) where revoked_at is null;
create trigger known_devices_set_updated_at before update on public.known_devices
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Security events (append-only)
-- ---------------------------------------------------------------------------------------------------
create table public.security_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  event_type text not null,
  occurred_at timestamptz not null default now(),
  device_id uuid references public.known_devices (id) on delete set null,
  request_ip inet,
  details jsonb not null default '{}'::jsonb,
  constraint security_events_type_format check (event_type ~ '^[a-z][a-z0-9_.]*$'),
  constraint security_events_details_is_object check (jsonb_typeof(details) = 'object')
);
comment on table public.security_events is
  'Append-only security timeline shown to the user. `details` carries identifiers only, never credentials or message bodies.';
create index security_events_user on public.security_events (user_id, occurred_at desc);
create index security_events_type on public.security_events (event_type, occurred_at desc);
create trigger security_events_append_only before update or delete on public.security_events
  for each row execute function app_private.tg_reject_write();

create or replace function public.record_security_event(
  p_event_type text,
  p_details jsonb default '{}'::jsonb,
  p_device_id uuid default null,
  p_request_ip inet default null
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor uuid := public.current_user_id();
  new_id bigint;
begin
  if actor is null then
    raise exception 'record_security_event needs an authenticated caller' using errcode = 'insufficient_privilege';
  end if;
  if p_device_id is not null and not exists (
    select 1 from public.known_devices d where d.id = p_device_id and d.user_id = actor
  ) then
    raise exception 'device does not belong to the current user' using errcode = 'insufficient_privilege';
  end if;
  insert into public.security_events (user_id, event_type, device_id, request_ip, details)
  values (actor, p_event_type, p_device_id, p_request_ip, coalesce(p_details, '{}'::jsonb))
  returning id into new_id;
  return new_id;
end;
$$;
comment on function public.record_security_event(text, jsonb, uuid, inet) is
  'Records a security event for the current user. The actor is taken from the verified claims, never from an argument.';

-- ---------------------------------------------------------------------------------------------------
-- Step-up grants
-- ---------------------------------------------------------------------------------------------------
create table public.step_up_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  operation text not null,
  granted_via text not null,
  challenge_id uuid references app_private.otp_challenges (id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint step_up_grants_operation_format check (operation ~ '^[a-z][a-z0-9_.]*$'),
  constraint step_up_grants_via_allowed check (granted_via in ('totp', 'otp_email', 'otp_sms')),
  constraint step_up_grants_expiry_after_grant check (expires_at > granted_at)
);
comment on table public.step_up_grants is
  'Short-lived permission to perform one sensitive operation. A backup code never issues a grant (D9).';
create index step_up_grants_open on public.step_up_grants (user_id, operation, expires_at) where consumed_at is null;

create or replace function public.has_step_up_grant(p_operation text) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.step_up_grants g
    where g.user_id = public.current_user_id()
      and g.operation = p_operation
      and g.consumed_at is null
      and g.expires_at > now()
  );
$$;
comment on function public.has_step_up_grant(text) is 'True while the current user holds an unconsumed, unexpired grant for the operation.';

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table app_private.otp_challenges enable row level security;
alter table app_private.password_reset_tokens enable row level security;
alter table app_private.rate_limits enable row level security;
alter table app_private.login_attempts enable row level security;
alter table app_private.account_lockouts enable row level security;
alter table public.known_devices enable row level security;
alter table public.security_events enable row level security;
alter table public.step_up_grants enable row level security;

-- app_private tables carry no policies and no grants: they are reachable only through the SECURITY
-- DEFINER functions above.

create policy known_devices_self_read on public.known_devices for select to authenticated
  using (user_id = public.current_user_id());
create policy known_devices_self_update on public.known_devices for update to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

create policy security_events_self_read on public.security_events for select to authenticated
  using (user_id = public.current_user_id());
create policy security_events_admin_read on public.security_events for select to authenticated
  using (public.has_permission('users.security.read'));

create policy step_up_grants_self_read on public.step_up_grants for select to authenticated
  using (user_id = public.current_user_id());

grant select, update on public.known_devices to authenticated;
grant select on public.security_events to authenticated;
grant select on public.step_up_grants to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.record_security_event(text, jsonb, uuid, inet),
  public.has_step_up_grant(text)
  to authenticated;

grant execute on function
  app_private.rate_limit_hit(text, bytea, interval, integer),
  app_private.is_account_locked(uuid)
  to app_system, app_worker;
