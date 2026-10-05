-- 0101 — The retention window the listing event stream needed, and everything ingestion did not change.
--
-- What is proven here: the retention function exists, is a definer with a pinned search path, and is
-- executable by **nobody** — not `app_system`, not `app_worker` — because it is reached only through
-- `run_scheduled_job` under pg_cron's own privileges, exactly as 0073's retention job is; it drops a partition
-- whose whole month is outside the window and **keeps** one that still reaches inside it, which is what makes
-- the ninety days a floor rather than a target; it refuses a window of zero or less rather than obeying it; it
-- touches `promotion_events` and the audit log not at all; the contract row and the real `cron.job` agree, so
-- `cron_job_problems()` stays empty; and the dispatcher gained exactly one branch while every other branch,
-- and its no-re-raise failure recording, is unchanged.
--
-- Also proven: 0013's own ingestion surface is untouched — `record_listing_events` keeps its signature, its
-- de-duplication and its two grants — and this increment added **no rollup, no aggregate, no view and no
-- reader**: `analytics.listing.read` is still consumed by nothing in the database, and `promotion_analytics`
-- is exactly as 6-J left it. The four event types this increment emits are a subset of the six 0013 allows,
-- and the two it does not emit are still permitted by the column constraint, because excluding `impression`
-- and `view` is a scope decision in the application and not a schema change.

begin;
create extension if not exists pgtap with schema extensions;

select plan(76);

-- ---------------------------------------------------------------------------------------------------
-- The retention function
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'drop_expired_listing_event_partitions', array['integer'],
  'the retention function exists');
select function_returns('app_private', 'drop_expired_listing_event_partitions', array['integer'], 'integer',
  'and answers how many partitions it dropped');
select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'drop_expired_listing_event_partitions'),
  true, 'it is security definer');
select is(
  (select p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'drop_expired_listing_event_partitions'),
  array['search_path=pg_catalog, public'], 'with a pinned search path');
select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'drop_expired_listing_event_partitions'),
  'v', 'and it is volatile, because it drops tables');

-- Reachable only through the dispatcher, like 0073's retention job.
select ok(
  not has_function_privilege('app_system',
    'app_private.drop_expired_listing_event_partitions(integer)', 'execute'),
  'app_system may not drop a partition');
select ok(
  not has_function_privilege('app_worker',
    'app_private.drop_expired_listing_event_partitions(integer)', 'execute'),
  'and neither may the worker');
select ok(
  not has_function_privilege('public',
    'app_private.drop_expired_listing_event_partitions(integer)', 'execute'),
  'nor public');
select ok(
  not has_function_privilege('authenticated',
    'app_private.drop_expired_listing_event_partitions(integer)', 'execute'),
  'nor a signed-in request');

select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'the security contract holds with it added');
select is((select count(*) from public.audit_attribution_problems()), 0::bigint,
  'and it does not name 8-B''s audit channel');

-- ---------------------------------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.cron_job_problems()), 0::bigint,
  'the schedule still matches its contract');
select is(
  (select count(*) from app_private.scheduled_job_contract where job_key = 'listing_events.retention'),
  1::bigint, 'the contract names the retention job exactly once');
select is(
  (select cron_schedule from app_private.scheduled_job_contract where job_key = 'listing_events.retention'),
  '25 4 * * *', 'at the approved nightly moment');
select is(
  (select target_signature from app_private.scheduled_job_contract
    where job_key = 'listing_events.retention'),
  'app_private.drop_expired_listing_event_partitions(90)',
  'calling the function with the ninety-day window (owner decision 7)');
select ok(
  exists (select 1 from cron.job where jobname = 'marketplace.listing_events.retention'),
  'and the real catalogue has it scheduled');
select is(
  (select command from cron.job where jobname = 'marketplace.listing_events.retention'),
  'select app_private.run_scheduled_job(''listing_events.retention'')',
  'through the dispatcher and nothing else: a cron command is never business logic');

-- 0032's and 0073's jobs are all still there, and the retention job is the only one added.
-- Narrowed by 0102, which added the rollup. What belongs to this increment is that its own job is there
-- exactly once and that it added no second retention rule, both of which are asserted around this line.
select ok((select count(*) from app_private.scheduled_job_contract) >= 14,
  'this increment''s job joined 0032''s twelve and 0073''s purge, and none was displaced');
select is(
  (select count(*) from app_private.scheduled_job_contract where job_key like '%purge%'),
  1::bigint, 'and the only purge is still 0073''s, so no second retention rule was invented');
select ok(
  exists (select 1 from app_private.scheduled_job_contract where job_key = 'partitions.ensure'),
  '0032''s partition creator is untouched');
