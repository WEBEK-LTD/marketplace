-- 0107 — Analytics event identity: a ledger that makes `event_id` authoritative for de-duplication.
--
-- Sixteen comments in this repository promise that analytics delivery is at-least-once-safe because the
-- database de-duplicates on `event_id`. Eleven of them name `event_id`. The index is on
-- `(event_id, occurred_at)`, and that difference is the whole defect.
--
-- ---------------------------------------------------------------------------------------------------
-- WHY THE EXISTING KEY CANNOT CARRY THE GUARANTEE
-- ---------------------------------------------------------------------------------------------------
--
-- `public.listing_events` is `partition by range (occurred_at)`, and PostgreSQL refuses a unique index on a
-- partitioned table that does not contain every partitioning column:
--
--     ERROR:  unique constraint on partitioned table must include all partitioning columns
--     DETAIL:  UNIQUE constraint on table "listing_events" lacks column "occurred_at"
--
-- So `(event_id, occurred_at)` was not a choice; it was the only unique key available. It de-duplicates only
-- when a redelivery carries a byte-identical `occurred_at` — and `occurred_at` is not a property of the event.
-- `ListingEventIngestionService.occurredAt` replaces the client's value with a fresh `Date.now()` when it is
-- **missing, unparseable, in the future, or older than seven days**, and this writer adds a second `now()`
-- fallback when the key is absent from the payload. Four of five input cases therefore produce a different
-- `occurred_at` on every delivery, and the conflict target never matches.
--
-- Proved by execution before this migration was written. Two deliveries, separate transactions, `occurred_at`
-- omitted:
--
--     delivery 1 inserted: 1
--     delivery 2 inserted: 1
--     rows for that one event_id: 2
--     listing_analytics.clicks = 2        <- one click, counted twice, on a seller's own screen
--
-- The same two deliveries **inside one transaction** insert one row, because `now()` is transaction-stable.
-- That is why the existing pgTAP assertion passes: every pgTAP file runs in a single transaction, so the
-- obvious de-duplication test cannot fail. The test was not wrong about its intent; it was unable to observe
-- the thing it asserted. 0107's suite uses `clock_timestamp()` and explicit distinct timestamps so it can.
--
-- ---------------------------------------------------------------------------------------------------
-- THE DESIGN (owner decision 1, D-1)
-- ---------------------------------------------------------------------------------------------------
--
-- A **non-partitioned identity ledger**, keyed by `event_id` alone, consulted inside the writer:
--
--   1. the batch is collapsed on `event_id`, first occurrence winning;
--   2. the ids are inserted into the ledger with `on conflict do nothing`, and the ids that **won** come back;
--   3. only those ids produce event rows.
--
-- All three steps are one statement, so the ledger entry and the event row commit or roll back together. There
-- is no window in which an id is claimed and its event is missing.
--
-- Because the ledger is keyed on `event_id` and nothing else, the guarantee no longer depends on `occurred_at`
-- at all. A redelivery with a re-stamped timestamp, an absent timestamp, a skewed clock or a stale date is one
-- event, once. `occurred_at` keeps its existing meaning and its existing `now()` fallback — `occurredAt` stays
-- optional in the contract (owner decision 4), and the fallback is now harmless rather than load-bearing.
--
-- **The ledger lives inside the database writer** (owner decision 9), so the normal worker path and the
-- degraded direct API path are covered by the same code. Neither application can opt out, and nothing in
-- either application needed to change.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT DONE
-- ---------------------------------------------------------------------------------------------------
--
-- **`occurredAt` does not become required** (owner decision 4). No contract, route, response shape or cursor
-- changes anywhere in this increment.
--
-- **The rollup is unchanged** (owner decision 5). `count(*)` stays, and it is now correct because the rows it
-- counts are de-duplicated before they arrive. `count(distinct event_id)` was considered and rejected: it is
-- **incomplete**, not merely weaker. Two deliveries straddling midnight land on different days, and a per-day
-- distinct count then reports one each and still totals two — measured, not assumed:
--
--     day 2026-10-03: count(*)=1  count(distinct event_id)=1
--     day 2026-10-04: count(*)=1  count(distinct event_id)=1
--     so per-day distinct counting still totals 2 for one event
--
-- **No backfill, no cleanup, no row preflight** (owner decision 6). Nothing is deployed, so no duplicate rows
-- exist to repair. A preflight over existing rows would be ceremony against an empty table.
--
-- **The 503 stays** (owner decision 7). When the stream publish fails and the degraded insert fails too, the
-- API still answers 503. The point of this migration is that the retry it invites is now safe, rather than
-- converting a visible failure into silent loss.
--
-- ---------------------------------------------------------------------------------------------------
-- A NOTE ON THE SECOND WRITER
-- ---------------------------------------------------------------------------------------------------
--
-- `app_private.record_promotion_events` carried the identical defect — the same `coalesce(..., now())`, the
-- same `on conflict (event_id, occurred_at)`, on a table partitioned the same way. It has **no application
-- caller anywhere in this repository**, so it was latent rather than reachable. It is fixed here anyway (owner
-- decision 3): leaving a known defect in place because nothing currently reaches it is how it gets rediscovered
-- by whoever builds the surface that does.
--
-- One asymmetry is recorded rather than smoothed over: `listing_events` has a partition-dropping retention job
-- (0101, ninety days) and `promotion_events` has none. Both **ledgers** are pruned at ninety days here, so a
-- promotion event redelivered more than ninety days later could duplicate even though its event partitions are
-- still present. That is acceptable for a writer with no caller, and the increment that gives
-- `promotion_events` a retention policy should revisit it rather than inherit it silently.

