-- pgTAP — migration 0102: the listing analytics rollup and its two read surfaces.
--
-- Six things are being held to account.
--
-- **The rollup counts the four types 0101 ingests and no others.** `impression` and `view` are in the fixture,
-- are permitted by 0013's own constraint, and must not appear in any total — so a future ingestion change
-- cannot start counting them under a definition nobody has agreed.
--
-- **Idempotence is empirical, not asserted.** The job is run twice for the same day and the counts are compared;
-- an upsert that added instead of replacing would double them and fail here. The same property is what makes an
-- owner-triggered backfill safe, so a named older day is rolled up too.
--
-- **Seller attribution comes from `listings`, because the event stream's own column cannot provide it.** Every
-- fixture event is inserted with `seller_user_id` null, exactly as 0101 writes them, and the rollup is required
-- to resolve the owner anyway.
--
-- **Ownership isolation, and the other seller's title.** Two sellers with events each: neither sees a row of the
-- other's, and the check is that the other seller's title appears nowhere in the output rather than that the row
-- count is right.
--
-- **The staff surface is the first consumer of `analytics.listing.read`**, and is held to the whole two-key
-- contract: the permission, AAL2 where the role requires MFA, a revoked grant, an expired grant, and a caller
-- with no role at all. A refusal returns no rows, which is the same answer as an empty window.
--
-- **Nothing identifying crosses either surface.** No function reads `session_hash` or the event stream's
-- `user_id`, and neither reader returns an account identifier — the staff surface names a storefront by its
-- public slug.
--
-- Deterministic: fixed uuids, and every date anchored to `current_date` the way the readers' windows are.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(166);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XLA', '961', 'L', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZL', 'ZLA', '991', 'Landia', 'Landia', '991', 'XLA', true);

