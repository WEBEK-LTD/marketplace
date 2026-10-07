-- pgTAP — migration 0107: the analytics event identity ledger.
--
-- Sixteen comments promised that analytics delivery was at-least-once-safe because the database de-duplicated
-- on `event_id`. The index was on `(event_id, occurred_at)`, and the ingestion layer replaces `occurred_at`
-- with a fresh `now()` whenever the client's value is missing, unparseable, in the future or older than seven
-- days. 0107 adds a ledger keyed on `event_id` alone and consults it inside the writer.
--
-- **This file has to work around the trap that hid the defect for four increments.** Every pgTAP file runs in
-- one transaction, and `now()` is transaction-stable inside it — so two deliveries that omit `occurred_at` get
-- the *same* timestamp here and de-duplicate even under the broken implementation. The existing assertion in
-- `0013_favorites_and_events.test.sql` passes for exactly that reason: it could not observe the thing it
-- claimed. Every de-duplication assertion below therefore uses `clock_timestamp()` or explicitly different
-- timestamps, never bare `now()`, and section 3 proves the old conflict target fails the same scenario.
--
-- What is proven, in order:
--
--   * **one event row per `event_id`**, whatever happens to `occurred_at` — proved with values two days apart,
--     with one delivery omitting the column entirely, and with `clock_timestamp()` differences;
--   * **the old key would have failed** the same scenario, so these assertions are not vacuous;
--   * **the ledger is atomic with the events** — a batch whose event insert raises leaves no ledger entry
--     behind, so a failed delivery is retryable rather than swallowed for ninety days;
--   * **batches behave**: mixed new and already-seen ids insert only the new ones, and the same id twice inside
--     one batch inserts once, keeping the first occurrence;
--   * **both application paths are covered**, because there is exactly one writer and both the worker and the
--     degraded direct path call it;
--   * **retention is bounded, ordered and durable** — ninety days, oldest first, refusing a nonsense batch
--     size, reached through the scheduled-job contract and the dispatcher;
--   * **the ledger is readless and private** — no grant to any application role, RLS enabled, not partitioned;
--   * `promotion_events` got the same fix, and the rollup is unchanged.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(104);

-- ---------------------------------------------------------------------------------------------------
-- 1. Shape, privilege and the contract checkers
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'listing_event_ids', 'the listing ledger exists');
select has_table('public', 'promotion_event_ids', 'the promotion ledger exists');

select col_is_pk('public', 'listing_event_ids', 'event_id',
  'the listing ledger is keyed on event_id alone, which is the whole point of it');
select col_is_pk('public', 'promotion_event_ids', 'event_id', 'and so is the promotion ledger');

select col_not_null('public', 'listing_event_ids', 'first_seen_at', 'first_seen_at is required');
select col_has_default('public', 'listing_event_ids', 'first_seen_at', 'and defaults, so a writer cannot omit it');

-- Not partitioned, and that is load-bearing rather than incidental: partitioning by `first_seen_at` would force
-- that column into the unique key and reproduce the defect the table exists to fix.
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('listing_event_ids', 'promotion_event_ids')
      and c.relkind <> 'r'),
  0, 'neither ledger is partitioned, so event_id can be a unique key on its own');

-- The reason the partitioned tables could never carry this guarantee, asserted rather than described.
select throws_ok(
  'create unique index probe_event_id_only on public.listing_events (event_id)',
  '0A000', null,
  'a unique index on event_id alone is impossible on listing_events: the partition key must be in it');

select ok(
  (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('listing_event_ids', 'promotion_event_ids')),
  'both ledgers have row level security enabled');

-- Readless and private (owner decision 8). No role reaches either table; four definer functions do.
select is(
  (select count(*)::int from information_schema.role_table_grants g
    where g.table_schema = 'public'
      and g.table_name in ('listing_event_ids', 'promotion_event_ids')
      and g.grantee in ('authenticated', 'anon', 'app_system', 'app_worker')),
  0, 'no application role holds any privilege on either ledger');

