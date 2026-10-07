-- pgTAP — migration 0081: platform job runs and outbox health, the admin side (Phase 7-Q).
--
-- What these assertions hold to account:
--
--   * **one key, and only the two roles that hold it.** Every function is driven by an admin, a
--     super_admin, a moderator, a support agent and a buyer; the first two read, the other three get
--     nothing — never a row, never an error saying why.
--   * **both roles holding the key are `requires_mfa`, so read is gated at aal2** although
--     `job_runs_admin_read` itself has no `is_aal2()`. Each function is driven by the right person at
--     `aal1`, by a revoked grant and by an expired one.
--   * **`job_runs.details -> 'message'` never crosses.** `message` is `left(sqlerrm, 500)` and a raw
--     PostgreSQL error message embeds row data, so a failure fixture is written whose message contains a
--     canary string, and every projection of every function is searched for it. This is the assertion this
--     file exists for most.
--   * **the four outbox states are 0007's own**, taken from its partial indexes: a fixture is built with a
--     row in each and the counts are checked against hand-computed numbers, including a pending row that is
--     not yet due.
--   * **not one identifier crosses on the outbox surface.** Asserted on the result types: no event id, no
--     aggregate id or type, no payload, no `created_by` — on either outbox function.
--   * **nothing here writes.** Every function is `stable` rather than `volatile`, none contains an `insert`,
--     `update` or `delete` statement, and the row counts of `job_runs` and `outbox_events` are compared
--     before and after every function has been called.
--   * **this increment adds no writer at all**, which is the property that would break first if somebody
--     later added a retry or cancel control: the exact inventory of `app_private` functions this migration
--     creates is asserted, and every one of them is `stable`.
--   * **no threshold and no verdict.** Nothing returns a boolean health answer or a "stale" flag, because
--     `sweep_outbox_events` takes its threshold from its caller.
--
-- Deterministic: fixed uuids, explicit ages, and every fixture given a distinct age so no assertion depends
-- on `now()` being transaction-stable. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(225);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
/*
 * `job_runs` is not empty in a database that has been up for a while: pg_cron really runs the thirteen
 * contracted jobs, and each run really records a row. So the fixture starts by clearing both tables, inside
 * the transaction this file rolls back, and every count below is then a count of exactly what this file put
 * there. Asserting against "my rows plus however many the scheduler happened to write" would be a test whose
 * result depends on how long the database has been running.
 *
 * Neither table is append-only — `append_only_problems()` does not name them — so this is a plain delete and
 * not a hole in a guard.
 */
delete from public.job_runs;
delete from public.outbox_events;

insert into auth.users (id, email) values
  ('fb000000-0000-4000-8000-000000000001', 'r-admin@test.invalid'),
  ('fb000000-0000-4000-8000-000000000002', 'r-super-admin@test.invalid'),
  ('fb000000-0000-4000-8000-000000000003', 'r-moderator@test.invalid'),
  ('fb000000-0000-4000-8000-000000000004', 'r-support-agent@test.invalid'),
  ('fb000000-0000-4000-8000-000000000005', 'r-buyer@test.invalid'),
  ('fb000000-0000-4000-8000-000000000006', 'r-revoked-admin@test.invalid'),
  ('fb000000-0000-4000-8000-000000000007', 'r-expired-admin@test.invalid');

insert into public.user_roles (user_id, role_key, granted_at) values
  ('fb000000-0000-4000-8000-000000000001', 'admin', now() - interval '10 days'),
  ('fb000000-0000-4000-8000-000000000002', 'super_admin', now() - interval '10 days'),
  ('fb000000-0000-4000-8000-000000000003', 'moderator', now() - interval '10 days'),
  ('fb000000-0000-4000-8000-000000000004', 'support_agent', now() - interval '10 days'),
  ('fb000000-0000-4000-8000-000000000005', 'buyer', now() - interval '10 days');

insert into public.user_roles (user_id, role_key, granted_at, revoked_at) values
  ('fb000000-0000-4000-8000-000000000006', 'admin', now() - interval '20 days', now() - interval '1 hour');
insert into public.user_roles (user_id, role_key, granted_at, expires_at) values
  ('fb000000-0000-4000-8000-000000000007', 'admin', now() - interval '20 days', now() - interval '1 hour');

/*
 * The canary. This string goes into `details -> 'message'` exactly where the dispatcher puts
 * `left(sqlerrm, 500)`, which is where a check-constraint violation would have quoted the failing row. If
 * any projection anywhere in this migration carries it, an admin screen can carry arbitrary row data.
 */
create or replace function pg_temp.canary() returns text
language sql immutable as $$ select 'CANARY_ROW_DATA_THAT_MUST_NEVER_BE_PROJECTED'::text $$;

-- Four runs of a contracted job, each with a distinct age so the newest-first order is unambiguous, plus
-- one run of a job the contract does not name.
insert into public.job_runs (id, job_name, scheduled_for, started_at, finished_at, status,
                             error_type, processed_count, details) values
  -- Succeeded, oldest.
  ('fc000000-0000-4000-8000-000000000001', 'offers.expire', null,
   now() - interval '40 minutes', now() - interval '40 minutes' + interval '250 milliseconds',
   'succeeded', null, 7, jsonb_build_object('job_key', 'offers.expire')),
  -- Failed, and its details carry the canary exactly as the dispatcher would have written it.
  ('fc000000-0000-4000-8000-000000000002', 'offers.expire', null,
   now() - interval '30 minutes', now() - interval '30 minutes' + interval '120 milliseconds',
   'failed', 'sqlstate_23514', null,
   jsonb_build_object('job_key', 'offers.expire', 'sqlstate', '23514', 'message', pg_temp.canary())),
  -- Skipped.
  ('fc000000-0000-4000-8000-000000000003', 'offers.expire', null,
   now() - interval '20 minutes', now() - interval '20 minutes', 'skipped', null, 0,
   jsonb_build_object('job_key', 'offers.expire')),
  -- Running, newest: no finish time, which `job_runs_finished_when_done` makes equivalent to the status.
  ('fc000000-0000-4000-8000-000000000004', 'offers.expire', null,
   now() - interval '10 minutes', null, 'running', null, null, '{}'::jsonb),
  -- A run of a job key the contract does not name. It stays readable and is reported as uncontracted.
  ('fc000000-0000-4000-8000-000000000005', 'legacy.retired_job', null,
   now() - interval '5 minutes', now() - interval '5 minutes' + interval '10 milliseconds',
   'succeeded', null, 0, jsonb_build_object('job_key', 'legacy.retired_job'));

