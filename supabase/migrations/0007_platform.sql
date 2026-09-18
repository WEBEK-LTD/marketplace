-- 0007 — Platform kernel: transactional outbox, idempotency keys and job runs (v5.2 migration plan).
--
-- The outbox is the only bridge between a database transaction and the queue:
--   1. the business transaction commits the event with the rest of its work;
--   2. the relay claims unpublished events and publishes them to BullMQ;
--   3. a worker processes the event and records completion by event id;
--   4. the sweeper re-publishes events that were published but never completed after a threshold;
--   5. poison events are dead-lettered and stop being re-published.
--
-- Payloads carry identifiers only. No table here is reachable directly: every access goes through the
-- SECURITY DEFINER functions below, so `app_system` and `app_worker` need no table privileges.

-- ---------------------------------------------------------------------------------------------------
-- Outbox
-- ---------------------------------------------------------------------------------------------------
create table public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  published_at timestamptz,
  completed_at timestamptz,
  dead_lettered_at timestamptz,
  attempts integer not null default 0,
  last_error_type text,
  created_by uuid references auth.users (id) on delete set null,
  constraint outbox_events_aggregate_type_format check (aggregate_type ~ '^[a-z][a-z0-9_]*$'),
  constraint outbox_events_event_type_format check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  constraint outbox_events_aggregate_id_present check (length(btrim(aggregate_id)) between 1 and 200),
  constraint outbox_events_payload_is_object check (jsonb_typeof(payload) = 'object'),
  constraint outbox_events_payload_size check (pg_column_size(payload) <= 8192),
  constraint outbox_events_attempts_positive check (attempts >= 0),
  constraint outbox_events_completion_needs_publish check (completed_at is null or published_at is not null),
  constraint outbox_events_not_completed_and_dead check (completed_at is null or dead_lettered_at is null),
  constraint outbox_events_error_type_format check (last_error_type is null or last_error_type ~ '^[A-Za-z][A-Za-z0-9_]*$')
);
comment on table public.outbox_events is
  'Transactional outbox. Payloads carry identifiers only — never message bodies, credentials or personal data.';
comment on column public.outbox_events.last_error_type is
  'Error class name only. Error messages and stack traces are never stored (Step 4 dead-letter decision).';

create index outbox_events_pending on public.outbox_events (available_at, id)
  where published_at is null and dead_lettered_at is null;
create index outbox_events_in_flight on public.outbox_events (published_at)
  where published_at is not null and completed_at is null and dead_lettered_at is null;
create index outbox_events_aggregate on public.outbox_events (aggregate_type, aggregate_id, occurred_at);
create index outbox_events_dead_lettered on public.outbox_events (dead_lettered_at desc) where dead_lettered_at is not null;