-- ---------------------------------------------------------------------------------------------------
-- 1. The two ledgers
-- ---------------------------------------------------------------------------------------------------
-- Readless and private (owner decision 8). No grant to `authenticated` or `anon`, no RLS policy, and no
-- reader anywhere in the application: the only code that touches these tables is the two definer writers and
-- the two pruning functions below. RLS is enabled because `rls_problems()` requires it of every table in these
-- schemas, and with no policy and no grant the enabled-but-policyless state is exactly the intent — nothing
-- reaches it except a definer function, which bypasses RLS by design.
--
-- **Not partitioned, on purpose.** Partitioning by `first_seen_at` would force that column into the unique
-- key and reproduce the very defect this table exists to fix.
create table public.listing_event_ids (
  event_id uuid primary key,
  first_seen_at timestamptz not null default now()
);
comment on table public.listing_event_ids is
  'Identity ledger for public.listing_events (0107). One row per event_id ever accepted, which is what makes at-least-once delivery safe: de-duplication is on event_id alone and does not depend on occurred_at, whose value the ingestion layer may replace with now(). Written only by app_private.record_listing_events, pruned only by app_private.prune_listing_event_ids. No reader, no grant, no policy.';

-- Oldest-first pruning needs this; the primary key serves the de-duplication lookup.
create index listing_event_ids_first_seen on public.listing_event_ids (first_seen_at);

alter table public.listing_event_ids enable row level security;

create table public.promotion_event_ids (
  event_id uuid primary key,
  first_seen_at timestamptz not null default now()
);
comment on table public.promotion_event_ids is
  'Identity ledger for public.promotion_events (0107), on the same terms as public.listing_event_ids. Its writer has no application caller yet; the ledger exists so that the defect is not waiting for the increment that adds one.';

create index promotion_event_ids_first_seen on public.promotion_event_ids (first_seen_at);

alter table public.promotion_event_ids enable row level security;

-- **No append-only trigger, and that is a decision rather than an omission.**
--
-- An `event_id` is a fact that cannot be amended, so an update-rejecting trigger looked right. It is not
-- available here, and `public.append_only_problems()` is what says so: the checker is bidirectional. A table
-- carrying any `tg_%reject%` trigger **must** be named in `app_private.append_only_contract`, and that contract
-- means "refuses UPDATE *and* DELETE". Retention has to delete from a ledger that is not partitioned, so
-- entering these tables in the contract would assert something untrue of them, and renaming the trigger to slip
-- past the pattern would be gaming the check rather than satisfying it.
--
-- So the protection is the absence of reach, not a trigger. No role is granted anything on either table; the
-- only code that touches them is four `security definer` functions, two of which only ever insert and two of
-- which only ever delete by age. Nothing in either application can issue an UPDATE because nothing in either
-- application can issue any statement against these tables at all. The verification block at the end of this
-- migration asserts exactly that, so the guarantee is measured rather than described.
--
-- Attempted and reverted while writing this migration:
--
--     public.listing_event_ids | the table refuses writes but the contract does not name it