insert into auth.users (id, email) values
  ('aa000000-0000-4000-8000-000000000001', 'la-one@test.invalid'),
  ('aa000000-0000-4000-8000-000000000002', 'la-two@test.invalid'),
  ('aa000000-0000-4000-8000-000000000003', 'la-staff@test.invalid'),
  ('aa000000-0000-4000-8000-000000000004', 'la-nobody@test.invalid'),
  ('aa000000-0000-4000-8000-000000000005', 'la-susp@test.invalid'),
  ('aa000000-0000-4000-8000-000000000006', 'la-moderator@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, country_code, status, suspended_at, suspension_reason, verification_status, verified_at)
values
  ('aa000000-0000-4000-8000-000000000001', 'la-one', 'Shop One', 'ZL', 'active', null, null, 'verified', now()),
  ('aa000000-0000-4000-8000-000000000002', 'la-two', 'Shop Two', 'ZL', 'active', null, null, 'verified', now()),
  -- A suspended storefront still reads its own rows: reading one's own data is not a mutation (Phase 6).
  ('aa000000-0000-4000-8000-000000000005', 'la-susp', 'Suspended Shop', 'ZL', 'suspended',
   now() - interval '10 days', 'SUSPENSION-REASON-SECRET', 'unverified', null);

insert into public.categories (id, slug, parent_id, listing_type_code, is_active, depth)
values ('dd000000-0000-4000-8000-000000000001', 'la-cat', null, 'product', true, 0);

insert into public.listings (id, slug, seller_user_id, category_id, listing_type_code, title, description,
  status, currency_code, country_code, content_language, price_minor, approved_at, published_at)
values
  ('ee000000-0000-4000-8000-000000000001', 'la-listing-one', 'aa000000-0000-4000-8000-000000000001',
   'dd000000-0000-4000-8000-000000000001', 'product', 'Listing One',
   'A listing long enough to satisfy the description bound.', 'active', 'XLA', 'ZL', 'en', 1000, now(), now()),
  ('ee000000-0000-4000-8000-000000000002', 'la-listing-two', 'aa000000-0000-4000-8000-000000000002',
   'dd000000-0000-4000-8000-000000000001', 'product', 'OTHER-SELLER-TITLE',
   'Another listing long enough to satisfy the bound.', 'active', 'XLA', 'ZL', 'en', 1000, now(), now()),
  ('ee000000-0000-4000-8000-000000000003', 'la-listing-susp', 'aa000000-0000-4000-8000-000000000005',
   'dd000000-0000-4000-8000-000000000001', 'product', 'Suspended Listing',
   'A listing long enough to satisfy the description bound.', 'active', 'XLA', 'ZL', 'en', 1000, now(), now());

-- Yesterday, on listing one: three clicks, two contacts, one favorite, one share — plus one impression and one
-- view, which 0013 permits, 0101 does not ingest, and the rollup must not count.
--
-- Every row carries `seller_user_id` null and a zero-length `session_hash`, exactly as 0101's ingestion writes
-- them: the rollup is required to resolve the owner from `listings` regardless.
insert into public.listing_events (event_id, listing_id, seller_user_id, event_type, occurred_at, user_id, session_hash, source)
select gen_random_uuid(), 'ee000000-0000-4000-8000-000000000001', null, t,
       (current_date - 1) + interval '10 hours', null, decode('', 'hex'), 'search'
  from unnest(array['click','click','click','contact','contact','favorite','share','impression','view']) as t;
-- Yesterday, on the other seller's listing and on the suspended storefront's.
insert into public.listing_events (event_id, listing_id, event_type, occurred_at)
values
  (gen_random_uuid(), 'ee000000-0000-4000-8000-000000000002', 'click', (current_date - 1) + interval '11 hours'),
  (gen_random_uuid(), 'ee000000-0000-4000-8000-000000000003', 'contact', (current_date - 1) + interval '12 hours');
-- An older day, for the bounded backfill, and today, which yesterday's run must not reach.
insert into public.listing_events (event_id, listing_id, event_type, occurred_at)
values
  (gen_random_uuid(), 'ee000000-0000-4000-8000-000000000001', 'click', (current_date - 10) + interval '9 hours'),
  (gen_random_uuid(), 'ee000000-0000-4000-8000-000000000001', 'click', (current_date - 10) + interval '10 hours'),
  (gen_random_uuid(), 'ee000000-0000-4000-8000-000000000001', 'click', current_date + interval '1 hour');
-- The exact boundaries of yesterday: the first instant belongs to it, the first instant of today does not.
insert into public.listing_events (event_id, listing_id, event_type, occurred_at)
values
  (gen_random_uuid(), 'ee000000-0000-4000-8000-000000000002', 'share', (current_date - 1)),
  (gen_random_uuid(), 'ee000000-0000-4000-8000-000000000002', 'share', current_date);

insert into public.user_roles (user_id, role_key, granted_at)
values
  ('aa000000-0000-4000-8000-000000000003', 'admin', now()),
  -- A staff role that does not carry the key: holding *a* role is not holding *this* permission.
  ('aa000000-0000-4000-8000-000000000006', 'moderator', now());

-- ---------------------------------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'listing_analytics', 'the rollup table exists');
select has_column('public', 'listing_analytics', 'listing_id', 'it keys on the listing');
select has_column('public', 'listing_analytics', 'seller_user_id', 'and records the owner as of that day');
select has_column('public', 'listing_analytics', 'day', 'and the day');
select has_column('public', 'listing_analytics', 'clicks', 'clicks');
select has_column('public', 'listing_analytics', 'contacts', 'contacts');
select has_column('public', 'listing_analytics', 'favorites', 'favorites');
select has_column('public', 'listing_analytics', 'shares', 'shares');
select has_column('public', 'listing_analytics', 'computed_at', 'and when it was computed');
select col_type_is('public', 'listing_analytics', 'day', 'date', 'the day is a calendar day, not a timestamp');
select col_type_is('public', 'listing_analytics', 'clicks', 'bigint', 'counts are bigint');
select col_type_is('public', 'listing_analytics', 'contacts', 'bigint', 'all four of them');
select col_type_is('public', 'listing_analytics', 'favorites', 'bigint', 'all four of them');
select col_type_is('public', 'listing_analytics', 'shares', 'bigint', 'all four of them');
select col_is_pk('public', 'listing_analytics', array['listing_id', 'day'],
  'the grain is (listing_id, day): owner decision 1, with no source in it');

-- Owner decision 2: four metrics, and no column for a type this platform does not ingest.
select is(
  (select coalesce(array_agg(c.column_name::text order by c.column_name), array[]::text[])
     from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'listing_analytics'),
  array['clicks', 'computed_at', 'contacts', 'day', 'favorites', 'listing_id', 'seller_user_id', 'shares'],
  'and those eight columns are the whole table: no impressions, no views, no rate, no session count');

