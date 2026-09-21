-- 0032 — pg_cron jobs: the database-only scheduled work (v5.2 "Runtime → Jobs"; D23, D24, C18, C10).
--
-- The approved runtime split puts a specific list of jobs on pg_cron and everything else on the worker:
--
--   > pg_cron (database-only): Promotion start/end; reservation and attempt expiry; balance release
--   > after hold; offer expiry; service auto-completion (D23); analytics rollups; partition creation;
--   > unverified-account purge (D24, schedule depends on C18)
--
-- This migration schedules exactly that list, minus the one entry the specification itself withholds,
-- plus the two jobs later migrations wrote their functions for. Nothing is invented and nothing is
-- borrowed from the worker's column — in particular the **outbox sweeper is not scheduled here**, because
-- the same table files "sweeper" under *Worker repeatable jobs*. `app_private.sweep_outbox_events()`
-- stays exactly where 0007 left it, callable, unscheduled.
--
-- **The unverified-account purge (D24) is deliberately not scheduled.** The specification marks it
-- "APPROVED conceptually; schedule depends on C18", and records that "C18 moved to before production;
-- Phase 2 needs configurable fields only". Scheduling it here would be choosing a retention period that
-- an explicitly deferred decision owns. The job is absent, and the guard below treats its absence as
-- correct rather than as a gap.
--
-- How a job runs, and why it runs this way:
--
--   * **One shape for every command.** Every cron entry is literally
--     `select app_private.run_scheduled_job('<key>')`. No cron entry contains business logic, an inline
--     UPDATE, or a function call the contract does not name. That makes the whole schedule auditable
--     from `cron.job` alone — which is what the pgTAP file reads.
--   * **One dispatcher.** `app_private.run_scheduled_job()` maps a key to a call through a `CASE` over
--     literal keys, never by executing text from a table. The contract table is data; data never becomes
--     code here, so a row in it cannot turn into an injection surface.
--   * **Every run is recorded.** The dispatcher opens a `public.job_runs` row through 0007's
--     `start_job_run()` and closes it through `finish_job_run()`, which is the specification's own rule
--     that every job writes to `job_runs`.
--   * **Failure behaviour.** pg_cron runs each command in its own transaction, so a re-raised exception
--     would roll back the very row that records the failure. The dispatcher therefore catches, records
--     `status = 'failed'` with the SQLSTATE in `error_type`, and returns `-1`. The durable record is the
--     `job_runs` row that the admin platform page already reads under `platform.job.read`; one failing
--     job never blocks the rest of the schedule, and nothing is silently lost.
--   * **Repeated execution is safe.** Every target selects the rows that are due, transitions them, and
--     returns how many it moved. A second run finds nothing due and returns zero. The partition helpers
--     are `if not exists` by construction. `assert_security_contract()` is read-only. None of them
--     depends on being run at a particular moment or exactly once.
--   * **Transaction boundaries are unchanged.** Each target does its own work in the single transaction
--     pg_cron gives it, and publishes through `enqueue_outbox_event()` inside that transaction exactly as
--     it would when called from a request. There is no second publication path.
--
-- Three expiry sweeps have no function yet, because the module that defined the state left the sweep to
-- this migration: 0015 built `offers_expiring` and `service_quotes_expiring` as partial indexes on
-- `expires_at` that exist for no other purpose, and 0019 built `payment_attempts_open` the same way.
-- They are written here as named functions in the established sweep shape — bounded `limit`, one batch
-- outbox event — and the attempt sweep goes through 0020's `settle_payment_attempt()` rather than
-- touching the table, so every rule that function enforces still applies.
--
-- Scheduler privileges. 0031 found and closed pg_cron's `PUBLIC` grant on its two sequences. The same
-- audit, repeated here against the rest of the extension, found three more: `select` on `cron.job`,
-- `select, delete` on `cron.job_run_details`, and `execute` on `cron.schedule()`, `cron.unschedule()`
-- and `cron.job_cache_invalidate()` — all granted to `PUBLIC`, which `anon` and `authenticated` inherit.
-- No request role can reach any of them today, having no `usage` on the `cron` schema, but they are
-- revoked here for the same reason the sequences were. Each revoke was verified against a live
-- schedule → execute → unschedule cycle: the background worker still runs jobs and still records them.
-- `public.cron_job_problems()` now asserts all of it, and is folded into the 0031 umbrella, so a future
-- extension upgrade that re-grants them fails the security contract.
--
-- Nothing here introduces a payment, payout, provider or settlement behaviour; no HTTP or external
-- network job is created; `finance.settlement_posting_enabled` is neither read nor written; and no
-- blocked or deferred decision is opened.

