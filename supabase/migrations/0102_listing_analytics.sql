-- 0102 — Listing analytics: the rollup 0101's ingestion was built for, and the two surfaces that read it.
--
-- 0101 collects raw listing events and says so in its own header: *"No rollup, no aggregate, no view, no console
-- reader."* Its suite pins that absence by name, down to `hasnt_table('public', 'listing_analytics')`. This
-- migration fills exactly that gap and nothing beside it.
--
-- `analytics.listing.read` has been seeded since 0033 and consumed by **no function** — only by two RLS policies
-- that nothing in this architecture reaches, because `app_system` holds no table privileges and every read goes
-- through a named definer function. This migration makes it a real key for the first time.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT THE DATA ACTUALLY CONTAINS, AND WHY THE SHAPE BELOW FOLLOWS FROM IT
-- ---------------------------------------------------------------------------------------------------
--
-- Four of `listing_events`' columns are **structurally null** in every row this platform can currently produce,
-- and the rollup is shaped around that fact rather than around the column list:
--
--   * `seller_user_id` — 0101 deliberately omits it, and 0013's writer derives nothing, so it is always null.
--     `listing_events_append_only` rejects UPDATE per row, so it can never be backfilled either. The table's own
--     `listing_events_seller_read` policy therefore matches nothing. **Seller attribution comes from
--     `listings.seller_user_id`**, which is `not null`, resolved once here at rollup time.
--   * `promotion_id` — nothing in the repository sends it.
--   * `referrer_host` — nothing in the repository sends it.
--   * `source` — only `search` and `listing` are ever emitted, and the browse surfaces deliberately emit none,
--     because 0101 left the browse taxonomy undecided. So `source` is **not in the grain** (owner decision 1):
--     grouping by a half-populated dimension would write a wrong fact into something a reader groups by.
--
-- And one column is worse than null. 0013 stores `session_hash` as
-- `decode(coalesce(nullif(e ->> 'session_hash', ''), ''), 'hex')`, which for an absent digest yields a
-- **zero-length bytea, not null**. Every anonymous event therefore shares one value, so `count(distinct
-- session_hash)` would report all anonymous traffic as a single session. Unique sessions and unique visitors are
-- **not honestly computable** from this data and are not computed (owner decision 4). Nothing here reads
-- `session_hash` or `user_id` at all.
--
-- ---------------------------------------------------------------------------------------------------
-- THE OWNER DECISIONS THIS MIGRATION ENFORCES
-- ---------------------------------------------------------------------------------------------------
--
-- **1. The grain is `(listing_id, day)`.** No `source`, no promotion, no referrer — see above.
--
-- **2. All four ingested event types get a column**: `clicks`, `contacts`, `favorites`, `shares`. Two of them read
-- zero today, because `favorite` and `share` are accepted by the contract and the constraint and no control on any
-- surface fires them. That is a surfaces gap, not an analytics one, and a fixed shape costs nothing now where
-- adding a column later costs a migration and a contract change.
--
-- **3. The day is a UTC day**, matching `rollup_promotion_analytics`, which also takes the server's `current_date`.
-- Noted rather than hidden: `platform.display_timezone` is seeded `"Africa/Cairo"` (C20), so a stored day and a
-- displayed day can differ by up to three hours at the boundary. Choosing Cairo here would have made the two
-- rollups in this schema disagree with each other, which is worse.
--
-- **4. No unique sessions, no unique visitors** — see above.
--
-- **5. Two read surfaces.** The seller reads their own rows by **ownership**, consuming no permission key, exactly
-- as `seller_promotion_analytics` does. Staff read every row through **`analytics.listing.read`**, with the
-- two-key pattern every other console reader uses.
--
-- **6. The staff surface requires AAL2**, through `roles.requires_mfa` as every other staff reader does.
--
-- **7. A historical backfill is bounded and owner-triggered.** `rollup_listing_analytics(p_day)` takes the day, so
-- a catch-up is one call per day through the existing job machinery. There is **no automatic catch-up loop**: a
-- job that silently reached backwards would turn one missed night into an unbounded scan of the retained window.
--
-- **8. `listing_analytics` is retained indefinitely.** Raw events live 90 days at minimum (0101); the aggregate
-- outliving them is the entire point. No second retention job is added and 0101's window is untouched.
--
-- **9. The rollup runs daily at 02:50 UTC**, after `promotions.rollup` (02:35) and before `partitions.ensure`
-- (03:10). It reads yesterday, which is always far inside the 90-day retention window, so retention at 04:25 can
-- never remove a day before it has been rolled up.
--
-- **10. `listing_id` cascades on delete**, matching `promotion_analytics`. A deleted listing's aggregates go with
-- it; `seller_user_id` carries no foreign key of its own, so the row has exactly one owner.
--
-- **11. The rollup is granted to nobody.** Only `postgres` may execute it, and it is reached solely through
-- `app_private.run_scheduled_job`, which is how 0101's retention job is shaped. `rollup_promotion_analytics` is
-- granted to `app_system` and `app_worker`; that is an older, looser shape and **0025 is not reopened here**.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS NOT HERE
-- ---------------------------------------------------------------------------------------------------
--
-- No `impression` and no `view`: 0101 does not ingest them and their definitions are a Phase 9 decision. No rate,
-- ratio, click-through or conversion — there is no denominator without impressions, and inventing one would be
-- inventing a KPI. No ranking, scoring or promoted-result merge. No new event type, no source taxonomy, no new
-- permission key. No change to `listing_events`, to 0013's writer, to 0101's ingestion or retention, to
-- `promotion_events`, `promotion_analytics`, `rollup_promotion_analytics` or `seller_promotion_analytics`. No
-- public or unauthenticated surface. Nothing financial: no payment, payout, settlement, refund, seller-balance,
-- provider or financial-setting table or function is read or written here.