select has_index('public', 'listing_analytics', 'listing_analytics_by_seller',
  'the seller reader has its own index');
select has_index('public', 'listing_analytics', 'listing_analytics_by_day',
  'and the day ordering has one, as promotion_analytics does');
select col_not_null('public', 'listing_analytics', 'seller_user_id', 'the owner is never unknown');
select col_not_null('public', 'listing_analytics', 'day', 'nor is the day');

-- Owner decision 10.
select is(
  (select confdeltype from pg_constraint
    where conrelid = 'public.listing_analytics'::regclass and contype = 'f'),
  'c', 'the listing reference cascades on delete, matching promotion_analytics');
select is(
  (select count(*)::int from pg_constraint
    where conrelid = 'public.listing_analytics'::regclass and contype = 'f'),
  1, 'and it is the only foreign key: seller_user_id carries none of its own');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.listing_analytics'::regclass),
  'row level security is enabled, as rls_problems() requires of every public table');
select is(
  (select count(*)::int from pg_policy where polrelid = 'public.listing_analytics'::regclass),
  1, 'with exactly one policy');
select ok(
  (select pg_get_expr(polqual, polrelid) like '%current_user_id%'
     from pg_policy where polrelid = 'public.listing_analytics'::regclass),
  'the policy admits the owner');
select ok(
  (select pg_get_expr(polqual, polrelid) like '%analytics.listing.read%'
     from pg_policy where polrelid = 'public.listing_analytics'::regclass),
  'or staff holding the key, mirroring promotion_analytics_read');

select ok(
  has_table_privilege('authenticated', 'public.listing_analytics', 'select'),
  'a signed-in request may select');
select ok(not has_table_privilege('authenticated', 'public.listing_analytics', 'insert'),
  'and never insert');
select ok(not has_table_privilege('authenticated', 'public.listing_analytics', 'update'),
  'never update');
select ok(not has_table_privilege('authenticated', 'public.listing_analytics', 'delete'),
  'and never delete');

select ok(
  not exists (select 1 from app_private.append_only_contract k
               where k.table_schema = 'public' and k.table_name = 'listing_analytics'),
  'it is not an append-only table: the rollup upserts, exactly as the promotion rollup does');

-- No table privilege is granted to the application roles: every path is a definer function.
select ok(not has_table_privilege('app_system', 'public.listing_analytics', 'select'),
  'app_system holds no table privilege on it');
select ok(not has_table_privilege('app_worker', 'public.listing_analytics', 'select'),
  'and neither does the worker');

-- ---------------------------------------------------------------------------------------------------
-- The rollup function
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'rollup_listing_analytics', array['date'], 'the rollup exists');
select function_returns('app_private', 'rollup_listing_analytics', array['date'], 'integer',
  'and answers how many rows it wrote');
select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'rollup_listing_analytics'),
  true, 'it is security definer');
select is(
  (select p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'rollup_listing_analytics'),
  array['search_path=pg_catalog, public'], 'with a pinned search path');

-- Owner decision 11: granted to nobody, reachable only through the dispatcher.
select ok(not has_function_privilege('app_system', 'app_private.rollup_listing_analytics(date)', 'execute'),
  'app_system may not run the rollup');
select ok(not has_function_privilege('app_worker', 'app_private.rollup_listing_analytics(date)', 'execute'),
  'and neither may the worker');
select ok(not has_function_privilege('public', 'app_private.rollup_listing_analytics(date)', 'execute'),
  'nor public');
select ok(not has_function_privilege('authenticated', 'app_private.rollup_listing_analytics(date)', 'execute'),
  'nor a signed-in request');

-- What it computes ----------------------------------------------------------------------------------
select is(app_private.rollup_listing_analytics(), 3,
  'rolling up yesterday writes one row per listing with events in it');

select is(
  (select clicks from public.listing_analytics
    where listing_id = 'ee000000-0000-4000-8000-000000000001' and day = current_date - 1),
  3::bigint, 'the clicks are counted');
select is(
  (select contacts from public.listing_analytics
    where listing_id = 'ee000000-0000-4000-8000-000000000001' and day = current_date - 1),
  2::bigint, 'and the contacts');
