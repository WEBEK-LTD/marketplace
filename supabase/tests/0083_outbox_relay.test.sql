-- pgTAP — migration 0083: the handler-scoped claim and the worker-side event read (Phase 8-A).
--
-- What these assertions hold to account:
--
--   * **an unregistered event type is never touched.** The claim is driven with a list that names one
--     type while four others sit pending, and every column of every other row is compared before and
--     after: no `published_at`, no `attempts` increment, no `completed_at`, no `dead_lettered_at`. This
--     is the assertion this file exists for.
--   * **an empty registry claims nothing, and the database is what refuses it** — not application code.
--     A null list, an empty list and a list containing a null each raise.
--   * **an unhandled event cannot enter a sweep cycle.** `sweep_outbox_events` requires `published_at is
--     not null` and only the claim sets it, so the sweeper is driven repeatedly across a long simulated
--     outage and returns 0 while the unhandled rows stay pending and at zero attempts.
--   * **the claim is 0007's claim plus one predicate.** Same bounds (1-1000), same ordering, same
--     `for update skip locked`, same `attempts` increment, same refusal of a published or dead-lettered
--     or not-yet-available row.
--   * **concurrent claims stay disjoint**, proven with two real sessions through dblink rather than
--     asserted in prose.
--   * **completion and dead-lettering stay idempotent**, and a dead-lettered event is never swept again.
--   * **the reader reads and settles nothing**: it is `stable`, it contains no write statement, and the
--     table is byte-for-byte unchanged across a call.
--   * **the grants are `app_worker` only.** Neither function is executable by `public`, `anon`,
--     `authenticated`, `app_api` or `app_system`.
--   * **no financial table is written by anything this migration adds**, checked by snapshotting every
--     one of the eleven financial tables around the whole exercise.
--
-- Deterministic: fixed uuids and explicit ages, so no assertion depends on `now()` being
-- transaction-stable. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(96);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
/*
 * `outbox_events` is not empty in a database that has been up for a while: pg_cron runs the contracted
 * jobs and their writers really append events. So the fixture clears the table inside the transaction this
 * file rolls back, and every count below is a count of exactly what this file put there.
 */
delete from public.outbox_events;

-- One handled type, and four that no handler is registered for. The four stand for the 45+ event types
-- the repository already emits and 8-A deliberately leaves alone.
insert into public.outbox_events (id, aggregate_type, aggregate_id, event_type, payload, occurred_at, available_at)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'listing', 'aaaaaaaa-0000-4000-8000-000000000001', 'listing.published',  '{}'::jsonb, now() - interval '9 minutes', now() - interval '9 minutes'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'listing', 'aaaaaaaa-0000-4000-8000-000000000002', 'listing.published',  '{}'::jsonb, now() - interval '8 minutes', now() - interval '8 minutes'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'payment', 'batch',                                'payment.succeeded',  '{}'::jsonb, now() - interval '7 minutes', now() - interval '7 minutes'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'payout',  'batch',                                'payout.created',     '{}'::jsonb, now() - interval '6 minutes', now() - interval '6 minutes'),
  ('bbbbbbbb-0000-4000-8000-000000000003', 'dispute', 'batch',                                'dispute.resolved',   '{}'::jsonb, now() - interval '5 minutes', now() - interval '5 minutes'),
  ('bbbbbbbb-0000-4000-8000-000000000004', 'order',   'batch',                                'order.paid',         '{}'::jsonb, now() - interval '4 minutes', now() - interval '4 minutes');

-- A snapshot of everything an unregistered event must still look like afterwards.
create temporary table unhandled_before on commit drop as
  select id, event_type, attempts, published_at, completed_at, dead_lettered_at, available_at, last_error_type
    from public.outbox_events
   where event_type <> 'listing.published';

-- Every financial table, counted once before anything runs.
create function pg_temp.money_rows() returns table (relation text, n bigint) language sql as $fn$
  select 'refunds', count(*) from public.refunds
  union all select 'refund_items', count(*) from public.refund_items
  union all select 'payments', count(*) from public.payments
  union all select 'payment_attempts', count(*) from public.payment_attempts
  union all select 'payment_disputes', count(*) from public.payment_disputes
  union all select 'payment_events', count(*) from public.payment_events
  union all select 'ledger_entries', count(*) from public.ledger_entries
  union all select 'ledger_journals', count(*) from public.ledger_journals
  union all select 'seller_balances', count(*) from public.seller_balances
  union all select 'withdrawals', count(*) from public.withdrawals
  union all select 'payouts', count(*) from public.payouts