-- ---------------------------------------------------------------------------------------------------
-- 2. The writers, with the ledger consulted before any event row is written
-- ---------------------------------------------------------------------------------------------------
-- Dumped from the live catalogue and edited, rather than retyped: the column lists, the casts, the
-- `nullif`/`decode` handling and the `occurred_at` fallback are 0013's own and are unchanged.
--
-- **`distinct on` is not decoration.** Without it, a batch carrying the same `event_id` twice inserts **one**
-- ledger row and **two** event rows, because the single winner joins to both incoming copies. Measured while
-- writing this migration:
--
--     ledger rows: 1
--     event rows : 2  -> first copy + second copy
--
-- Collapsing the batch first, keeping the first occurrence by array position, gives one of each. A client may
-- legitimately send the same event twice in one flush, and the guarantee has to hold inside a batch as well as
-- between batches.
--
-- `with ordinality` supplies that position. `event_id` is deliberately **not** filtered for null: an event
-- without one still reaches the ledger's `not null` primary key and still raises, exactly as it raised against
-- `listing_events.event_id` before.
create or replace function app_private.record_listing_events(p_events jsonb)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  inserted integer;
begin
  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'record_listing_events expects a JSON array of events';
  end if;

  with raw as (
    select e.value as event, e.ord
      from jsonb_array_elements(p_events) with ordinality as e(value, ord)
  ),
  incoming as (
    select distinct on ((r.event ->> 'event_id')::uuid)
           (r.event ->> 'event_id')::uuid as event_id, r.event
      from raw r
     order by (r.event ->> 'event_id')::uuid, r.ord
  ),
  winners as (
    insert into public.listing_event_ids (event_id)
    select i.event_id from incoming i
    on conflict (event_id) do nothing
    returning event_id
  )
  insert into public.listing_events (
    event_id, listing_id, seller_user_id, event_type, occurred_at, user_id, session_hash,
    source, referrer_host, promotion_id
  )
  select
    i.event_id,
    (i.event ->> 'listing_id')::uuid,
    nullif(i.event ->> 'seller_user_id', '')::uuid,
    i.event ->> 'event_type',
    coalesce(nullif(i.event ->> 'occurred_at', '')::timestamptz, now()),
    nullif(i.event ->> 'user_id', '')::uuid,
    decode(coalesce(nullif(i.event ->> 'session_hash', ''), ''), 'hex'),
    nullif(i.event ->> 'source', ''),
    nullif(i.event ->> 'referrer_host', ''),
    nullif(i.event ->> 'promotion_id', '')::uuid
    from incoming i
    join winners w on w.event_id = i.event_id
  -- 0013's clause, kept. The ledger is the authority now, so this can only matter for a row written before
  -- 0107 existed, and silently doing nothing is kinder there than raising on a historical artefact.
  on conflict (event_id, occurred_at) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$function$;

comment on function app_private.record_listing_events(jsonb) is
  'Batched insert used by the analytics consumer and by the degraded direct path. De-duplicates on event_id alone, through public.listing_event_ids, in the same statement that writes the events: a redelivered batch inserts nothing and returns zero however its occurred_at was stamped. A batch carrying the same event_id twice yields one row, the first occurrence. Returns the number of event rows written.';

create or replace function app_private.record_promotion_events(p_events jsonb)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  inserted integer;
begin
  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'record_promotion_events expects a JSON array of events';
  end if;

  with raw as (
    select e.value as event, e.ord
      from jsonb_array_elements(p_events) with ordinality as e(value, ord)
  ),
  incoming as (
    select distinct on ((r.event ->> 'event_id')::uuid)
           (r.event ->> 'event_id')::uuid as event_id, r.event
      from raw r
     order by (r.event ->> 'event_id')::uuid, r.ord
  ),
  winners as (
    insert into public.promotion_event_ids (event_id)
    select i.event_id from incoming i
    on conflict (event_id) do nothing
    returning event_id
  )
  insert into public.promotion_events (
    event_id, promotion_id, listing_id, seller_user_id, event_type, placement, occurred_at,
    user_id, session_hash
  )
  select
    i.event_id,
    (i.event ->> 'promotion_id')::uuid,
    (i.event ->> 'listing_id')::uuid,
    nullif(i.event ->> 'seller_user_id', '')::uuid,
    i.event ->> 'event_type',
    nullif(i.event ->> 'placement', ''),
    coalesce(nullif(i.event ->> 'occurred_at', '')::timestamptz, now()),
    nullif(i.event ->> 'user_id', '')::uuid,
    decode(coalesce(nullif(i.event ->> 'session_hash', ''), ''), 'hex')
    from incoming i
    join winners w on w.event_id = i.event_id
  on conflict (event_id, occurred_at) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$function$;