-- ---------------------------------------------------------------------------------------------------
-- The rollup table
-- ---------------------------------------------------------------------------------------------------
create table public.listing_analytics (
  listing_id uuid not null references public.listings (id) on delete cascade,
  -- Resolved from `listings.seller_user_id` at rollup time, because the event stream's own column is always
  -- null and cannot be backfilled. Deliberately **not** a foreign key: this records who held the listing on
  -- that day, and the row's lifetime is the listing's, which the cascade above already governs.
  seller_user_id uuid not null,
  day date not null,
  clicks bigint not null default 0,
  contacts bigint not null default 0,
  favorites bigint not null default 0,
  shares bigint not null default 0,
  computed_at timestamptz not null default now(),
  primary key (listing_id, day),
  constraint listing_analytics_counts_not_negative check (
    clicks >= 0 and contacts >= 0 and favorites >= 0 and shares >= 0
  )
);
comment on table public.listing_analytics is
  'Daily rollups of the four listing event types 0101 ingests, written only by the pg_cron job and read through the seller and staff analytics services. Recomputable from listing_events while those events are retained, so it is never the authority for anything. Holds no impressions or views (not ingested), no rates, and nothing derived from user_id or session_hash.';
comment on column public.listing_analytics.seller_user_id is
  'The listing owner as of the rollup, from listings.seller_user_id. listing_events.seller_user_id is always null and append-only, so it cannot be used.';
comment on column public.listing_analytics.day is
  'A UTC calendar day, matching promotion_analytics. platform.display_timezone (Africa/Cairo) is a display setting and is not applied here.';

create index listing_analytics_by_seller on public.listing_analytics (seller_user_id, day desc);
create index listing_analytics_by_day on public.listing_analytics (day desc);

-- ---------------------------------------------------------------------------------------------------
-- The rollup
-- ---------------------------------------------------------------------------------------------------
-- One day, recomputed from the stream. Idempotent by construction: the upsert **replaces** the counts rather
-- than adding to them, so running it again for the same day produces the same answer, and a backfill of a day
-- that was already rolled up is safe.
--
-- `count(*)` and not `count(distinct event_id)`: the rows are already de-duplicated at insert, so a re-delivered
-- batch never reached the table twice in the first place. That is true **because of 0107's identity ledger**,
-- which keys on `event_id` alone — not because of 0013's `(event_id, occurred_at)` index, which this comment
-- used to credit and which a re-stamped timestamp defeats. `count(distinct event_id)` was considered in 0107 and
-- rejected as incomplete: duplicates straddling midnight are counted once per day and still total two.
--
-- The half-open window `[target, target + 1)` on the partition key lets the planner prune to the one or two
-- monthly partitions the day lies in.
create or replace function app_private.rollup_listing_analytics(p_day date default null) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target date := coalesce(p_day, (current_date - 1));
  rolled integer;