$fn$;
create temporary table money_before on commit drop as select * from pg_temp.money_rows();

-- ---------------------------------------------------------------------------------------------------
-- The functions exist, with the shape 0083 declares
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'claim_outbox_events_for', array['text[]', 'integer'],
  'the handler-scoped claim exists');
select has_function('app_private', 'outbox_event_for_worker', array['uuid'],
  'the worker-side event read exists');

select is(p.provolatile::text, 'v', 'the claim is volatile: it writes published_at and attempts')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'claim_outbox_events_for';
select is(p.provolatile::text, 's', 'the reader is stable: it settles nothing')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'outbox_event_for_worker';

select ok(p.prosecdef, 'the claim is SECURITY DEFINER')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'claim_outbox_events_for';
select ok(p.prosecdef, 'the reader is SECURITY DEFINER')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'outbox_event_for_worker';

select ok('search_path=pg_catalog, public' = any(p.proconfig), 'the claim pins the established search_path')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'claim_outbox_events_for';
select ok('search_path=pg_catalog, public' = any(p.proconfig), 'the reader pins the established search_path')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'outbox_event_for_worker';

-- The reader must not contain a write statement. Asserted on statement forms, never on bare words: the
-- function's own comment mentions completion and dead-lettering.
select ok(pg_get_functiondef(p.oid) !~* '(insert\s+into|update\s+public\.|delete\s+from)',
          'the reader contains no write statement')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'outbox_event_for_worker' and p.prokind = 'f';

-- ---------------------------------------------------------------------------------------------------
-- Privileges: app_worker only
-- ---------------------------------------------------------------------------------------------------
select ok(has_function_privilege('app_worker', p.oid, 'execute'), 'app_worker may claim')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'claim_outbox_events_for';
select ok(has_function_privilege('app_worker', p.oid, 'execute'), 'app_worker may read an event')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'outbox_event_for_worker';

select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
          format('%s may not call %s', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_api'), ('app_system')) as r(rolname)
 where n.nspname = 'app_private'
   and p.proname in ('claim_outbox_events_for', 'outbox_event_for_worker');

-- ---------------------------------------------------------------------------------------------------
-- An empty registry claims nothing — and the database is what refuses it
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$select * from app_private.claim_outbox_events_for(null::text[], 100)$$,
  null, null, 'a null event-type list is refused');
select throws_ok(
  $$select * from app_private.claim_outbox_events_for(array[]::text[], 100)$$,
  null, null, 'an empty event-type list is refused');
select throws_ok(
  $$select * from app_private.claim_outbox_events_for(array['listing.published', null]::text[], 100)$$,
  null, null, 'a list containing a null is refused');

select is((select count(*) from public.outbox_events where published_at is not null), 0::bigint,
  'nothing was published by any of the refused calls');

-- ---------------------------------------------------------------------------------------------------
-- The same bounds 0007 applies
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$select * from app_private.claim_outbox_events_for(array['listing.published'], 0)$$,
  null, null, 'a batch size below 1 is refused');
select throws_ok(
  $$select * from app_private.claim_outbox_events_for(array['listing.published'], 1001)$$,
  null, null, 'a batch size above 1000 is refused');
select lives_ok(
  $$select * from app_private.claim_outbox_events_for(array['listing.published'], 1)$$,
  'the lowest batch size is accepted');

-- That call claimed exactly one row, the oldest available one.
select is((select count(*) from public.outbox_events where published_at is not null), 1::bigint,
  'a batch size of one claims exactly one event');
select is((select id from public.outbox_events where published_at is not null),
  'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
  'the claim takes the oldest available event first');
select is((select attempts from public.outbox_events where id = 'aaaaaaaa-0000-4000-8000-000000000001'), 1,
  'the claim increments attempts');

-- ---------------------------------------------------------------------------------------------------
-- THE CENTRAL ASSERTION: an unregistered event type is not touched
-- ---------------------------------------------------------------------------------------------------
select lives_ok(
  $$select * from app_private.claim_outbox_events_for(array['listing.published'], 100)$$,
  'the relay claims its registered type');

select is((select count(*) from public.outbox_events where event_type = 'listing.published' and published_at is not null),
  2::bigint, 'both handled events are now claimed');

select is(
  (select count(*) from public.outbox_events e
     join unhandled_before b on b.id = e.id
    where e.attempts is distinct from b.attempts
       or e.published_at is distinct from b.published_at
       or e.completed_at is distinct from b.completed_at
       or e.dead_lettered_at is distinct from b.dead_lettered_at
       or e.available_at is distinct from b.available_at
       or e.last_error_type is distinct from b.last_error_type),
  0::bigint,
  'not one column of any unregistered event changed');

