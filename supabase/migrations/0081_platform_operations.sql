-- 0081 — Platform job runs and outbox health, the admin side (Phase 7-Q).
--
-- Seven functions, no schema change, no new permission, no new status, and **no writer of any kind**. This
-- is the first admin increment that adds not one mutating function: 0007 and 0032 own every write to
-- `job_runs` and `outbox_events`, and the workers own every write to both. Everything below reads.
--
-- ---------------------------------------------------------------------------------------------------
-- Why a migration is needed at all
-- ---------------------------------------------------------------------------------------------------
-- Two different reasons, and they are worth separating because they are not the same situation.
--
-- **`public.job_runs` has a staff policy that nothing can reach.** 0007 wrote it:
--
--     job_runs_admin_read    for select to authenticated    using (has_permission('platform.job.read'))
--
-- A policy for `authenticated` is a rule about a session carrying JWT claims. This application does not
-- connect that way: `app_system` is `noinherit`, holds no table privileges (0003, S8), and `withRlsContext`
-- is forbidden in production code. So that policy describes a capability authorized in the database and
-- reachable by nothing — until a named `app_private` function exists for it. The readers below are that, and
-- they add nothing the policy does not already permit: the predicate restates 0003's own permission rule
-- with the assurance level as a parameter and the key as a **literal**.
--
-- **`public.outbox_events` has no policy at all.** 0007 says so in as many words: "The outbox and
-- idempotency tables have no policies: they are reachable only through the functions above." RLS is on,
-- there are zero policies and zero grants, so nothing but the owner and 0007's own SECURITY DEFINER
-- functions can see a row. Reading it here is therefore a **new** authorization rather than an unreachable
-- one being reached, and that deserves saying plainly:
--
--   * The key is `platform.job.read`, which is the only platform permission in the catalogue (0033) and the
--     one 7-F seeded `/platform/jobs` with. Only `admin` and `super_admin` hold it — the 0033 cross-join —
--     and both are `requires_mfa`. No new key is introduced, because introducing one is an owner decision.
--   * v5.2 puts `outbox_events`, `idempotency_keys` and `job_runs` in one module: "Platform (shared
--     kernel)". The sweeper that drains the outbox is itself one of the jobs this page is about.
--   * **What crosses is aggregate only.** Counts in the four states the schema's own partial indexes
--     define, the oldest age in each, and dead-letters grouped by event type and error class. No payload,
--     no `aggregate_id`, no `aggregate_type` value bound to a row, no `created_by`, and **not even an event
--     id**. Nothing on this surface is administered — there is no retry, no cancel, no requeue, because no
--     writer for any of those exists — so an identifier would enable nothing here and would only widen what
--     a console can disclose. A count is the whole of what a read-only operational page needs.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT THIS SURFACE DELIBERATELY DOES NOT SHOW, AND WHY
-- ---------------------------------------------------------------------------------------------------
-- **`job_runs.details` never crosses, whole or in part beyond two keys.** Both copies of the dispatcher —
-- 0032's and 0073's replacement — record a failure like this:
--
--     perform app_private.finish_job_run(run_id, 'failed', null, format('sqlstate_%s', sqlstate),
--       jsonb_build_object('job_key', p_job_key, 'sqlstate', sqlstate, 'message', left(sqlerrm, 500)));
--
-- `sqlerrm` is a raw PostgreSQL error message, and a raw error message embeds row data: a check-constraint
-- violation quotes the failing row, a unique violation quotes the key values, a foreign-key violation names
-- the referenced row. So `details` is a disclosure surface wearing the clothes of a diagnostic field, and
-- projecting it as a blob would put arbitrary row content on an admin screen through a channel nobody
-- reviewed.
--
-- What crosses instead is the two keys that are structured and bounded — `job_key`, which is the contract
-- key the run already carries in `job_name`, and `sqlstate`, which is five characters of PostgreSQL error
-- class — together with the `error_type` **column**, which 0007 constrains to `^[A-Za-z][A-Za-z0-9_]*$`.
-- `details -> 'message'` is read by nothing below, and a pgTAP assertion says so for each projection.
--
-- The cost is real and is stated rather than hidden: a failed run's screen shows the SQLSTATE and the error
-- class, not the failure text. Reading the text is a database operation, not a console one.
--
-- **The security contract as a whole never crosses either.** `public.cron_job_problems()` is projected, and
-- projected **whole**: it is 0032's own guard over the scheduled jobs, it is already granted to `app_system`,
-- and re-slicing which of its clauses an operator may see would be this migration deciding something 0032
-- decided. `public.security_contract_problems()` is **not** projected — the full posture of RLS, grants,
-- roles, definers, views, append-only tables and storage is a different concern from the job schedule, and
-- it has no permission of its own to be read under.
--
-- ---------------------------------------------------------------------------------------------------
-- TWO CAPABILITY GAPS THIS SURFACE MAKES VISIBLE, RECORDED RATHER THAN FILLED
-- ---------------------------------------------------------------------------------------------------
-- **1. No relay and no sweeper exist.** 0007 granted `claim_outbox_events`, `complete_outbox_event`,
-- `sweep_outbox_events` and `dead_letter_outbox_event` to `app_worker`, and **nothing in this repository
-- calls any of them.** The API enqueues events; nothing drains them. So every row stays at
-- `published_at is null`, the pending count only grows, and no row is ever completed or dead-lettered.
--
-- The numbers this surface reports are therefore accurate and would mislead if left unexplained: a large
-- pending count with a very old oldest-pending age is not a relay falling behind, it is the relay not
-- existing yet. The console says so in words next to the figures. Nothing here invents a relay, a lag
-- measure or a health verdict.
--
-- **2. Worker repeatable jobs record nothing in `job_runs`.** v5.2 says "Every job run is recorded in
-- `job_runs`" and lists seven worker repeatable jobs — payment status polling, payout status polling,
-- provider reconciliation, email and WABEK delivery retries, promotion expiry notices, and the sweeper.
-- The worker calls neither `start_job_run` nor `finish_job_run`, and 7-D's `buildQueueDefinitions`
-- registers no queue at all while the email transport is undecided. So `job_runs` holds pg_cron runs only,
-- and `scheduled_job_contract` names thirteen pg_cron jobs and no worker job.
--
-- Adding the writer would mean this migration deciding what a worker run records, which is the worker's
-- decision and an owner's. It is not added. The catalogue reports what the contract contains, and the
-- console states that a job absent from it is absent because nothing schedules it here.
--
-- ---------------------------------------------------------------------------------------------------
-- The state vocabularies are the schema's, not this file's
-- ---------------------------------------------------------------------------------------------------
-- A run's status is `job_runs_status_allowed`: `running`, `succeeded`, `failed`, `skipped`. Nothing below
-- adds a fifth or collapses two.
--
-- An event's state is read off 0007's own four partial indexes and the predicates its own functions use:
--
--     pending          published_at is null and dead_lettered_at is null        (outbox_events_pending)
--     in flight        published_at is not null and completed_at is null
--                        and dead_lettered_at is null                          (outbox_events_in_flight)
--     completed        completed_at is not null
--     dead-lettered    dead_lettered_at is not null                            (outbox_events_dead_lettered)
--
-- **No threshold is applied anywhere.** `sweep_outbox_events` takes its staleness as a parameter defaulting
-- to five minutes, so "stale" is a caller's choice rather than a schema fact: this surface reports the
-- oldest age in each state and lets a person judge it. Declaring a number unhealthy would be inventing the
-- threshold that 0007 deliberately left to the caller.