select is(
  (select favorites from public.listing_analytics
    where listing_id = 'ee000000-0000-4000-8000-000000000001' and day = current_date - 1),
  1::bigint, 'and the favorites, which no control fires yet but the contract accepts');
select is(
  (select shares from public.listing_analytics
    where listing_id = 'ee000000-0000-4000-8000-000000000001' and day = current_date - 1),
  1::bigint, 'and the shares');

-- The whole point of excluding them here as well as in ingestion.
select is(
  (select clicks + contacts + favorites + shares from public.listing_analytics
    where listing_id = 'ee000000-0000-4000-8000-000000000001' and day = current_date - 1),
  7::bigint, 'nine events produced seven: the impression and the view are not counted anywhere');
select is(
  (select count(*) from public.listing_events
    where listing_id = 'ee000000-0000-4000-8000-000000000001'
      and occurred_at >= current_date - 1 and occurred_at < current_date),
  9::bigint, 'and both are still in the stream, untouched');

-- Seller attribution, from `listings` and not from the stream.
select is(
  (select seller_user_id from public.listing_analytics
    where listing_id = 'ee000000-0000-4000-8000-000000000001' and day = current_date - 1),
  'aa000000-0000-4000-8000-000000000001'::uuid,
  'the owner is resolved from listings');
select is(
  (select count(*) from public.listing_events where seller_user_id is not null),
  0::bigint,
  'while every event still carries no seller at all, exactly as 0101 writes them');

-- The day boundary (owner decision 3): a half-open UTC day.
select is(
  (select shares from public.listing_analytics
    where listing_id = 'ee000000-0000-4000-8000-000000000002' and day = current_date - 1),
  1::bigint, 'the first instant of the day belongs to it');
select is((select count(*) from public.listing_analytics where day = current_date), 0::bigint,
  'and the first instant of today does not: today is never rolled up by the default run');

-- Idempotence, empirically.
select is(app_private.rollup_listing_analytics(), 3, 'running it again writes the same three rows');
select is(
  (select clicks from public.listing_analytics
    where listing_id = 'ee000000-0000-4000-8000-000000000001' and day = current_date - 1),
  3::bigint, 'and the counts are replaced, not added to');
select is((select count(*) from public.listing_analytics where day = current_date - 1), 3::bigint,
  'with no duplicate rows');

-- Owner decision 7: a bounded, owner-triggered backfill of one named day.
select is(app_private.rollup_listing_analytics(current_date - 10), 1, 'a named older day can be rolled up');
select is(
  (select clicks from public.listing_analytics
    where listing_id = 'ee000000-0000-4000-8000-000000000001' and day = current_date - 10),
  2::bigint, 'with that day''s own counts');
select is((select count(*) from public.listing_analytics), 4::bigint,
  'and nothing between the two days was invented');
select is(app_private.rollup_listing_analytics(current_date - 60), 0,
  'a day with no events writes nothing rather than a row of zeroes');

-- A day whose listing is gone has nothing to attribute.
select lives_ok(
  $$delete from public.listing_analytics where listing_id = 'ee000000-0000-4000-8000-000000000003'$$,
  'a rollup row can be removed for the next assertion');
select is(app_private.rollup_listing_analytics(), 3, 'and the next run puts it back');

-- It writes nowhere else.
savepoint before_side_effects;
create temporary table la_before on commit drop as
  select (select count(*) from audit.audit_logs) as audit_rows,
         (select count(*) from public.outbox_events) as outbox_rows,
         (select count(*) from public.listing_events) as event_rows,
         (select count(*) from public.promotion_analytics) as promo_rows;
select lives_ok($$select app_private.rollup_listing_analytics()$$, 'the rollup runs');
select is((select count(*) from audit.audit_logs), (select audit_rows from la_before),
  'and writes nothing to the audit log');
select is((select count(*) from public.outbox_events), (select outbox_rows from la_before),
  'nothing to the outbox');
select is((select count(*) from public.listing_events), (select event_rows from la_before),
  'nothing to the event stream it reads');
select is((select count(*) from public.promotion_analytics), (select promo_rows from la_before),
  'and nothing to promotion analytics');
release savepoint before_side_effects;

-- ---------------------------------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.cron_job_problems()), 0::bigint,
  'the schedule matches its contract');