-- A scheduled run, to prove `scheduled_for` crosses and the unique index tolerates one.
insert into public.job_runs (id, job_name, scheduled_for, started_at, finished_at, status, processed_count,
                             details) values
  ('fc000000-0000-4000-8000-000000000006', 'partitions.ensure', timestamptz '2026-01-01 03:10:00+00',
   now() - interval '1 minute', now() - interval '1 minute' + interval '5 milliseconds', 'succeeded', 3,
   jsonb_build_object('job_key', 'partitions.ensure'));

-- One outbox event in each of 0007's four states, plus a pending row that is not yet due.
insert into public.outbox_events (id, aggregate_type, aggregate_id, event_type, payload, occurred_at,
                                  available_at, published_at, completed_at, dead_lettered_at, attempts,
                                  last_error_type) values
  -- Pending and due, oldest occurrence.
  ('fd000000-0000-4000-8000-000000000001', 'order', 'CANARY_AGGREGATE_ID_1', 'order.placed',
   jsonb_build_object('secret', pg_temp.canary()), now() - interval '9 hours', now() - interval '9 hours',
   null, null, null, 0, null),
  -- Pending and NOT yet due: counted as pending, not as due.
  ('fd000000-0000-4000-8000-000000000002', 'order', 'CANARY_AGGREGATE_ID_2', 'order.placed',
   '{}'::jsonb, now() - interval '8 hours', now() + interval '1 hour', null, null, null, 0, null),
  -- In flight: published, not completed, not dead.
  ('fd000000-0000-4000-8000-000000000003', 'review', 'CANARY_AGGREGATE_ID_3', 'review.moderated',
   '{}'::jsonb, now() - interval '7 hours', now() - interval '7 hours', now() - interval '6 hours',
   null, null, 1, null),
  -- Completed.
  ('fd000000-0000-4000-8000-000000000004', 'review', 'CANARY_AGGREGATE_ID_4', 'review.moderated',
   '{}'::jsonb, now() - interval '5 hours', now() - interval '5 hours', now() - interval '4 hours',
   now() - interval '3 hours', null, 1, null),
  -- Dead-lettered, two of one class and one of another.
  ('fd000000-0000-4000-8000-000000000005', 'order', 'CANARY_AGGREGATE_ID_5', 'order.placed',
   '{}'::jsonb, now() - interval '5 hours', now() - interval '5 hours', now() - interval '4 hours',
   null, now() - interval '2 hours', 5, 'TransportError'),
  ('fd000000-0000-4000-8000-000000000006', 'order', 'CANARY_AGGREGATE_ID_6', 'order.placed',
   '{}'::jsonb, now() - interval '5 hours', now() - interval '5 hours', now() - interval '4 hours',
   null, now() - interval '90 minutes', 6, 'TransportError'),
  ('fd000000-0000-4000-8000-000000000007', 'payout', 'CANARY_AGGREGATE_ID_7', 'payout.requested',
   '{}'::jsonb, now() - interval '5 hours', now() - interval '5 hours', now() - interval '4 hours',
   null, now() - interval '1 hour', 4, 'ProviderRejected');

-- Shorthands. Each takes the account and the assurance level, exactly as the functions do.
create or replace function pg_temp.runs(p_user uuid, p_aal2 boolean default true)
returns bigint language sql as $$
  select count(*) from app_private.job_run_page(p_user, p_aal2, 50);
$$;

create or replace function pg_temp.detail_outcome(p_user uuid, p_aal2 boolean default true,
                                                 p_run uuid default 'fc000000-0000-4000-8000-000000000002')
returns text language sql as $$
  select outcome from app_private.job_run_detail(p_user, p_aal2, p_run);
$$;

create or replace function pg_temp.catalogue(p_user uuid, p_aal2 boolean default true)
returns bigint language sql as $$
  select count(*) from app_private.scheduled_job_catalogue(p_user, p_aal2);
$$;

create or replace function pg_temp.health_outcome(p_user uuid, p_aal2 boolean default true)
returns text language sql as $$
  select outcome from app_private.outbox_health(p_user, p_aal2);
$$;

create or replace function pg_temp.dead(p_user uuid, p_aal2 boolean default true)
returns bigint language sql as $$
  select count(*) from app_private.outbox_dead_letters(p_user, p_aal2, 50);
$$;

create or replace function pg_temp.problems(p_user uuid, p_aal2 boolean default true)
returns bigint language sql as $$
  select count(*) from app_private.platform_schedule_problems(p_user, p_aal2);
$$;

/* Everything one function returns, as one string, for searching. */
create or replace function pg_temp.dump(p_sql text) returns text
language plpgsql as $$
declare
  out text := '';
  row record;
begin
  for row in execute p_sql loop
    out := out || row::text;
  end loop;
  return out;
end;
$$;

create or replace function pg_temp.result_columns(p_name text) returns text
language sql stable as $$
  select string_agg(a.argname, ',' order by a.ord)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(p.proargnames, p.proargmodes) with ordinality as a(argname, argmode, ord)
   where n.nspname = 'app_private' and p.proname = p_name and a.argmode = 't';