create or replace function public.enqueue_outbox_event(
  p_aggregate_type text,
  p_aggregate_id text,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb,
  p_available_at timestamptz default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  insert into public.outbox_events (aggregate_type, aggregate_id, event_type, payload, available_at, created_by)
  values (
    p_aggregate_type,
    p_aggregate_id,
    p_event_type,
    coalesce(p_payload, '{}'::jsonb),
    coalesce(p_available_at, now()),
    public.current_user_id()
  )
  returning id into new_id;
  return new_id;
end;
$$;
comment on function public.enqueue_outbox_event(text, text, text, jsonb, timestamptz) is
  'Appends an outbox event inside the caller''s transaction. The event is published only if that transaction commits.';

create or replace function app_private.claim_outbox_events(p_limit integer default 100)
returns table (
  id uuid,
  aggregate_type text,
  aggregate_id text,
  event_type text,
  payload jsonb,
  occurred_at timestamptz,
  attempts integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception 'p_limit must be between 1 and 1000';
  end if;
  return query
  with claimed as (
    select e.id
    from public.outbox_events e
    where e.published_at is null
      and e.dead_lettered_at is null
      and e.available_at <= now()
    order by e.available_at, e.id
    limit p_limit
    for update skip locked
  )
  update public.outbox_events e
     set published_at = now(),
         attempts = e.attempts + 1
    from claimed
   where e.id = claimed.id
  returning e.id, e.aggregate_type, e.aggregate_id, e.event_type, e.payload, e.occurred_at, e.attempts;
end;
$$;
comment on function app_private.claim_outbox_events(integer) is
  'Relay step: marks a batch as published and returns it. SKIP LOCKED keeps concurrent relays from claiming the same event.';

create or replace function app_private.complete_outbox_event(p_id uuid) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  update public.outbox_events
     set completed_at = now()
   where id = p_id and completed_at is null and dead_lettered_at is null;
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;
comment on function app_private.complete_outbox_event(uuid) is
  'Records handler completion by event id. Repeating it is a no-op, so handlers stay idempotent.';

create or replace function app_private.sweep_outbox_events(
  p_stale_after interval default interval '5 minutes',
  p_limit integer default 100
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  swept integer;
begin
  with stale as (
    select e.id
    from public.outbox_events e
    where e.published_at is not null
      and e.published_at < now() - p_stale_after
      and e.completed_at is null
      and e.dead_lettered_at is null
    order by e.published_at
    limit p_limit
    for update skip locked
  )
  update public.outbox_events e
     set published_at = null,
         available_at = now()
    from stale
   where e.id = stale.id;
  get diagnostics swept = row_count;
  return swept;
end;
$$;
comment on function app_private.sweep_outbox_events(interval, integer) is
  'Sweeper step: returns events with no recorded completion to the pending state so the relay publishes them again.';

create or replace function app_private.dead_letter_outbox_event(p_id uuid, p_error_type text) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  update public.outbox_events
     set dead_lettered_at = now(),
         last_error_type = p_error_type
   where id = p_id and completed_at is null and dead_lettered_at is null;
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;
comment on function app_private.dead_letter_outbox_event(uuid, text) is
  'Stops re-publishing a poison event. Only the error class is stored, never the message or stack trace.';

-- ---------------------------------------------------------------------------------------------------
-- Idempotency keys
-- ---------------------------------------------------------------------------------------------------
create table public.idempotency_keys (
  scope text not null,
  idempotency_key text not null,
  user_id uuid references auth.users (id) on delete cascade,
  request_hash bytea not null,
  status text not null default 'in_progress',
  response_status smallint,
  response_body jsonb,
  resource_type text,
  resource_id text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null,
  primary key (scope, idempotency_key),
  constraint idempotency_keys_scope_format check (scope ~ '^[a-z][a-z0-9_.]*$'),
  constraint idempotency_keys_key_length check (length(idempotency_key) between 8 and 255),
  constraint idempotency_keys_status_allowed check (status in ('in_progress', 'succeeded', 'failed')),
  constraint idempotency_keys_completion check ((status = 'in_progress') = (completed_at is null)),
  constraint idempotency_keys_response_status_range check (response_status is null or response_status between 100 and 599),
  constraint idempotency_keys_expiry_after_creation check (expires_at > created_at)
);
comment on table public.idempotency_keys is
  'Replay protection for unsafe API requests. `request_hash` lets a repeat with different content be rejected instead of replayed.';
create index idempotency_keys_expiry on public.idempotency_keys (expires_at);
create index idempotency_keys_user on public.idempotency_keys (user_id, created_at desc);

create or replace function public.claim_idempotency_key(
  p_scope text,
  p_key text,
  p_request_hash bytea,
  p_ttl interval default interval '24 hours'
) returns table (claimed boolean, status text, response_status smallint, response_body jsonb, resource_type text, resource_id text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing public.idempotency_keys;
begin
  insert into public.idempotency_keys (scope, idempotency_key, user_id, request_hash, expires_at)
  values (p_scope, p_key, public.current_user_id(), p_request_hash, now() + p_ttl)
  on conflict (scope, idempotency_key) do nothing;

  if found then
    return query select true, 'in_progress'::text, null::smallint, null::jsonb, null::text, null::text;
    return;
  end if;

  select * into existing from public.idempotency_keys k
   where k.scope = p_scope and k.idempotency_key = p_key;

  if existing.request_hash is distinct from p_request_hash then
    raise exception 'idempotency key % reused with a different request', p_key using errcode = 'unique_violation';
  end if;

  return query select false, existing.status, existing.response_status, existing.response_body, existing.resource_type, existing.resource_id;
end;
$$;
comment on function public.claim_idempotency_key(text, text, bytea, interval) is
  'Claims a key for a new request, or returns the stored outcome of the first one. A different request under the same key is rejected.';

create or replace function public.complete_idempotency_key(
  p_scope text,
  p_key text,
  p_status text,
  p_response_status smallint default null,
  p_response_body jsonb default null,
  p_resource_type text default null,
  p_resource_id text default null
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'idempotency completion status must be succeeded or failed';
  end if;
  update public.idempotency_keys
     set status = p_status,
         response_status = p_response_status,
         response_body = p_response_body,
         resource_type = p_resource_type,
         resource_id = p_resource_id,
         completed_at = now()
   where scope = p_scope and idempotency_key = p_key and status = 'in_progress';
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Job runs
-- ---------------------------------------------------------------------------------------------------
create table public.job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  scheduled_for timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  error_type text,
  processed_count integer,
  details jsonb not null default '{}'::jsonb,
  constraint job_runs_name_format check (job_name ~ '^[a-z][a-z0-9_.]*$'),
  constraint job_runs_status_allowed check (status in ('running', 'succeeded', 'failed', 'skipped')),
  constraint job_runs_finished_when_done check ((status = 'running') = (finished_at is null)),
  constraint job_runs_finish_after_start check (finished_at is null or finished_at >= started_at),
  constraint job_runs_details_is_object check (jsonb_typeof(details) = 'object'),
  constraint job_runs_error_type_format check (error_type is null or error_type ~ '^[A-Za-z][A-Za-z0-9_]*$')
);
comment on table public.job_runs is 'One row per scheduled job execution (v5.2: "Every job writes to job_runs").';
create unique index job_runs_scheduled_once on public.job_runs (job_name, scheduled_for) where scheduled_for is not null;
create index job_runs_recent on public.job_runs (job_name, started_at desc);

create or replace function app_private.start_job_run(p_job_name text, p_scheduled_for timestamptz default null) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  insert into public.job_runs (job_name, scheduled_for)
  values (p_job_name, p_scheduled_for)
  on conflict do nothing
  returning id into new_id;
  return new_id;
end;
$$;
comment on function app_private.start_job_run(text, timestamptz) is
  'Starts a job run. Returns NULL when the same scheduled run already exists, so a job never runs twice.';

create or replace function app_private.finish_job_run(
  p_id uuid,
  p_status text,
  p_processed_count integer default null,
  p_error_type text default null,
  p_details jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  update public.job_runs
     set status = p_status,
         finished_at = now(),
         processed_count = p_processed_count,
         error_type = p_error_type,
         details = coalesce(p_details, '{}'::jsonb)
   where id = p_id and status = 'running';
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.outbox_events enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.job_runs enable row level security;

-- The outbox and idempotency tables have no policies: they are reachable only through the functions above.
create policy job_runs_admin_read on public.job_runs for select to authenticated
  using (public.has_permission('platform.job.read'));

grant select on public.job_runs to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.enqueue_outbox_event(text, text, text, jsonb, timestamptz),
  public.claim_idempotency_key(text, text, bytea, interval),
  public.complete_idempotency_key(text, text, text, smallint, jsonb, text, text)
  to authenticated;

grant execute on function
  public.enqueue_outbox_event(text, text, text, jsonb, timestamptz),
  app_private.claim_outbox_events(integer),
  app_private.complete_outbox_event(uuid),
  app_private.sweep_outbox_events(interval, integer),
  app_private.dead_letter_outbox_event(uuid, text),
  app_private.start_job_run(text, timestamptz),
  app_private.finish_job_run(uuid, text, integer, text, jsonb)
  to app_system, app_worker;
