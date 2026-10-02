-- pgTAP — migration 0061: the seller's own listing write boundary.
--
-- Five things are being held to account.
--
-- **A seller cannot reach a state that is not theirs to reach.** `approved`, `active`, `rejected`,
-- `suspended`, `sold`, `expired` and `deleted` appear in no assignment in any of these functions, and none
-- of them has a `status` parameter — asserted on the sources and the parameter lists, then again by driving
-- every function against a listing in each of those states and finding it refused. 0027's `moderate_listing`
-- is untouched and remains the only path to a moderation decision.
--
-- **Ownership is structural.** Every statement is scoped by `seller_user_id = p_user_id`, so a listing that
-- belongs to somebody else answers exactly as one that does not exist — asserted with two sellers and a real
-- slug borrowed between them. No function takes a seller, an owner or a listing uuid at all.
--
-- **The transitions are the schema's own.** draft on creation, draft on edit, `pending_review` on
-- submission, `archived` with `archived_at` on archival. Every other transition the vocabulary allows is
-- attempted and refused.
--
-- **The immutable columns cannot move.** After an edit that touches all nine editable columns, the slug, the
-- type, the category, the owner, the status, the view count, `created_at` and every state-bearing timestamp
-- are compared against a before-snapshot.
--
-- **The audit trail is 0011's.** The status-history trigger writes a row per transition, the table is
-- append-only, and a refused mutation leaves nothing behind.
--
-- Deterministic: fixed uuids, no wall-clock dependence. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(194);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zy', 'Test locale', 'Test locale', 'ltr', true, false),
       ('zz', 'Other locale', 'Other locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTT', '961', 'T', 2, true, false, true, true),
       ('XNO', '962', 'N', 2, false, false, false, false);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZY', 'ZYZ', '997', 'Testland', 'Testland', '997', 'XTT', true),
       ('ZX', 'ZXZ', '996', 'Offland', 'Offland', '996', 'XTT', false);

insert into auth.users (id, email) values
  ('80000000-0000-4000-8000-000000000001', 'active-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000002', 'second-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000003', 'pending-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000004', 'suspended-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000005', 'closed-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000006', 'not-a-seller@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, country_code, status, suspended_at, suspension_reason, closed_at,
   verification_status, verified_at)
values
  ('80000000-0000-4000-8000-000000000001', 'active-shop', 'Active Shop', 'ZY', 'active',
   null, null, null, 'verified', '2026-02-01T00:00:00Z'),
  ('80000000-0000-4000-8000-000000000002', 'second-shop', 'Second Shop', 'ZY', 'active',
   null, null, null, 'verified', '2026-02-01T00:00:00Z'),
  ('80000000-0000-4000-8000-000000000003', 'pending-shop', 'Pending Shop', 'ZY', 'pending',
   null, null, null, 'unverified', null),
  ('80000000-0000-4000-8000-000000000004', 'suspended-shop', 'Suspended Shop', 'ZY', 'suspended',
   '2026-03-01T00:00:00Z', 'Repeated policy breaches, internal note', null, 'verified', '2026-02-01T00:00:00Z'),
  ('80000000-0000-4000-8000-000000000005', 'closed-shop', 'Closed Shop', 'ZY', 'closed',
   null, null, '2026-04-01T00:00:00Z', 'verified', '2026-02-01T00:00:00Z');

insert into public.categories (id, parent_id, depth, slug, listing_type_code, is_active, sort_order)
values
  ('c0000000-0000-4000-8000-000000000001', null, 0, 'widgets', 'product', true, 1),
  ('c0000000-0000-4000-8000-000000000002', null, 0, 'service-cat', 'service', true, 2),
  ('c0000000-0000-4000-8000-000000000003', null, 0, 'any-cat', null, true, 3),
  ('c0000000-0000-4000-8000-000000000004', null, 0, 'off-cat', null, false, 4);

-- A listing in each of the states a seller must not be able to reach or mutate, built directly so the
-- functions below are tested against them rather than against states they could have produced.
insert into public.listings
  (id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
   currency_code, price_minor, status, country_code, approved_at, sold_at, archived_at, deleted_at)