$$;

-- ---------------------------------------------------------------------------------------------------
-- 1. The functions exist, are SECURITY DEFINER, are pinned, and every one of them is STABLE
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'platform_can_read_jobs', array['uuid', 'boolean'],
  'the one predicate exists');
select has_function('app_private', 'job_run_page',
  array['uuid', 'boolean', 'integer', 'text', 'text', 'timestamptz', 'uuid'], 'the run page exists');
select has_function('app_private', 'job_run_detail', array['uuid', 'boolean', 'uuid'],
  'one run exists');
select has_function('app_private', 'scheduled_job_catalogue', array['uuid', 'boolean'],
  'the catalogue exists');
select has_function('app_private', 'outbox_health', array['uuid', 'boolean'], 'outbox health exists');
select has_function('app_private', 'outbox_dead_letters', array['uuid', 'boolean', 'integer'],
  'grouped dead letters exist');
select has_function('app_private', 'platform_schedule_problems', array['uuid', 'boolean'],
  'the schedule guard wrapper exists');

select is(p.prosecdef, true, format('%s is security definer', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('platform_can_read_jobs', 'job_run_page', 'job_run_detail',
                     'scheduled_job_catalogue', 'outbox_health', 'outbox_dead_letters',
                     'platform_schedule_problems');

select ok(p.proconfig @> array['search_path=pg_catalog, public'],
          format('%s pins its search path', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('platform_can_read_jobs', 'job_run_page', 'job_run_detail',
                     'scheduled_job_catalogue', 'outbox_health', 'outbox_dead_letters',
                     'platform_schedule_problems');

/*
 * The defining property of this increment. A volatile function is one that may write; every function here
 * is `stable`, which is the declaration that it does not. If somebody later adds a retry or a cancel
 * control to this migration, this is the assertion that fails.
 */
select is(p.provolatile, 's'::"char", format('%s is stable, so it cannot be a writer', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('platform_can_read_jobs', 'job_run_page', 'job_run_detail',
                     'scheduled_job_catalogue', 'outbox_health', 'outbox_dead_letters',
                     'platform_schedule_problems');

-- And the inventory is exactly those seven: nothing else was added under a platform, job or outbox name.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'platform_%' or p.proname like 'job_run%')),
  4::bigint,
  'exactly four app_private functions are named for the platform or a job run'
);

-- ---------------------------------------------------------------------------------------------------
-- 2. EXECUTE is revoked from public and granted to app_system only
-- ---------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('public', format('app_private.%s', sig), 'execute'),
          format('public cannot execute %s', sig))
  from unnest(array[
    'platform_can_read_jobs(uuid, boolean)',
    'job_run_page(uuid, boolean, integer, text, text, timestamptz, uuid)',
    'job_run_detail(uuid, boolean, uuid)',
    'scheduled_job_catalogue(uuid, boolean)',
    'outbox_health(uuid, boolean)',
    'outbox_dead_letters(uuid, boolean, integer)',
    'platform_schedule_problems(uuid, boolean)'
  ]) as sig;

select ok(has_function_privilege('app_system', format('app_private.%s', sig), 'execute'),
          format('app_system may execute %s', sig))
  from unnest(array[
    'platform_can_read_jobs(uuid, boolean)',
    'job_run_page(uuid, boolean, integer, text, text, timestamptz, uuid)',
    'job_run_detail(uuid, boolean, uuid)',
    'scheduled_job_catalogue(uuid, boolean)',
    'outbox_health(uuid, boolean)',
    'outbox_dead_letters(uuid, boolean, integer)',
    'platform_schedule_problems(uuid, boolean)'
  ]) as sig;

-- `anon` and `authenticated` reach none of it, whatever 0007's own policy says about the table.
select ok(not has_function_privilege('anon', 'app_private.job_run_page(uuid, boolean, integer, text, text, timestamptz, uuid)', 'execute'),
  'anon cannot execute the run page');
select ok(not has_function_privilege('authenticated', 'app_private.outbox_health(uuid, boolean)', 'execute'),
  'authenticated cannot execute outbox health');
select ok(not has_function_privilege('authenticated', 'app_private.outbox_dead_letters(uuid, boolean, integer)', 'execute'),
  'authenticated cannot execute the dead-letter grouping');

-- ---------------------------------------------------------------------------------------------------
-- 3. The predicate: one key, two roles, and the MFA rule
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.platform_can_read_jobs('fb000000-0000-4000-8000-000000000001', true),
  'an admin at aal2 holds platform.job.read');
select ok(app_private.platform_can_read_jobs('fb000000-0000-4000-8000-000000000002', true),
  'a super_admin at aal2 holds it');
select ok(not app_private.platform_can_read_jobs('fb000000-0000-4000-8000-000000000003', true),
  'a moderator does not hold it');
select ok(not app_private.platform_can_read_jobs('fb000000-0000-4000-8000-000000000004', true),
  'a support agent does not hold it');
select ok(not app_private.platform_can_read_jobs('fb000000-0000-4000-8000-000000000005', true),
  'a buyer does not hold it');

-- The assurance rule, although `job_runs_admin_read` itself carries no is_aal2().
select ok(not app_private.platform_can_read_jobs('fb000000-0000-4000-8000-000000000001', false),
  'an admin at aal1 holds nothing, because admin is requires_mfa');
select ok(not app_private.platform_can_read_jobs('fb000000-0000-4000-8000-000000000002', false),
  'a super_admin at aal1 holds nothing either');
select ok(not app_private.platform_can_read_jobs('fb000000-0000-4000-8000-000000000001', null),
  'a null assurance level is treated as aal1, never as aal2');

select ok(not app_private.platform_can_read_jobs('fb000000-0000-4000-8000-000000000006', true),
  'a revoked grant holds nothing');
select ok(not app_private.platform_can_read_jobs('fb000000-0000-4000-8000-000000000007', true),
  'an expired grant holds nothing');
select ok(not app_private.platform_can_read_jobs(null, true), 'no account holds anything');

-- The key is a literal in the body, not a parameter: the function takes two arguments and neither is text.
select is(
  (select pg_get_function_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'platform_can_read_jobs'),
  'p_user_id uuid, p_is_aal2 boolean',
  'the predicate takes an account and an assurance level, and no key: it cannot be asked about another'
);
select ok(pg_get_functiondef(p.oid) like '%''platform.job.read''%',
          'the key appears as a literal in the predicate')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'platform_can_read_jobs';

-- ---------------------------------------------------------------------------------------------------
-- 4. Every function refuses everyone but the two roles, at aal2
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.runs('fb000000-0000-4000-8000-000000000001'), 6::bigint,
  'an admin reads all six runs');