begin
  insert into public.listing_analytics (
    listing_id, seller_user_id, day, clicks, contacts, favorites, shares, computed_at
  )
  select
    e.listing_id,
    l.seller_user_id,
    target,
    count(*) filter (where e.event_type = 'click'),
    count(*) filter (where e.event_type = 'contact'),
    count(*) filter (where e.event_type = 'favorite'),
    count(*) filter (where e.event_type = 'share'),
    now()
    from public.listing_events e
    -- An inner join on purpose: an event whose listing has been deleted has nothing to attribute, and the
    -- cascade above would remove the row anyway.
    join public.listings l on l.id = e.listing_id
   where e.occurred_at >= target
     and e.occurred_at < target + 1
     -- The four 0101 ingests. `impression` and `view` are permitted by 0013's constraint, are not ingested,
     -- and are excluded here as well so that a future ingestion change cannot silently start counting them
     -- under a definition nobody has agreed.
     and e.event_type in ('click', 'contact', 'favorite', 'share')
   group by e.listing_id, l.seller_user_id
  on conflict (listing_id, day) do update
    set seller_user_id = excluded.seller_user_id,
        clicks = excluded.clicks,
        contacts = excluded.contacts,
        favorites = excluded.favorites,
        shares = excluded.shares,
        computed_at = excluded.computed_at;
  get diagnostics rolled = row_count;
  return rolled;
end;
$$;
comment on function app_private.rollup_listing_analytics(date) is
  'Recomputes one UTC day of listing rollups from listing_events. Idempotent: running it again for the same day overwrites with the same answer, which is also what makes an owner-triggered backfill safe. Reads neither user_id nor session_hash.';