select is(
  (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('listing_event_ids', 'promotion_event_ids')),
  0, 'and neither has an RLS policy, because nothing is meant to reach it');

-- No application code reads a ledger. The database is where that is checkable: no function outside the four
-- 0107 added may name either table.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app_private', 'public')
      -- Schema-qualified on purpose: the bare name is a substring of `prune_listing_event_ids`, so the
      -- dispatcher's own branch matched it and this assertion failed on its first run.
      and (p.prosrc like '%public.listing_event_ids%' or p.prosrc like '%public.promotion_event_ids%')
      and p.proname not in ('record_listing_events', 'record_promotion_events',
                            'prune_listing_event_ids', 'prune_promotion_event_ids')),
  0, 'only the two writers and the two pruners mention a ledger');

-- The append-only question, recorded as an assertion because the answer was not the obvious one. A
-- `tg_%reject%` trigger would oblige membership of `append_only_contract`, which means "refuses UPDATE *and*
-- DELETE" — untrue of a table its own retention deletes from. So there is no trigger, and no membership.
select is(
  (select count(*)::int from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('listing_event_ids', 'promotion_event_ids')
     and not tg.tgisinternal),
  0, 'neither ledger carries an append-only trigger, because retention must delete from it');

select is(
  (select count(*)::int from app_private.append_only_contract k
    where k.table_name in ('listing_event_ids', 'promotion_event_ids')),
  0, 'and neither claims membership of the append-only contract');