values
  ('a0000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', 'product',
   'c0000000-0000-4000-8000-000000000001', 'approved-listing', 'Approved Listing',
   'An approved listing description.', 'zy', 'XTT', 1000, 'approved', 'ZY', '2026-05-01T00:00:00Z', null, null, null),
  ('a0000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000001', 'product',
   'c0000000-0000-4000-8000-000000000001', 'active-listing', 'Active Listing',
   'An active listing description.', 'zy', 'XTT', 2000, 'active', 'ZY', '2026-05-01T00:00:00Z', null, null, null),
  ('a0000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000001', 'product',
   'c0000000-0000-4000-8000-000000000001', 'sold-listing', 'Sold Listing',
   'A sold listing description.', 'zy', 'XTT', 3000, 'sold', 'ZY', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z', null, null),
  ('a0000000-0000-4000-8000-000000000004', '80000000-0000-4000-8000-000000000001', 'product',
   'c0000000-0000-4000-8000-000000000001', 'rejected-listing', 'Rejected Listing',
   'A rejected listing description.', 'zy', 'XTT', 4000, 'rejected', 'ZY', null, null, null, null),
  ('a0000000-0000-4000-8000-000000000005', '80000000-0000-4000-8000-000000000001', 'product',
   'c0000000-0000-4000-8000-000000000001', 'suspended-listing', 'Suspended Listing',
   'A suspended listing description.', 'zy', 'XTT', 5000, 'suspended', 'ZY', null, null, null, null),
  ('a0000000-0000-4000-8000-000000000006', '80000000-0000-4000-8000-000000000001', 'product',
   'c0000000-0000-4000-8000-000000000001', 'archived-listing', 'Archived Listing',
   'An archived listing description.', 'zy', 'XTT', 6000, 'archived', 'ZY', '2026-05-01T00:00:00Z', null, '2026-07-01T00:00:00Z', null),
  ('a0000000-0000-4000-8000-000000000007', '80000000-0000-4000-8000-000000000001', 'product',
   'c0000000-0000-4000-8000-000000000001', 'deleted-listing', 'Deleted Listing',
   'A deleted listing description.', 'zy', 'XTT', 7000, 'deleted', 'ZY', null, null, null, '2026-08-01T00:00:00Z'),
  ('a0000000-0000-4000-8000-000000000008', '80000000-0000-4000-8000-000000000002', 'product',
   'c0000000-0000-4000-8000-000000000001', 'other-sellers-listing', 'Other Sellers Listing',
   'Another seller''s listing description.', 'zy', 'XTT', 8000, 'draft', 'ZY', null, null, null, null);

create temporary table audit_mark as
select coalesce(max(h.id), 0) as id from public.listing_status_history h;

-- ---------------------------------------------------------------------------------------------------
-- Security: the S8 contract, for all five functions
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_to_string(array_agg(p.proname || '/' || p.pronargs order by p.proname), ' ')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_listing%'
      -- 8-C's listing attribute and tag functions share the prefix and are inventoried by their own suite.
      and p.proname not like 'seller\_listing\_attribute%'
      and p.proname not like 'seller\_listing\_tag%'
      and p.proname not like 'seller\_listing\_vocabulary%'),
  'seller_listing_archive/2 seller_listing_create_draft/13 seller_listing_submit/2'
    || ' seller_listing_update_draft/20 seller_listings/4',
  'this migration adds exactly five functions, each with the arity it declares, and no overloads');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_listing%' and not p.prosecdef),
  0::bigint,
  'every one of them is SECURITY DEFINER');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_listing%'
      and array_to_string(p.proconfig, ',') <> 'search_path=pg_catalog, public'),
  0::bigint,
  'and every one has its search_path pinned');

-- No input parameter of any writer names a seller, an owner, a status, an approval or a timestamp: there
-- is no field through which a request could ask for one.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames[1:p.pronargs]) as arg
    where n.nspname = 'app_private' and p.proname like 'seller\_listing\_%'
      and (arg like '%seller%'
        or arg like '%owner%'
        or (arg like '%\_id' and arg <> 'p_user_id')
        or arg like '%status%'
        or arg like '%approv%'
        or arg like '%activ%'
        or arg like '%moderat%'
        or arg like '%\_at')),
  0::bigint,
  'no writer takes a seller, an owner, another identifier, a status, an approval, an activation or a timestamp');

select is(
  (select array_to_string(p.proargnames[1:2], ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_listing_submit'),
  'p_user_id,p_slug',
  'the submitter takes one caller id and one slug — no status, and no listing uuid');
select is(
  (select array_to_string(p.proargnames[1:2], ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_listing_archive'),
  'p_user_id,p_slug',
  'and so does the archiver');

select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_listing_create_draft'),
  'TABLE(outcome text, slug text, status text)',
  'the writers return an outcome, a slug and a status, and nothing private');

-- The readback carries no identifier at all.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames[5:22]) as col
    where n.nspname = 'app_private' and p.proname = 'seller_listings'
      and (col like '%_id' or col in ('approved_at', 'published_at', 'sold_at', 'expires_at', 'deleted_at',
                                      'view_count', 'seller_user_id'))),
  0::bigint,
  'the readback returns no identifier, no approval or publication time, no deletion time and no view count');

-- No dynamic SQL in any of them.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_listing%'
      and (strpos(p.prosrc, 'execute format') > 0 or strpos(p.prosrc, 'execute ''') > 0)),
  0::bigint,
  'none of them builds SQL at run time for a request-controlled value');

-- The states a seller may not reach appear nowhere in any writer's body — not in an assignment, not in a
-- comparison, not at all.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_listing\_%'
      and (strpos(p.prosrc, '''approved''') > 0 or strpos(p.prosrc, '''rejected''') > 0
        or strpos(p.prosrc, '''suspended''') > 0 or strpos(p.prosrc, '''sold''') > 0
        or strpos(p.prosrc, '''deleted''') > 0 or strpos(p.prosrc, '''expired''') > 0)),
  0::bigint,
  'no writer names approved, rejected, suspended, sold, expired or deleted anywhere in its body');
-- `active` is the one that needs care, because it is also a *seller* status. Strip the seller-status guard
-- and it disappears: no writer mentions an active listing anywhere, so none can create or move one.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_listing\_%'
      -- 8-C's listing attribute, tag and context functions share the prefix; they read the seller's status by
      -- the same rule and write no listing status at all, which their own suite asserts.
      and p.proname not like 'seller\_listing\_attribute%'
      and p.proname not like 'seller\_listing\_tag%'
      and p.proname not like 'seller\_listing\_vocabulary%'
      and strpos(
        replace(p.prosrc, 'v_seller_status not in (''pending'', ''active'')', ''),
        '''active'''
      ) > 0),
  0::bigint,
  'and the only mention of active in any of them is the seller-status guard, never a listing status');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('seller_listing_update_draft', 'seller_listing_submit', 'seller_listing_archive')
      and strpos(p.prosrc, 'seller_user_id = p_user_id') = 0),
  0::bigint,
  'every mutator scopes its statement by the caller''s own ownership');