-- ---------------------------------------------------------------------------------------------------
-- The seller surface: ownership, and no permission key
-- ---------------------------------------------------------------------------------------------------
-- The same shape as `seller_promotion_analytics` (0064): an outcome column, `'not_found'` for a caller with no
-- storefront, a window clamped to between a day and a year, and `bigint` sums as text because that is how a
-- 64-bit count crosses a JSON boundary without losing precision.
--
-- It consumes no permission key. A seller reading their own listings' totals is an ownership question, and
-- `analytics.listing.read` is a staff key — handing it to sellers would be the same mistake in reverse.
create or replace function app_private.seller_listing_analytics(p_user_id uuid, p_days integer)
returns table (
  outcome text,
  listing_slug text,
  listing_title text,
  listing_status text,
  first_day date,
  last_day date,
  clicks text,
  contacts text,
  favorites text,
  shares text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_exists boolean;
  -- A window, clamped: a day at least, a year at most. It selects rows and decides nothing about them.
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
begin
  select true into v_seller_exists
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_seller_exists is not true then
    return query select 'not_found'::text, null::text, null::text, null::text, null::date, null::date,
      null::text, null::text, null::text, null::text;
    return;
  end if;

  return query
    select
      'found'::text,
      l.slug,
      l.title,
      l.status,
      min(a.day),
      max(a.day),
      sum(a.clicks)::text,
      sum(a.contacts)::text,
      sum(a.favorites)::text,
      sum(a.shares)::text
      from public.listing_analytics a
      join public.listings l on l.id = a.listing_id
     -- The rollup's own `seller_user_id`, which is the listing owner as of that day. The join to `listings`
     -- is for the slug, the title and the status, never for the ownership test.
     where a.seller_user_id = p_user_id
       and a.day >= (current_date - v_days)
     group by l.slug, l.title, l.status, l.id
     order by max(a.day) desc, l.slug;
end;
$$;
comment on function app_private.seller_listing_analytics(uuid, integer) is
  'The caller''s own listings'' rollup totals over a recent window. Ownership-scoped and consumes no permission key. Returns no identifier: no listing id, no seller id, no user id and nothing derived from session_hash.';

-- ---------------------------------------------------------------------------------------------------
-- The staff surface: the first consumer of analytics.listing.read
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.listing_analytics_can_read(p_user_id uuid, p_is_aal2 boolean)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
      join public.role_permissions rp on rp.role_key = r.key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
       and rp.permission_key = 'analytics.listing.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;
comment on function app_private.listing_analytics_can_read(uuid, boolean) is
  'Whether this caller may read listing analytics across the platform: analytics.listing.read on a live, unexpired, unrevoked role, with AAL2 where the role requires MFA. The first consumer of a key seeded in 0033.';

-- A page of the rollup, newest day first, keyed by `(day, listing_id)` so the cursor is total and stable.
--
-- A caller who may not read gets **no rows at all**, which is the same answer as a window with nothing in it:
-- the refusal and the absence are indistinguishable, so the surface is not an oracle for whether any listing
-- has traffic. The limit is clamped here rather than trusted.
create or replace function app_private.listing_analytics_page(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_days integer,
  p_limit integer,
  p_cursor_day date default null,
  p_cursor_listing_id uuid default null
)
returns table (
  day date,
  listing_slug text,
  listing_title text,
  listing_status text,
  seller_slug text,
  clicks text,
  contacts text,
  favorites text,
  shares text,
  computed_at timestamptz,
  cursor_day date,
  cursor_listing_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if not app_private.listing_analytics_can_read(p_user_id, p_is_aal2) then
    return;
  end if;

  return query
    select
      a.day,
      l.slug,
      l.title,
      l.status,
      -- The storefront's public address, which is how staff identify a seller everywhere in this console.
      -- Never the account identifier.
      s.slug,
      a.clicks::text,
      a.contacts::text,
      a.favorites::text,
      a.shares::text,
      a.computed_at,
      a.day,
      a.listing_id
      from public.listing_analytics a
      join public.listings l on l.id = a.listing_id
      left join public.seller_profiles s on s.user_id = a.seller_user_id
     where a.day >= (current_date - v_days)
       and (
         p_cursor_day is null
         or p_cursor_listing_id is null
         or (a.day, a.listing_id) < (p_cursor_day, p_cursor_listing_id)
       )
     order by a.day desc, a.listing_id desc
     limit v_limit;
end;
$$;
comment on function app_private.listing_analytics_page(uuid, boolean, integer, integer, date, uuid) is
  'A page of listing rollups for staff holding analytics.listing.read, newest day first. Returns nothing at all when the caller may not read, so a refusal reads as an absence. Carries no account identifier, no session digest and no raw event.';

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
-- Required of every table in `public` by `rls_problems()`, and belt-and-braces here: nothing in this
-- architecture reaches the table as `authenticated`, because `app_system` holds no table privileges and the two
-- readers above are the only paths. The policy mirrors `promotion_analytics_read`: the owner, or staff holding
-- the key.
alter table public.listing_analytics enable row level security;

create policy listing_analytics_read on public.listing_analytics for select to authenticated
  using (
    seller_user_id = public.current_user_id()
    or public.has_permission('analytics.listing.read')
  );

grant select on public.listing_analytics to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Execution
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

-- Owner decision 11: the rollup is granted to nobody and is reachable only through the dispatcher.
revoke execute on function app_private.rollup_listing_analytics(date) from public, app_worker;

revoke execute on function app_private.seller_listing_analytics(uuid, integer) from public, app_worker;
revoke execute on function app_private.listing_analytics_can_read(uuid, boolean) from public, app_worker;
revoke execute on function app_private.listing_analytics_page(uuid, boolean, integer, integer, date, uuid)
  from public, app_worker;

-- `app_system` reads; the worker neither reads nor rolls up. The rollup runs as the definer through
-- `run_scheduled_job`, so it needs no grant of its own, and giving it one would be a second way in.
grant execute on function app_private.seller_listing_analytics(uuid, integer) to app_system;
grant execute on function app_private.listing_analytics_can_read(uuid, boolean) to app_system;
grant execute on function app_private.listing_analytics_page(uuid, boolean, integer, integer, date, uuid)
  to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The scheduled job (owner decision 9)
-- ---------------------------------------------------------------------------------------------------
insert into app_private.scheduled_job_contract (job_key, cron_schedule, target_signature, purpose)
values (
  'listing_analytics.rollup',
  '50 2 * * *',
  'app_private.rollup_listing_analytics(null)',
  'owner decision 9: rolls yesterday''s listing events into listing_analytics'
)
on conflict (job_key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- The dispatcher, with one branch added
-- ---------------------------------------------------------------------------------------------------
-- Recreated from the **live function body**, not reconstructed from the migration that first wrote it. The
-- body has changed since: it no longer re-raises (pg_cron gives each command its own transaction, so a
-- re-raise would roll back the row recording the failure), it records failures through the six-argument
-- `finish_job_run` and returns `-1`, and it dispatches `security.assert_contract` directly. Rebuilding it
-- from memory would have broken failure recording for every job in the catalogue.
--
-- `job_runs` therefore needs nothing from this migration: `start_job_run` opens exactly one row per
-- occurrence at status `running`, success closes it with the rollup's row count as `processed_count`, and a
-- failure closes it as `failed` with `sqlstate_<code>`. One row per occurrence, always.
CREATE OR REPLACE FUNCTION app_private.run_scheduled_job(p_job_key text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
set search_path = pg_catalog, public
AS $function$
declare
  run_id uuid;
  processed integer;
begin
  if not exists (select 1 from app_private.scheduled_job_contract k where k.job_key = p_job_key) then
    raise exception '% is not a scheduled job', p_job_key using errcode = 'invalid_parameter_value';
  end if;

  run_id := app_private.start_job_run(p_job_key);
  if run_id is null then
    return 0;
  end if;

  begin
    processed := case p_job_key
      when 'promotions.start'        then app_private.start_due_promotions(500)
      when 'promotions.expire'       then app_private.expire_due_promotions(500)
      when 'reservations.release'    then app_private.release_expired_reservations(500)
      when 'payment_attempts.expire' then app_private.expire_due_payment_attempts(200)
      when 'offers.expire'           then app_private.expire_due_offers(500)
      when 'service_quotes.expire'   then app_private.expire_due_service_quotes(500)
      when 'cms.publish_due'         then app_private.publish_due_content()
      when 'service_orders.complete' then app_private.complete_due_service_orders(200)
      when 'seller_balances.release' then app_private.release_seller_holds(500)
      when 'promotions.rollup'       then app_private.rollup_promotion_analytics(null)
      when 'partitions.ensure'       then app_private.ensure_event_partitions(3)
      when 'security.assert_contract' then app_private.assert_security_contract()
      -- 7-J, D7-09.
      when 'service_requests.payment_info_purge'
        then app_private.purge_due_payment_information(500)
      -- 0101, owner decision 7. The only branch this migration adds.
      when 'listing_events.retention'
        then app_private.drop_expired_listing_event_partitions(90)
      -- 0102, owner decision 9. The only branch this migration adds.
      when 'listing_analytics.rollup'
        then app_private.rollup_listing_analytics(null)
    end;
  exception when others then
    -- pg_cron gives each command its own transaction, so re-raising would roll back the very row that
    -- records the failure. The durable record is the job_runs row; the schedule carries on.
    --
    -- `error_type` is prefixed because 0007 constrains it to `^[A-Za-z][A-Za-z0-9_]*$` and a SQLSTATE
    -- such as `22023` starts with a digit: writing the bare code makes the failure record itself fail,
    -- which would lose the very thing it is meant to keep. The unprefixed code is in `details`.
    perform app_private.finish_job_run(run_id, 'failed', null, format('sqlstate_%s', sqlstate),
      jsonb_build_object('job_key', p_job_key, 'sqlstate', sqlstate, 'message', left(sqlerrm, 500)));
    return -1;
  end;

  perform app_private.finish_job_run(run_id, 'succeeded', processed,
    null, jsonb_build_object('job_key', p_job_key));
  return coalesce(processed, 0);
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- 0032's own block, re-run, so the catalogue matches the contract and `cron_job_problems()` stays empty.
-- `cron.schedule()` upserts on the job name; any `marketplace.*` job the contract no longer names is
-- unscheduled first.
do $$
declare
  stale text;
  entry app_private.scheduled_job_contract%rowtype;
begin
  for stale in
    select j.jobname from cron.job j
     where j.jobname like 'marketplace.%'
       and not exists (select 1 from app_private.scheduled_job_contract k
                        where 'marketplace.' || k.job_key = j.jobname)
  loop
    perform cron.unschedule(stale);
  end loop;

  for entry in select * from app_private.scheduled_job_contract order by job_key loop
    perform cron.schedule(
      'marketplace.' || entry.job_key,
      entry.cron_schedule,
      format('select app_private.run_scheduled_job(%L)', entry.job_key)
    );
  end loop;
end;
$$;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