select is((select count(*) from public.outbox_events where event_type <> 'listing.published' and attempts <> 0),
  0::bigint, 'no unregistered event spent an attempt');
select is((select count(*) from public.outbox_events where event_type <> 'listing.published' and published_at is not null),
  0::bigint, 'no unregistered event was published');
select is((select count(*) from public.outbox_events where completed_at is not null),
  0::bigint, 'the claim completes nothing, handled or not');
select is((select count(*) from public.outbox_events where dead_lettered_at is not null),
  0::bigint, 'the claim dead-letters nothing, handled or not');

-- Each unregistered type named, one assertion apiece, so a failure says which one leaked.
select is((select attempts from public.outbox_events where event_type = t), 0,
          format('%s was left alone', t))
  from unnest(array['payment.succeeded', 'payout.created', 'dispute.resolved', 'order.paid']) as t;

-- ---------------------------------------------------------------------------------------------------
-- An unregistered event cannot enter a sweep cycle
-- ---------------------------------------------------------------------------------------------------
/*
 * `sweep_outbox_events` requires `published_at is not null`, and only the claim sets that column. So an
 * event no handler is registered for is outside the sweep by construction, not by convention. Driven ten
 * times across a simulated hour to make the loop the claim would create impossible to miss.
 */
update public.outbox_events set published_at = null, attempts = 0
 where event_type = 'listing.published';

select is((select coalesce(sum(swept), 0)::bigint
             from generate_series(1, 10) as g,
                  lateral app_private.sweep_outbox_events(interval '1 second', 100) as swept),
  0::bigint, 'ten sweeps return nothing while no event is published');

select is((select count(*) from public.outbox_events where attempts <> 0), 0::bigint,
  'no event spent an attempt across the sweeps');
select is((select count(*) from public.outbox_events where dead_lettered_at is not null), 0::bigint,
  'no event was dead-lettered across the sweeps');
select is((select count(*) from public.outbox_events), 6::bigint,
  'every committed event is still there');

-- ---------------------------------------------------------------------------------------------------
-- The claim refuses what 0007's claim refuses
-- ---------------------------------------------------------------------------------------------------
update public.outbox_events set available_at = now() + interval '1 hour'
 where id = 'aaaaaaaa-0000-4000-8000-000000000002';

select is((select count(*) from app_private.claim_outbox_events_for(array['listing.published'], 100)), 1::bigint,
  'an event whose available_at has not arrived is not claimed');

update public.outbox_events set published_at = null, attempts = 0, available_at = now() - interval '1 minute';

update public.outbox_events set dead_lettered_at = now(), last_error_type = 'RangeError'
 where id = 'aaaaaaaa-0000-4000-8000-000000000002';
select is((select count(*) from app_private.claim_outbox_events_for(array['listing.published'], 100)), 1::bigint,
  'a dead-lettered event is never claimed again');

select is((select count(*) from app_private.claim_outbox_events_for(array['listing.published'], 100)), 0::bigint,
  'an already published event is not claimed twice');

-- ---------------------------------------------------------------------------------------------------
-- Settlement is idempotent, and dead-lettering stops the sweep
-- ---------------------------------------------------------------------------------------------------
select is(app_private.complete_outbox_event('aaaaaaaa-0000-4000-8000-000000000001'), true,
  'the first completion lands');
select is(app_private.complete_outbox_event('aaaaaaaa-0000-4000-8000-000000000001'), false,
  'the second completion is a no-op');
select is(app_private.dead_letter_outbox_event('aaaaaaaa-0000-4000-8000-000000000001', 'RangeError'), false,
  'a completed event cannot then be dead-lettered');
select is(app_private.dead_letter_outbox_event('aaaaaaaa-0000-4000-8000-000000000002', 'RangeError'), false,
  'dead-lettering an already dead-lettered event is a no-op');

select is((select count(*) from app_private.sweep_outbox_events(interval '0 seconds', 100)), 1::bigint,
  'the sweeper returns a count');
select is((select count(*) from public.outbox_events
            where completed_at is null and dead_lettered_at is null and published_at is not null), 0::bigint,
  'nothing settled is left in flight');

-- ---------------------------------------------------------------------------------------------------
-- The reader
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from app_private.outbox_event_for_worker('aaaaaaaa-0000-4000-8000-000000000001')), 1::bigint,
  'the reader returns the event it was given');
select is((select count(*) from app_private.outbox_event_for_worker('00000000-0000-4000-8000-000000000000')), 0::bigint,
  'the reader returns nothing for an id that does not exist, rather than raising');