-- ---------------------------------------------------------------------------------------------------
-- 1. The one predicate
-- ---------------------------------------------------------------------------------------------------
-- 0003's rule, restated with the key as a literal, exactly as every other admin surface does it. It is
-- inlined rather than factored into a helper taking a key: a shared `holds_key(user, aal2, key)` reachable
-- from `app_system` would be a generic permission oracle, and one bug away from being asked about any key
-- at all.
--
-- **Read is gated at `aal2` here, although 0007's policy does not say so.** `job_runs_admin_read` is the one
-- staff read policy in the platform with no `is_aal2()` conjunct — recorded as an observation, not changed,
-- because 0007 is closed. It makes no difference to this surface: both roles holding `platform.job.read`
-- are `requires_mfa` in 0033, so the predicate's own `(not r.requires_mfa or p_is_aal2)` refuses staff at
-- `aal1`, and asking whether the effective set contains the key is therefore the assurance test as well.
create or replace function app_private.platform_can_read_jobs(
  p_user_id uuid,
  p_is_aal2 boolean
) returns boolean
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
       and rp.permission_key = 'platform.job.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.platform_can_read_jobs(uuid, boolean) is
  'Whether one account holds platform.job.read effectively — the key as a literal, and 0003''s own requires_mfa rule applied with the assurance level as a parameter. Only admin and super_admin hold it (0033), and both require MFA, so staff at aal1 hold nothing.';