select ok(
  (select strpos(p.prosrc, 'p_user_id, p_listing_type_code') > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_listing_create_draft'),
  'and the writer that has no row to scope yet takes its owner from the caller''s id, not from a parameter');
select ok(
  (select strpos(p.prosrc, '''draft''') > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_listing_create_draft'),
  'and writes the status as a literal draft');

-- ACLs.
select ok(not has_function_privilege('public',
  'app_private.seller_listing_create_draft(uuid, text, text, text, text, text, text, text, text, bigint, boolean, text, text)', 'execute'),
  'PUBLIC cannot create a draft');
select ok(not has_function_privilege('authenticated',
  'app_private.seller_listing_create_draft(uuid, text, text, text, text, text, text, text, text, bigint, boolean, text, text)', 'execute'),
  'authenticated cannot');
select ok(not has_function_privilege('anon',
  'app_private.seller_listing_create_draft(uuid, text, text, text, text, text, text, text, text, bigint, boolean, text, text)', 'execute'),
  'anon cannot');
select ok(has_function_privilege('app_system',
  'app_private.seller_listing_create_draft(uuid, text, text, text, text, text, text, text, text, bigint, boolean, text, text)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('app_worker',
  'app_private.seller_listing_create_draft(uuid, text, text, text, text, text, text, text, text, bigint, boolean, text, text)', 'execute'),
  'app_worker cannot');
select ok(not has_function_privilege('authenticated', 'app_private.seller_listing_submit(uuid, text)', 'execute'),
  'authenticated cannot submit');
select ok(has_function_privilege('app_system', 'app_private.seller_listing_submit(uuid, text)', 'execute'),
  'app_system can submit');
select ok(not has_function_privilege('authenticated', 'app_private.seller_listing_archive(uuid, text)', 'execute'),
  'authenticated cannot archive');
select ok(has_function_privilege('app_system', 'app_private.seller_listing_archive(uuid, text)', 'execute'),
  'app_system can archive');
select ok(not has_function_privilege('anon', 'app_private.seller_listings(uuid, integer, timestamptz, text)', 'execute'),
  'anon cannot read a seller''s listings');
select ok(has_function_privilege('app_system', 'app_private.seller_listings(uuid, integer, timestamptz, text)', 'execute'),
  'app_system can');

select is(
  (select count(*) from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'listings' and grantee in ('app_system', 'app_worker')),
  0::bigint,
  'app_system still holds no privilege on public.listings');
select is(
  (select array_to_string(array_agg(distinct privilege_type order by privilege_type), ',')
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'listings' and grantee = 'authenticated'),
  'INSERT,SELECT,UPDATE',
  '0011''s authenticated grants are unchanged: no DELETE, and nothing widened');
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'listings'),
  6::bigint,
  '0011''s six listing policies are still in place as defence in depth');
select ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app_private' and p.proname = 'moderate_listing'),
  '0027''s moderation entry point still exists and was not replaced');

select lives_ok($$ select app_private.assert_security_contract() $$,
  'the deploy-time security contract still holds');

-- ---------------------------------------------------------------------------------------------------
-- Creating a draft
-- ---------------------------------------------------------------------------------------------------
create temporary table made as
select * from app_private.seller_listing_create_draft(
  '80000000-0000-4000-8000-000000000001', 'a-chair', '  A Chair  ',
  '  A very fine chair indeed.  ', 'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, '  Gov  ', '  Cairo  ');

select is((select outcome from made), 'created', 'an active seller creates a draft');
select is((select slug from made), 'a-chair', 'the slug comes back');
select is((select status from made), 'draft', 'and the status is draft');

select is((select l.title from public.listings l where l.slug = 'a-chair'), 'A Chair',
  'the title is stored trimmed');
select is((select l.description from public.listings l where l.slug = 'a-chair'), 'A very fine chair indeed.',
  'the description is stored trimmed');
select is((select l.governorate from public.listings l where l.slug = 'a-chair'), 'Gov',
  'the governorate is stored trimmed');
select is((select l.city from public.listings l where l.slug = 'a-chair'), 'Cairo',
  'the city is stored trimmed');
select is((select l.seller_user_id from public.listings l where l.slug = 'a-chair'),
  '80000000-0000-4000-8000-000000000001'::uuid,
  'the listing belongs to the account whose id was supplied, and no other');
select is((select l.price_minor from public.listings l where l.slug = 'a-chair'), null::bigint,
  'a draft needs no price');
select is(
  (select count(*) from public.listing_media m join public.listings l on l.id = m.listing_id
    where l.slug = 'a-chair'),
  0::bigint,
  'and no media: S-9 holds without a special case');
select is(
  (select count(*) from public.listing_product_details d join public.listings l on l.id = d.listing_id
    where l.slug = 'a-chair'),
  0::bigint,
  'and no product detail row, which nothing requires for a draft');
select is((select l.submitted_at from public.listings l where l.slug = 'a-chair'), null::timestamptz,
  'no submission time');
select is((select l.approved_at from public.listings l where l.slug = 'a-chair'), null::timestamptz,
  'no approval time: a seller cannot pre-approve their own listing');
select is((select l.archived_at from public.listings l where l.slug = 'a-chair'), null::timestamptz,
  'no archival time');
select is((select l.deleted_at from public.listings l where l.slug = 'a-chair'), null::timestamptz,
  'no deletion time');
select is((select l.view_count from public.listings l where l.slug = 'a-chair'), 0::bigint,
  'the view count is the table''s own default');
select ok((select l.created_at from public.listings l where l.slug = 'a-chair') is not null,
  'the timestamps are the table''s defaults, not the caller''s');

select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000003', 'pending-sellers-draft', 'Pending Sellers Draft',
    'A description long enough to pass.', 'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'created',
  'a pending seller may create a draft too');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'a-service', 'A Service',
    'A description long enough to pass.', 'service', 'service-cat', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'created',
  'a service goes in a service category');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'unscoped-cat-listing', 'Unscoped',
    'A description long enough to pass.', 'product', 'any-cat', 'zy', 'XTT', 'ZY', 500, true, null, null)),
  'created',
  'a category scoped to neither type accepts either');