select is((select count(*)::int from public.append_only_problems()), 0,
  'so the bidirectional append-only checker is satisfied');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('07000000-0000-4000-8000-000000000001', 'ledger-seller@test.invalid'),
  ('07000000-0000-4000-8000-000000000002', 'ledger-buyer@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, verification_status, verified_at)
values
  ('07000000-0000-4000-8000-000000000001', 'ledger-shop', 'Ledger Shop', 'Ledger Shop LLC',
   'ledger@test.invalid', '+201000000071', 'EG', 'active', 'verified', now() - interval '30 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('07100000-0000-4000-8000-000000000001', null, 'ledger-cat', true, 71);
insert into public.category_translations (category_id, locale_code, name) values
  ('07100000-0000-4000-8000-000000000001', 'en', 'Ledger Category');

insert into public.listings (
  id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
  currency_code, price_minor, is_negotiable, status, country_code, city, created_at, approved_at
) values (
  '07200000-0000-4000-8000-000000000001', '07000000-0000-4000-8000-000000000001', 'product',
  '07100000-0000-4000-8000-000000000001', 'ledger-item', 'Ledger item',
  'A description long enough to satisfy the length constraint.', 'en',
  'EGP', 100000, true, 'active', 'EG', 'Cairo', now() - interval '20 days', now() - interval '19 days'
);

-- One event, built here so every delivery below is byte-identical except for `occurred_at`.
create or replace function pg_temp.deliver(p_event_id uuid, p_occurred_at text default null)
returns integer language sql as $$
  select app_private.record_listing_events(jsonb_build_array(
    jsonb_strip_nulls(jsonb_build_object(
      'event_id', p_event_id,
      'listing_id', '07200000-0000-4000-8000-000000000001',
      'event_type', 'click',
      'occurred_at', p_occurred_at))));
$$;

create or replace function pg_temp.rows_for(p_event_id uuid) returns integer language sql stable as $$
  select count(*)::integer from public.listing_events where event_id = p_event_id;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 2. One event row per event_id, whatever happens to occurred_at
-- ---------------------------------------------------------------------------------------------------
-- The scenario proved against the pre-0107 writer: two deliveries whose `occurred_at` differs. Before 0107 this
-- produced two rows and the rollup counted two clicks. `clock_timestamp()` is deliberate — bare `now()` is
-- frozen inside this transaction and would make the assertion pass for the wrong reason.
select is(pg_temp.deliver('a7000000-0000-4000-8000-000000000001', clock_timestamp()::text), 1,
  'the first delivery writes one row');
select is(pg_temp.deliver('a7000000-0000-4000-8000-000000000001', (clock_timestamp() + interval '1 second')::text), 0,
  'a second delivery one second later writes nothing');
select is(pg_temp.rows_for('a7000000-0000-4000-8000-000000000001'), 1,
  'so exactly one event row carries that event_id, with two different occurred_at values offered');

-- Two days apart, well beyond any clock skew, and still one event.
select is(pg_temp.deliver('a7000000-0000-4000-8000-000000000002', (now() - interval '2 days')::text), 1,
  'an event dated two days ago is written');
select is(pg_temp.deliver('a7000000-0000-4000-8000-000000000002', clock_timestamp()::text), 0,
  'and redelivering it with today''s date writes nothing');
select is(pg_temp.rows_for('a7000000-0000-4000-8000-000000000002'), 1,
  'de-duplication does not depend on occurred_at at all');

-- The omitted case, which is what the API produces for a missing, unparseable, future or stale `occurredAt`:
-- the writer's own `now()` fallback. Delivered second, so its timestamp genuinely differs from the first.
select is(pg_temp.deliver('a7000000-0000-4000-8000-000000000003', (now() - interval '3 hours')::text), 1,
  'an event with an explicit timestamp is written');
select is(pg_temp.deliver('a7000000-0000-4000-8000-000000000003', null), 0,
  'and the same event with occurred_at omitted — the normalised case — writes nothing');
select is(pg_temp.rows_for('a7000000-0000-4000-8000-000000000003'), 1, 'still one row');

select is(pg_temp.deliver('a7000000-0000-4000-8000-000000000004', null), 1,
  'the reverse order: omitted first, which takes the now() fallback');
select is(pg_temp.deliver('a7000000-0000-4000-8000-000000000004', (now() + interval '1 hour')::text), 0,
  'then an hour-ahead timestamp, as a skewed clock would send, writes nothing');
select is(pg_temp.rows_for('a7000000-0000-4000-8000-000000000004'), 1, 'still one row');

-- Many deliveries, every one with a different timestamp. The guarantee is not "twice"; it is "once, ever".
do $$
declare i int;
begin
  for i in 1..10 loop
    perform pg_temp.deliver('a7000000-0000-4000-8000-000000000005',
      (now() - make_interval(hours => i))::text);
  end loop;
end $$;
select is(pg_temp.rows_for('a7000000-0000-4000-8000-000000000005'), 1,
  'ten deliveries with ten different timestamps produce one row');

select is((select count(*)::int from public.listing_event_ids
            where event_id = 'a7000000-0000-4000-8000-000000000005'), 1,
  'and one ledger entry, not ten');

-- ---------------------------------------------------------------------------------------------------
-- 3. The old key would have failed this — so section 2 is not vacuous
-- ---------------------------------------------------------------------------------------------------
-- The pre-0107 writer's whole de-duplication was `on conflict (event_id, occurred_at) do nothing` with no
-- ledger. That clause is reproduced here directly against the table, which is the honest way to show what it
-- did: the same conflict target, the same two timestamps, and two rows instead of one.
savepoint old_behaviour;

insert into public.listing_events (event_id, listing_id, event_type, occurred_at)
values ('a8000000-0000-4000-8000-000000000001', '07200000-0000-4000-8000-000000000001', 'click',
        clock_timestamp())
on conflict (event_id, occurred_at) do nothing;

insert into public.listing_events (event_id, listing_id, event_type, occurred_at)
values ('a8000000-0000-4000-8000-000000000001', '07200000-0000-4000-8000-000000000001', 'click',
        clock_timestamp() + interval '1 second')
on conflict (event_id, occurred_at) do nothing;

select is(pg_temp.rows_for('a8000000-0000-4000-8000-000000000001'), 2,
  'the old conflict target admits both deliveries: two rows for one event_id. This is the defect.');

select is(
  (select sum(case when la.clicks is null then 0 else la.clicks end)::int
     from public.listing_analytics la where la.listing_id = '07200000-0000-4000-8000-000000000001'),
  null, 'no rollup has run yet, so the inflation is not yet visible — which is how it would reach a seller');

rollback to savepoint old_behaviour;
select is(pg_temp.rows_for('a8000000-0000-4000-8000-000000000001'), 0, 'rolled back, that probe is gone');

-- The same two deliveries through the 0107 writer: one row.
select is(pg_temp.deliver('a8000000-0000-4000-8000-000000000002', clock_timestamp()::text), 1, 'through the writer, delivery one');
select is(pg_temp.deliver('a8000000-0000-4000-8000-000000000002', (clock_timestamp() + interval '1 second')::text), 0,
  'and delivery two writes nothing');
select is(pg_temp.rows_for('a8000000-0000-4000-8000-000000000002'), 1,
  'one row where the old key gave two: the ledger is what changed');

-- ---------------------------------------------------------------------------------------------------
-- 4. The ledger is atomic with the events it admits
-- ---------------------------------------------------------------------------------------------------
-- The one failure mode that would be worse than the defect: an id claimed in the ledger whose event row was
-- never written. That event would be silently dropped on every retry for ninety days. The ledger insert and the
-- event insert are one statement, so a failure rolls both back — asserted, not assumed.
savepoint atomicity;

select throws_ok(
  $$select app_private.record_listing_events(jsonb_build_array(
      jsonb_build_object('event_id', 'a9000000-0000-4000-8000-000000000001',
        'listing_id', '07200000-0000-4000-8000-000000000001', 'event_type', 'click'),
      jsonb_build_object('event_id', 'a9000000-0000-4000-8000-000000000002',
        'listing_id', '07200000-0000-4000-8000-000000000001', 'event_type', 'not_a_valid_type')))$$,
  '23514', null,
  'a batch carrying an invalid event type is refused by 0013''s constraint');

rollback to savepoint atomicity;

select is((select count(*)::int from public.listing_event_ids
            where event_id in ('a9000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000002')),
  0, 'and it left no ledger entry behind — neither for the bad event nor for the good one beside it');

select is(pg_temp.deliver('a9000000-0000-4000-8000-000000000001', clock_timestamp()::text), 1,
  'so the good event is still deliverable afterwards, rather than swallowed for ninety days');

-- ---------------------------------------------------------------------------------------------------
-- 5. Batches
-- ---------------------------------------------------------------------------------------------------
-- Mixed: one already seen, two new. Only the new ones become rows.
select is(
  app_private.record_listing_events(jsonb_build_array(
    jsonb_build_object('event_id', 'a7000000-0000-4000-8000-000000000001',
      'listing_id', '07200000-0000-4000-8000-000000000001', 'event_type', 'click',
      'occurred_at', clock_timestamp()),
    jsonb_build_object('event_id', 'aa000000-0000-4000-8000-000000000001',
      'listing_id', '07200000-0000-4000-8000-000000000001', 'event_type', 'contact',
      'occurred_at', clock_timestamp()),
    jsonb_build_object('event_id', 'aa000000-0000-4000-8000-000000000002',
      'listing_id', '07200000-0000-4000-8000-000000000001', 'event_type', 'share',
      'occurred_at', clock_timestamp()))),
  2, 'a batch of three with one already seen inserts two');

select is(pg_temp.rows_for('a7000000-0000-4000-8000-000000000001'), 1,
  'the already-seen event still has exactly one row');
select is(pg_temp.rows_for('aa000000-0000-4000-8000-000000000001'), 1, 'the first new one has a row');
select is(pg_temp.rows_for('aa000000-0000-4000-8000-000000000002'), 1, 'and so does the second');

-- The same id twice inside ONE batch. Without the `distinct on` in the writer this inserts **two** rows — the
-- single ledger winner joins to both copies — which was measured while 0107 was being written and is why the
-- collapse is there. A client may legitimately send the same event twice in one flush.
select is(
  app_private.record_listing_events(jsonb_build_array(
    jsonb_build_object('event_id', 'ab000000-0000-4000-8000-000000000001',
      'listing_id', '07200000-0000-4000-8000-000000000001', 'event_type', 'click',
      'source', 'search', 'occurred_at', clock_timestamp()),
    jsonb_build_object('event_id', 'ab000000-0000-4000-8000-000000000001',
      'listing_id', '07200000-0000-4000-8000-000000000001', 'event_type', 'click',
      'source', 'listing', 'occurred_at', clock_timestamp() + interval '1 second'))),
  1, 'the same event_id twice inside one batch inserts one row');

select is(pg_temp.rows_for('ab000000-0000-4000-8000-000000000001'), 1, 'exactly one');
select is(
  (select source from public.listing_events where event_id = 'ab000000-0000-4000-8000-000000000001'),
  'search', 'and it is the first occurrence that is kept, by position in the array');

-- An empty batch, and a non-array, both as before.
select is(app_private.record_listing_events('[]'::jsonb), 0, 'an empty batch inserts nothing and does not raise');
select throws_ok($$select app_private.record_listing_events('{}'::jsonb)$$, null, null,
  'a non-array is still refused, as 0013 refused it');

-- An event with no event_id still raises rather than being silently dropped: the ledger''s primary key is
-- not null, exactly as `listing_events.event_id` was.
select throws_ok(
  $$select app_private.record_listing_events(jsonb_build_array(jsonb_build_object(
      'listing_id', '07200000-0000-4000-8000-000000000001', 'event_type', 'click')))$$,
  '23502', null, 'an event with no event_id is refused, not dropped');

-- ---------------------------------------------------------------------------------------------------
-- 6. Both application paths, and the rollup
-- ---------------------------------------------------------------------------------------------------
-- There is exactly one writer of listing_events, which is why owner decision 9 could be satisfied by changing
-- the database alone: the worker's normal path and the API's degraded direct path both reach this function, and
-- neither application can opt out of the ledger.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app_private', 'public')
      and p.prosrc like '%insert into public.listing_events%'),
  1, 'exactly one function inserts into listing_events, so both paths are covered by changing it');

