-- 0101 — Listing event ingestion: the retention window the stream needs, and nothing the stream already had.
--
-- **Almost none of the database side of ingestion is new.** `public.listing_events` has existed since 0013:
-- partitioned by `occurred_at`, indexed by listing and by promotion, with `app_private.record_listing_events`
-- — a batched insert that de-duplicates on `(event_id, occurred_at)` and whose own comment already says it is
-- "used by the analytics consumer and by the degraded direct path", which is both halves of O-21. Execute is
-- already granted to `app_system` (the degraded path) and `app_worker` (the consumer). 0032 already keeps the
-- partitions three months ahead through `partitions.ensure`.
--
-- What was missing was anything that *emits* an event, which is this increment's API, worker and web work, and
-- one thing that belongs in the database: **what happens to an event when it gets old**. Nothing dropped a
-- `listing_events` partition, so the stream would have grown without bound from its first write.
--
-- **RAW EVENTS ARE RETAINED FOR NINETY DAYS, THROUGH THE PARTITION MODEL (OWNER DECISION 7).**
--
-- The owner's decision is ninety days, with no separate business-retention rule invented and the existing
-- partition model used. That has one consequence worth stating plainly rather than discovering later:
-- `ensure_month_partitions` makes **monthly** partitions, so a partition can only be dropped once its whole
-- month is outside the window. Effective retention is therefore ninety days **at minimum** and up to a month
-- more — never less. Dropping a partition whose range still reaches inside the window would delete events the
-- decision says to keep, so the extra tail is the honest cost of the model the owner chose. Deleting
-- individual rows inside the newest expired partition would be more precise and would fight the partition
-- model for no gain, so this does not do it.
--
-- **Only `listing_events`.** `promotion_events` is partitioned the same way and `audit.audit_logs` likewise,
-- and neither is touched: the decision is about raw listing events, and applying a ninety-day window to the
-- audit log or to promotion analytics would be inventing a retention rule for data nobody asked about.
--
-- **The job is reached the way every job is reached.** A contract row in `app_private.scheduled_job_contract`,
-- a branch in `run_scheduled_job`'s CASE over literal keys, and a cron command that is the dispatcher call and
-- nothing else — the shape 0032 established and 0073 followed when it added the only other retention job.
-- `public.cron_job_problems()` compares the contract with the real `cron.job`, so the scheduling block below is
-- 0032's own, re-run, which keeps that guard at zero.
--
-- **WHAT IS NOT HERE.** No rollup, no aggregate, no view, no console reader — `analytics.listing.read` is
-- consumed by nothing in this increment and the admin console gains no section. No `impression` and no `view`:
-- 0013's column constraint permits all six event types and this increment emits four, because the impression
-- definition (visibility threshold, dedupe window) is a Phase 9 decision and Phase 6-J recorded the same gap
-- for views. Nothing in `promotion_analytics` changes. No financial path is touched.

-- ---------------------------------------------------------------------------------------------------
-- 1. The retention job's function
-- ---------------------------------------------------------------------------------------------------
-- Drops whole partitions of `public.listing_events` whose entire month lies outside the retention window.
-- Returns how many it dropped, so the figure lands in `job_runs` like every other job's count.
--
-- The candidates come from `pg_inherits` — a real partition of this one table — and the name must match
-- `ensure_month_partitions`' own `<table>_YYYYMM` shape exactly, so nothing outside this table's partitions
-- can be reached even if something else in the schema were named similarly. The month comes from that suffix,
-- which is the inverse of how the partition was created.
create or replace function app_private.drop_expired_listing_event_partitions(p_retain_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  dropped integer := 0;
  cutoff timestamptz;
  part record;
begin
  -- A window of zero or less would mean "drop everything", which is not a retention rule. Refused rather
  -- than obeyed, because this function is reached by a schedule and a wrong argument would be silent.
  if p_retain_days is null or p_retain_days < 1 then
    raise exception 'the retention window must be at least one day'
      using errcode = 'invalid_parameter_value';
  end if;

  cutoff := date_trunc('day', now()) - make_interval(days => p_retain_days);

  for part in
    select child.relname as partition_name,
           to_date(right(child.relname, 6), 'YYYYMM') as month_start
      from pg_inherits i
      join pg_class child on child.oid = i.inhrelid
      join pg_class parent on parent.oid = i.inhparent
      join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
     where parent_ns.nspname = 'public'
       and parent.relname = 'listing_events'
       and child.relname ~ '^listing_events_[0-9]{6}$'
     order by child.relname
  loop
    -- The whole month must be outside the window. A partition whose range still reaches inside it holds
    -- events the retention decision says to keep, so it stays until next month.
    if (part.month_start + interval '1 month') <= cutoff then
      execute format('drop table if exists public.%I', part.partition_name);
      dropped := dropped + 1;
    end if;
  end loop;

  return dropped;
end;
$$;

comment on function app_private.drop_expired_listing_event_partitions(integer) is
  'Drops partitions of public.listing_events whose entire month is older than the retention window (owner decision 7: ninety days). Because the partitions are monthly, effective retention is ninety days at minimum and up to a month more — never less, since a partition still reaching inside the window is kept. Touches no other partitioned table: promotion_events and the audit log keep their own lifecycles. Returns the number dropped, which lands in job_runs.';

revoke all on function app_private.drop_expired_listing_event_partitions(integer) from public;

-- No grant to anybody. Like 0073's retention job, it is reachable only through `run_scheduled_job` under
-- pg_cron's own privileges: neither `app_system` nor `app_worker` may drop a partition.

-- ---------------------------------------------------------------------------------------------------
-- 2. The contract row and the dispatcher branch
-- ---------------------------------------------------------------------------------------------------
-- `25 4 * * *`: after 0032's `partitions.ensure` at 03:10 — which only creates future partitions, so the two
-- never contend — and after 0073's purge at 04:05, so the nightly data-lifecycle jobs run in one quiet block
-- and a slow night shows up as one late window rather than several.
insert into app_private.scheduled_job_contract (job_key, cron_schedule, target_signature, purpose) values
  ('listing_events.retention', '25 4 * * *',
   'app_private.drop_expired_listing_event_partitions(90)',
   'owner decision 7: drops listing event partitions whose whole month is outside the ninety-day window')
on conflict (job_key) do nothing;

-- The dispatcher, reproduced with one branch added. The key-to-call mapping stays a CASE over literal keys
-- rather than `execute` over a column: the contract table is data, and data never becomes code here.
create or replace function app_private.run_scheduled_job(p_job_key text) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
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
$$;

comment on function app_private.run_scheduled_job(text) is
  'The one entry point every cron job calls. Looks the key up in the contract, opens a job run, dispatches through a CASE over literal keys, and records the count or the failure in job_runs without re-raising, because pg_cron gives each command its own transaction. 0101 added one branch, the listing event retention job, and changed nothing else.';

-- ---------------------------------------------------------------------------------------------------
-- 3. Scheduling, idempotently
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