select is((select count(*) from app_private.scheduled_job_contract), 17::bigint,
  'seventeen contracted jobs: 0101''s retention, this rollup, and 0107''s two ledger prunes');
select is(
  (select cron_schedule from app_private.scheduled_job_contract where job_key = 'listing_analytics.rollup'),
  '50 2 * * *', 'owner decision 9: daily at 02:50, after the promotion rollup and before the partitioner');
select is(
  (select target_signature from app_private.scheduled_job_contract where job_key = 'listing_analytics.rollup'),
  'app_private.rollup_listing_analytics(null)', 'the contract names what it calls');
select is(
  (select command from cron.job where jobname = 'marketplace.listing_analytics.rollup'),
  'select app_private.run_scheduled_job(''listing_analytics.rollup'')',
  'and the cron command is only the dispatcher, never the function itself');
select is(
  (select schedule from cron.job where jobname = 'marketplace.listing_analytics.rollup'),
  '50 2 * * *', 'at the contracted schedule');
select is((select count(*) from cron.job), 17::bigint,
  'seventeen jobs are scheduled, and only seventeen');
select is((select count(*) from cron.job where jobname not like 'marketplace.%'), 0::bigint,
  'every scheduled job still belongs to this marketplace');

-- 0101's two jobs and the promotion rollup are untouched.
select is(
  (select cron_schedule from app_private.scheduled_job_contract where job_key = 'listing_events.retention'),
  '25 4 * * *', '0101''s retention window keeps its own schedule');
select is(
  (select cron_schedule from app_private.scheduled_job_contract where job_key = 'promotions.rollup'),
  '35 2 * * *', 'and so does the promotion rollup');

-- job_runs: one row per occurrence, through the existing machinery.
savepoint job_runs_probe;
delete from public.job_runs;
select lives_ok($$select app_private.run_scheduled_job('listing_analytics.rollup')$$,
  'the dispatcher runs the job');
select is((select count(*) from public.job_runs where job_name = 'listing_analytics.rollup'), 1::bigint,
  'one job_runs row per occurrence');
select is((select status from public.job_runs where job_name = 'listing_analytics.rollup'), 'succeeded',
  'recorded as succeeded');
select is((select processed_count from public.job_runs where job_name = 'listing_analytics.rollup'), 3,
  'with the rollup''s own row count as processed_count');
select ok((select error_type is null from public.job_runs where job_name = 'listing_analytics.rollup'),
  'and no error type');
select ok((select finished_at is not null from public.job_runs where job_name = 'listing_analytics.rollup'),
  'and a finish time, so the row is not left running');
select is((select details ->> 'job_key' from public.job_runs where job_name = 'listing_analytics.rollup'),
  'listing_analytics.rollup', 'the details name the job and nothing else about the data');
select lives_ok($$select app_private.run_scheduled_job('listing_analytics.rollup')$$,
  'a second occurrence runs');
select is((select count(*) from public.job_runs where job_name = 'listing_analytics.rollup'), 2::bigint,
  'and is recorded separately, never merged with the first');
rollback to job_runs_probe;

select throws_ok(
  $$select app_private.run_scheduled_job('listing_analytics.rollups')$$,
  '22023', null, 'a key the contract does not name is refused rather than silently doing nothing');

-- ---------------------------------------------------------------------------------------------------
-- The seller surface: ownership, and no permission key
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'seller_listing_analytics', array['uuid', 'integer'],
  'the seller reader exists');
select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_listing_analytics'),
  's', 'it is stable: a reader writes nothing');
select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_listing_analytics'),
  true, 'and security definer');