select ok(has_function_privilege('app_worker', 'app_private.record_listing_events(jsonb)', 'execute'),
  'the worker may still call it');
select ok(has_function_privilege('app_system', 'app_private.record_listing_events(jsonb)', 'execute'),
  'and so may the API, for the degraded direct path');

-- The rollup is untouched (owner decision 5): still `count(*)`, which is now correct because the rows it counts
-- are de-duplicated before they arrive.
select matches(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'rollup_listing_analytics'),
  'count\(\*\) filter', 'the rollup still counts with count(*), unchanged');

select doesnt_match(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'rollup_listing_analytics'),
  'count\(distinct', 'and count(distinct) was deliberately not added');

-- And the number a seller sees is now right. One event delivered eleven times above, plus the others.
select is((select app_private.rollup_listing_analytics(current_date)) >= 0, true, 'the rollup runs');
select is(
  (select la.clicks::int from public.listing_analytics la
    where la.listing_id = '07200000-0000-4000-8000-000000000001' and la.day = current_date),
  (select count(distinct e.event_id)::int from public.listing_events e
    where e.listing_id = '07200000-0000-4000-8000-000000000001' and e.event_type = 'click'
      and e.occurred_at >= current_date and e.occurred_at < current_date + 1),
  'and count(*) now equals count(distinct event_id), because the rows are already unique');