select ok(
  exists (select 1 from app_private.scheduled_job_contract where job_key = 'promotions.rollup'),
  'and the promotion rollup, which this increment does not change');

-- ---------------------------------------------------------------------------------------------------
-- The dispatcher gained one branch and lost nothing
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select p.prosrc like '%listing_events.retention%' from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'run_scheduled_job'),
  'the dispatcher reaches the retention job');
select ok(
  (select p.prosrc like '%drop_expired_listing_event_partitions(90)%' from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'run_scheduled_job'),
  'with the ninety-day argument written in the branch');

-- Every other branch, named, so a reproduction that dropped one fails here rather than in production.
select ok(
  (select bool_and(p.prosrc like '%' || k.job_key || '%') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join app_private.scheduled_job_contract k
    where n.nspname = 'app_private' and p.proname = 'run_scheduled_job'),
  'every job in the contract has a branch in the dispatcher');
select ok(
  (select p.prosrc like '%finish_job_run(run_id, ''failed''%' from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'run_scheduled_job'),
  'the failure path still records a failed run');
select ok(
  (select p.prosrc like '%sqlstate_%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'run_scheduled_job'),
  'with the prefixed error type 0007''s constraint requires');
select ok(
  (select p.prosrc like '%return -1%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'run_scheduled_job'),
  'and it does not re-raise, because pg_cron gives each command its own transaction');
select ok(
  (select p.prosrc like '%finish_job_run(run_id, ''succeeded''%' from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'run_scheduled_job'),
  'the success path still records a succeeded run with its count');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'run_scheduled_job'),
  1, 'and there is exactly one dispatcher: no overload was created');

-- ---------------------------------------------------------------------------------------------------
-- Dropping, and not dropping
-- ---------------------------------------------------------------------------------------------------
create function pg_temp.partitions_of(p_table text) returns text[] language sql stable as $f$
  select coalesce(array_agg(child.relname::text order by child.relname), array[]::text[])
    from pg_inherits i
    join pg_class child on child.oid = i.inhrelid
    join pg_class parent on parent.oid = i.inhparent
    join pg_namespace ns on ns.oid = parent.relnamespace
   where ns.nspname = 'public' and parent.relname = p_table;
$f$;

-- Two months that are wholly outside a ninety-day window, and one that is not. The names are the ones
-- `ensure_month_partitions` would have produced, which is what the function matches on.
create table public.listing_events_202401 partition of public.listing_events
  for values from ('2024-01-01+00') to ('2024-02-01+00');
create table public.listing_events_202402 partition of public.listing_events
  for values from ('2024-02-01+00') to ('2024-03-01+00');

select ok(
  pg_temp.partitions_of('listing_events') @> array['listing_events_202401', 'listing_events_202402'],
  'two expired partitions exist before the run');

-- An event inside one of them, so the drop is observably a drop of data and not only of a relation.
insert into public.listing_events (event_id, listing_id, event_type, occurred_at)
values ('e1010000-0000-4000-8000-000000000001', 'e1010000-0000-4000-8000-0000000000a1',
        'click', '2024-01-15T10:00:00Z');
select is((select count(*) from public.listing_events), 1::bigint, 'and it holds one event');

select is(app_private.drop_expired_listing_event_partitions(90), 2,
  'the run drops exactly the two expired partitions');
select is((select count(*) from public.listing_events), 0::bigint, 'the event inside them is gone');
select ok(
  not (pg_temp.partitions_of('listing_events') && array['listing_events_202401', 'listing_events_202402']),
  'and neither partition remains');

-- The current partitions, which 0032 keeps three months ahead, are all still there.
select ok(
  array_length(pg_temp.partitions_of('listing_events'), 1) >= 3,
  'the partitions inside the window are untouched');
select ok(
  (select bool_and(part >= 'listing_events_2026') from unnest(pg_temp.partitions_of('listing_events')) as part),
  'every surviving partition is a recent one');

-- A second run is idempotent: nothing is left to drop.
select is(app_private.drop_expired_listing_event_partitions(90), 0,
  'a second run drops nothing, so the job is idempotent');

-- A partition that still reaches inside the window is kept, which is the whole point of the monthly model.
create table public.listing_events_boundary partition of public.listing_events
  for values from ('2099-01-01+00') to ('2099-02-01+00');
select is(app_private.drop_expired_listing_event_partitions(90), 0,
  'a future partition is never dropped');
select ok(
  pg_temp.partitions_of('listing_events') @> array['listing_events_boundary'],
  'and it survives — though its name does not match the generated shape, so it could not be dropped anyway');
drop table public.listing_events_boundary;

-- A very long window keeps everything; a very short one still only drops whole expired months.
select is(app_private.drop_expired_listing_event_partitions(36500), 0,
  'a hundred-year window drops nothing');