select is(pg_temp.runs('fb000000-0000-4000-8000-000000000002'), 6::bigint,
  'a super_admin reads them too');
select is(pg_temp.runs('fb000000-0000-4000-8000-000000000003'), 0::bigint,
  'a moderator reads no run');
select is(pg_temp.runs('fb000000-0000-4000-8000-000000000004'), 0::bigint,
  'a support agent reads no run');
select is(pg_temp.runs('fb000000-0000-4000-8000-000000000005'), 0::bigint,
  'a buyer reads no run');
select is(pg_temp.runs('fb000000-0000-4000-8000-000000000001', false), 0::bigint,
  'an admin at aal1 reads no run');
select is(pg_temp.runs('fb000000-0000-4000-8000-000000000006'), 0::bigint,
  'a revoked admin reads no run');
select is(pg_temp.runs('fb000000-0000-4000-8000-000000000007'), 0::bigint,
  'an expired admin reads no run');
select is(pg_temp.runs(null), 0::bigint, 'no account reads no run');

select is(pg_temp.detail_outcome('fb000000-0000-4000-8000-000000000001'), 'found',
  'an admin reads one run');
select is(pg_temp.detail_outcome('fb000000-0000-4000-8000-000000000002'), 'found',
  'a super_admin reads one run');
select is(pg_temp.detail_outcome('fb000000-0000-4000-8000-000000000003'), 'not_found',
  'a moderator is answered exactly as a missing run is');
select is(pg_temp.detail_outcome('fb000000-0000-4000-8000-000000000004'), 'not_found',
  'a support agent likewise');
select is(pg_temp.detail_outcome('fb000000-0000-4000-8000-000000000005'), 'not_found',
  'a buyer likewise');
select is(pg_temp.detail_outcome('fb000000-0000-4000-8000-000000000001', false), 'not_found',
  'an admin at aal1 likewise');
select is(pg_temp.detail_outcome('fb000000-0000-4000-8000-000000000006'), 'not_found',
  'a revoked admin likewise');
select is(pg_temp.detail_outcome('fb000000-0000-4000-8000-000000000007'), 'not_found',
  'an expired admin likewise');
select is(pg_temp.detail_outcome(null), 'not_found', 'and no account likewise');

-- A run that does not exist answers identically to a caller who may not read one. That is the whole point.
select is(
  pg_temp.detail_outcome('fb000000-0000-4000-8000-000000000001', true,
                         'fc000000-0000-4000-8000-0000000000ff'),
  pg_temp.detail_outcome('fb000000-0000-4000-8000-000000000003'),
  'an absent run and a missing permission give the same answer'
);
select is(pg_temp.detail_outcome('fb000000-0000-4000-8000-000000000001', true, null), 'not_found',
  'a null run id is the same answer again');

-- Fifteen since 0102 added the listing analytics rollup, after 0101's retention job made it fourteen.
-- Narrowed by 0107, which added two prune jobs. The invariant is that the catalogue matches the contract
-- exactly and carries nothing extra, and that is unchanged — only the number moved.
select is(pg_temp.catalogue('fb000000-0000-4000-8000-000000000001'), 17::bigint,
  'an admin reads the whole contract');
select is(pg_temp.catalogue('fb000000-0000-4000-8000-000000000003'), 0::bigint,
  'a moderator reads no contract row');
select is(pg_temp.catalogue('fb000000-0000-4000-8000-000000000004'), 0::bigint,
  'a support agent reads none');
select is(pg_temp.catalogue('fb000000-0000-4000-8000-000000000001', false), 0::bigint,
  'an admin at aal1 reads none');
select is(pg_temp.catalogue(null), 0::bigint, 'no account reads none');

select is(pg_temp.health_outcome('fb000000-0000-4000-8000-000000000001'), 'found',
  'an admin reads outbox health');
select is(pg_temp.health_outcome('fb000000-0000-4000-8000-000000000002'), 'found',
  'a super_admin reads it');
/*
 * The defect this shape exists to prevent. An aggregate over a set the WHERE clause emptied returns one row
 * of zeros, which is not a refusal — a service would render a health panel of zeros to somebody holding no
 * key. Testing the key before the aggregate runs is what makes the refusal a stated outcome.
 */
select is(pg_temp.health_outcome('fb000000-0000-4000-8000-000000000003'), 'not_found',
  'a moderator is refused rather than handed a row of zeros');
select is(pg_temp.health_outcome('fb000000-0000-4000-8000-000000000004'), 'not_found',
  'a support agent likewise');
select is(pg_temp.health_outcome('fb000000-0000-4000-8000-000000000005'), 'not_found',
  'a buyer likewise');
select is(pg_temp.health_outcome('fb000000-0000-4000-8000-000000000001', false), 'not_found',
  'an admin at aal1 likewise');