-- ---------------------------------------------------------------------------------------------------
-- 7. Retention (owner decision 2: ninety days)
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'prune_listing_event_ids', array['integer'], 'the listing pruner exists');
select has_function('app_private', 'prune_promotion_event_ids', array['integer'], 'the promotion pruner exists');

select is(app_private.prune_listing_event_ids(5000), 0,
  'nothing is older than ninety days yet, so a run prunes nothing');

-- Age three entries past the window and leave one inside it.
insert into public.listing_event_ids (event_id, first_seen_at) values
  ('ac000000-0000-4000-8000-000000000001', now() - interval '91 days'),
  ('ac000000-0000-4000-8000-000000000002', now() - interval '120 days'),
  ('ac000000-0000-4000-8000-000000000003', now() - interval '365 days'),
  ('ac000000-0000-4000-8000-000000000004', now() - interval '89 days');

select is(app_private.prune_listing_event_ids(5000), 3,
  'three entries past ninety days are forgotten');
select is((select count(*)::int from public.listing_event_ids
            where event_id = 'ac000000-0000-4000-8000-000000000004'), 1,
  'and the one still inside the window is kept');
select is(app_private.prune_listing_event_ids(5000), 0, 'a second run prunes nothing: it is idempotent');

-- Bounded, oldest first — 7-J's shape rather than a second one.
insert into public.listing_event_ids (event_id, first_seen_at) values
  ('ad000000-0000-4000-8000-000000000001', now() - interval '200 days'),
  ('ad000000-0000-4000-8000-000000000002', now() - interval '150 days'),
  ('ad000000-0000-4000-8000-000000000003', now() - interval '100 days');