-- ---------------------------------------------------------------------------------------------------
-- Scheduler privilege hygiene, before anything is scheduled
-- ---------------------------------------------------------------------------------------------------
revoke all on cron.job, cron.job_run_details from public;
revoke all on sequence cron.jobid_seq, cron.runid_seq from public;
revoke all on all functions in schema cron from public;
revoke all on all routines in schema cron from public;
revoke all on schema cron from public;

-- ---------------------------------------------------------------------------------------------------
-- The sweeps this migration owns
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.expire_due_offers(p_limit integer default 500) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  expired integer;
begin
  with due as (
    select o.id from public.offers o
     where o.status = 'pending' and o.expires_at <= now()
     order by o.expires_at
     limit greatest(p_limit, 0)
  )
  update public.offers o
     set status = 'expired', responded_at = now()
    from due
   where o.id = due.id;
  get diagnostics expired = row_count;

  if expired > 0 then
    perform public.enqueue_outbox_event('offer', 'batch', 'offer.expired',
      jsonb_build_object('count', expired));
  end if;
  return expired;
end;
$$;
comment on function app_private.expire_due_offers(integer) is
  'Closes offers whose window has passed. Idempotent: a second run finds nothing pending and returns 0.';

create or replace function app_private.expire_due_service_quotes(p_limit integer default 500) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  expired integer;
begin
  with due as (
    select q.id from public.service_quotes q
     where q.status = 'sent' and q.expires_at <= now()
     order by q.expires_at
     limit greatest(p_limit, 0)
  )
  update public.service_quotes q
     set status = 'expired', responded_at = now()
    from due
   where q.id = due.id;
  get diagnostics expired = row_count;

  if expired > 0 then
    perform public.enqueue_outbox_event('service_quote', 'batch', 'service_quote.expired',
      jsonb_build_object('count', expired));
  end if;
  return expired;
end;
$$;
comment on function app_private.expire_due_service_quotes(integer) is
  'Closes quotes whose window has passed. Idempotent, and never touches the one accepted quote a request may have.';

create or replace function app_private.expire_due_payment_attempts(p_limit integer default 200) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  due_attempt uuid;
  expired integer := 0;
begin
  -- Through 0020's settler, never by touching the table: every rule it enforces — the late-success
  -- path (D18), the exception cases, the event trail — stays in force.
  for due_attempt in
    select a.id from public.payment_attempts a
     where a.status in ('pending', 'requires_action')
       and a.expires_at is not null and a.expires_at <= now()
     order by a.expires_at
     limit greatest(p_limit, 0)
  loop
    perform app_private.settle_payment_attempt(due_attempt, 'expired');
    expired := expired + 1;
  end loop;

  if expired > 0 then
    perform public.enqueue_outbox_event('payment_attempt', 'batch', 'payment_attempt.expired',
      jsonb_build_object('count', expired));
  end if;
  return expired;
end;
$$;
comment on function app_private.expire_due_payment_attempts(integer) is
  'Expires open payment attempts past their window, through settle_payment_attempt() so no rule is bypassed.';

create or replace function app_private.ensure_event_partitions(p_months_ahead integer default 3) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  created integer := 0;
begin
  created := created + audit.ensure_partitions(p_months_ahead);
  created := created + app_private.ensure_month_partitions('public', 'listing_events', p_months_ahead);
  created := created + app_private.ensure_month_partitions('public', 'promotion_events', p_months_ahead);
  return created;
end;
$$;
comment on function app_private.ensure_event_partitions(integer) is
  'Creates next month''s partitions for the audit log and both event streams. Idempotent: existing partitions are left alone.';