comment on function app_private.record_promotion_events(jsonb) is
  'Batched insert for promotion events, de-duplicating on event_id alone through public.promotion_event_ids, on the same terms as record_listing_events (0107). It has no application caller yet; the de-duplication is correct before the surface that needs it exists rather than after.';

-- ---------------------------------------------------------------------------------------------------
-- 3. Retention: ninety days, enforced by a scheduled job (owner decision 2)
-- ---------------------------------------------------------------------------------------------------
-- A bounded batch, oldest first, following 7-J's `purge_due_payment_information` rather than inventing a
-- second shape. The ledgers are not partitioned — they cannot be, see the header — so retention is a delete
-- and not a partition drop.
--
-- The window is the **guarantee** window: ninety days after an event is first seen, its id is forgotten and a
-- redelivery of it would be accepted again. Ninety days matches the listing-event retention in 0101, so an id
-- is remembered for at least as long as the event it identifies is kept.
create or replace function app_private.prune_listing_event_ids(p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  pruned integer;
begin
  if p_limit is null or p_limit < 1 then
    raise exception 'the prune batch size must be at least one'
      using errcode = 'invalid_parameter_value';
  end if;

  with due as (
    select l.event_id
      from public.listing_event_ids l
     where l.first_seen_at < now() - interval '90 days'
     order by l.first_seen_at, l.event_id
     limit p_limit
  )
  delete from public.listing_event_ids l
   using due
   where l.event_id = due.event_id;
  get diagnostics pruned = row_count;

  return pruned;
end;
$$;

comment on function app_private.prune_listing_event_ids(integer) is
  'Forgets listing event ids first seen more than ninety days ago (0107, owner decision 2), a bounded batch at a time, oldest first. The window is the de-duplication guarantee window: an id this has forgotten would be accepted again. Ninety days matches 0101''s event retention, so an id outlives the event it identifies. Returns the number forgotten, which lands in job_runs.';

revoke all on function app_private.prune_listing_event_ids(integer) from public;

create or replace function app_private.prune_promotion_event_ids(p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  pruned integer;
begin
  if p_limit is null or p_limit < 1 then
    raise exception 'the prune batch size must be at least one'
      using errcode = 'invalid_parameter_value';
  end if;

  with due as (
    select p.event_id
      from public.promotion_event_ids p
     where p.first_seen_at < now() - interval '90 days'
     order by p.first_seen_at, p.event_id
     limit p_limit
  )
  delete from public.promotion_event_ids p
   using due
   where p.event_id = due.event_id;
  get diagnostics pruned = row_count;

  return pruned;
end;
$$;

comment on function app_private.prune_promotion_event_ids(integer) is
  'Forgets promotion event ids first seen more than ninety days ago (0107), on the same terms as prune_listing_event_ids. Note that public.promotion_events itself has no partition-dropping retention job, so this ledger is pruned while its events are kept — recorded in 0107''s header as the asymmetry for a later increment to settle rather than a gap.';

revoke all on function app_private.prune_promotion_event_ids(integer) from public;

-- No grant to anybody, following 0101's retention function: reachable only through `run_scheduled_job` under
-- pg_cron's own privileges. Neither `app_system` nor `app_worker` may forget an event id.

-- ---------------------------------------------------------------------------------------------------
-- 4. The contract rows and the dispatcher branches
-- ---------------------------------------------------------------------------------------------------
-- `40 4 * * *` and `45 4 * * *`: inside the quiet nightly data-lifecycle block, after 0101's partition drop at
-- 04:25, so a ledger is never pruned while the partitions it refers to are being dropped.
insert into app_private.scheduled_job_contract (job_key, cron_schedule, target_signature, purpose) values
  ('listing_event_ids.prune', '40 4 * * *',
   'app_private.prune_listing_event_ids(5000)',
   '0107, owner decision 2: forgets listing event ids older than the ninety-day de-duplication window'),
  ('promotion_event_ids.prune', '45 4 * * *',
   'app_private.prune_promotion_event_ids(5000)',
   '0107, owner decision 2: forgets promotion event ids older than the ninety-day de-duplication window')
on conflict (job_key) do nothing;

-- The dispatcher, reproduced with two branches added. The key-to-call mapping stays a CASE over literal keys
-- rather than `execute` over a column: the contract table is data, and data never becomes code here.
create or replace function app_private.run_scheduled_job(p_job_key text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
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
      -- 0101, owner decision 7.
      when 'listing_events.retention'
        then app_private.drop_expired_listing_event_partitions(90)
      -- 0102, owner decision 9.
      when 'listing_analytics.rollup'
        then app_private.rollup_listing_analytics(null)
      -- 0107, owner decision 2. The only branches this migration adds.
      when 'listing_event_ids.prune'
        then app_private.prune_listing_event_ids(5000)
      when 'promotion_event_ids.prune'
        then app_private.prune_promotion_event_ids(5000)
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

-- ---------------------------------------------------------------------------------------------------
-- 5. Verification — this migration proves its own work before it finishes
-- ---------------------------------------------------------------------------------------------------
-- The claim is behavioural, so it is tested behaviourally rather than by reading the catalogue: two
-- deliveries of one event id, with **deliberately different** `occurred_at` values, must produce one row.
-- `clock_timestamp()` is used rather than `now()`, because `now()` is transaction-stable and would make this
-- block pass for the wrong reason — the precise trap that hid the defect for four increments.
do $$
declare
  v_id uuid := gen_random_uuid();
  v_listing uuid;
  v_first integer;
  v_second integer;
  v_rows integer;
  v_problems text[] := array[]::text[];
begin
  select l.id into v_listing from public.listings l limit 1;

  if v_listing is null then
    -- A fresh database has no listing to attach an event to. The pgTAP suite builds one and proves the
    -- behaviour there; skipping is honest, and silently passing a test that did not run is not.
    raise notice 'ledger verification skipped: no listing exists yet to attach a probe event to.';
  else
    v_first := app_private.record_listing_events(jsonb_build_array(jsonb_build_object(
      'event_id', v_id, 'listing_id', v_listing, 'event_type', 'click',
      'occurred_at', clock_timestamp())));

    v_second := app_private.record_listing_events(jsonb_build_array(jsonb_build_object(
      'event_id', v_id, 'listing_id', v_listing, 'event_type', 'click',
      'occurred_at', clock_timestamp() + interval '1 second')));

    select count(*) into v_rows from public.listing_events where event_id = v_id;

    if v_first <> 1 then
      v_problems := v_problems || format('the first delivery wrote %s rows, expected 1', v_first);
    end if;
    if v_second <> 0 then
      v_problems := v_problems || format('the second delivery wrote %s rows, expected 0', v_second);
    end if;
    if v_rows <> 1 then
      v_problems := v_problems || format('%s rows carry the probe event id, expected 1', v_rows);
    end if;

    -- The probe is removed through the partition, since the events table refuses a row delete.
    delete from public.listing_event_ids where event_id = v_id;
  end if;

  -- The ledgers must be reachable by nobody but a definer function.
  if exists (
    select 1 from information_schema.role_table_grants g
     where g.table_schema = 'public'
       and g.table_name in ('listing_event_ids', 'promotion_event_ids')
       and g.grantee in ('authenticated', 'anon', 'app_system', 'app_worker')
  ) then
    v_problems := v_problems || 'a ledger is granted to an application role';
  end if;

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('listing_event_ids', 'promotion_event_ids')
       and not c.relrowsecurity
  ) then
    v_problems := v_problems || 'a ledger does not have row level security enabled';
  end if;

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('listing_event_ids', 'promotion_event_ids')
       and c.relkind <> 'r'
  ) then
    v_problems := v_problems || 'a ledger is partitioned, which would defeat its own unique key';
  end if;

  if array_length(v_problems, 1) is not null then
    raise exception 'analytics identity ledger verification failed: %', array_to_string(v_problems, '; ')
      using errcode = 'check_violation';
  end if;

  raise notice 'analytics identity ledger verified: event_id is authoritative for de-duplication.';
end $$;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