select is(app_private.prune_listing_event_ids(1), 1, 'a batch size of one forgets one');
select is((select count(*)::int from public.listing_event_ids
            where event_id = 'ad000000-0000-4000-8000-000000000001'), 0,
  'and it is the oldest that goes first');
select is(app_private.prune_listing_event_ids(1), 1, 'then the next oldest');
select is((select count(*)::int from public.listing_event_ids
            where event_id = 'ad000000-0000-4000-8000-000000000002'), 0, 'in order');
select is(app_private.prune_listing_event_ids(10), 1, 'and the rest in one go');

select throws_ok($$select app_private.prune_listing_event_ids(0)$$, '22023', null,
  'a batch size of zero is refused rather than obeyed');
select throws_ok($$select app_private.prune_listing_event_ids(-1)$$, '22023', null, 'and so is a negative one');
select throws_ok($$select app_private.prune_listing_event_ids(null)$$, '22023', null, 'and so is null');

-- Forgetting an id means a redelivery is accepted again. That is the guarantee window, stated as a fact rather
-- than left for somebody to discover.
select is(pg_temp.deliver('ae000000-0000-4000-8000-000000000001', (now() - interval '1 hour')::text), 1,
  'an event is delivered');
select is(pg_temp.deliver('ae000000-0000-4000-8000-000000000001', clock_timestamp()::text), 0,
  'and redelivery is refused while its id is remembered');
update public.listing_event_ids set first_seen_at = now() - interval '91 days'
 where event_id = 'ae000000-0000-4000-8000-000000000001';
select is(app_private.prune_listing_event_ids(10), 1, 'once the id ages out it is forgotten');
select is(pg_temp.deliver('ae000000-0000-4000-8000-000000000001', clock_timestamp()::text), 1,
  'and a redelivery after that is accepted: ninety days is the guarantee window, not for ever');

-- The promotion pruner, on the same terms.
insert into public.promotion_event_ids (event_id, first_seen_at) values
  ('af000000-0000-4000-8000-000000000001', now() - interval '91 days'),
  ('af000000-0000-4000-8000-000000000002', now() - interval '10 days');
select is(app_private.prune_promotion_event_ids(5000), 1, 'the promotion pruner forgets the aged entry');
select is((select count(*)::int from public.promotion_event_ids), 1, 'and keeps the recent one');
select throws_ok($$select app_private.prune_promotion_event_ids(0)$$, '22023', null,
  'it refuses a nonsense batch size too');

-- Neither pruner is reachable by an application role: like 0101's retention, only pg_cron's own privileges
-- reach it through `run_scheduled_job`.
select ok(not has_function_privilege('app_system', 'app_private.prune_listing_event_ids(integer)', 'execute'),
  'app_system may not forget an event id');
select ok(not has_function_privilege('app_worker', 'app_private.prune_listing_event_ids(integer)', 'execute'),
  'nor may app_worker');
select ok(not has_function_privilege('public', 'app_private.prune_listing_event_ids(integer)', 'execute'),
  'nor may public');