-- ---------------------------------------------------------------------------------------------------
-- Creation: validation, all of it 0011's
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'Bad_Slug', 'Title here', 'A description long enough.',
    'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'invalid', 'a slug outside 0011''s format is refused');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'ab', 'Title here', 'A description long enough.',
    'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'invalid', 'a two-character slug is refused');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'title-short', 'ab', 'A description long enough.',
    'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'invalid', 'a two-character title is below 0011''s minimum of three');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'title-long', repeat('t', 141), 'A description long enough.',
    'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'invalid', 'a 141-character title is above the maximum of 140');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'title-blank', '   ', 'A description long enough.',
    'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'invalid', 'a whitespace title is refused: the limit is on the trimmed value');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'desc-short', 'Title here', 'too short',
    'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'invalid', 'a nine-character description is below the minimum of ten');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'desc-long', 'Title here', repeat('d', 20001),
    'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'invalid', 'a 20001-character description is above the maximum');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'desc-ten', 'Title here', 'abcdefghij',
    'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'created', 'and exactly ten characters is accepted');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'bad-type', 'Title here', 'A description long enough.',
    'gizmo', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'invalid', 'a listing type that is not in listing_types is refused');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'cat-mismatch', 'Title here', 'A description long enough.',
    'product', 'service-cat', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'invalid', 'a category scoped to services refuses a product');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'cat-off', 'Title here', 'A description long enough.',
    'product', 'off-cat', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'invalid', 'an inactive category is refused');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'cat-missing', 'Title here', 'A description long enough.',
    'product', 'no-such-category', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'invalid', 'a category that does not exist is refused');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'bad-locale', 'Title here', 'A description long enough.',
    'product', 'widgets', 'qq', 'XTT', 'ZY', null, null, null, null)),
  'invalid', 'a content language that is not a locale is refused');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'bad-currency', 'Title here', 'A description long enough.',
    'product', 'widgets', 'zy', 'XNO', 'ZY', null, null, null, null)),
  'invalid', 'a currency that is not enabled for pricing is refused');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'bad-country', 'Title here', 'A description long enough.',
    'product', 'widgets', 'zy', 'XTT', 'ZX', null, null, null, null)),
  'invalid', 'a country that is not marketplace-enabled is refused (D17)');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'neg-price', 'Title here', 'A description long enough.',
    'product', 'widgets', 'zy', 'XTT', 'ZY', -1, null, null, null)),
  'invalid', 'a negative price is refused');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'zero-price', 'Title here', 'A description long enough.',
    'product', 'widgets', 'zy', 'XTT', 'ZY', 0, null, null, null)),
  'created', 'a zero price is accepted: 0011 allows it');

-- Slug collisions, including the permanent-redirect case.
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000002', 'a-chair', 'Title here', 'A description long enough.',
    'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'slug_taken', 'a slug another seller holds answers slug_taken');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair', 'Title here', 'A description long enough.',
    'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'slug_taken', 'and so does one the caller already holds');
select is(
  (select count(*) from public.listings l where l.slug = 'a-chair'),
  1::bigint,
  'neither attempt created a second listing at that address');

-- ---------------------------------------------------------------------------------------------------
-- Who may create
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000006', 'no-shop-listing', 'Title here', 'A description long enough.',
    'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'not_found', 'an account with no storefront cannot create a listing');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    null, 'null-user-listing', 'Title here', 'A description long enough.',
    'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'not_found', 'nor can a caller with no id');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000004', 'suspended-sellers-listing', 'Title here',
    'A description long enough.', 'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'not_editable', 'a suspended seller receives no mutation authorization');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000005', 'closed-sellers-listing', 'Title here',
    'A description long enough.', 'product', 'widgets', 'zy', 'XTT', 'ZY', null, null, null, null)),
  'not_editable', 'and neither does a closed one');
select is(
  (select outcome from app_private.seller_listing_create_draft(
    '80000000-0000-4000-8000-000000000004', 'Bad_Slug_Too', 'ab', 'short',
    'gizmo', 'no-cat', 'qq', 'XNO', 'ZX', -1, null, null, null)),
  'not_editable',
  'a suspended seller sending nonsense still gets not_editable, so the body cannot probe the gate');
select is(
  (select count(*) from public.listings l
    where l.slug in ('no-shop-listing', 'suspended-sellers-listing', 'closed-sellers-listing')),
  0::bigint,
  'and none of those refusals wrote anything');

-- ---------------------------------------------------------------------------------------------------
-- Editing a draft
-- ---------------------------------------------------------------------------------------------------
create temporary table before_edit as
select slug, seller_user_id, listing_type_code, category_id, status, view_count, created_at,
       submitted_at, approved_at, published_at, sold_at, expires_at, archived_at, deleted_at
  from public.listings where slug = 'a-chair';

select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    true, '  Renamed Chair  ', true, '  A rather different description.  ', true, 4500, true, true,
    true, 'zz', true, 'XTT', true, 'ZY', true, 'New Governorate', true, 'Alexandria')),
  'updated',
  'a seller edits every editable field of their own draft at once');