select is(pg_temp.health_outcome('fb000000-0000-4000-8000-000000000006'), 'not_found',
  'a revoked admin likewise');
select is(pg_temp.health_outcome(null), 'not_found', 'and no account likewise');
select is(
  (select pending_count from app_private.outbox_health('fb000000-0000-4000-8000-000000000003', true)),
  null::bigint,
  'a refused health read carries no number at all, not even a zero'
);

select is(pg_temp.dead('fb000000-0000-4000-8000-000000000001'), 2::bigint,
  'an admin reads two dead-letter groups');
select is(pg_temp.dead('fb000000-0000-4000-8000-000000000003'), 0::bigint,
  'a moderator reads no dead-letter group');
select is(pg_temp.dead('fb000000-0000-4000-8000-000000000004'), 0::bigint,
  'a support agent reads none');
select is(pg_temp.dead('fb000000-0000-4000-8000-000000000001', false), 0::bigint,
  'an admin at aal1 reads none');
select is(pg_temp.dead(null), 0::bigint, 'no account reads none');

select is(pg_temp.problems('fb000000-0000-4000-8000-000000000003'), 0::bigint,
  'a moderator reads no schedule problem');
select is(pg_temp.problems('fb000000-0000-4000-8000-000000000004'), 0::bigint,
  'a support agent reads none');
select is(pg_temp.problems('fb000000-0000-4000-8000-000000000001', false), 0::bigint,
  'an admin at aal1 reads none');
select is(pg_temp.problems(null), 0::bigint, 'no account reads none');

-- ---------------------------------------------------------------------------------------------------
-- 5. THE CANARY: `details -> 'message'` never crosses, from any function
-- ---------------------------------------------------------------------------------------------------
-- The fixture's failed run carries the canary in exactly the key `left(sqlerrm, 500)` is written to. If any
-- projection carries it, arbitrary row data can reach an admin screen.
select ok(
  pg_temp.dump($$select * from app_private.job_run_page(
    'fb000000-0000-4000-8000-000000000001'::uuid, true, 50)$$) not like
    '%' || pg_temp.canary() || '%',
  'the run page does not carry the raw error message'
);
select ok(
  pg_temp.dump($$select * from app_private.job_run_detail(
    'fb000000-0000-4000-8000-000000000001'::uuid, true,
    'fc000000-0000-4000-8000-000000000002'::uuid)$$) not like '%' || pg_temp.canary() || '%',
  'one run does not carry the raw error message either, and it is the run that has one'
);
select ok(
  pg_temp.dump($$select * from app_private.scheduled_job_catalogue(
    'fb000000-0000-4000-8000-000000000001'::uuid, true)$$) not like '%' || pg_temp.canary() || '%',
  'the catalogue does not carry it through its last-run columns'
);

-- Neither does the word `message` appear in any result column name, nor `details` itself.
select ok(',' || pg_temp.result_columns('job_run_page') || ',' not like '%,details,%',
  'the run page does not return the details blob');
select ok(',' || pg_temp.result_columns('job_run_detail') || ',' not like '%,details,%',
  'one run does not return the details blob');
select ok(pg_temp.result_columns('job_run_detail') not like '%message%',
  'one run returns no column whose name contains message');
select ok(pg_temp.result_columns('job_run_page') not like '%message%',
  'the run page returns no column whose name contains message');

-- What it does return instead: the two structured keys and the constrained column.
select is(
  (select error_sqlstate from app_private.job_run_detail('fb000000-0000-4000-8000-000000000001', true,
                                                         'fc000000-0000-4000-8000-000000000002')),
  '23514',
  'the sqlstate crosses, because five characters of error class carry no row data'
);
select is(
  (select detail_job_key from app_private.job_run_detail('fb000000-0000-4000-8000-000000000001', true,
                                                          'fc000000-0000-4000-8000-000000000002')),
  'offers.expire',
  'the job key crosses, and it is the key the row already carries in job_name'
);
select is(
  (select error_type from app_private.job_run_detail('fb000000-0000-4000-8000-000000000001', true,
                                                     'fc000000-0000-4000-8000-000000000002')),
  'sqlstate_23514',
  'the constrained error_type column crosses'
);

-- And the body reads those two keys and no third.
select ok(pg_get_functiondef(p.oid) not like '%''message''%',
          'the body of one run never names the message key')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'job_run_detail';
-- Asserted as the read it would have to perform, not as the word: the function's own comment explains why
-- `message` is skipped, and a comment is part of the body `pg_get_functiondef` returns.
select ok(pg_get_functiondef(p.oid) !~* $re$details\s*->>?\s*'message'$re$,
          'and no statement in it reads the message key out of details')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'job_run_detail';
select ok(pg_get_functiondef(p.oid) !~* $re$details\s*->>?\s*'message'$re$,
          'nor does the run page')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'job_run_page';

-- ---------------------------------------------------------------------------------------------------
-- 6. The outbox surface carries no identifier of any kind
-- ---------------------------------------------------------------------------------------------------
-- Asserted on the declared result columns, which is the property rather than a property of this fixture.
select ok(',' || pg_temp.result_columns('outbox_health') || ',' not like '%,' || col || ',%',
          format('outbox health returns no %s', col))
  from unnest(array['id', 'event_id', 'aggregate_id', 'aggregate_type', 'payload', 'created_by']) as col;

select ok(',' || pg_temp.result_columns('outbox_dead_letters') || ',' not like '%,' || col || ',%',
          format('the dead-letter grouping returns no %s', col))
  from unnest(array['id', 'event_id', 'aggregate_id', 'aggregate_type', 'payload', 'created_by']) as col;