-- ---------------------------------------------------------------------------------------------------
-- 2. One page of runs
-- ---------------------------------------------------------------------------------------------------
-- Newest first, because a run is a thing that happened rather than a thing waiting to be worked: the useful
-- end of this list is the recent one. Optionally narrowed to one status, or to one job name.
--
-- `duration_ms` is computed rather than stored, from the two timestamps the row already carries, and is null
-- while a run is still going — `job_runs_finished_when_done` guarantees that `finished_at is null` is
-- exactly `status = 'running'`, so a null duration is a running row and never a missing measurement.
--
-- **`details` is not among the columns.** Neither is anything derived from `details -> 'message'`.
create or replace function app_private.job_run_page(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_status text default null,
  p_job_name text default null,
  p_cursor_started_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  job_name text,
  status text,
  scheduled_for timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms bigint,
  error_type text,
  processed_count integer,
  is_contracted boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.id,
         r.job_name,
         r.status,
         r.scheduled_for,
         r.started_at,
         r.finished_at,
         case when r.finished_at is null then null::bigint
              else (extract(epoch from (r.finished_at - r.started_at)) * 1000)::bigint
         end,
         r.error_type,
         r.processed_count,
         -- Whether the schedule still names this job. A run whose key the contract has dropped is a real
         -- thing that happened and stays readable; saying which is which is the honest way to show both.
         exists (select 1 from app_private.scheduled_job_contract k where k.job_key = r.job_name)
    from public.job_runs r
   where p_user_id is not null
     and app_private.platform_can_read_jobs(p_user_id, p_is_aal2)
     and (p_status is null or r.status = p_status)
     and (p_job_name is null or r.job_name = p_job_name)
     -- The cursor is bound as two typed parameters and compared as a pair; no fragment is built from it.
     and (
       p_cursor_started_at is null
       or p_cursor_id is null
       or (r.started_at, r.id) < (p_cursor_started_at, p_cursor_id)
     )
   order by r.started_at desc, r.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.job_run_page(uuid, boolean, integer, text, text, timestamptz, uuid) is
  'One page of job runs for a holder of platform.job.read at aal2, newest first, optionally narrowed to one of 0007''s four statuses or one job name. It carries the timings, the run''s own duration, the constrained error_type column and the processed count — and never job_runs.details, whose message key holds a raw PostgreSQL error message and therefore arbitrary row data.';

-- ---------------------------------------------------------------------------------------------------
-- 3. One run
-- ---------------------------------------------------------------------------------------------------
-- The same columns, plus the two `details` keys that are structured and safe, plus the contract row the run
-- belongs to when there still is one.
--
-- `sqlstate` is five characters of PostgreSQL error class and `job_key` is the contract key the row already
-- carries in `job_name`; both are read with `->>` and neither can carry row data. **`message` is not read
-- here.** It is the only key of the three the dispatcher writes that is absent, and it is absent because it
-- is `left(sqlerrm, 500)`.
--
-- A run that does not exist and a caller without the key answer identically, as every admin surface does.
create or replace function app_private.job_run_detail(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_run_id uuid
) returns table (
  outcome text,
  id uuid,
  job_name text,
  status text,
  scheduled_for timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms bigint,
  error_type text,
  error_sqlstate text,
  detail_job_key text,
  processed_count integer,
  is_contracted boolean,
  cron_schedule text,
  target_signature text,
  purpose text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null or p_run_id is null
     or not app_private.platform_can_read_jobs(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::bigint, null::text, null::text,
                        null::text, null::integer, null::boolean, null::text, null::text, null::text;
    return;
  end if;

  return query
    select 'found'::text,
           r.id,
           r.job_name,
           r.status,
           r.scheduled_for,
           r.started_at,
           r.finished_at,
           case when r.finished_at is null then null::bigint
                else (extract(epoch from (r.finished_at - r.started_at)) * 1000)::bigint
           end,
           r.error_type,
           -- Five characters of error class. Read by key rather than as a blob, and the third key the
           -- dispatcher writes — `message`, which is `left(sqlerrm, 500)` — is deliberately not read.
           r.details ->> 'sqlstate',
           r.details ->> 'job_key',
           r.processed_count,
           k.job_key is not null,
           k.cron_schedule,
           k.target_signature,
           k.purpose
      from public.job_runs r
      left join app_private.scheduled_job_contract k on k.job_key = r.job_name
     where r.id = p_run_id;

  if not found then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::bigint, null::text, null::text,
                        null::text, null::integer, null::boolean, null::text, null::text, null::text;
  end if;
end;
$$;

comment on function app_private.job_run_detail(uuid, boolean, uuid) is
  'One job run for a holder of platform.job.read at aal2, with the contract row it belongs to when the schedule still names its key. A run that does not exist and a caller without the key answer identically. It reads two keys out of details — the sqlstate and the job key, both structured and bounded — and never the third, `message`, which is left(sqlerrm, 500) and therefore arbitrary row data.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The schedule, with each job's last run beside it
-- ---------------------------------------------------------------------------------------------------
-- `scheduled_job_contract` is the authoritative answer to "what does this database schedule": 0032 wrote it
-- as a table precisely so the schedule could be compared with reality rather than remembered, and 0073 added
-- its row the same way. This projects it whole — the cron expression, what each job calls, and the purpose
-- 0032 wrote in English — with the facts of the most recent run alongside.
--
-- `target_signature` names an `app_private` or `audit` function and is constrained to that shape. It is a
-- schema fact rather than a secret, and it is what tells an operator reading a failure which function
-- failed; a page that showed a job key with no indication of what it runs would send them to the migrations
-- to find out.
--
-- **A job with no run yet reports nulls, not a zero.** They are different facts: nothing has run, versus
-- something ran and processed nothing.
create or replace function app_private.scheduled_job_catalogue(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  job_key text,
  cron_schedule text,
  target_signature text,
  purpose text,
  run_count bigint,
  last_status text,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_duration_ms bigint,
  last_error_type text,
  last_processed_count integer,
  failure_count bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select k.job_key,
         k.cron_schedule,
         k.target_signature,
         k.purpose,
         coalesce(c.run_count, 0),
         l.status,
         l.started_at,
         l.finished_at,
         case when l.finished_at is null then null::bigint
              else (extract(epoch from (l.finished_at - l.started_at)) * 1000)::bigint
         end,
         l.error_type,
         l.processed_count,
         coalesce(c.failure_count, 0)
    from app_private.scheduled_job_contract k
    left join lateral (
      select count(*) as run_count,
             count(*) filter (where r.status = 'failed') as failure_count
        from public.job_runs r
       where r.job_name = k.job_key
    ) c on true
    left join lateral (
      select r.status, r.started_at, r.finished_at, r.error_type, r.processed_count
        from public.job_runs r
       where r.job_name = k.job_key
       order by r.started_at desc, r.id desc
       limit 1
    ) l on true
   where p_user_id is not null
     and app_private.platform_can_read_jobs(p_user_id, p_is_aal2)
   order by k.job_key;
$$;

comment on function app_private.scheduled_job_catalogue(uuid, boolean) is
  'Every job 0032''s scheduled_job_contract names, with its cron expression, the function it calls, its stated purpose, and the facts of its most recent run. A contracted job that has never run reports nulls rather than zeros, because nothing having run is a different fact from something running and processing nothing. It lists no worker repeatable job, because the worker records no run and the contract names none.';

-- ---------------------------------------------------------------------------------------------------
-- 5. Outbox health
-- ---------------------------------------------------------------------------------------------------
-- One row of counts and ages. The four states are 0007's own partial-index predicates, and `due_count`
-- narrows pending by `available_at <= now()`, which is the very condition `claim_outbox_events` claims on —
-- so a pending event not yet due is reported as pending and not as waiting.
--
-- **Not one identifier is returned.** No event id, no aggregate id, no aggregate type, no payload, no
-- `created_by`. There is nothing to act on here, so there is nothing an identifier would let anyone do.
--
-- **No threshold and no verdict.** The oldest age in each state is a fact; calling it late would be a rule,
-- and `sweep_outbox_events` deliberately takes its staleness from its caller.
--
-- At the time of writing every one of these events is pending, because no relay exists. That is reported
-- rather than smoothed over.
--
-- **This one carries an `outcome`, and the reason is worth writing down.** Every other reader here is
-- set-returning, so an unauthorized caller gets zero rows and zero rows is the same answer as "nothing to
-- show" — the pattern 0080's moderation trail already uses deliberately. An aggregate query is different: a
-- `count(*)` over a set the WHERE clause emptied still returns **one row, of zeros**. That row discloses
-- nothing, but it is not a refusal either, and a service reading it would render a health panel of zeros to
-- somebody holding no key instead of the neutral not-found every other surface answers with. So the
-- authorization is tested first, in plpgsql, and the refusal is a stated outcome rather than an arithmetic
-- accident.
create or replace function app_private.outbox_health(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  outcome text,
  pending_count bigint,
  due_count bigint,
  in_flight_count bigint,
  completed_count bigint,
  dead_lettered_count bigint,
  oldest_pending_at timestamptz,
  oldest_in_flight_at timestamptz,
  latest_dead_lettered_at timestamptz,
  max_attempts integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null or not app_private.platform_can_read_jobs(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::bigint, null::bigint, null::bigint, null::bigint,
                        null::bigint, null::timestamptz, null::timestamptz, null::timestamptz,
                        null::integer;
    return;
  end if;

  return query
    select 'found'::text,
           count(*) filter (where e.published_at is null and e.dead_lettered_at is null),
           count(*) filter (where e.published_at is null and e.dead_lettered_at is null
                              and e.available_at <= now()),
           count(*) filter (where e.published_at is not null and e.completed_at is null
                              and e.dead_lettered_at is null),
           count(*) filter (where e.completed_at is not null),
           count(*) filter (where e.dead_lettered_at is not null),
           min(e.occurred_at) filter (where e.published_at is null and e.dead_lettered_at is null),
           min(e.published_at) filter (where e.published_at is not null and e.completed_at is null
                                         and e.dead_lettered_at is null),
           max(e.dead_lettered_at),
           max(e.attempts)
      from public.outbox_events e;
end;
$$;

comment on function app_private.outbox_health(uuid, boolean) is
  'The transactional outbox as counts and ages only, for a holder of platform.job.read at aal2. It carries an outcome because it aggregates: a count over a set the authorization emptied would still return one row of zeros, which is not a refusal, so the key is tested before the aggregate runs. The four states are 0007''s own partial-index predicates and due_count is claim_outbox_events'' own condition. It returns no event id, no aggregate id or type, no payload and no created_by, because nothing on this surface acts on an event and an identifier would therefore enable nothing. It applies no staleness threshold and reaches no verdict: sweep_outbox_events takes its threshold from its caller, so declaring one here would invent a rule.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Dead letters, grouped
-- ---------------------------------------------------------------------------------------------------
-- What is stuck, as classes rather than rows: one row per (event type, error class), with how many and when
-- the first and last of them died. Both grouping columns are constrained by 0007 —
-- `outbox_events_event_type_format` and `outbox_events_error_type_format` — so neither can carry free text.
--
-- **Grouped rather than listed, on purpose.** A list of dead letters would have to identify them to be worth
-- listing, and identifying them means naming the order, conversation or account each one is about. The class
-- and the count are what tell an operator what is wrong; the rows themselves are a database matter, and
-- there is no action here to take on one.
--
-- Empty is the expected answer today: nothing dead-letters, because nothing publishes.
create or replace function app_private.outbox_dead_letters(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer default 20
) returns table (
  event_type text,
  last_error_type text,
  event_count bigint,
  first_dead_lettered_at timestamptz,
  last_dead_lettered_at timestamptz,
  max_attempts integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select e.event_type,
         e.last_error_type,
         count(*),
         min(e.dead_lettered_at),
         max(e.dead_lettered_at),
         max(e.attempts)
    from public.outbox_events e
   where p_user_id is not null
     and app_private.platform_can_read_jobs(p_user_id, p_is_aal2)
     and e.dead_lettered_at is not null
   group by e.event_type, e.last_error_type
   order by max(e.dead_lettered_at) desc, e.event_type, e.last_error_type
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.outbox_dead_letters(uuid, boolean, integer) is
  'Dead-lettered events grouped by event type and error class, newest group first, for a holder of platform.job.read at aal2. Both grouping columns are constrained by 0007 and neither can carry free text. It lists no individual event and no identifier: a list would have to name the order, conversation or account each event is about to be worth listing, and there is no action here to take on one.';

-- ---------------------------------------------------------------------------------------------------
-- 7. Where the schedule and reality disagree
-- ---------------------------------------------------------------------------------------------------
-- 0032's own guard, projected whole and unaltered. It answers the question this page exists to answer —
-- is what the database actually schedules what the contract says — and it already answers it for the deploy
-- and for the nightly `security.assert_contract` job. `app_system` may already execute it.
--
-- **Whole, not re-sliced.** `cron_job_problems()` mixes schedule drift with scheduler-privilege hygiene
-- because 0032 decided they belong together; picking which of its clauses an operator may see would be this
-- migration overruling that. `security_contract_problems()` is a different matter and is **not** wrapped
-- here: the whole security posture is not the job schedule, and it has no permission of its own.
--
-- Empty means the schedule matches the contract, which is the only good answer.
create or replace function app_private.platform_schedule_problems(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  object text,
  problem text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.object, p.problem
    from public.cron_job_problems() p
   where p_user_id is not null
     and app_private.platform_can_read_jobs(p_user_id, p_is_aal2)
   order by p.object, p.problem;
$$;

comment on function app_private.platform_schedule_problems(uuid, boolean) is
  'Where the real pg_cron catalogue and 0032''s scheduled-job contract disagree, for a holder of platform.job.read at aal2. It wraps public.cron_job_problems() whole and unaltered rather than re-slicing which of its clauses a console may see, because 0032 decided that grouping. It deliberately does not wrap security_contract_problems(): the whole security posture is not the job schedule and has no permission of its own.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.platform_can_read_jobs(uuid, boolean) from public;
revoke execute on function app_private.job_run_page(uuid, boolean, integer, text, text, timestamptz, uuid) from public;
revoke execute on function app_private.job_run_detail(uuid, boolean, uuid) from public;
revoke execute on function app_private.scheduled_job_catalogue(uuid, boolean) from public;
revoke execute on function app_private.outbox_health(uuid, boolean) from public;
revoke execute on function app_private.outbox_dead_letters(uuid, boolean, integer) from public;
revoke execute on function app_private.platform_schedule_problems(uuid, boolean) from public;

grant execute on function app_private.platform_can_read_jobs(uuid, boolean) to app_system;
grant execute on function app_private.job_run_page(uuid, boolean, integer, text, text, timestamptz, uuid) to app_system;
grant execute on function app_private.job_run_detail(uuid, boolean, uuid) to app_system;
grant execute on function app_private.scheduled_job_catalogue(uuid, boolean) to app_system;
grant execute on function app_private.outbox_health(uuid, boolean) to app_system;
grant execute on function app_private.outbox_dead_letters(uuid, boolean, integer) to app_system;
grant execute on function app_private.platform_schedule_problems(uuid, boolean) to app_system;

select app_private.assert_security_contract();