select is((select l.title from public.listings l where l.slug = 'a-chair'), 'Renamed Chair',
  'the title changed, trimmed');
select is((select l.description from public.listings l where l.slug = 'a-chair'),
  'A rather different description.', 'the description changed');
select is((select l.price_minor from public.listings l where l.slug = 'a-chair'), 4500::bigint,
  'the price changed');
select is((select l.is_negotiable from public.listings l where l.slug = 'a-chair'), true,
  'the negotiable flag changed');
select is((select l.content_language from public.listings l where l.slug = 'a-chair'), 'zz',
  'the content language changed');
select is((select l.country_code from public.listings l where l.slug = 'a-chair'), 'ZY'::char(2),
  'the country was set');
select is((select l.governorate from public.listings l where l.slug = 'a-chair'), 'New Governorate',
  'the governorate changed');
select is((select l.city from public.listings l where l.slug = 'a-chair'), 'Alexandria',
  'the city changed');

-- The immutable columns, after that same edit.
select is((select l.slug from public.listings l where l.seller_user_id = '80000000-0000-4000-8000-000000000001'
            and l.title = 'Renamed Chair'),
  (select b.slug from before_edit b), 'the slug is unchanged: an edit cannot move a public address');
select is((select l.seller_user_id from public.listings l where l.slug = 'a-chair'),
  (select b.seller_user_id from before_edit b), 'the owner is unchanged');
select is((select l.listing_type_code from public.listings l where l.slug = 'a-chair'),
  (select b.listing_type_code from before_edit b), 'the listing type is unchanged');
select is((select l.category_id from public.listings l where l.slug = 'a-chair'),
  (select b.category_id from before_edit b), 'the category is unchanged');
select is((select l.status from public.listings l where l.slug = 'a-chair'),
  (select b.status from before_edit b), 'the status is unchanged: an edit is not a transition');
select is((select l.view_count from public.listings l where l.slug = 'a-chair'),
  (select b.view_count from before_edit b), 'the view count is unchanged');
select is((select l.created_at from public.listings l where l.slug = 'a-chair'),
  (select b.created_at from before_edit b), 'created_at is unchanged');
select is((select l.submitted_at from public.listings l where l.slug = 'a-chair'),
  (select b.submitted_at from before_edit b), 'submitted_at is unchanged');
select is((select l.approved_at from public.listings l where l.slug = 'a-chair'),
  (select b.approved_at from before_edit b), 'approved_at is unchanged: no self-approval');
select is((select l.published_at from public.listings l where l.slug = 'a-chair'),
  (select b.published_at from before_edit b), 'published_at is unchanged');
select is((select l.sold_at from public.listings l where l.slug = 'a-chair'),
  (select b.sold_at from before_edit b), 'sold_at is unchanged');
select is((select l.expires_at from public.listings l where l.slug = 'a-chair'),
  (select b.expires_at from before_edit b), 'expires_at is unchanged');
select is((select l.archived_at from public.listings l where l.slug = 'a-chair'),
  (select b.archived_at from before_edit b), 'archived_at is unchanged');
select is((select l.deleted_at from public.listings l where l.slug = 'a-chair'),
  (select b.deleted_at from before_edit b), 'deleted_at is unchanged');

-- Omitted preserves; an explicit null clears where 0011 allows it.
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    true, 'Renamed Again', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null)),
  'updated', 'an edit may touch one field');
select is((select l.description from public.listings l where l.slug = 'a-chair'),
  'A rather different description.', 'an omitted description kept its value');
select is((select l.price_minor from public.listings l where l.slug = 'a-chair'), 4500::bigint,
  'an omitted price kept its value');
select is((select l.city from public.listings l where l.slug = 'a-chair'), 'Alexandria',
  'an omitted city kept its value');
select is((select l.title from public.listings l where l.slug = 'a-chair'), 'Renamed Again',
  'and the one field that was set changed');

select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    false, null, false, null, true, null, false, null, false, null, false, null, false, null,
    true, null, true, '   ')),
  'updated', 'the three nullable columns can be cleared');
select is((select l.price_minor from public.listings l where l.slug = 'a-chair'), null::bigint,
  'the price was cleared');
select is((select l.governorate from public.listings l where l.slug = 'a-chair'), null::text,
  'the governorate was cleared');
select is((select l.city from public.listings l where l.slug = 'a-chair'), null::text,
  'and a whitespace city is stored as absent');

-- The not-null columns cannot be cleared.
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    true, null, false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null)),
  'invalid', 'the title cannot be cleared');
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    false, null, true, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null)),
  'invalid', 'nor the description');
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    false, null, false, null, false, null, false, null, true, null, false, null, false, null,
    false, null, false, null)),
  'invalid', 'nor the content language');
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    false, null, false, null, false, null, false, null, false, null, true, null, false, null,
    false, null, false, null)),
  'invalid', 'nor the currency');
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    false, null, false, null, false, null, false, null, false, null, false, null, true, null,
    false, null, false, null)),
  'invalid', 'nor the country');
select is((select l.title from public.listings l where l.slug = 'a-chair'), 'Renamed Again',
  'and none of those refusals changed anything');

-- Edit validation mirrors creation.
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    true, 'ab', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null)),
  'invalid', 'a too-short title is refused on edit too');
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    false, null, false, null, true, -5, false, null, false, null, false, null, false, null,
    false, null, false, null)),
  'invalid', 'a negative price is refused on edit');
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    false, null, false, null, false, null, false, null, true, 'qq', false, null, false, null,
    false, null, false, null)),
  'invalid', 'an unknown locale is refused on edit');
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    false, null, false, null, false, null, false, null, false, null, true, 'XNO', false, null,
    false, null, false, null)),
  'invalid', 'a disabled currency is refused on edit');
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    false, null, false, null, false, null, false, null, false, null, false, null, true, 'ZX',
    false, null, false, null)),
  'invalid', 'a non-marketplace country is refused on edit');