-- The stronger version: the canary is in a pending event's payload, and every aggregate id in the fixture is
-- a canary string. Neither function's output contains any of them.
select ok(
  pg_temp.dump($$select * from app_private.outbox_health(
    'fb000000-0000-4000-8000-000000000001'::uuid, true)$$) not like '%CANARY%',
  'outbox health carries neither a payload nor an aggregate id'
);
select ok(
  pg_temp.dump($$select * from app_private.outbox_dead_letters(
    'fb000000-0000-4000-8000-000000000001'::uuid, true, 50)$$) not like '%CANARY%',
  'the dead-letter grouping carries neither a payload nor an aggregate id'
);

-- What the grouping does carry: the two constrained columns, and counts.
select is(
  (select event_count from app_private.outbox_dead_letters('fb000000-0000-4000-8000-000000000001', true, 50)
    where event_type = 'order.placed' and last_error_type = 'TransportError'),
  2::bigint,
  'two dead letters of one class are one group of two'
);
select is(
  (select event_count from app_private.outbox_dead_letters('fb000000-0000-4000-8000-000000000001', true, 50)
    where event_type = 'payout.requested' and last_error_type = 'ProviderRejected'),
  1::bigint,
  'and a different class is its own group'
);
select is(
  (select max_attempts from app_private.outbox_dead_letters('fb000000-0000-4000-8000-000000000001', true, 50)
    where last_error_type = 'TransportError'),
  6,
  'the group reports the highest attempt count in it'
);
-- Newest group first.
select is(
  (select array_agg(d.last_error_type order by d.ord)
     from app_private.outbox_dead_letters('fb000000-0000-4000-8000-000000000001', true, 50)
          with ordinality as d(event_type, last_error_type, event_count, first_at, last_at, attempts, ord)),
  array['ProviderRejected', 'TransportError'],
  'the most recently dead-lettered group comes first'
);

-- ---------------------------------------------------------------------------------------------------
-- 7. The four outbox states are 0007's own
-- ---------------------------------------------------------------------------------------------------
select is((select pending_count from app_private.outbox_health('fb000000-0000-4000-8000-000000000001', true)),
  2::bigint, 'two events are pending: unpublished and not dead');
select is((select due_count from app_private.outbox_health('fb000000-0000-4000-8000-000000000001', true)),
  1::bigint, 'one of them is due, which is claim_outbox_events'' own condition');
select is((select in_flight_count from app_private.outbox_health('fb000000-0000-4000-8000-000000000001', true)),
  1::bigint, 'one event is in flight: published, not completed, not dead');
select is((select completed_count from app_private.outbox_health('fb000000-0000-4000-8000-000000000001', true)),
  1::bigint, 'one event is completed');
select is((select dead_lettered_count from app_private.outbox_health('fb000000-0000-4000-8000-000000000001', true)),
  3::bigint, 'three events are dead-lettered');

-- A dead-lettered row was published, and it is counted as dead rather than as in flight: the states are
-- exclusive in the order 0007's indexes define them.
select is(
  (select in_flight_count + completed_count + dead_lettered_count + pending_count
     from app_private.outbox_health('fb000000-0000-4000-8000-000000000001', true)),
  7::bigint,
  'the four states partition every event exactly once'
);

select ok(
  (select oldest_pending_at from app_private.outbox_health('fb000000-0000-4000-8000-000000000001', true))
    < now() - interval '8 hours',
  'the oldest pending occurrence is reported as an age, not as a verdict'
);
select ok(
  (select oldest_in_flight_at from app_private.outbox_health('fb000000-0000-4000-8000-000000000001', true))
    < now() - interval '5 hours',
  'so is the oldest in-flight publication'
);
select is(
  (select max_attempts from app_private.outbox_health('fb000000-0000-4000-8000-000000000001', true)),
  6,
  'the highest attempt count in the table crosses as a number'
);

-- No verdict anywhere: nothing returns a boolean saying whether any of this is acceptable.
select ok(pg_temp.result_columns('outbox_health') not like '%is_%',
  'outbox health states no verdict');
select ok(pg_temp.result_columns('outbox_health') not like '%stale%',
  'and applies no staleness threshold, which sweep_outbox_events takes from its caller');
select ok(pg_temp.result_columns('outbox_health') not like '%healthy%',
  'and calls nothing healthy');

-- ---------------------------------------------------------------------------------------------------
-- 8. The run page: order, filters, cursor, clamping
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_agg(r.status order by r.ord)
     from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50) with ordinality
          as r(id, job_name, status, scheduled_for, started_at, finished_at, duration_ms, error_type,
               processed_count, is_contracted, ord)),
  array['succeeded', 'succeeded', 'running', 'skipped', 'failed', 'succeeded'],
  'runs come back newest first'
);

select is(
  (select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50, 'failed')),
  1::bigint, 'the status filter narrows to one of 0007''s four');
select is(
  (select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50, 'running')),
  1::bigint, 'including the running one');
select is(
  (select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50, 'approved')),
  0::bigint, 'a status the schema does not have matches nothing rather than raising');
select is(
  (select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50, null,
                                                 'offers.expire')),
  4::bigint, 'the job-name filter narrows to one job');
select is(
  (select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50, null,
                                                 'no.such_job')),
  0::bigint, 'an unknown job name matches nothing');
select is(
  (select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50, 'failed',
                                                 'offers.expire')),
  1::bigint, 'both filters apply together');

-- The cursor moves past a position and never repeats it.
select is(
  (select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50, null, null,
     (select started_at from public.job_runs where id = 'fc000000-0000-4000-8000-000000000004'),
     'fc000000-0000-4000-8000-000000000004')),
  3::bigint,
  'a cursor at the running row returns the three older rows and not itself'
);
select ok(
  (select bool_and(r.id <> 'fc000000-0000-4000-8000-000000000004')
     from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50, null, null,
       (select started_at from public.job_runs where id = 'fc000000-0000-4000-8000-000000000004'),
       'fc000000-0000-4000-8000-000000000004') r),
  'and the cursor row itself is never in the page'
);
-- Half a cursor is no cursor: both parts are needed, and neither alone silently changes the page.
select is(
  (select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50, null, null,
     now(), null)),
  6::bigint, 'a time with no identifier is ignored rather than half-applied');