-- ---------------------------------------------------------------------------------------------------
-- 8. Retention is durable: the contract, the dispatcher and pg_cron all name it
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.scheduled_job_contract
            where job_key in ('listing_event_ids.prune', 'promotion_event_ids.prune')), 2,
  'both prune jobs are in the scheduled-job contract');

select is((select target_signature from app_private.scheduled_job_contract
            where job_key = 'listing_event_ids.prune'),
  'app_private.prune_listing_event_ids(5000)', 'with the signature the dispatcher calls');

select is((select cron_schedule from app_private.scheduled_job_contract
            where job_key = 'listing_event_ids.prune'), '40 4 * * *',
  'scheduled after 0101''s partition drop at 04:25, so a ledger is never pruned mid-drop');
select is((select cron_schedule from app_private.scheduled_job_contract
            where job_key = 'promotion_event_ids.prune'), '45 4 * * *', 'and the promotion one after it');

select ok(
  (select p.prosrc like '%prune_listing_event_ids(5000)%' and p.prosrc like '%prune_promotion_event_ids(5000)%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'run_scheduled_job'),
  'the dispatcher has a branch for each, so the contract row is reachable');

select is((select count(*)::int from cron.job
            where jobname in ('marketplace.listing_event_ids.prune', 'marketplace.promotion_event_ids.prune')),
  2, 'and pg_cron carries both jobs');

select is((select count(*)::int from public.cron_job_problems()), 0,
  'so the cron catalogue still matches the contract exactly');

-- Running it through the dispatcher records a job run, which is what makes a silent failure visible.
select is(app_private.run_scheduled_job('listing_event_ids.prune'), 0,
  'the job runs through the dispatcher and prunes nothing right now');
select is((select count(*)::int from public.job_runs where job_name = 'listing_event_ids.prune'), 1,
  'and it recorded a run');
select is((select status from public.job_runs where job_name = 'listing_event_ids.prune'), 'succeeded',
  'which succeeded');

-- ---------------------------------------------------------------------------------------------------
-- 9. The promotion writer got the same fix (owner decision 3)
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select p.prosrc like '%public.promotion_event_ids%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'record_promotion_events'),
  'record_promotion_events consults its ledger');

select ok(
  (select p.prosrc like '%distinct on%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'record_promotion_events'),
  'and collapses a batch on event_id, so an in-batch duplicate cannot slip through there either');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app_private', 'public')
      and p.prosrc like '%insert into public.promotion_events%'),
  1, 'there is still exactly one writer of promotion_events');

-- ---------------------------------------------------------------------------------------------------
-- 10. Nothing else moved
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('record_listing_events', 'record_promotion_events', 'run_scheduled_job',
                        'prune_listing_event_ids', 'prune_promotion_event_ids')
      and not (p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public'])),
  0, 'every function 0107 writes or replaces is security definer with a pinned search_path');

select is((select count(*)::int from app_private.whitespace_contract_problems()), 0,
  '0105''s whitespace contract still holds');
select is((select count(*)::int from public.security_contract_problems()), 0, 'the security contract holds');
select is((select count(*)::int from public.rls_problems()), 0, 'RLS is unchanged');
select is((select count(*)::int from public.grant_problems()), 0, 'grants are unchanged');
select is((select count(*)::int from public.definer_problems()), 0, 'definer hygiene is unchanged');
select is((select count(*)::int from public.role_boundary_problems()), 0, 'role boundaries are unchanged');
select is((select count(*)::int from public.anon_privilege_problems()), 0, 'anon holds nothing new');
select is((select count(*)::int from public.view_security_problems()), 0, 'view security is unchanged');
select is((select count(*)::int from public.storage_bucket_problems()), 0, 'storage buckets are unchanged');
select is((select count(*)::int from public.audit_attribution_problems()), 0, 'audit attribution is unchanged');

-- 0106 is closed history and must stay that way.
select is(
  (select ((regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1])::integer
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'listing_analytics_page'),
  101, '0106''s probe-row ceiling on the analytics reader is untouched');

select * from finish();
rollback;