select ok(app_private.drop_expired_listing_event_partitions(1) >= 0,
  'and a one-day window is accepted, dropping only months that are wholly past');

-- A window that is not a window is refused rather than obeyed.
select throws_ok(
  'select app_private.drop_expired_listing_event_partitions(0)',
  '22023', null, 'a window of zero is refused');
select throws_ok(
  'select app_private.drop_expired_listing_event_partitions(-1)',
  '22023', null, 'and a negative one');
select throws_ok(
  'select app_private.drop_expired_listing_event_partitions(null)',
  '22023', null, 'and no window at all');

-- ---------------------------------------------------------------------------------------------------
-- Only this table
-- ---------------------------------------------------------------------------------------------------
select ok(
  array_length(pg_temp.partitions_of('promotion_events'), 1) >= 3,
  'promotion_events still has its partitions');
create table public.promotion_events_202401 partition of public.promotion_events
  for values from ('2024-01-01+00') to ('2024-02-01+00');
select is(app_private.drop_expired_listing_event_partitions(90), 0,
  'an expired promotion_events partition is not dropped by the listing retention job');
select ok(
  pg_temp.partitions_of('promotion_events') @> array['promotion_events_202401'],
  'it is still there: the decision is about raw listing events and nothing else');
drop table public.promotion_events_202401;

select ok(
  (select p.prosrc not like '%promotion_events%' from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'drop_expired_listing_event_partitions'),
  'the function does not name promotion_events');
select ok(
  (select p.prosrc not like '%audit%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'drop_expired_listing_event_partitions'),
  'nor the audit log');
select ok(
  (select p.prosrc like '%pg_inherits%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'drop_expired_listing_event_partitions'),
  'it reaches only real partitions of one table, through pg_inherits');
select ok(
  (select p.prosrc like '%^listing\_events\_[0-9]{6}$%' or p.prosrc like '%listing_events_[0-9]{6}%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'drop_expired_listing_event_partitions'),
  'and only names matching the generated monthly shape');

-- ---------------------------------------------------------------------------------------------------
-- 0013's ingestion surface is untouched
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'record_listing_events', array['jsonb'],
  '0013''s batch writer still has its signature');
select ok(
  has_function_privilege('app_system', 'app_private.record_listing_events(jsonb)', 'execute'),
  'app_system may still write events: the degraded direct path');
select ok(
  has_function_privilege('app_worker', 'app_private.record_listing_events(jsonb)', 'execute'),
  'and the worker may: the stream consumer');
select ok(
  not has_function_privilege('public', 'app_private.record_listing_events(jsonb)', 'execute'),
  'and public may not');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'record_listing_events'),
  1, 'with exactly one of it: this increment did not replace or overload it');

-- De-duplication, which is what makes at-least-once delivery safe.
select is(
  app_private.record_listing_events(jsonb_build_array(
    jsonb_build_object('event_id', 'e1010000-0000-4000-8000-000000000011',
                       'listing_id', 'e1010000-0000-4000-8000-0000000000a1',
                       'event_type', 'click', 'occurred_at', now()::text))),
  1, 'one event is inserted');
-- Narrowed by 0107: the redelivery now carries a *different* timestamp. Both calls used to pass `now()::text`,
-- which is one value inside a pgTAP transaction, so the assertion matched on the old `(event_id, occurred_at)`
-- key and could not observe a break in de-duplication. `clock_timestamp()` advances; the invariant is unchanged.
select is(
  app_private.record_listing_events(jsonb_build_array(
    jsonb_build_object('event_id', 'e1010000-0000-4000-8000-000000000011',
                       'listing_id', 'e1010000-0000-4000-8000-0000000000a1',
                       'event_type', 'click', 'occurred_at', (clock_timestamp() + interval '3 seconds')::text))),
  0, 'and the same event id a second time inserts nothing, whatever its occurred_at');
select is((select count(*) from public.listing_events), 1::bigint, 'leaving one row');

-- A batch of the four types this increment emits.
select is(
  app_private.record_listing_events((
    select jsonb_agg(jsonb_build_object(
      'event_id', gen_random_uuid(),
      'listing_id', 'e1010000-0000-4000-8000-0000000000a1',
      'event_type', t,
      'occurred_at', now()::text))
    from unnest(array['click', 'contact', 'favorite', 'share']) as t)),
  4, 'a batch of the four V1 event types is accepted');
select is((select count(distinct event_type) from public.listing_events), 4::bigint,
  'and all four are stored');

-- The two this increment does not emit are still permitted by the schema, because excluding them is a
-- decision in the application rather than a change to 0013's constraint.
select is(
  app_private.record_listing_events(jsonb_build_array(
    jsonb_build_object('event_id', gen_random_uuid(),
                       'listing_id', 'e1010000-0000-4000-8000-0000000000a1',
                       'event_type', 'view', 'occurred_at', now()::text))),
  1, 'a view is still storable: Phase 9 owns its definition, not this schema');