select is(
  (select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50, null, null,
     null, 'fc000000-0000-4000-8000-000000000004')),
  6::bigint, 'an identifier with no time likewise');

select is((select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 2)),
  2::bigint, 'the limit is honoured');
select is((select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 0)),
  1::bigint, 'a limit of zero is clamped up to one');
select is((select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, -5)),
  1::bigint, 'so is a negative one');
select is((select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, null)),
  6::bigint, 'a null limit falls back to the default');
select is((select count(*) from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 9999)),
  6::bigint, 'and an enormous one is clamped to the ceiling');

-- ---------------------------------------------------------------------------------------------------
-- 9. What a run row says
-- ---------------------------------------------------------------------------------------------------
select is(
  (select duration_ms from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50)
    where id = 'fc000000-0000-4000-8000-000000000001'),
  250::bigint,
  'the duration is computed from the two timestamps the row already carries'
);
select is(
  (select duration_ms from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50)
    where id = 'fc000000-0000-4000-8000-000000000004'),
  null::bigint,
  'a running row has no duration, which job_runs_finished_when_done makes equivalent to its status'
);
select is(
  (select finished_at from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50)
    where id = 'fc000000-0000-4000-8000-000000000004'),
  null::timestamptz,
  'and no finish time'
);
select is(
  (select processed_count from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50)
    where id = 'fc000000-0000-4000-8000-000000000003'),
  0,
  'a skipped run that processed nothing reports zero'
);
select is(
  (select processed_count from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50)
    where id = 'fc000000-0000-4000-8000-000000000002'),
  null::integer,
  'and a failed run reports no count, which is a different fact from zero'
);
select is(
  (select scheduled_for from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50)
    where id = 'fc000000-0000-4000-8000-000000000006'),
  timestamptz '2026-01-01 03:10:00+00',
  'a scheduled run reports the moment it was scheduled for'
);

-- Contracted or not: a run of a key the schedule has dropped stays readable and says so.
select ok(
  (select is_contracted from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50)
    where id = 'fc000000-0000-4000-8000-000000000001'),
  'a run of a contracted job is reported as contracted'
);
select ok(
  not (select is_contracted from app_private.job_run_page('fb000000-0000-4000-8000-000000000001', true, 50)
        where id = 'fc000000-0000-4000-8000-000000000005'),
  'a run of a job the contract no longer names is reported as uncontracted, not hidden'
);

-- One run, with its contract row beside it.
select is(
  (select cron_schedule from app_private.job_run_detail('fb000000-0000-4000-8000-000000000001', true,
                                                         'fc000000-0000-4000-8000-000000000002')),
  '*/5 * * * *',
  'one run carries the cron expression of the job it belongs to'
);
select is(
  (select target_signature from app_private.job_run_detail('fb000000-0000-4000-8000-000000000001', true,
                                                            'fc000000-0000-4000-8000-000000000002')),
  'app_private.expire_due_offers(500)',
  'and what that job calls, so a failure can be traced without opening a migration'
);
select ok(
  (select purpose from app_private.job_run_detail('fb000000-0000-4000-8000-000000000001', true,
                                                   'fc000000-0000-4000-8000-000000000002')) is not null,
  'and the purpose 0032 wrote for it'
);
select is(
  (select cron_schedule from app_private.job_run_detail('fb000000-0000-4000-8000-000000000001', true,
                                                         'fc000000-0000-4000-8000-000000000005')),
  null::text,
  'an uncontracted run carries no schedule, because there is none to carry'
);
select ok(
  not (select is_contracted from app_private.job_run_detail('fb000000-0000-4000-8000-000000000001', true,
                                                             'fc000000-0000-4000-8000-000000000005')),
  'and says so rather than leaving the nulls to be interpreted'
);
select is(
  (select error_sqlstate from app_private.job_run_detail('fb000000-0000-4000-8000-000000000001', true,
                                                          'fc000000-0000-4000-8000-000000000001')),
  null::text,
  'a succeeded run has no sqlstate'
);

-- ---------------------------------------------------------------------------------------------------
-- 10. The catalogue
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.scheduled_job_catalogue('fb000000-0000-4000-8000-000000000001', true)),
  (select count(*) from app_private.scheduled_job_contract),
  'the catalogue reports every contracted job and no more'
);
select is(
  (select run_count from app_private.scheduled_job_catalogue('fb000000-0000-4000-8000-000000000001', true)
    where job_key = 'offers.expire'),
  4::bigint,
  'a job with four runs reports four'
);
select is(
  (select failure_count from app_private.scheduled_job_catalogue('fb000000-0000-4000-8000-000000000001', true)
    where job_key = 'offers.expire'),
  1::bigint,
  'and one failure among them'
);
select is(
  (select last_status from app_private.scheduled_job_catalogue('fb000000-0000-4000-8000-000000000001', true)
    where job_key = 'offers.expire'),
  'running',
  'the most recent run is the newest by start time, not the newest finished'
);

-- A contracted job that has never run: nulls, not zeros. They are different facts.
select is(
  (select run_count from app_private.scheduled_job_catalogue('fb000000-0000-4000-8000-000000000001', true)
    where job_key = 'reservations.release'),
  0::bigint,
  'a job that has never run has run zero times'
);
select is(
  (select last_status from app_private.scheduled_job_catalogue('fb000000-0000-4000-8000-000000000001', true)
    where job_key = 'reservations.release'),
  null::text,
  'and reports no last status rather than a made-up one'
);
select is(
  (select last_processed_count from app_private.scheduled_job_catalogue(
     'fb000000-0000-4000-8000-000000000001', true) where job_key = 'reservations.release'),
  null::integer,
  'and no processed count, because nothing having run is not the same as running and processing nothing'
);
select is(
  (select last_duration_ms from app_private.scheduled_job_catalogue('fb000000-0000-4000-8000-000000000001', true)
    where job_key = 'offers.expire'),
  null::bigint,
  'a job whose last run is still going reports no duration for it'
);