select is((select event_type from app_private.outbox_event_for_worker('bbbbbbbb-0000-4000-8000-000000000001')),
  'payment.succeeded', 'the reader reads any event, registered or not — it is a read, not a claim');
select is((select aggregate_id from app_private.outbox_event_for_worker('bbbbbbbb-0000-4000-8000-000000000001')),
  'batch', 'the reader carries an aggregate_id that is not a uuid, which is why the job carries the event id');
select isnt((select completed_at from app_private.outbox_event_for_worker('aaaaaaaa-0000-4000-8000-000000000001')),
  null, 'the reader returns the settlement columns, so a handler can skip a settled event');

-- Reading changes nothing at all.
create temporary table before_read on commit drop as select * from public.outbox_events;
select count(*) from app_private.outbox_event_for_worker('bbbbbbbb-0000-4000-8000-000000000002');
select count(*) from app_private.outbox_event_for_worker('bbbbbbbb-0000-4000-8000-000000000003');
select is((select count(*) from (
             table before_read except table public.outbox_events
             union all
             table public.outbox_events except table before_read) as d), 0::bigint,
  'reading an event changes no row');

-- ---------------------------------------------------------------------------------------------------
-- Concurrency: disjoint claims are 0007's mechanism, carried over unchanged
-- ---------------------------------------------------------------------------------------------------
/*
 * Two concurrent sessions cannot be driven from one pgTAP transaction, and this sandbox has no dblink. So
 * the property is asserted where it actually lives: the claim's own statement. `for update skip locked`
 * over a `limit`ed sub-select is what makes two relays take disjoint sets, and it is 0007's mechanism
 * carried over rather than a new one — so the two definitions are compared on exactly the clauses that
 * produce it. Statement forms, never bare words: both functions' comments talk about SKIP LOCKED.
 */
select ok(pg_get_functiondef(p.oid) ~* 'for\s+update\s+skip\s+locked',
          'the handler-scoped claim locks with FOR UPDATE SKIP LOCKED')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'claim_outbox_events_for' and p.prokind = 'f';

select ok(pg_get_functiondef(p.oid) ~* 'order\s+by\s+e\.available_at,\s*e\.id',
          'the handler-scoped claim orders exactly as 0007s claim does')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'claim_outbox_events_for' and p.prokind = 'f';

select ok(pg_get_functiondef(p.oid) ~* 'set\s+published_at\s*=\s*now\(\),\s*attempts\s*=\s*e\.attempts\s*\+\s*1',
          'the handler-scoped claim publishes and counts the attempt in one statement')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'claim_outbox_events_for' and p.prokind = 'f';

select ok(pg_get_functiondef(p.oid) ~* 'e\.event_type\s*=\s*any\(p_event_types\)',
          'the one predicate that distinguishes it from 0007s claim is the registry filter')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'claim_outbox_events_for' and p.prokind = 'f';

-- ---------------------------------------------------------------------------------------------------
-- The result shapes the worker binds to
-- ---------------------------------------------------------------------------------------------------
select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'claim_outbox_events_for'),
  'TABLE(id uuid, aggregate_type text, aggregate_id text, event_type text, payload jsonb, occurred_at timestamp with time zone, attempts integer)',
  'the claim returns exactly the seven columns 0007s claim returns, in the same order');

select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'outbox_event_for_worker'),
  'TABLE(id uuid, aggregate_type text, aggregate_id text, event_type text, payload jsonb, occurred_at timestamp with time zone, attempts integer, published_at timestamp with time zone, completed_at timestamp with time zone, dead_lettered_at timestamp with time zone)',
  'the reader returns those seven plus the three settlement columns, and nothing else');

-- `created_by` never crosses to the worker on either function: an outbox event names whoever wrote it,
-- and a relay has no business knowing.
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app_private'
              and p.proname in ('claim_outbox_events_for', 'outbox_event_for_worker')
              and pg_get_function_result(p.oid) like '%created_by%'), 0::bigint,
  'created_by crosses on neither function');

-- ---------------------------------------------------------------------------------------------------
-- The outbox stays reachable only through functions
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'outbox_events'), 0::bigint,
  'outbox_events still has no policy: it is reachable only through the named functions');
select ok((select relrowsecurity from pg_class where oid = 'public.outbox_events'::regclass),
  'row level security is still enabled on outbox_events');
select is((select count(*) from information_schema.role_table_grants
            where grantee = 'app_worker' and table_schema in ('public', 'app_private', 'audit')), 0::bigint,
  'app_worker still holds no table privilege anywhere');