-- ---------------------------------------------------------------------------------------------------
-- The schedule, written down
-- ---------------------------------------------------------------------------------------------------
create table app_private.scheduled_job_contract (
  job_key text primary key,
  cron_schedule text not null,
  target_signature text not null,
  purpose text not null,
  constraint scheduled_job_contract_key_format check (job_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  constraint scheduled_job_contract_schedule_present check (length(btrim(cron_schedule)) > 0),
  constraint scheduled_job_contract_target_format check (target_signature ~ '^(app_private|audit)\.[a-z_]+\('),
  constraint scheduled_job_contract_purpose_present check (length(btrim(purpose)) > 0)
);
comment on table app_private.scheduled_job_contract is
  'The jobs this database schedules, their cron expressions and what each one calls. Compared with the real `cron.job` by `cron_job_problems()`.';
alter table app_private.scheduled_job_contract enable row level security;

insert into app_private.scheduled_job_contract (job_key, cron_schedule, target_signature, purpose) values
  ('promotions.start',        '*/5 * * * *', 'app_private.start_due_promotions(500)',
     'moves scheduled promotions into active once their start has passed'),
  ('promotions.expire',       '*/5 * * * *', 'app_private.expire_due_promotions(500)',
     'ends promotions whose window has closed'),
  ('reservations.release',    '* * * * *',   'app_private.release_expired_reservations(500)',
     'returns stock held by abandoned checkouts, which is why it runs every minute'),
  ('payment_attempts.expire', '*/5 * * * *', 'app_private.expire_due_payment_attempts(200)',
     'closes payment attempts past their window, through 0020''s settler'),
  ('offers.expire',           '*/5 * * * *', 'app_private.expire_due_offers(500)',
     'closes offers whose window has passed'),
  ('service_quotes.expire',   '*/5 * * * *', 'app_private.expire_due_service_quotes(500)',
     'closes service quotes whose window has passed'),
  ('cms.publish_due',         '*/5 * * * *', 'app_private.publish_due_content()',
     'publishes scheduled pages and blog posts whose moment has arrived (0030)'),
  ('service_orders.complete', '17 * * * *',  'app_private.complete_due_service_orders(200)',
     'D23: completes delivered service orders whose buyer-response period has passed'),
  ('seller_balances.release', '23 * * * *',  'app_private.release_seller_holds(500)',
     'moves completed orders'' earnings from pending to available once the hold has elapsed'),
  ('promotions.rollup',       '35 2 * * *',  'app_private.rollup_promotion_analytics(null)',
     'rolls yesterday''s promotion events into promotion_analytics'),
  ('partitions.ensure',       '10 3 * * *',  'app_private.ensure_event_partitions(3)',
     'keeps the audit log and both event streams partitioned three months ahead'),
  ('security.assert_contract','45 3 * * *',  'app_private.assert_security_contract()',
     'raises if the 0031 security contract has drifted, so the failure lands in job_runs');

-- ---------------------------------------------------------------------------------------------------
-- The dispatcher
-- ---------------------------------------------------------------------------------------------------
-- The key-to-call mapping is a CASE over literal keys, not `execute` over a column: the contract table
-- is data, and data never becomes code here.
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
  'The one entry point every cron command uses. Records the run in job_runs, and records a failure rather than losing it.';

-- ---------------------------------------------------------------------------------------------------
-- Scheduling, idempotently
-- ---------------------------------------------------------------------------------------------------
-- `cron.schedule()` upserts on the job name, so applying this migration twice leaves one job per key.
-- Any `marketplace.*` job the contract no longer names is unscheduled first, so the catalogue can never
-- drift past the contract.
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
-- The guard
-- ---------------------------------------------------------------------------------------------------
create or replace function public.cron_job_problems()
returns table (object text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- A contracted job that is missing, misscheduled, pointed somewhere else, or switched off.
  select 'marketplace.' || k.job_key, 'the scheduled job does not exist'
    from app_private.scheduled_job_contract k
   where not exists (select 1 from cron.job j where j.jobname = 'marketplace.' || k.job_key)
  union all
  select j.jobname, format('the schedule is %L, the contract says %L', j.schedule, k.cron_schedule)
    from app_private.scheduled_job_contract k
    join cron.job j on j.jobname = 'marketplace.' || k.job_key
   where j.schedule is distinct from k.cron_schedule
  union all
  select j.jobname, 'the command is not the approved dispatcher call'
    from app_private.scheduled_job_contract k
    join cron.job j on j.jobname = 'marketplace.' || k.job_key
   where j.command is distinct from format('select app_private.run_scheduled_job(%L)', k.job_key)
  union all
  select j.jobname, 'the job is not active'
    from app_private.scheduled_job_contract k
    join cron.job j on j.jobname = 'marketplace.' || k.job_key
   where not j.active
  union all
  -- Anything scheduled that the contract does not name, under any name at all.
  select j.jobname, 'a cron job exists that the contract does not describe'
    from cron.job j
   where not exists (select 1 from app_private.scheduled_job_contract k
                      where 'marketplace.' || k.job_key = j.jobname)
  union all
  -- A job must run as the role that owns the schema, never as a request role.
  select j.jobname, format('the job runs as %L', j.username)
    from cron.job j
   where j.username in ('anon', 'authenticated', 'app_api')
  union all
  -- Scheduler internals stay out of reach: this is the 0031 finding, extended to the tables.
  select format('cron.%s', g.table_name), format('%s holds %s on a scheduler table', g.grantee, lower(g.privilege_type))
    from information_schema.role_table_grants g
   where g.table_schema = 'cron' and g.grantee in ('PUBLIC', 'anon', 'authenticated', 'app_api')
  union all
  select format('cron.%s', r.routine_name), format('%s may execute a scheduler routine', r.grantee)
    from information_schema.role_routine_grants r
   where r.specific_schema = 'cron' and r.grantee in ('PUBLIC', 'anon', 'authenticated', 'app_api')
  union all
  select 'cron', format('%s holds usage on the scheduler schema', g.role_name)
    from (select unnest(array['anon', 'authenticated', 'app_api']) as role_name) g
   where has_schema_privilege(g.role_name, 'cron', 'usage')
  union all
  select format('cron.%s', s.relname), 'a scheduler sequence is reachable by PUBLIC or a request role'
    from (select c.oid, c.relname
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'cron' and c.relkind = 'S'
           offset 0) s
   where has_sequence_privilege('anon', s.oid, 'usage, select, update')
      or has_sequence_privilege('authenticated', s.oid, 'usage, select, update');
$$;
comment on function public.cron_job_problems() is
  'Where the real pg_cron catalogue and the scheduled-job contract disagree, plus scheduler-privilege hygiene.';

-- The 0031 umbrella is replaced here with the identical function plus the cron clause, so the one
-- assertion the deploy and the nightly job already run now covers the schedule too. 0031's file is
-- untouched; this is the same replace-in-a-later-migration step 0021, 0028 and 0030 used.
create or replace function public.security_contract_problems()
returns table (area text, object text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select 'rls', * from public.rls_problems()
  union all select 'grants', * from public.grant_problems()
  union all select 'anon', * from public.anon_privilege_problems()
  union all select 'roles', * from public.role_boundary_problems()
  union all select 'security_definer', * from public.definer_problems()
  union all select 'views', * from public.view_security_problems()
  union all select 'append_only', * from public.append_only_problems()
  union all select 'storage', * from public.storage_bucket_problems()
  union all select 'cron', * from public.cron_job_problems();
$$;
comment on function public.security_contract_problems() is
  'Every violation of the Phase 2 security contract, in one place, now including the pg_cron schedule.';

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

-- The dispatcher and its targets are server-only, exactly like every other scheduled entry point; the
-- cron worker runs them as the schema owner, not as a request role.
grant execute on function
  public.cron_job_problems(),
  public.security_contract_problems()
  to app_system, app_worker;

grant execute on function
  app_private.run_scheduled_job(text),
  app_private.expire_due_offers(integer),
  app_private.expire_due_service_quotes(integer),
  app_private.expire_due_payment_attempts(integer),
  app_private.ensure_event_partitions(integer)
  to app_system, app_worker;

-- ---------------------------------------------------------------------------------------------------
-- Enforcement
-- ---------------------------------------------------------------------------------------------------
-- The contract now includes the schedule, so this also proves every job landed as written.
select app_private.assert_security_contract();