-- ---------------------------------------------------------------------------------------------------
-- Editing: ownership and state
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000002', 'a-chair',
    true, 'Stolen', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null)),
  'not_found',
  'another seller cannot edit this listing, and learns nothing about whether it exists');
select is((select l.title from public.listings l where l.slug = 'a-chair'), 'Renamed Again',
  'and the listing was not touched');
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'other-sellers-listing',
    true, 'Stolen', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null)),
  'not_found',
  'and the reverse: this seller cannot edit the other''s real draft');
select is((select l.title from public.listings l where l.slug = 'other-sellers-listing'),
  'Other Sellers Listing', 'which is untouched');
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'no-such-listing',
    true, 'Nothing', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null)),
  'not_found', 'a slug that does not exist answers the same way');
select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000004', 'a-chair',
    true, 'Suspended edit', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null)),
  'not_editable', 'a suspended seller cannot edit at all');

-- Every non-draft state refuses an edit.
select is(
  (select array_to_string(array_agg(t.outcome order by t.listing_slug), ',') from (
    select 'approved-listing' as listing_slug,
           (select outcome from app_private.seller_listing_update_draft(
             '80000000-0000-4000-8000-000000000001', 'approved-listing',
             true, 'x1', false, null, false, null, false, null, false, null, false, null, false, null,
             false, null, false, null)) as outcome
    union all select 'active-listing',
           (select outcome from app_private.seller_listing_update_draft(
             '80000000-0000-4000-8000-000000000001', 'active-listing',
             true, 'x2', false, null, false, null, false, null, false, null, false, null, false, null,
             false, null, false, null))
    union all select 'archived-listing',
           (select outcome from app_private.seller_listing_update_draft(
             '80000000-0000-4000-8000-000000000001', 'archived-listing',
             true, 'x3', false, null, false, null, false, null, false, null, false, null, false, null,
             false, null, false, null))
    union all select 'rejected-listing',
           (select outcome from app_private.seller_listing_update_draft(
             '80000000-0000-4000-8000-000000000001', 'rejected-listing',
             true, 'x4', false, null, false, null, false, null, false, null, false, null, false, null,
             false, null, false, null))
    union all select 'sold-listing',
           (select outcome from app_private.seller_listing_update_draft(
             '80000000-0000-4000-8000-000000000001', 'sold-listing',
             true, 'x5', false, null, false, null, false, null, false, null, false, null, false, null,
             false, null, false, null))
    union all select 'suspended-listing',
           (select outcome from app_private.seller_listing_update_draft(
             '80000000-0000-4000-8000-000000000001', 'suspended-listing',
             true, 'x6', false, null, false, null, false, null, false, null, false, null, false, null,
             false, null, false, null))
  ) t),
  'not_editable,not_editable,not_editable,not_editable,not_editable,not_editable',
  'no listing outside draft may be edited: approved, active, archived, rejected, sold and suspended all refuse');
select is(
  (select count(*) from public.listings l
    where l.title in ('x1', 'x2', 'x3', 'x4', 'x5', 'x6')),
  0::bigint,
  'and not one of those attempts wrote anything');

-- ---------------------------------------------------------------------------------------------------
-- Submission
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_listing_submit('80000000-0000-4000-8000-000000000001', 'a-chair')),
  'incomplete',
  'a product with no price cannot be submitted: approval would refuse it');
select is((select l.status from public.listings l where l.slug = 'a-chair'), 'draft',
  'and it is still a draft');

select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    false, null, false, null, true, 9900, false, null, false, null, false, null, false, null,
    false, null, false, null)),
  'updated', 'so the seller sets a price');

create temporary table submitted as
select * from app_private.seller_listing_submit('80000000-0000-4000-8000-000000000001', 'a-chair');

select is((select outcome from submitted), 'submitted', 'and submits it');
select is((select status from submitted), 'pending_review', 'the returned status is 0011''s own review state');
select is((select l.status from public.listings l where l.slug = 'a-chair'), 'pending_review',
  'the row says so too');
select ok((select l.submitted_at from public.listings l where l.slug = 'a-chair') is not null,
  'and submitted_at was recorded');
select is((select l.approved_at from public.listings l where l.slug = 'a-chair'), null::timestamptz,
  'approval is still nobody''s but a moderator''s');
select is((select l.published_at from public.listings l where l.slug = 'a-chair'), null::timestamptz,
  'nothing was published');

select is(
  (select outcome from app_private.seller_listing_update_draft(
    '80000000-0000-4000-8000-000000000001', 'a-chair',
    true, 'After submission', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null)),
  'not_editable',
  'after submission the seller can no longer edit it as a draft');
select is(
  (select outcome from app_private.seller_listing_submit('80000000-0000-4000-8000-000000000001', 'a-chair')),
  'not_editable',
  'and cannot submit it twice');
select is((select l.title from public.listings l where l.slug = 'a-chair'), 'Renamed Again',
  'so the submitted listing is exactly what was submitted');

-- A custom service may be submitted without a price; a fixed one may not.
select is(
  (select outcome from app_private.seller_listing_submit('80000000-0000-4000-8000-000000000001', 'a-service')),
  'incomplete',
  'a service with no details row states no pricing model, so it needs a price (0048''s own stance)');