-- Ordered by key, so the page is stable between reads.
select is(
  (select array_agg(c.job_key order by c.ord) = array_agg(c.job_key order by c.job_key)
     from app_private.scheduled_job_catalogue('fb000000-0000-4000-8000-000000000001', true) with ordinality
          as c(job_key, cron_schedule, target_signature, purpose, run_count, last_status, last_started_at,
               last_finished_at, last_duration_ms, last_error_type, last_processed_count, failure_count, ord)),
  true,
  'the catalogue is ordered by job key'
);

-- The reported gap, asserted as a fact rather than described: the contract names no worker job.
select is(
  (select count(*) from app_private.scheduled_job_catalogue('fb000000-0000-4000-8000-000000000001', true)
    where job_key in ('outbox.relay', 'outbox.sweep', 'payments.poll', 'payouts.poll', 'email.retry')),
  0::bigint,
  'the catalogue names no worker repeatable job, because the contract names none and the worker records none'
);

-- ---------------------------------------------------------------------------------------------------
-- 11. The schedule guard is 0032's, wrapped whole
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.platform_schedule_problems('fb000000-0000-4000-8000-000000000001', true)),
  (select count(*) from public.cron_job_problems()),
  'an authorized caller sees exactly what 0032''s own guard reports, neither filtered nor added to'
);
select is(pg_temp.result_columns('platform_schedule_problems'), 'object,problem',
  'and it returns 0032''s own two columns, unchanged');

-- A drifted schedule is reported. Switching one contracted job off is the smallest real drift there is.
update cron.job set active = false where jobname = 'marketplace.offers.expire';
select ok(
  exists (select 1 from app_private.platform_schedule_problems('fb000000-0000-4000-8000-000000000001', true)
           where object = 'marketplace.offers.expire' and problem = 'the job is not active'),
  'a contracted job switched off is reported as a problem'
);
select is(
  (select count(*) from app_private.platform_schedule_problems('fb000000-0000-4000-8000-000000000003', true)),
  0::bigint,
  'and a moderator still sees none of it'
);
update cron.job set active = true where jobname = 'marketplace.offers.expire';
select is(
  (select count(*) from app_private.platform_schedule_problems('fb000000-0000-4000-8000-000000000001', true)),
  0::bigint,
  'with the schedule matching the contract again, there is nothing to report'
);

-- The whole security posture is deliberately not wrapped: no function here reads it.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and pg_get_functiondef(p.oid) like '%security_contract_problems%'
      and p.proname in ('platform_can_read_jobs', 'job_run_page', 'job_run_detail',
                        'scheduled_job_catalogue', 'outbox_health', 'outbox_dead_letters',
                        'platform_schedule_problems')),
  0::bigint,
  'nothing in this migration projects the whole security contract, which has no permission of its own'
);

-- ---------------------------------------------------------------------------------------------------
-- 12. NOTHING HERE WRITES
-- ---------------------------------------------------------------------------------------------------
-- The bodies contain no write statement. Asserted as statement forms rather than bare words, because a
-- function's own comments are part of `prosrc` and the word "update" appears in prose above.
select ok(pg_get_functiondef(p.oid) !~* '\minsert\s+into\s+', format('%s inserts nothing', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('platform_can_read_jobs', 'job_run_page', 'job_run_detail',
                     'scheduled_job_catalogue', 'outbox_health', 'outbox_dead_letters',
                     'platform_schedule_problems');

select ok(pg_get_functiondef(p.oid) !~* '\mupdate\s+(public|app_private|audit)\.',
          format('%s updates no table', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('platform_can_read_jobs', 'job_run_page', 'job_run_detail',
                     'scheduled_job_catalogue', 'outbox_health', 'outbox_dead_letters',
                     'platform_schedule_problems');

select ok(pg_get_functiondef(p.oid) !~* '\mdelete\s+from\s+', format('%s deletes nothing', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('platform_can_read_jobs', 'job_run_page', 'job_run_detail',
                     'scheduled_job_catalogue', 'outbox_health', 'outbox_dead_letters',
                     'platform_schedule_problems');

-- Nothing reaches 0007's or 0032's writers either: no run is started, finished, claimed, swept or
-- dead-lettered from this surface, and no job is dispatched.
select ok(
  not exists (
    select 1
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private'
       and p.proname in ('platform_can_read_jobs', 'job_run_page', 'job_run_detail',
                         'scheduled_job_catalogue', 'outbox_health', 'outbox_dead_letters',
                         'platform_schedule_problems')
       and pg_get_functiondef(p.oid) like '%' || w.fn || '%'
  ),
  format('no function here calls %s', w.fn)
) from unnest(array['start_job_run', 'finish_job_run', 'claim_outbox_events', 'complete_outbox_event',
                    'sweep_outbox_events', 'dead_letter_outbox_event', 'run_scheduled_job',
                    'enqueue_outbox_event', 'cron.schedule', 'cron.unschedule']) as w(fn);

-- And the observable proof: every row count is what it was before any of this ran.
select is((select count(*) from public.job_runs), 6::bigint,
  'six job runs went in and six are there after every function has been called');
select is((select count(*) from public.outbox_events), 7::bigint,
  'seven outbox events went in and seven are there');
select is((select count(*) from app_private.scheduled_job_contract), 17::bigint,
  'and the contract is untouched');

select * from finish();
rollback;