select is(
  (select p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_listing_analytics'),
  array['search_path=pg_catalog, public'], 'with a pinned search path');
select ok(has_function_privilege('app_system', 'app_private.seller_listing_analytics(uuid, integer)', 'execute'),
  'app_system may read it');
select ok(
  not has_function_privilege('app_worker', 'app_private.seller_listing_analytics(uuid, integer)', 'execute'),
  'the worker may not: no schedule reads a seller''s analytics');
select ok(
  not has_function_privilege('authenticated', 'app_private.seller_listing_analytics(uuid, integer)', 'execute'),
  'and neither may a request reach it directly');

select is(
  (select outcome from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000004', 30)),
  'not_found', 'a caller with no storefront gets not_found, as 6-J''s reader does');
select is(
  (select count(*) from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000004', 30)),
  1::bigint, 'as exactly one row, carrying nothing else');
select is(
  (select listing_slug from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000004', 30)),
  null, 'with no listing in it');

select is(
  (select count(*) from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', 30)),
  1::bigint, 'the first seller sees their one listing');
select is(
  (select clicks from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', 30)),
  '5', 'with its clicks summed over the window, as text');
select is(
  (select contacts from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', 30)),
  '2', 'its contacts');
select is(
  (select favorites from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', 30)),
  '1', 'its favorites');
select is(
  (select shares from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', 30)),
  '1', 'and its shares');
select is(
  (select first_day from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', 30)),
  current_date - 10, 'the window''s first day is the earliest rolled-up day it covers');
select is(
  (select last_day from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', 30)),
  current_date - 1, 'and the last is the most recent');
select is(
  (select listing_status from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', 30)),
  'active', 'the listing''s current status comes along, as 6-J''s reader carries the promotion''s');

-- Ownership isolation, checked by the other seller's values rather than by a row count.
select is(
  (select count(*) from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000002', 30)),
  1::bigint, 'the second seller sees only their own listing');
select is(
  (select listing_slug from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000002', 30)),
  'la-listing-two', 'which is theirs');
select is(
  (select count(*) from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', 365)
    where listing_title = 'OTHER-SELLER-TITLE'),
  0::bigint, 'and the other seller''s title appears nowhere in the first seller''s output');
select is(
  (select count(*) from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000002', 365)
    where listing_slug = 'la-listing-one'),
  0::bigint, 'nor theirs in the second''s');

-- A suspended storefront still reads its own rows, and the suspension reason is not among them.
select is(
  (select count(*) from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000005', 30)),
  1::bigint, 'a suspended storefront still reads its own analytics');
select is(
  (select contacts from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000005', 30)),
  '1', 'with its own counts');
select is(
  (select count(*) from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000005', 365)
    where coalesce(listing_title, '') || coalesce(listing_status, '') like '%SUSPENSION-REASON-SECRET%'),
  0::bigint, 'and nothing about why it is suspended');

-- The window, clamped rather than trusted.
select is(
  (select clicks from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', 0)),
  '3', 'a window of zero days is clamped to one, so only yesterday is summed');
select is(
  (select clicks from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', -5)),
  '3', 'and so is a negative one');
select is(
  (select clicks from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', null)),
  '5', 'a missing window is the default thirty days');
select is(
  (select clicks from app_private.seller_listing_analytics('aa000000-0000-4000-8000-000000000001', 100000)),
  '5', 'and one beyond a year is clamped to a year');

-- ---------------------------------------------------------------------------------------------------
-- The staff surface: the first consumer of analytics.listing.read
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'listing_analytics_can_read', array['uuid', 'boolean'],
  'the staff gate exists');
select function_returns('app_private', 'listing_analytics_can_read', array['uuid', 'boolean'], 'boolean',
  'and answers yes or no');
select has_function('app_private', 'listing_analytics_page',
  array['uuid', 'boolean', 'integer', 'integer', 'date', 'uuid'], 'the staff reader exists');
select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'listing_analytics_page'),
  's', 'and it is stable');
select ok(
  has_function_privilege('app_system',
    'app_private.listing_analytics_page(uuid, boolean, integer, integer, date, uuid)', 'execute'),
  'app_system may read the page');
select ok(
  not has_function_privilege('app_worker',
    'app_private.listing_analytics_page(uuid, boolean, integer, integer, date, uuid)', 'execute'),
  'and the worker may not');

select ok(app_private.listing_analytics_can_read('aa000000-0000-4000-8000-000000000003', true),
  'an admin with AAL2 may read');
select ok(not app_private.listing_analytics_can_read('aa000000-0000-4000-8000-000000000003', false),
  'owner decision 6: the same admin without AAL2 may not, because the role requires MFA');
select ok(not app_private.listing_analytics_can_read('aa000000-0000-4000-8000-000000000003', null),
  'and a null second factor fails closed');
select ok(not app_private.listing_analytics_can_read('aa000000-0000-4000-8000-000000000006', true),
  'a moderator may not: holding a staff role is not holding this permission');
select ok(not app_private.listing_analytics_can_read('aa000000-0000-4000-8000-000000000001', true),
  'nor may a seller, who reads their own rows by ownership instead');
select ok(not app_private.listing_analytics_can_read('aa000000-0000-4000-8000-000000000004', true),
  'nor anybody with no role at all');
select ok(not app_private.listing_analytics_can_read(null, true), 'nor an unknown caller');

select is(
  (select count(*) from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 365, 100)),
  4::bigint, 'the page shows every seller''s rows to staff who may read');
select is(
  (select count(*) from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', false, 365, 100)),
  0::bigint, 'and nothing at all without AAL2');
select is(
  (select count(*) from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000006', true, 365, 100)),
  0::bigint, 'nothing to a moderator');
select is(
  (select count(*) from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000001', true, 365, 100)),
  0::bigint, 'nothing to a seller through this surface');
select is(
  (select count(*) from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000004', true, 365, 100)),
  0::bigint, 'and nothing to a caller with no role, which reads exactly like an empty window');

-- A revoked or expired grant stops reading, which is what "takes effect on the next request" means.
savepoint grant_probe;
update public.user_roles set revoked_at = now(), revoked_by = 'aa000000-0000-4000-8000-000000000003'
 where user_id = 'aa000000-0000-4000-8000-000000000003' and role_key = 'admin';
select ok(not app_private.listing_analytics_can_read('aa000000-0000-4000-8000-000000000003', true),
  'a revoked role stops reading');
select is(
  (select count(*) from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 365, 100)),
  0::bigint, 'and the page goes empty with it');
rollback to grant_probe;

savepoint expiry_probe;
update public.user_roles set granted_at = now() - interval '2 days', expires_at = now() - interval '1 hour'
 where user_id = 'aa000000-0000-4000-8000-000000000003' and role_key = 'admin';
select ok(not app_private.listing_analytics_can_read('aa000000-0000-4000-8000-000000000003', true),
  'an expired role stops reading too');
rollback to expiry_probe;

-- Ordering, the cursor, and the limit.
select is(
  (select day from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 365, 1)),
  current_date - 1, 'the page is newest day first');
select is(
  (select count(*) from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 365, 1)),
  1::bigint, 'a limit of one returns one row');
select is(
  (select count(*) from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 365, 0)),
  1::bigint, 'a limit of zero is clamped to one');
select is(
  (select count(*) from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 365, 100000)),
  4::bigint, 'and a limit beyond the maximum returns what there is');

-- The cursor is total: `(day, listing_id)` never ties, so no row is repeated or skipped.
select is(
  (select count(distinct (day, cursor_listing_id))
     from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 365, 100)),
  4::bigint, 'every row has its own cursor position');
select is(
  (select p2.cursor_listing_id
     from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 365, 1) p1,
          app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 365, 1,
            p1.cursor_day, p1.cursor_listing_id) p2),
  -- Ordered by (day desc, listing_id desc), the newest day's highest listing id comes first, so the row
  -- after it is the next id down — never the one just read.
  'ee000000-0000-4000-8000-000000000002'::uuid,
  'following a cursor yields the next row, never the one just read');
select is(
  (select count(*)
     from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 365, 100,
       current_date - 365, '00000000-0000-4000-8000-000000000000'::uuid)),
  0::bigint, 'a cursor past the end yields nothing rather than wrapping');
select is(
  (select count(*) from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 1, 100)),
  3::bigint, 'the window clamps here too: one day shows only yesterday''s rows');

-- The seller is named by their storefront's public address, never by an account identifier.
select is(
  (select seller_slug from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 365, 1)),
  'la-susp', 'the page names a seller by their public slug, suspended or not');
select is(
  (select count(*) from app_private.listing_analytics_page('aa000000-0000-4000-8000-000000000003', true, 365, 100)
    where seller_slug is null),
  0::bigint, 'every row has one');

-- ---------------------------------------------------------------------------------------------------
-- Privacy: nothing identifying is read, and nothing identifying is returned
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('rollup_listing_analytics', 'seller_listing_analytics',
                        'listing_analytics_can_read', 'listing_analytics_page')
      and p.prosrc like '%session_hash%'),
  0, 'no function this increment adds reads the session digest');
select ok(
  (select replace(p.prosrc, 'seller_user_id', '') not like '%user_id%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'rollup_listing_analytics'),
  'and the rollup reads no account at all: only the seller it resolves from listings');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('rollup_listing_analytics', 'seller_listing_analytics', 'listing_analytics_page')
      and p.prosrc like '%referrer_host%'),
  0, 'nor the referrer, which nothing populates anyway');

-- The two readers' output columns, pinned: an identifier added later fails here.
select is(
  (select coalesce(array_agg(a.name order by a.ord), array[]::text[])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
          unnest(p.proargnames) with ordinality as a(name, ord)
    where n.nspname = 'app_private' and p.proname = 'seller_listing_analytics'
      and a.ord > 2),
  array['outcome', 'listing_slug', 'listing_title', 'listing_status', 'first_day', 'last_day',
        'clicks', 'contacts', 'favorites', 'shares'],
  'the seller reader returns ten columns and no identifier among them');
select is(
  (select coalesce(array_agg(a.name order by a.ord), array[]::text[])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
          unnest(p.proargnames) with ordinality as a(name, ord)
    where n.nspname = 'app_private' and p.proname = 'listing_analytics_page'
      and a.ord > 6),
  array['day', 'listing_slug', 'listing_title', 'listing_status', 'seller_slug',
        'clicks', 'contacts', 'favorites', 'shares', 'computed_at', 'cursor_day', 'cursor_listing_id'],
  'and the staff reader twelve, the only identifier among them being the cursor''s own position');

select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'the security contract holds with all of it added');
select is((select count(*) from public.audit_attribution_problems()), 0::bigint,
  'and nothing names 8-B''s audit channel');
select is((select count(*) from public.rls_problems()), 0::bigint, 'every table still has row level security');
select is((select count(*) from public.grant_problems()), 0::bigint, 'and no grant is without a policy');
select is((select count(*) from public.definer_problems()), 0::bigint, 'every definer function is still sound');

-- ---------------------------------------------------------------------------------------------------
-- What this increment did not touch
-- ---------------------------------------------------------------------------------------------------
-- 0101's ingestion and retention, and 0013's writer, exactly as they were.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'record_listing_events'
      and pg_get_function_identity_arguments(p.oid) = 'p_events jsonb'),
  1::bigint, '0013''s writer keeps its one argument');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'drop_expired_listing_event_partitions'
      and pg_get_function_identity_arguments(p.oid) = 'p_retain_days integer'),
  1::bigint, 'and 0101''s retention its one');