insert into public.listing_service_details (listing_id, pricing_model, delivery_days)
select l.id, 'custom', null from public.listings l where l.slug = 'a-service';
select is(
  (select outcome from app_private.seller_listing_submit('80000000-0000-4000-8000-000000000001', 'a-service')),
  'submitted',
  'a custom-priced service may be submitted with no price at all');
select is((select l.price_minor from public.listings l where l.slug = 'a-service'), null::bigint,
  'and its price is still null: submission set no amount');

select is(
  (select outcome from app_private.seller_listing_submit('80000000-0000-4000-8000-000000000002', 'a-chair')),
  'not_found', 'another seller cannot submit this listing');
select is(
  (select outcome from app_private.seller_listing_submit('80000000-0000-4000-8000-000000000001', 'approved-listing')),
  'not_editable', 'an approved listing cannot be submitted');
select is(
  (select outcome from app_private.seller_listing_submit('80000000-0000-4000-8000-000000000001', 'archived-listing')),
  'not_editable', 'nor an archived one');
select is(
  (select outcome from app_private.seller_listing_submit('80000000-0000-4000-8000-000000000001', 'rejected-listing')),
  'not_editable', 'nor a rejected one: resubmission is not a 6-F transition');
select is(
  (select outcome from app_private.seller_listing_submit('80000000-0000-4000-8000-000000000004', 'a-chair')),
  'not_editable', 'a suspended seller cannot submit');
select is(
  (select outcome from app_private.seller_listing_submit('80000000-0000-4000-8000-000000000006', 'a-chair')),
  'not_found', 'an account with no storefront cannot submit');
select is(
  (select outcome from app_private.seller_listing_submit(null, 'a-chair')),
  'not_found', 'nor can a caller with no id');

-- ---------------------------------------------------------------------------------------------------
-- Archive
-- ---------------------------------------------------------------------------------------------------
create temporary table archived as
select * from app_private.seller_listing_archive('80000000-0000-4000-8000-000000000001', 'active-listing');

select is((select outcome from archived), 'archived', 'an active listing can be archived by its seller');
select is((select status from archived), 'archived', 'the returned status says so');
select is((select l.status from public.listings l where l.slug = 'active-listing'), 'archived',
  'and the row says so');
select ok((select l.archived_at from public.listings l where l.slug = 'active-listing') is not null,
  'archived_at was set, as 0011''s biconditional requires');
select is((select l.deleted_at from public.listings l where l.slug = 'active-listing'), null::timestamptz,
  'and nothing was deleted');
select is(
  (select outcome from app_private.seller_listing_archive('80000000-0000-4000-8000-000000000001', 'approved-listing')),
  'archived',
  'an approved listing can be archived too: approved and active are 0011''s live pair');

select is(
  (select outcome from app_private.seller_listing_archive('80000000-0000-4000-8000-000000000001', 'a-chair')),
  'not_editable', 'a submitted listing cannot be archived');
select is(
  (select outcome from app_private.seller_listing_archive('80000000-0000-4000-8000-000000000001', 'desc-ten')),
  'not_editable', 'nor can a draft');
select is(
  (select outcome from app_private.seller_listing_archive('80000000-0000-4000-8000-000000000001', 'sold-listing')),
  'not_editable', 'nor a sold one');
select is(
  (select outcome from app_private.seller_listing_archive('80000000-0000-4000-8000-000000000001', 'rejected-listing')),
  'not_editable', 'nor a rejected one');
select is(
  (select outcome from app_private.seller_listing_archive('80000000-0000-4000-8000-000000000001', 'suspended-listing')),
  'not_editable', 'nor a suspended one: a seller cannot archive their way out of moderation');
select is(
  (select outcome from app_private.seller_listing_archive('80000000-0000-4000-8000-000000000001', 'archived-listing')),
  'not_editable', 'and an already-archived listing is not archived twice');
select is(
  (select outcome from app_private.seller_listing_archive('80000000-0000-4000-8000-000000000002', 'archived-listing')),
  'not_found', 'another seller cannot archive this listing');
select is(
  (select outcome from app_private.seller_listing_archive('80000000-0000-4000-8000-000000000004', 'active-listing')),
  'not_editable', 'a suspended seller cannot archive');
select is(
  (select l.status from public.listings l where l.slug = 'suspended-listing'), 'suspended',
  'the suspended listing is still suspended');
select is(
  (select l.status from public.listings l where l.slug = 'sold-listing'), 'sold',
  'and the sold one still sold');

-- ---------------------------------------------------------------------------------------------------
-- A seller can never reach a state that is not theirs
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.listings l
    where l.seller_user_id = '80000000-0000-4000-8000-000000000001'
      and l.slug in ('a-chair', 'a-service', 'desc-ten', 'zero-price', 'unscoped-cat-listing')
      and l.status not in ('draft', 'pending_review')),
  0::bigint,
  'every listing this migration created is a draft or a submission: never approved, active or verified');
select is(
  (select count(*) from public.listings l where l.approved_at is not null and l.slug in ('a-chair', 'a-service')),
  0::bigint,
  'no listing created here carries an approval time');
select is(
  (select count(*) from public.listing_moderation_actions),
  0::bigint,
  'no moderation action was created: 6-F moderates nothing');
select is(
  (select count(*) from public.listings l where l.status = 'deleted' and l.slug <> 'deleted-listing'),
  0::bigint,
  'nothing was deleted: there is no seller-side delete');
select is(
  (select count(*) from public.user_roles),
  0::bigint,
  'and no role was assigned');