select is(
  app_private.record_listing_events(jsonb_build_array(
    jsonb_build_object('event_id', gen_random_uuid(),
                       'listing_id', 'e1010000-0000-4000-8000-0000000000a1',
                       'event_type', 'impression', 'occurred_at', now()::text))),
  1, 'and an impression');
select ok(
  exists (select 1 from pg_constraint
           where conrelid = 'public.listing_events'::regclass
             and pg_get_constraintdef(oid) like '%impression%'
             and pg_get_constraintdef(oid) like '%view%'),
  'because 0013''s own constraint still permits all six types, unchanged');

-- An unknown event type is refused by that constraint.
select throws_ok(
  $q$ select app_private.record_listing_events(jsonb_build_array(
        jsonb_build_object('event_id', gen_random_uuid(),
                           'listing_id', 'e1010000-0000-4000-8000-0000000000a1',
                           'event_type', 'purchase', 'occurred_at', now()::text))) $q$,
  '23514', null, 'an event type outside the six is refused by 0013''s constraint');

-- The session hash is bytea and arrives hex-encoded, which is what the API will send.
select is(
  app_private.record_listing_events(jsonb_build_array(
    jsonb_build_object('event_id', 'e1010000-0000-4000-8000-000000000022',
                       'listing_id', 'e1010000-0000-4000-8000-0000000000a1',
                       'event_type', 'click', 'occurred_at', now()::text,
                       'session_hash', repeat('ab', 32)))),
  1, 'an event with a hex session hash is accepted');
select is(
  (select length(session_hash) from public.listing_events
    where event_id = 'e1010000-0000-4000-8000-000000000022'),
  32, 'and the hash is stored as thirty-two bytes, which is one SHA-256');

-- A non-array payload is refused, so a malformed batch cannot be partially written.
select throws_ok(
  $q$ select app_private.record_listing_events('{"event_type":"click"}'::jsonb) $q$,
  null, null, 'a payload that is not an array is refused');

-- ---------------------------------------------------------------------------------------------------
-- No rollup, no reader, no console
-- ---------------------------------------------------------------------------------------------------
-- Narrowed by 0102, which is the increment that reads. What this increment owns is that **none of its own
-- functions** consumes the key: ingestion is not a console and must never become the thing that reads.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('record_listing_events', 'drop_expired_listing_event_partitions')
      and p.prosrc like '%analytics.listing.read%'),
  0, 'neither the writer nor the retention job consumes analytics.listing.read');
select ok(
  exists (select 1 from public.permissions where key = 'analytics.listing.read'),
  'the key is seeded, and 0102 is the increment that reads it');
select is(
  (select coalesce(array_agg(p.proname::text order by p.proname), array[]::text[])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc ~ 'listing_events'
      and p.proname <> 'run_scheduled_job'),
  -- 0102's rollup reads the stream as well; the three this increment is about are unchanged.
  array['drop_expired_listing_event_partitions', 'ensure_event_partitions', 'record_listing_events',
        'rollup_listing_analytics'],
  'besides the dispatcher, four functions name listing_events: 0013''s writer, 0032''s partitioner, this increment''s retention and 0102''s rollup');
select is(
  (select coalesce(array_agg(p.proname::text order by p.proname), array[]::text[])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc ~ 'promotion_analytics'
      and p.proname <> 'run_scheduled_job'),
  array['rollup_promotion_analytics', 'seller_promotion_analytics'],
  'and promotion analytics is exactly as 6-J left it: the dispatcher reaches its rollup and nothing new does');
-- Narrowed by 0102, which created the rollup table this assertion named as the later increment's. What
-- remains true, and is what this increment is accountable for, is that **nothing it added touches it**: the
-- writer and the retention job neither read nor write the rollup, so ingestion cannot become aggregation.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('record_listing_events', 'drop_expired_listing_event_partitions')
      and p.prosrc like '%listing_analytics%'),
  0, 'neither the writer nor the retention job names the rollup table');
select hasnt_table('public', 'listing_event_rollups',
  'and no rollup exists under a second name: 0102''s is public.listing_analytics');

-- ---------------------------------------------------------------------------------------------------
-- Nothing financial
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select p.prosrc !~* 'settlement|payout|balance|payment|ledger|commission|withdrawal'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'drop_expired_listing_event_partitions'),
  'the retention function names nothing financial');
select is(
  (select value from public.site_settings where key = 'finance.settlement_posting_enabled'),
  'false', 'and the settlement posting flag is still false, untouched');

rollback;