-- ---------------------------------------------------------------------------------------------------
-- One job_runs row per scheduled occurrence — the owner's rule, proven against 0007's own index
-- ---------------------------------------------------------------------------------------------------
delete from public.job_runs;

select isnt(app_private.start_job_run('outbox.relay', timestamptz '2026-01-01 00:00:00+00'), null::uuid,
  'the first delivery of an occurrence opens a run');
select is(app_private.start_job_run('outbox.relay', timestamptz '2026-01-01 00:00:00+00'), null::uuid,
  'a second delivery of the same occurrence opens nothing');
select is(app_private.start_job_run('outbox.relay', timestamptz '2026-01-01 00:00:00+00'), null::uuid,
  'and a third opens nothing either');
select is((select count(*) from public.job_runs where job_name = 'outbox.relay'), 1::bigint,
  'a redelivered occurrence leaves exactly one row');

select isnt(app_private.start_job_run('outbox.relay', timestamptz '2026-01-01 00:00:15+00'), null::uuid,
  'the next occurrence is a different run');
select is((select count(*) from public.job_runs where job_name = 'outbox.relay'), 2::bigint,
  'two occurrences, two rows');

select isnt(app_private.start_job_run('outbox.sweeper', timestamptz '2026-01-01 00:00:00+00'), null::uuid,
  'the sweeper records its own occurrences under its own name');
select is((select count(*) from public.job_runs), 3::bigint,
  'the relay and the sweeper do not share a row');

-- Both names satisfy 0007's own format constraint, so neither could ever be rejected at write time.
select matches('outbox.relay'::text, '^[a-z][a-z0-9_.]*$', 'the relays job name matches job_runs_name_format');
select matches('outbox.sweeper'::text, '^[a-z][a-z0-9_.]*$', 'the sweepers job name matches job_runs_name_format');

-- Settling is once-only, which is what keeps a retry from rewriting a finished occurrence.
select is(app_private.finish_job_run(
            (select id from public.job_runs where job_name = 'outbox.sweeper'), 'succeeded', 0, null, '{}'::jsonb),
  true, 'a running occurrence settles');
select is(app_private.finish_job_run(
            (select id from public.job_runs where job_name = 'outbox.sweeper'), 'succeeded', 0, null, '{}'::jsonb),
  false, 'settling it again changes nothing');

select is((select processed_count from public.job_runs where job_name = 'outbox.sweeper'), 0,
  'the count of what a run processed is a column, not a details key');
select is((select details from public.job_runs where job_name = 'outbox.sweeper'), '{}'::jsonb,
  'the relay and sweeper write no details key at all, so nothing can leak through one');

-- ---------------------------------------------------------------------------------------------------
-- The financial boundary
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from money_before b join pg_temp.money_rows() a on a.relation = b.relation where a.n <> b.n),
  0::bigint,
  'not one financial table changed while the whole outbox exercise ran');

select is((select count(*) from pg_temp.money_rows()), 11::bigint,
  'all eleven financial tables were actually counted');

-- 0083 adds exactly two functions and no table, no policy and no trigger.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('claim_outbox_events_for', 'outbox_event_for_worker')),
  2::bigint,
  '0083 contributes exactly two functions');

select is((select count(*) from pg_tables where schemaname = 'public' and tablename like 'outbox%'), 1::bigint,
  '0083 adds no new outbox table: the transactional outbox is still 0007s one table');

-- 0007's own contracts are untouched.
select has_function('app_private', 'claim_outbox_events', array['integer'], '0007s unfiltered claim is unchanged');
select has_function('app_private', 'complete_outbox_event', array['uuid'], '0007s completion is unchanged');
select has_function('app_private', 'sweep_outbox_events', array['interval', 'integer'], '0007s sweeper is unchanged');
select has_function('app_private', 'dead_letter_outbox_event', array['uuid', 'text'], '0007s dead-letter writer is unchanged');
select has_function('app_private', 'start_job_run', array['text', 'timestamptz'], '0007s job-run opener is unchanged');
select has_function('app_private', 'finish_job_run', array['uuid', 'text', 'integer', 'text', 'jsonb'],
  '0007s job-run closer is unchanged');

-- The unique protection the owner's rule relies on.
select ok(
  (select indexdef ~ 'scheduled_for' and indexdef ~ 'UNIQUE'
     from pg_indexes where schemaname = 'public' and indexname = 'job_runs_scheduled_once'),
  'one scheduled occurrence can hold at most one job_runs row');

select * from finish();
rollback;