-- The deleted fixture is invisible to the seller's own readback.
select is(
  (select count(*) from app_private.seller_listings('80000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'deleted-listing'),
  0::bigint,
  'a deleted listing is not listed at all');

-- ---------------------------------------------------------------------------------------------------
-- The readback
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from app_private.seller_listings('80000000-0000-4000-8000-000000000001', 50, null, null)) > 0,
  'the seller sees their own listings');
select is(
  (select count(*) from app_private.seller_listings('80000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'other-sellers-listing'),
  0::bigint,
  'and none of anybody else''s');
select is(
  (select count(*) from app_private.seller_listings('80000000-0000-4000-8000-000000000002', 50, null, null)),
  1::bigint,
  'the other seller sees exactly their own one');
select is(
  (select r.status from app_private.seller_listings('80000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'a-chair'),
  'pending_review',
  'the readback reports the real status');
select is(
  (select r.category_slug from app_private.seller_listings('80000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'a-chair'),
  'widgets',
  'and names the category by its public slug, not by an identifier');
select is(
  (select r.media_count from app_private.seller_listings('80000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'a-chair'),
  0,
  'and counts media without disclosing any object path');
select is(
  (select count(*) from app_private.seller_listings('80000000-0000-4000-8000-000000000001', 2, null, null)),
  2::bigint,
  'the page size is honoured');
select is(
  (select count(*) from app_private.seller_listings('80000000-0000-4000-8000-000000000001', 500, null, null)),
  (select count(*) from public.listings l
    where l.seller_user_id = '80000000-0000-4000-8000-000000000001' and l.status <> 'deleted'),
  'an oversized page size is clamped and still returns every listing the seller has');
select is(
  (select count(*) from app_private.seller_listings('80000000-0000-4000-8000-000000000006', 50, null, null)),
  0::bigint,
  'an account with no storefront sees nothing');
select is(
  (select count(*) from app_private.seller_listings(null, 50, null, null)),
  0::bigint,
  'and a caller with no id sees nothing');

-- Keyset pagination walks the whole list without repeating or skipping.
select is(
  (with first_page as (
     select r.created_at, r.slug
       from app_private.seller_listings('80000000-0000-4000-8000-000000000001', 3, null, null) r
      order by r.created_at desc, r.slug desc
   ),
   cursor_row as (select created_at, slug from first_page order by created_at, slug limit 1),
   second_page as (
     select r.slug from app_private.seller_listings(
       '80000000-0000-4000-8000-000000000001', 50,
       (select created_at from cursor_row), (select slug from cursor_row)) r
   )
   select count(*) from second_page s
    where s.slug in (select slug from first_page)),
  0::bigint,
  'the second page never repeats a row from the first');

-- ---------------------------------------------------------------------------------------------------
-- Audit: 0011's status-history trigger, untouched
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from public.listing_status_history h
    where h.id > (select m.id from audit_mark m) and h.to_status = 'draft') > 0,
  'creating a draft writes a status-history row, from 0011''s own trigger');
select ok(
  (select count(*) from public.listing_status_history h
    join public.listings l on l.id = h.listing_id
    where h.id > (select m.id from audit_mark m)
      and l.slug = 'a-chair' and h.from_status = 'draft' and h.to_status = 'pending_review') = 1,
  'submitting writes the draft to pending_review transition');
select ok(
  (select count(*) from public.listing_status_history h
    join public.listings l on l.id = h.listing_id
    where h.id > (select m.id from audit_mark m)
      and l.slug = 'active-listing' and h.from_status = 'active' and h.to_status = 'archived') = 1,
  'archiving writes the active to archived transition');
select is(
  (select count(*) from public.listing_status_history h
    where h.id > (select m.id from audit_mark m)
      and h.to_status in ('approved', 'rejected', 'suspended', 'deleted', 'sold', 'expired')),
  0::bigint,
  'and no transition into a moderation or lifecycle state anybody but a moderator owns');
select is(
  (select count(*) from public.listing_status_history h
    join public.listings l on l.id = h.listing_id
    where h.id > (select m.id from audit_mark m) and l.title in ('x1', 'x2', 'x3', 'x4', 'x5', 'x6')),
  0::bigint,
  'a refused mutation leaves no history behind: the trail records changes, not attempts');
select throws_ok(
  $$ update public.listing_status_history set to_status = 'approved'
      where id = (select min(h.id) from public.listing_status_history h) $$,
  '23001',
  null,
  'the status history is still append-only: not even a superuser rewrites a recorded transition');

-- ---------------------------------------------------------------------------------------------------
-- The public surfaces are untouched
-- ---------------------------------------------------------------------------------------------------
select is(
  (select r.outcome from app_private.public_listing_by_slug('a-chair', 'en') r),
  'not_found',
  'a submitted listing is not publicly visible: 0046 is unchanged');
-- Archiving is not a deletion, and 0011 says so: the page an archived listing had stays reachable and says
-- it is no longer available. 6-F changed nothing about that, which is exactly why there is no seller delete.
select is(
  (select r.outcome from app_private.public_listing_by_slug('active-listing', 'en') r),
  'found',
  'the listing this migration archived is still publicly reachable, as 0011 intends');
select is(
  (select r.availability from app_private.public_listing_by_slug('active-listing', 'en') r),
  'no_longer_available',
  'and the public page reports it as no longer available rather than for sale');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_listing_by_slug'
      and pg_get_function_result(p.oid) like '%seller_user_id%'),
  0::bigint,
  'the public reader still returns no seller_user_id column: 0046 is untouched');
select ok(
  public.listing_status_is_public('archived'),
  '0011''s own visibility rule for archived is unchanged: the page stays reachable and says "no longer available"');
select ok(
  not public.listing_status_is_purchasable('archived'),
  'and it is not purchasable');

select * from finish();
rollback;
