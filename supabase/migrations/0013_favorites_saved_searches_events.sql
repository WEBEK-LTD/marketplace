-- 0013 — Favorites, saved searches and listing analytics events (v5.2 migration plan).
--
-- Favorites and saved searches are durable user data. `listing_events` is the analytics stream: the API
-- writes through Redis to a worker consumer group that inserts in batches, and inserts directly into
-- PostgreSQL while Redis is unavailable. Delivery is at-least-once, so every event carries an `event_id`
-- and the unique key on it makes a repeated insert a no-op rather than a double count.
--
-- `listing_events` is partitioned by month (v5.2 "Monthly partitions") and append-only. The generic
-- partition helper introduced here is reused by `promotion_events` in 0025.

-- ---------------------------------------------------------------------------------------------------
-- Favorites
-- ---------------------------------------------------------------------------------------------------
create table public.favorites (
  user_id uuid not null references auth.users (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);
comment on table public.favorites is 'Listings a user saved. Counts are derived from this durable table, never from the analytics stream.';
create index favorites_by_listing on public.favorites (listing_id, created_at desc);

-- ---------------------------------------------------------------------------------------------------
-- Saved searches
-- ---------------------------------------------------------------------------------------------------
create table public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  query jsonb not null,
  notify boolean not null default false,
  last_notified_at timestamptz,
  last_matched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_searches_name_length check (length(btrim(name)) between 1 and 120),
  constraint saved_searches_query_is_object check (jsonb_typeof(query) = 'object'),
  constraint saved_searches_query_size check (pg_column_size(query) <= 8192),
  unique (user_id, name)
);
comment on table public.saved_searches is 'A stored search, optionally with new-match notifications. `query` holds the search parameters, never results.';
create index saved_searches_notifying on public.saved_searches (user_id) where notify;
create trigger saved_searches_set_updated_at before update on public.saved_searches
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Monthly partition helper
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.ensure_month_partitions(
  p_schema name,
  p_table name,
  p_months_ahead integer default 3
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  offset_month integer;
  month_start date;
  partition_name text;
  created integer := 0;
begin
  if p_months_ahead < 0 or p_months_ahead > 24 then
    raise exception 'p_months_ahead must be between 0 and 24';
  end if;
  if to_regclass(format('%I.%I', p_schema, p_table)) is null then
    raise exception '%.% does not exist', p_schema, p_table;
  end if;
  for offset_month in -1 .. p_months_ahead loop
    month_start := (date_trunc('month', now()) + make_interval(months => offset_month))::date;
    partition_name := format('%s_%s', p_table, to_char(month_start, 'YYYYMM'));
    if to_regclass(format('%I.%I', p_schema, partition_name)) is null then
      execute format(
        'create table %I.%I partition of %I.%I for values from (%L) to (%L)',
        p_schema, partition_name, p_schema, p_table,
        month_start, (month_start + interval '1 month')::date
      );
      execute format('alter table %I.%I enable row level security', p_schema, partition_name);
      execute format('revoke all on %I.%I from public, anon, authenticated', p_schema, partition_name);
      created := created + 1;
    end if;
  end loop;
  return created;
end;
$$;
comment on function app_private.ensure_month_partitions(name, name, integer) is
  'Creates the monthly partitions around today for a range-partitioned table, with RLS enabled on each. Idempotent; scheduled by pg_cron in 0032.';

-- ---------------------------------------------------------------------------------------------------
-- Listing events
-- ---------------------------------------------------------------------------------------------------
create table public.listing_events (
  id bigint generated always as identity,
  event_id uuid not null,
  listing_id uuid not null,
  seller_user_id uuid,
  event_type text not null,
  occurred_at timestamptz not null default now(),
  user_id uuid,
  session_hash bytea,
  source text,
  referrer_host text,
  promotion_id uuid,
  primary key (id, occurred_at),
  constraint listing_events_type_allowed check (event_type in ('impression', 'view', 'click', 'contact', 'favorite', 'share')),
  constraint listing_events_source_allowed check (source is null or source in ('search', 'category', 'listing', 'seller', 'home', 'external')),
  constraint listing_events_referrer_host_length check (referrer_host is null or length(referrer_host) <= 255)
) partition by range (occurred_at);
comment on table public.listing_events is
  'At-least-once analytics stream, deduplicated by `event_id`. Carries identifiers and a hashed session only — never an IP address or a raw session id.';

-- Deduplication: the partition key must be part of the unique key on a partitioned table.
create unique index listing_events_event_id on public.listing_events (event_id, occurred_at);
create index listing_events_listing on public.listing_events (listing_id, occurred_at desc);
create index listing_events_seller on public.listing_events (seller_user_id, occurred_at desc);
create index listing_events_promotion on public.listing_events (promotion_id, occurred_at desc) where promotion_id is not null;
create trigger listing_events_append_only before update or delete on public.listing_events
  for each row execute function app_private.tg_reject_write();

select app_private.ensure_month_partitions('public', 'listing_events', 3);

create or replace function app_private.record_listing_events(p_events jsonb) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  inserted integer;
begin
  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'record_listing_events expects a JSON array of events';
  end if;
  insert into public.listing_events (event_id, listing_id, seller_user_id, event_type, occurred_at, user_id, session_hash, source, referrer_host, promotion_id)
  select
    (e ->> 'event_id')::uuid,
    (e ->> 'listing_id')::uuid,
    nullif(e ->> 'seller_user_id', '')::uuid,
    e ->> 'event_type',
    coalesce(nullif(e ->> 'occurred_at', '')::timestamptz, now()),
    nullif(e ->> 'user_id', '')::uuid,
    decode(coalesce(nullif(e ->> 'session_hash', ''), ''), 'hex'),
    nullif(e ->> 'source', ''),
    nullif(e ->> 'referrer_host', ''),
    nullif(e ->> 'promotion_id', '')::uuid
  from jsonb_array_elements(p_events) as e
  on conflict (event_id, occurred_at) do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;
comment on function app_private.record_listing_events(jsonb) is
  'Batched insert used by the analytics consumer and by the degraded direct path. Repeats are dropped by event id.';

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.favorites enable row level security;
alter table public.saved_searches enable row level security;
alter table public.listing_events enable row level security;

create policy favorites_self_all on public.favorites for all to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id() and public.listing_is_visible(listing_id));

create policy saved_searches_self_all on public.saved_searches for all to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

-- A seller sees the events of their own listings; nobody else reads the stream directly.
create policy listing_events_seller_read on public.listing_events for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy listing_events_admin_read on public.listing_events for select to authenticated
  using (public.has_permission('analytics.listing.read'));

grant select, insert, delete on public.favorites to authenticated;
grant select, insert, update, delete on public.saved_searches to authenticated;
grant select on public.listing_events to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  app_private.record_listing_events(jsonb),
  app_private.ensure_month_partitions(name, name, integer)
  to app_system, app_worker;