select is(
  (select count(*)::int from pg_constraint
    where conrelid = 'public.listing_events'::regclass and conname = 'listing_events_type_allowed'),
  1, '0013''s event-type constraint is unchanged');
select ok(
  (select pg_get_constraintdef(oid) like '%impression%'
     from pg_constraint where conrelid = 'public.listing_events'::regclass
      and conname = 'listing_events_type_allowed'),
  'and still permits impression, which this increment simply does not count');

-- Promotion analytics, exactly as 6-J left it.
select is(
  (select coalesce(array_agg(p.proname::text order by p.proname), array[]::text[])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc ~ 'promotion_analytics'
      and p.proname <> 'run_scheduled_job'),
  array['rollup_promotion_analytics', 'seller_promotion_analytics'],
  'promotion analytics is still reached by exactly its own two functions');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_promotion_analytics'
      and pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_days integer'),
  1::bigint, 'and 6-J''s reader keeps its signature');

-- No new permission key, and the seeded one is now consumed.
select is((select count(*) from public.permissions where key like 'analytics%'), 1::bigint,
  'analytics.listing.read is still the only analytics permission: no key was invented');
select ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app_private' and p.prosrc like '%analytics.listing.read%'),
  'and it is consumed for the first time since 0033 seeded it');

-- Nothing financial.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('rollup_listing_analytics', 'seller_listing_analytics',
                        'listing_analytics_can_read', 'listing_analytics_page')
      and (p.prosrc ~ 'payout|settlement|seller_balance|payment|refund|ledger|provider')),
  0, 'no function this increment adds names a financial table or path');
select is((public.site_setting('finance.settlement_posting_enabled'))::boolean, false,
  'and settlement posting is still disabled');

select finish();
rollback;
