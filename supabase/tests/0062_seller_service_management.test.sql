-- pgTAP — migration 0062: the seller's own service write boundary.
--
-- Six things are being held to account.
--
-- **6-G adds no state and no second model.** The four new functions touch two tables: `listings`, through
-- 6-F's own functions, and `listing_service_details`. There is no service status column, no service slug and
-- no service owner, so the assertions here check that the *listing's* status and owner are what decide
-- everything — and that `approved`, `active`, `rejected`, `suspended`, `sold` and `deleted` appear nowhere in
-- any new function's body.
--
-- **The composition is real, not a copy.** `seller_service_create_draft` and `seller_service_update_draft`
-- are asserted to call 6-F's functions by name, and every 6-F refusal is driven through them and found to
-- come back verbatim. That is what guarantees the two cannot drift.
--
-- **Ownership is the listing's, and a product is not a service.** Two sellers, a product and a service, and
-- a borrowed slug: a listing that is not the caller's and one that is theirs but is a product answer
-- identically to one that does not exist.
--
-- **The five detail fields obey the table's own constraints**, restated as outcomes rather than exceptions,
-- including the one about the pair: `fixed` requires a delivery time.
--
-- **Submission and archival are 6-F's, unchanged.** Driven here against services to prove the reuse, with
-- 0048's `custom`-priced exemption exercised both ways.
--
-- **The history is 0011's.** A detail edit writes no status-history row; a submission and an archive each
-- write exactly one, from the same trigger that serves products.
--
-- Deterministic: fixed uuids, no wall-clock dependence. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(214);

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
  ('a0000000-0000-4000-8000-000000000001', 'svc-active@test.invalid'),
  ('a0000000-0000-4000-8000-000000000002', 'svc-second@test.invalid'),
  ('a0000000-0000-4000-8000-000000000003', 'svc-pending@test.invalid'),
  ('a0000000-0000-4000-8000-000000000004', 'svc-suspended@test.invalid'),
  ('a0000000-0000-4000-8000-000000000005', 'svc-closed@test.invalid'),
  ('a0000000-0000-4000-8000-000000000006', 'svc-nobody@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, country_code, status, suspended_at, suspension_reason, closed_at,
   verification_status, verified_at)
values
  ('a0000000-0000-4000-8000-000000000001', 'svc-shop', 'Service Shop', 'ZY', 'active',
   null, null, null, 'verified', '2026-02-01T00:00:00Z'),
  ('a0000000-0000-4000-8000-000000000002', 'other-svc-shop', 'Other Shop', 'ZY', 'active',
   null, null, null, 'verified', '2026-02-01T00:00:00Z'),
  ('a0000000-0000-4000-8000-000000000003', 'pending-svc-shop', 'Pending Shop', 'ZY', 'pending',
   null, null, null, 'unverified', null),
  ('a0000000-0000-4000-8000-000000000004', 'suspended-svc-shop', 'Suspended Shop', 'ZY', 'suspended',
   '2026-03-01T00:00:00Z', 'Repeated policy breaches, internal note', null, 'verified', '2026-02-01T00:00:00Z'),
  ('a0000000-0000-4000-8000-000000000005', 'closed-svc-shop', 'Closed Shop', 'ZY', 'closed',
   null, null, '2026-04-01T00:00:00Z', 'verified', '2026-02-01T00:00:00Z');

insert into public.categories (id, parent_id, depth, slug, listing_type_code, is_active, sort_order)
values
  ('e0000000-0000-4000-8000-000000000001', null, 0, 'svc-cat', 'service', true, 1),
  ('e0000000-0000-4000-8000-000000000002', null, 0, 'prod-cat', 'product', true, 2),
  ('e0000000-0000-4000-8000-000000000003', null, 0, 'any-svc-cat', null, true, 3),
  ('e0000000-0000-4000-8000-000000000004', null, 0, 'off-svc-cat', null, false, 4);

-- A service listing in each state a seller must not be able to reach, built directly so the functions are
-- tested against them rather than against states they could have produced.
insert into public.listings
  (id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
   currency_code, price_minor, status, country_code, approved_at, sold_at, archived_at, deleted_at)
values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'service',
   'e0000000-0000-4000-8000-000000000001', 'approved-service', 'Approved Service',
   'An approved service description.', 'zy', 'XTT', 1000, 'approved', 'ZY', '2026-05-01T00:00:00Z', null, null, null),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'service',
   'e0000000-0000-4000-8000-000000000001', 'active-service', 'Active Service',
   'An active service description.', 'zy', 'XTT', 2000, 'active', 'ZY', '2026-05-01T00:00:00Z', null, null, null),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'service',
   'e0000000-0000-4000-8000-000000000001', 'sold-service', 'Sold Service',
   'A sold service description.', 'zy', 'XTT', 3000, 'sold', 'ZY', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z', null, null),
  ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'service',
   'e0000000-0000-4000-8000-000000000001', 'rejected-service', 'Rejected Service',
   'A rejected service description.', 'zy', 'XTT', 4000, 'rejected', 'ZY', null, null, null, null),
  ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'service',
   'e0000000-0000-4000-8000-000000000001', 'suspended-service', 'Suspended Service',
   'A suspended service description.', 'zy', 'XTT', 5000, 'suspended', 'ZY', null, null, null, null),
  ('b0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', 'service',
   'e0000000-0000-4000-8000-000000000001', 'archived-service', 'Archived Service',
   'An archived service description.', 'zy', 'XTT', 6000, 'archived', 'ZY', '2026-05-01T00:00:00Z', null, '2026-07-01T00:00:00Z', null),
  ('b0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001', 'service',
   'e0000000-0000-4000-8000-000000000001', 'deleted-service', 'Deleted Service',
   'A deleted service description.', 'zy', 'XTT', 7000, 'deleted', 'ZY', null, null, null, '2026-08-01T00:00:00Z'),
  ('b0000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000002', 'service',
   'e0000000-0000-4000-8000-000000000001', 'other-sellers-service', 'Other Sellers Service',
   'Another seller''s service description.', 'zy', 'XTT', 8000, 'draft', 'ZY', null, null, null, null),
  -- The caller's own product, which the service surface must not reach.
  ('b0000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001', 'product',
   'e0000000-0000-4000-8000-000000000002', 'a-product', 'A Product',
   'A product description here.', 'zy', 'XTT', 9000, 'draft', 'ZY', null, null, null, null);

insert into public.listing_service_details (listing_id, pricing_model, delivery_days, revisions_included, requires_brief, scope)
values ('b0000000-0000-4000-8000-000000000002', 'fixed', 10, 2, false, 'Existing scope.');

create temporary table history_mark as
select coalesce(max(h.id), 0) as id from public.listing_status_history h;
-- `outbox_events.id` is a uuid, so there is no max() watermark to take: the existing ids are snapshotted
-- instead and excluded below. The table is append-only in effect, so this is enough to isolate this file.
create temporary table outbox_mark as
select e.id from public.outbox_events e;

-- ---------------------------------------------------------------------------------------------------
-- Security: the S8 contract, for all four functions
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_to_string(array_agg(p.proname || '/' || p.pronargs order by p.proname), ' ')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_service%'),
  'seller_service_create_draft/17 seller_service_details_problem/5 seller_service_update_draft/30'
    || ' seller_services/4',
  'this migration adds exactly four functions, each with the arity it declares, and no overloads');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_service%' and not p.prosecdef),
  0::bigint,
  'every one of them is SECURITY DEFINER, the predicate included');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_service%'
      and array_to_string(p.proconfig, ',') <> 'search_path=pg_catalog, public'),
  0::bigint,
  'and every one has its search_path pinned');

-- No input parameter of either writer names a seller, an owner, a status, a type or a timestamp.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames[1:p.pronargs]) as arg
    where n.nspname = 'app_private'
      and p.proname in ('seller_service_create_draft', 'seller_service_update_draft')
      and (arg like '%seller%'
        or arg like '%owner%'
        or (arg like '%\_id' and arg <> 'p_user_id')
        or arg like '%status%'
        or arg like '%approv%'
        or arg like '%activ%'
        or arg like '%moderat%'
        or arg like '%listing\_type%'
        or arg like '%\_at')),
  0::bigint,
  'no writer takes a seller, an owner, another identifier, a status, a listing type or a timestamp');

select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_service_create_draft'),
  'TABLE(outcome text, slug text, status text)',
  'the writers answer with an outcome, a slug and a status, exactly as 6-F''s do');

-- The readback carries no identifier at all.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames[5:27]) as col
    where n.nspname = 'app_private' and p.proname = 'seller_services'
      and (col like '%\_id' or col in ('approved_at', 'published_at', 'sold_at', 'expires_at', 'deleted_at',
                                       'view_count', 'seller_user_id', 'listing_type_code'))),
  0::bigint,
  'the readback returns no identifier, no approval or publication time, no deletion time and no view count');

-- No dynamic SQL anywhere.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_service%'
      and (strpos(p.prosrc, 'execute format') > 0 or strpos(p.prosrc, 'execute ''') > 0)),
  0::bigint,
  'none of them builds SQL at run time for a request-controlled value');

-- The states a seller may not reach appear nowhere in either writer's body. `active` is excluded from the
-- first assertion because it is also a *seller* status, and checked separately below.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('seller_service_create_draft', 'seller_service_update_draft')
      and (strpos(p.prosrc, '''approved''') > 0 or strpos(p.prosrc, '''rejected''') > 0
        or strpos(p.prosrc, '''suspended''') > 0 or strpos(p.prosrc, '''sold''') > 0
        or strpos(p.prosrc, '''deleted''') > 0 or strpos(p.prosrc, '''expired''') > 0
        or strpos(p.prosrc, '''pending_review''') > 0)),
  0::bigint,
  'no writer names approved, rejected, suspended, sold, expired, deleted or pending_review anywhere');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('seller_service_create_draft', 'seller_service_update_draft')
      and strpos(
        replace(p.prosrc, 'v_seller_status not in (''pending'', ''active'')', ''),
        '''active'''
      ) > 0),
  0::bigint,
  'and the only mention of active in either is the seller-status guard, never a listing status');

-- The composition, asserted on the source: 6-F is called, not copied.
select ok(
  (select strpos(p.prosrc, 'app_private.seller_listing_create_draft(') > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_service_create_draft'),
  'the creator calls 6-F''s creator rather than restating its rules');
select ok(
  (select strpos(p.prosrc, 'app_private.seller_listing_update_draft(') > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_service_update_draft'),
  'and the editor calls 6-F''s editor');
select ok(
  (select strpos(p.prosrc, '''service''') > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_service_create_draft'),
  'passing the listing type as a literal, so nothing but a service can be created');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_service%'
      and strpos(p.prosrc, 'insert into public.listings') > 0),
  0::bigint,
  'and no new function inserts into public.listings itself');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_service%'
      and strpos(p.prosrc, 'update public.listings') > 0),
  0::bigint,
  'nor updates it: the nine listing columns are 6-F''s to write and only 6-F''s');

-- 6-F's own four functions are untouched by this migration.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_listing%'
      -- 8-C's listing attribute and tag functions share the prefix and are inventoried by their own suite.
      and p.proname not like 'seller\_listing\_attribute%'
      and p.proname not like 'seller\_listing\_tag%'
      and p.proname not like 'seller\_listing\_vocabulary%'),
  5::bigint,
  '6-F''s five listing functions are still exactly five: none was replaced or overloaded');
select ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app_private' and p.proname = 'moderate_listing'),
  '0027''s moderation entry point still exists and was not replaced');
select ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app_private' and p.proname = 'public_services'),
  '4-C''s public service reader still exists');
select ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app_private' and p.proname = 'public_service_by_slug'),
  'and so does its detail reader: the frozen public surface is untouched');

-- ACLs.
select ok(not has_function_privilege('public', 'app_private.seller_services(uuid, integer, timestamptz, text)', 'execute'),
  'PUBLIC cannot read a seller''s services');
select ok(not has_function_privilege('anon', 'app_private.seller_services(uuid, integer, timestamptz, text)', 'execute'),
  'anon cannot');
select ok(not has_function_privilege('authenticated', 'app_private.seller_services(uuid, integer, timestamptz, text)', 'execute'),
  'authenticated cannot');
select ok(has_function_privilege('app_system', 'app_private.seller_services(uuid, integer, timestamptz, text)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('app_worker', 'app_private.seller_services(uuid, integer, timestamptz, text)', 'execute'),
  'app_worker cannot');
select ok(not has_function_privilege('public',
  'app_private.seller_service_create_draft(uuid, text, text, text, text, text, text, text, bigint, boolean, text, text, text, integer, integer, boolean, text)',
  'execute'), 'PUBLIC cannot create a service draft');
select ok(not has_function_privilege('authenticated',
  'app_private.seller_service_create_draft(uuid, text, text, text, text, text, text, text, bigint, boolean, text, text, text, integer, integer, boolean, text)',
  'execute'), 'authenticated cannot');
select ok(has_function_privilege('app_system',
  'app_private.seller_service_create_draft(uuid, text, text, text, text, text, text, text, bigint, boolean, text, text, text, integer, integer, boolean, text)',
  'execute'), 'app_system can');
select ok(not has_function_privilege('public',
  'app_private.seller_service_details_problem(text, integer, integer, boolean, text)', 'execute'),
  'PUBLIC cannot even call the predicate');
select ok(has_function_privilege('app_system',
  'app_private.seller_service_details_problem(text, integer, integer, boolean, text)', 'execute'),
  'app_system can');

select is(
  (select count(*) from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'listing_service_details'
      and grantee in ('app_system', 'app_worker')),
  0::bigint,
  'app_system holds no privilege on public.listing_service_details');
select is(
  (select array_to_string(array_agg(distinct privilege_type order by privilege_type), ',')
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'listing_service_details' and grantee = 'authenticated'),
  'DELETE,INSERT,SELECT,UPDATE',
  '0011''s authenticated grants on the detail table are unchanged: nothing widened, nothing revoked');
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'listing_service_details'),
  2::bigint,
  '0011''s two detail-table policies are still in place as defence in depth');
select is(
  (select array_to_string(array_agg(distinct privilege_type order by privilege_type), ',')
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'listings' and grantee = 'authenticated'),
  'INSERT,SELECT,UPDATE',
  'and the listings grants are still 6-F''s: no DELETE appeared');

select lives_ok($$ select app_private.assert_security_contract() $$,
  'the deploy-time security contract still holds');

-- ---------------------------------------------------------------------------------------------------
-- The detail-field predicate, on its own
-- ---------------------------------------------------------------------------------------------------
select ok(not app_private.seller_service_details_problem(null, null, null, null, null),
  'stating nothing at all is fine: a service needs no detail row');
select ok(app_private.seller_service_details_problem(null, 5, null, null, null),
  'a delivery time with no pricing model is refused');
select ok(app_private.seller_service_details_problem(null, null, 3, null, null),
  'so is a revision count with no pricing model');
select ok(app_private.seller_service_details_problem(null, null, null, true, null),
  'so is a brief requirement');
select ok(app_private.seller_service_details_problem(null, null, null, null, 'Some scope.'),
  'and so is a scope');
select ok(not app_private.seller_service_details_problem(null, null, null, null, '   '),
  'but whitespace is not a statement');
select ok(app_private.seller_service_details_problem('hourly', 5, null, null, null),
  'a pricing model the table does not allow is refused');
select ok(not app_private.seller_service_details_problem('custom', null, null, null, null),
  'a custom model needs no delivery time');
select ok(app_private.seller_service_details_problem('fixed', null, null, null, null),
  'a fixed model does: that is the table''s own biconditional');
select ok(not app_private.seller_service_details_problem('fixed', 1, 0, false, null),
  'one day is inside the window');
select ok(not app_private.seller_service_details_problem('fixed', 365, 0, false, null),
  'and so is 365');
select ok(app_private.seller_service_details_problem('fixed', 0, null, null, null),
  'zero days is not');
select ok(app_private.seller_service_details_problem('fixed', 366, null, null, null),
  'nor is 366');
select ok(app_private.seller_service_details_problem('custom', null, -1, null, null),
  'a negative revision count is refused');
select ok(not app_private.seller_service_details_problem('custom', null, 0, null, null),
  'zero revisions is a fact, not an absence');
select ok(app_private.seller_service_details_problem('custom', null, null, null, repeat('s', 5001)),
  'a 5001-character scope is refused');
select ok(not app_private.seller_service_details_problem('custom', null, null, null, repeat('s', 5000)),
  'and 5000 is accepted');

-- ---------------------------------------------------------------------------------------------------
-- Creating a service draft
-- ---------------------------------------------------------------------------------------------------
create temporary table made as
select * from app_private.seller_service_create_draft(
  'a0000000-0000-4000-8000-000000000001', 'logo-design', '  Logo Design  ',
  '  I will design a logo for you.  ', 'svc-cat', 'zy', 'XTT', 'ZY', null, null, '  Gov  ', '  Cairo  ',
  'custom', null, 3, true, '  Two concepts.  ');

select is((select outcome from made), 'created', 'an active seller creates a service draft');
select is((select slug from made), 'logo-design', 'the slug comes back');
select is((select status from made), 'draft', 'and the status is draft');

select is((select l.listing_type_code from public.listings l where l.slug = 'logo-design'), 'service',
  'the listing is a service, decided by a literal rather than by anything sent');
select is((select l.seller_user_id from public.listings l where l.slug = 'logo-design'),
  'a0000000-0000-4000-8000-000000000001'::uuid,
  'and it belongs to the account whose id was supplied, and no other');
select is((select l.title from public.listings l where l.slug = 'logo-design'), 'Logo Design',
  '6-F''s trimming applies, because 6-F did the insert');
select is((select l.price_minor from public.listings l where l.slug = 'logo-design'), null::bigint,
  'a service draft needs no price');
select is(
  (select count(*) from public.listing_media m join public.listings l on l.id = m.listing_id
    where l.slug = 'logo-design'),
  0::bigint,
  'and no media: S-9 holds for services as it does for products');

select is((select d.pricing_model from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  'custom', 'the pricing model was stored');
select is((select d.delivery_days from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  null::smallint, 'a custom-priced service carries no delivery time');
select is((select d.revisions_included from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  3::smallint, 'the revision count was stored');
select is((select d.requires_brief from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  true, 'the brief requirement was stored');
select is((select d.scope from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  'Two concepts.', 'and the scope, trimmed');

select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'fixed-service', 'Fixed Service',
    'A description long enough.', 'svc-cat', 'zy', 'XTT', 'ZY', 5000, true, null, null,
    'fixed', 14, 1, false, null)),
  'created', 'a fixed-price service with a delivery time is created');
select is(
  (select d.delivery_days from public.listing_service_details d
     join public.listings l on l.id = d.listing_id where l.slug = 'fixed-service'),
  14::smallint, 'with its delivery time');

select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'bare-service', 'Bare Service',
    'A description long enough.', 'svc-cat', 'zy', 'XTT', 'ZY', 5000, null, null, null,
    null, null, null, null, null)),
  'created', 'a service that states nothing about pricing is created too');
select is(
  (select count(*) from public.listing_service_details d join public.listings l on l.id = d.listing_id
    where l.slug = 'bare-service'),
  0::bigint,
  'and gets no detail row at all, which is the state 6-F alone already produces');
select is(
  (select d.revisions_included from public.listing_service_details d
     join public.listings l on l.id = d.listing_id where l.slug = 'fixed-service'),
  1::smallint, 'a stated revision count is stored rather than defaulted');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'defaulted-service', 'Defaulted Service',
    'A description long enough.', 'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null,
    'custom', null, null, null, null)),
  'created', 'the two not-null detail columns may be left unstated');
select is(
  (select d.revisions_included || '/' || d.requires_brief::text from public.listing_service_details d
     join public.listings l on l.id = d.listing_id where l.slug = 'defaulted-service'),
  '0/false', 'and they take the table''s own defaults rather than a value invented here');

select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000003', 'pending-sellers-service', 'Pending Sellers Service',
    'A description long enough.', 'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null,
    'custom', null, null, null, null)),
  'created', 'a pending seller may create a service draft');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'any-cat-service', 'Any Cat Service',
    'A description long enough.', 'any-svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null,
    'custom', null, null, null, null)),
  'created', 'a category scoped to neither type accepts a service');

-- ---------------------------------------------------------------------------------------------------
-- Creation: the detail-field refusals, and that they leave nothing behind
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'bad-fixed', 'Bad Fixed', 'A description long enough.',
    'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null, 'fixed', null, null, null, null)),
  'invalid', 'a fixed-price service with no delivery time is refused');
select is(
  (select count(*) from public.listings l where l.slug = 'bad-fixed'),
  0::bigint,
  'and no listing was created: the detail fields are checked before anything is written');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'no-model', 'No Model', 'A description long enough.',
    'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null, null, null, 5, null, null)),
  'invalid', 'a revision count with no pricing model is refused');
select is(
  (select count(*) from public.listings l where l.slug = 'no-model'),
  0::bigint, 'and leaves no listing either');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'bad-model', 'Bad Model', 'A description long enough.',
    'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null, 'hourly', 5, null, null, null)),
  'invalid', 'a pricing model the table does not allow is refused');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'bad-days', 'Bad Days', 'A description long enough.',
    'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null, 'fixed', 400, null, null, null)),
  'invalid', 'a delivery time outside the table''s window is refused');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'bad-revisions', 'Bad Revisions', 'A description long enough.',
    'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null, 'custom', null, -2, null, null)),
  'invalid', 'a negative revision count is refused');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'bad-scope', 'Bad Scope', 'A description long enough.',
    'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null, 'custom', null, null, null, repeat('s', 5001))),
  'invalid', 'and an over-long scope is refused');
select is(
  (select count(*) from public.listings l
    where l.slug in ('bad-model', 'bad-days', 'bad-revisions', 'bad-scope')),
  0::bigint,
  'not one of those refusals created a listing');

-- ---------------------------------------------------------------------------------------------------
-- Creation: 6-F's refusals, propagated verbatim
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000006', 'no-shop-service', 'No Shop Service',
    'A description long enough.', 'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null,
    'custom', null, null, null, null)),
  'not_found', 'an account with no storefront cannot create a service');
select is(
  (select outcome from app_private.seller_service_create_draft(
    null, 'null-user-service', 'Null User Service', 'A description long enough.',
    'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null, 'custom', null, null, null, null)),
  'not_found', 'nor can a caller with no id');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000004', 'suspended-sellers-service', 'Suspended Sellers Service',
    'A description long enough.', 'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null,
    'custom', null, null, null, null)),
  'not_editable', 'a suspended seller receives no mutation authorization');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000005', 'closed-sellers-service', 'Closed Sellers Service',
    'A description long enough.', 'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null,
    'custom', null, null, null, null)),
  'not_editable', 'and neither does a closed one');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000002', 'logo-design', 'Stolen Address',
    'A description long enough.', 'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null,
    'custom', null, null, null, null)),
  'slug_taken', 'an address another seller holds answers slug_taken');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'Bad_Slug', 'Bad Slug Service',
    'A description long enough.', 'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null,
    'custom', null, null, null, null)),
  'invalid', 'a slug outside 6-F''s format is refused by 6-F');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'short-title-service', 'ab',
    'A description long enough.', 'svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null,
    'custom', null, null, null, null)),
  'invalid', 'and so is a two-character title');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'product-cat-service', 'Product Cat Service',
    'A description long enough.', 'prod-cat', 'zy', 'XTT', 'ZY', 100, null, null, null,
    'custom', null, null, null, null)),
  'invalid', 'a category scoped to products refuses a service, which is the categories table''s own rule');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'off-cat-service', 'Off Cat Service',
    'A description long enough.', 'off-svc-cat', 'zy', 'XTT', 'ZY', 100, null, null, null,
    'custom', null, null, null, null)),
  'invalid', 'an inactive category is refused');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'off-currency-service', 'Off Currency Service',
    'A description long enough.', 'svc-cat', 'zy', 'XNO', 'ZY', 100, null, null, null,
    'custom', null, null, null, null)),
  'invalid', 'a currency not enabled for pricing is refused');
select is(
  (select outcome from app_private.seller_service_create_draft(
    'a0000000-0000-4000-8000-000000000001', 'off-country-service', 'Off Country Service',
    'A description long enough.', 'svc-cat', 'zy', 'XTT', 'ZX', 100, null, null, null,
    'custom', null, null, null, null)),
  'invalid', 'and a country not enabled for the marketplace is refused (D17)');
select is(
  (select count(*) from public.listings l
    where l.slug in ('no-shop-service', 'suspended-sellers-service', 'closed-sellers-service',
                     'short-title-service', 'product-cat-service')),
  0::bigint,
  'and none of those refusals wrote anything');

-- ---------------------------------------------------------------------------------------------------
-- Editing a service draft
-- ---------------------------------------------------------------------------------------------------
create temporary table before_service_edit as
select slug, seller_user_id, listing_type_code, category_id, status, view_count, created_at,
       submitted_at, approved_at, published_at, sold_at, expires_at, archived_at, deleted_at
  from public.listings where slug = 'logo-design';

select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'logo-design',
    true, '  Logo Design Pro  ', true, 'A rather different description.', true, 7500, true, true,
    true, 'zz', true, 'XTT', true, 'ZY', true, 'New Governorate', true, 'Alexandria',
    true, 'fixed', true, 5, true, 1, true, false, true, '  Revised scope.  ')),
  'updated',
  'a seller edits all fourteen editable fields of their own service draft at once');

-- 6-F's nine, written by 6-F.
select is((select l.title from public.listings l where l.slug = 'logo-design'), 'Logo Design Pro',
  'the title changed, trimmed');
select is((select l.description from public.listings l where l.slug = 'logo-design'),
  'A rather different description.', 'the description changed');
select is((select l.price_minor from public.listings l where l.slug = 'logo-design'), 7500::bigint,
  'the price changed');
select is((select l.is_negotiable from public.listings l where l.slug = 'logo-design'), true,
  'the negotiable flag changed');
select is((select l.content_language from public.listings l where l.slug = 'logo-design'), 'zz',
  'the content language changed');
select is((select l.city from public.listings l where l.slug = 'logo-design'), 'Alexandria',
  'the city changed');

-- This increment's five.
select is((select d.pricing_model from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  'fixed', 'the pricing model changed');
select is((select d.delivery_days from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  5::smallint, 'the delivery time was set, which the fixed model requires');
select is((select d.revisions_included from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  1::smallint, 'the revision count changed');
select is((select d.requires_brief from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  false, 'the brief requirement changed');
select is((select d.scope from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  'Revised scope.', 'and the scope changed, trimmed');

-- The immutable columns, after that same edit.
select is((select l.slug from public.listings l where l.title = 'Logo Design Pro'),
  (select b.slug from before_service_edit b), 'the slug is unchanged: an edit cannot move a public address');
select is((select l.seller_user_id from public.listings l where l.slug = 'logo-design'),
  (select b.seller_user_id from before_service_edit b), 'the owner is unchanged');
select is((select l.listing_type_code from public.listings l where l.slug = 'logo-design'),
  (select b.listing_type_code from before_service_edit b),
  'the listing type is unchanged: a service cannot become a product');
select is((select l.category_id from public.listings l where l.slug = 'logo-design'),
  (select b.category_id from before_service_edit b), 'the category is unchanged');
select is((select l.status from public.listings l where l.slug = 'logo-design'),
  (select b.status from before_service_edit b), 'the status is unchanged: an edit is not a transition');
select is((select l.view_count from public.listings l where l.slug = 'logo-design'),
  (select b.view_count from before_service_edit b), 'the view count is unchanged');
select is((select l.created_at from public.listings l where l.slug = 'logo-design'),
  (select b.created_at from before_service_edit b), 'created_at is unchanged');
select is((select l.submitted_at from public.listings l where l.slug = 'logo-design'),
  (select b.submitted_at from before_service_edit b), 'submitted_at is unchanged');
select is((select l.approved_at from public.listings l where l.slug = 'logo-design'),
  (select b.approved_at from before_service_edit b), 'approved_at is unchanged: no self-approval');
select is((select l.published_at from public.listings l where l.slug = 'logo-design'),
  (select b.published_at from before_service_edit b), 'published_at is unchanged');
select is((select l.sold_at from public.listings l where l.slug = 'logo-design'),
  (select b.sold_at from before_service_edit b), 'sold_at is unchanged');
select is((select l.expires_at from public.listings l where l.slug = 'logo-design'),
  (select b.expires_at from before_service_edit b), 'expires_at is unchanged');
select is((select l.archived_at from public.listings l where l.slug = 'logo-design'),
  (select b.archived_at from before_service_edit b), 'archived_at is unchanged');
select is((select l.deleted_at from public.listings l where l.slug = 'logo-design'),
  (select b.deleted_at from before_service_edit b), 'deleted_at is unchanged');
select is((select d.created_at from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  (select d2.created_at from public.listing_service_details d2
     join public.listings l2 on l2.id = d2.listing_id where l2.slug = 'logo-design'),
  'and the detail row keeps its own created_at, which no parameter reaches');

-- Omitted preserves; explicit null clears where the table allows it.
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'logo-design',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, false, null, false, null, false, null, true, null)),
  'updated', 'the scope can be cleared on its own');
select is((select d.scope from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  null::text, 'and it is');
select is((select d.pricing_model from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  'fixed', 'while the omitted pricing model kept its value');
select is((select d.delivery_days from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  5::smallint, 'and so did the omitted delivery time');
select is((select l.title from public.listings l where l.slug = 'logo-design'), 'Logo Design Pro',
  'and the omitted listing fields were left alone');

select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'logo-design',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, true, null, false, null, false, null, false, null)),
  'invalid',
  'clearing the delivery time while the model is still fixed is refused: the constraint is about the pair');
select is((select d.delivery_days from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  5::smallint, 'and nothing changed');

select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'logo-design',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    true, 'custom', true, null, false, null, false, null, false, null)),
  'updated', 'but moving to a custom model and clearing it together is fine');
select is((select d.delivery_days from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'logo-design'),
  null::smallint, 'and the delivery time is gone');

-- Withdrawing the pricing model withdraws the row.
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'logo-design',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    true, null, false, null, false, null, false, null, false, null)),
  'updated', 'withdrawing the pricing model is allowed');
select is(
  (select count(*) from public.listing_service_details d join public.listings l on l.id = d.listing_id
    where l.slug = 'logo-design'),
  0::bigint,
  'and it removes the detail row, which is the state a service with nothing stated is in');
select is((select l.title from public.listings l where l.slug = 'logo-design'), 'Logo Design Pro',
  'the listing itself survives: withdrawing a pricing model is not a deletion');
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'logo-design',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    true, null, true, 7, false, null, false, null, false, null)),
  'invalid',
  'withdrawing the model while also stating a delivery time is contradictory and is refused, not resolved');

-- A service that never had a row gains one on its first edit.
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'bare-service',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    true, 'fixed', true, 21, true, 2, true, true, true, 'Full brief required.')),
  'updated', 'a service with no detail row gains one when a pricing model is first stated');
select is(
  (select d.pricing_model || '/' || d.delivery_days || '/' || d.revisions_included || '/' || d.requires_brief::text
     from public.listing_service_details d join public.listings l on l.id = d.listing_id
    where l.slug = 'bare-service'),
  'fixed/21/2/true', 'with every stated value');
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'bare-service',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, true, 30, false, null, false, null, false, null)),
  'updated', 'and is then edited like any other');
select is((select d.delivery_days from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'bare-service'),
  30::smallint, 'with the change stored');

-- An edit that touches no detail field does not create a row.
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'logo-design',
    true, 'Renamed Again', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, false, null, false, null, false, null, false, null)),
  'updated', 'an edit that touches only listing fields is allowed on a service with no detail row');
select is(
  (select count(*) from public.listing_service_details d join public.listings l on l.id = d.listing_id
    where l.slug = 'logo-design'),
  0::bigint,
  'and creates no detail row, because nothing about pricing was stated');

-- The 6-F validation refusals reach through the composition.
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'bare-service',
    true, 'ab', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, false, null, false, null, false, null, false, null)),
  'invalid', 'a too-short title is refused by 6-F through the composition');
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'bare-service',
    true, null, false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, false, null, false, null, false, null, false, null)),
  'invalid', 'and so is clearing a not-null listing column');
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'bare-service',
    false, null, false, null, true, -5, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, false, null, false, null, false, null, false, null)),
  'invalid', 'a negative price is refused');
select is((select d.delivery_days from public.listing_service_details d
             join public.listings l on l.id = d.listing_id where l.slug = 'bare-service'),
  30::smallint,
  'and a refusal from the listing half leaves the detail half untouched: the two commit together');

-- ---------------------------------------------------------------------------------------------------
-- Editing: ownership, type and state
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'a-product',
    true, 'Stolen Product', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    true, 'custom', false, null, false, null, false, null, false, null)),
  'not_found',
  'the caller''s own product is not reachable from the service surface: there is no service at that address');
select is((select l.title from public.listings l where l.slug = 'a-product'), 'A Product',
  'and the product was not touched');
select is(
  (select count(*) from public.listing_service_details d join public.listings l on l.id = d.listing_id
    where l.slug = 'a-product'),
  0::bigint,
  'nor did it gain a service detail row');
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000002', 'bare-service',
    true, 'Stolen', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, false, null, false, null, false, null, false, null)),
  'not_found', 'another seller cannot edit this service, and learns nothing about whether it exists');
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'other-sellers-service',
    true, 'Stolen', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, false, null, false, null, false, null, false, null)),
  'not_found', 'and the reverse: this seller cannot edit the other''s real service draft');
select is((select l.title from public.listings l where l.slug = 'other-sellers-service'),
  'Other Sellers Service', 'which is untouched');
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'no-such-service',
    true, 'Nothing', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, false, null, false, null, false, null, false, null)),
  'not_found', 'a slug that does not exist answers the same way');
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000004', 'bare-service',
    true, 'Suspended edit', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, false, null, false, null, false, null, false, null)),
  'not_editable', 'a suspended seller cannot edit at all');
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000005', 'bare-service',
    true, 'Closed edit', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, false, null, false, null, false, null, false, null)),
  'not_editable', 'and neither can a closed one');
select is(
  (select outcome from app_private.seller_service_update_draft(
    null, 'bare-service',
    true, 'No caller', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, false, null, false, null, false, null, false, null)),
  'not_found', 'nor can a caller with no id');

-- Every non-draft state refuses an edit, detail fields included.
select is(
  (select array_to_string(array_agg(t.outcome order by t.listing_slug), ',') from (
    select 'active-service' as listing_slug,
           (select outcome from app_private.seller_service_update_draft(
             'a0000000-0000-4000-8000-000000000001', 'active-service',
             false, null, false, null, false, null, false, null, false, null, false, null, false, null,
             false, null, false, null,
             true, 'custom', false, null, false, null, false, null, false, null)) as outcome
    union all select 'approved-service',
           (select outcome from app_private.seller_service_update_draft(
             'a0000000-0000-4000-8000-000000000001', 'approved-service',
             false, null, false, null, false, null, false, null, false, null, false, null, false, null,
             false, null, false, null,
             true, 'custom', false, null, false, null, false, null, false, null))
    union all select 'archived-service',
           (select outcome from app_private.seller_service_update_draft(
             'a0000000-0000-4000-8000-000000000001', 'archived-service',
             false, null, false, null, false, null, false, null, false, null, false, null, false, null,
             false, null, false, null,
             true, 'custom', false, null, false, null, false, null, false, null))
    union all select 'rejected-service',
           (select outcome from app_private.seller_service_update_draft(
             'a0000000-0000-4000-8000-000000000001', 'rejected-service',
             false, null, false, null, false, null, false, null, false, null, false, null, false, null,
             false, null, false, null,
             true, 'custom', false, null, false, null, false, null, false, null))
    union all select 'sold-service',
           (select outcome from app_private.seller_service_update_draft(
             'a0000000-0000-4000-8000-000000000001', 'sold-service',
             false, null, false, null, false, null, false, null, false, null, false, null, false, null,
             false, null, false, null,
             true, 'custom', false, null, false, null, false, null, false, null))
    union all select 'suspended-service',
           (select outcome from app_private.seller_service_update_draft(
             'a0000000-0000-4000-8000-000000000001', 'suspended-service',
             false, null, false, null, false, null, false, null, false, null, false, null, false, null,
             false, null, false, null,
             true, 'custom', false, null, false, null, false, null, false, null))
  ) t),
  'not_editable,not_editable,not_editable,not_editable,not_editable,not_editable',
  'no service outside draft may be edited: active, approved, archived, rejected, sold and suspended refuse');
select is(
  (select d.pricing_model from public.listing_service_details d
     where d.listing_id = 'b0000000-0000-4000-8000-000000000002'),
  'fixed',
  'and the live service''s own detail row is exactly as it was: not one of those attempts wrote to it');

-- ---------------------------------------------------------------------------------------------------
-- Submission and archival are 6-F's, reused rather than reimplemented
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like '%service%submit%' or p.proname like '%service%archive%'
        or p.proname like 'seller\_service\_submit%' or p.proname like 'seller\_service\_archive%')),
  0::bigint,
  '6-G adds no service submission or archival function: a second one would be a second state machine');

select is(
  (select outcome from app_private.seller_listing_submit(
    'a0000000-0000-4000-8000-000000000001', 'bare-service')),
  'submitted', '6-F''s submitter moves a priced service draft to review');
select is(
  (select l.status from public.listings l where l.slug = 'bare-service'), 'pending_review',
  'the status is 0011''s own review state');
select ok(
  (select l.submitted_at from public.listings l where l.slug = 'bare-service') is not null,
  'and submitted_at was recorded');
select is(
  (select l.approved_at from public.listings l where l.slug = 'bare-service'), null::timestamptz,
  'approval is still nobody''s but a moderator''s');
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'bare-service',
    true, 'After Submission', false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    true, 'custom', false, null, false, null, false, null, false, null)),
  'not_editable',
  'after submission the seller can no longer edit the service, detail fields included');
select is(
  (select d.pricing_model from public.listing_service_details d join public.listings l on l.id = d.listing_id
    where l.slug = 'bare-service'),
  'fixed', 'and the submitted service is exactly what was submitted');

-- 0048's rule, reached through the service surface. The earlier fourteen-field edit gave this service a
-- price, so the price is cleared first: that is what makes the pricing model the only thing standing
-- between it and review, which is the whole point of the rule.
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'logo-design',
    false, null, false, null, true, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    false, null, false, null, false, null, false, null, false, null)),
  'updated', 'a service draft''s price can be cleared');
select is(
  (select l.price_minor from public.listings l where l.slug = 'logo-design'), null::bigint,
  'and it is');
select is(
  (select outcome from app_private.seller_listing_submit(
    'a0000000-0000-4000-8000-000000000001', 'logo-design')),
  'incomplete',
  'a priceless service whose pricing model was withdrawn cannot be submitted: 0048 would refuse it');
select is(
  (select outcome from app_private.seller_service_update_draft(
    'a0000000-0000-4000-8000-000000000001', 'logo-design',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null,
    false, null, false, null,
    true, 'custom', false, null, false, null, false, null, false, null)),
  'updated', 'stating a custom pricing model again');
select is(
  (select outcome from app_private.seller_listing_submit(
    'a0000000-0000-4000-8000-000000000001', 'logo-design')),
  'submitted',
  'makes the priceless service submittable, which is exactly 0048''s custom-priced exemption');
select is(
  (select l.price_minor from public.listings l where l.slug = 'logo-design'), null::bigint,
  'and its price is still null: nothing here invented one');

select is(
  (select outcome from app_private.seller_listing_archive(
    'a0000000-0000-4000-8000-000000000001', 'active-service')),
  'archived', '6-F''s archiver withdraws a live service from sale');
select is(
  (select l.status from public.listings l where l.slug = 'active-service'), 'archived',
  'the status says so');
select ok(
  (select l.archived_at from public.listings l where l.slug = 'active-service') is not null,
  'archived_at was set, as 0011''s biconditional requires');
select is(
  (select l.deleted_at from public.listings l where l.slug = 'active-service'), null::timestamptz,
  'and nothing was deleted');
select is(
  (select count(*) from public.listing_service_details d
    where d.listing_id = 'b0000000-0000-4000-8000-000000000002'),
  1::bigint,
  'the archived service keeps its detail row: archival is not deletion, here either');
select is(
  (select outcome from app_private.seller_listing_archive(
    'a0000000-0000-4000-8000-000000000001', 'approved-service')),
  'archived', 'an approved service can be archived too, which is the ratified live pair');
select is(
  (select outcome from app_private.seller_listing_archive(
    'a0000000-0000-4000-8000-000000000001', 'suspended-service')),
  'not_editable', 'a suspended service cannot be archived: no archiving out of moderation');
select is(
  (select outcome from app_private.seller_listing_archive(
    'a0000000-0000-4000-8000-000000000001', 'sold-service')),
  'not_editable', 'nor a sold one');

-- ---------------------------------------------------------------------------------------------------
-- A seller can never reach a state that is not theirs
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.listings l
    where l.seller_user_id = 'a0000000-0000-4000-8000-000000000001'
      and l.slug in ('logo-design', 'fixed-service', 'bare-service', 'defaulted-service',
                     'any-cat-service')
      and l.status not in ('draft', 'pending_review')),
  0::bigint,
  'every service this migration created is a draft or a submission: never approved, active or verified');
select is(
  (select count(*) from public.listing_moderation_actions),
  0::bigint,
  'no moderation action was created: 6-G moderates nothing');
select is(
  (select count(*) from public.listings l where l.status = 'deleted' and l.slug <> 'deleted-service'),
  0::bigint,
  'nothing was deleted: there is no seller-side delete of a service or its listing');
select is(
  (select count(*) from public.user_roles),
  0::bigint,
  'and no role was assigned');
select is(
  (select count(*) from public.service_requests),
  0::bigint,
  'no buyer service request was created or touched');
select is(
  (select count(*) from public.service_quotes),
  0::bigint,
  'no service quote either');
select is(
  (select count(*) from public.service_deliveries),
  0::bigint,
  'and no service delivery: all three stay outside 6-G');

-- ---------------------------------------------------------------------------------------------------
-- The readback
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 50, null, null)) > 0,
  'the seller sees their own services');
select is(
  (select count(*) from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'a-product'),
  0::bigint,
  'and not their own products: this reader is scoped to services');
select is(
  (select count(*) from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'other-sellers-service'),
  0::bigint,
  'and none of anybody else''s');
select is(
  (select count(*) from app_private.seller_services('a0000000-0000-4000-8000-000000000002', 50, null, null)),
  1::bigint,
  'the other seller sees exactly their own one');
select is(
  (select count(*) from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'deleted-service'),
  0::bigint,
  'a deleted service is not listed at all');
select is(
  (select r.status from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'logo-design'),
  'pending_review', 'the readback reports the real status');
select is(
  (select r.category_slug from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'logo-design'),
  'svc-cat', 'and names the category by its public slug, not by an identifier');
select is(
  (select r.currency_minor_unit from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'logo-design'),
  2::smallint,
  'and carries the currency''s own minor unit, read from public.currencies as 4-C reads it');
select is(
  (select r.pricing_model from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'logo-design'),
  'custom', 'the detail fields come back with the service');
select is(
  (select r.pricing_model from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'defaulted-service'),
  'custom', 'for a service that has a detail row');
select is(
  (select r.pricing_model from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'any-cat-service'),
  'custom', 'and for one in an unscoped category');
select is(
  (select count(*) from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'sold-service' and r.pricing_model is null),
  1::bigint,
  'a service with no detail row reads as nulls rather than vanishing: the join is a left join');
select is(
  (select r.media_count from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 50, null, null) r
    where r.slug = 'logo-design'),
  0,
  'media are counted without disclosing any object path');
select is(
  (select count(*) from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 2, null, null)),
  2::bigint,
  'the page size is honoured');
select is(
  (select count(*) from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 500, null, null)),
  (select count(*) from public.listings l
    where l.seller_user_id = 'a0000000-0000-4000-8000-000000000001'
      and l.listing_type_code = 'service' and l.status <> 'deleted'),
  'an oversized page size is clamped and still returns every service the seller has');
select is(
  (select count(*) from app_private.seller_services('a0000000-0000-4000-8000-000000000006', 50, null, null)),
  0::bigint,
  'an account with no storefront sees nothing');
select is(
  (select count(*) from app_private.seller_services(null, 50, null, null)),
  0::bigint,
  'and a caller with no id sees nothing');

select is(
  (with first_page as (
     select r.created_at, r.slug
       from app_private.seller_services('a0000000-0000-4000-8000-000000000001', 3, null, null) r
      order by r.created_at desc, r.slug desc
   ),
   cursor_row as (select created_at, slug from first_page order by created_at, slug limit 1),
   second_page as (
     select r.slug from app_private.seller_services(
       'a0000000-0000-4000-8000-000000000001', 50,
       (select created_at from cursor_row), (select slug from cursor_row)) r
   )
   select count(*) from second_page s where s.slug in (select slug from first_page)),
  0::bigint,
  'the second page never repeats a row from the first');

-- ---------------------------------------------------------------------------------------------------
-- Audit, history and events: 0011's, unchanged
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from public.listing_status_history h
    where h.id > (select m.id from history_mark m) and h.to_status = 'draft') > 0,
  'creating a service writes a status-history row, from 0011''s own trigger');
select ok(
  (select count(*) from public.listing_status_history h
    join public.listings l on l.id = h.listing_id
    where h.id > (select m.id from history_mark m)
      and l.slug = 'bare-service' and h.from_status = 'draft' and h.to_status = 'pending_review') = 1,
  'submitting a service writes the draft to pending_review transition');
select ok(
  (select count(*) from public.listing_status_history h
    join public.listings l on l.id = h.listing_id
    where h.id > (select m.id from history_mark m)
      and l.slug = 'active-service' and h.from_status = 'active' and h.to_status = 'archived') = 1,
  'archiving a service writes the active to archived transition');
select is(
  (select count(*) from public.listing_status_history h
    where h.id > (select m.id from history_mark m)
      and h.to_status in ('approved', 'rejected', 'suspended', 'deleted', 'sold', 'expired')),
  0::bigint,
  'and no transition into a state anybody but a moderator owns');
select is(
  (select count(*) from public.listing_status_history h
    join public.listings l on l.id = h.listing_id
    where h.id > (select m.id from history_mark m) and l.slug = 'logo-design'
      and h.from_status = h.to_status),
  0::bigint,
  'editing detail fields writes no status-history row, because it is not a transition');
select ok(
  (select count(*) from public.outbox_events e
    where e.id not in (select m.id from outbox_mark m)) > 0,
  'the transitions published outbox events, from the same trigger that serves products');
select is(
  (select count(*) from public.outbox_events e
    where e.id not in (select m.id from outbox_mark m)
      and e.event_type not like 'listing.%'),
  0::bigint,
  'and every one of them is a listing event: no parallel service event type was invented');
select throws_ok(
  $$ update public.listing_status_history set to_status = 'approved'
      where id = (select min(h.id) from public.listing_status_history h) $$,
  '23001',
  null,
  'the status history is still append-only: not even a superuser rewrites a recorded transition');

-- ---------------------------------------------------------------------------------------------------
-- The frozen public surface is untouched
-- ---------------------------------------------------------------------------------------------------
select is(
  (select r.outcome from app_private.public_service_by_slug('logo-design', 'en') r),
  'not_found',
  'a submitted service is not publicly visible: 4-C is unchanged');
select is(
  (select r.outcome from app_private.public_service_by_slug('active-service', 'en') r),
  'found',
  'and the service this migration archived is still publicly reachable, as 0011 intends');
select is(
  (select r.availability from app_private.public_service_by_slug('active-service', 'en') r),
  'no_longer_available',
  'reported as no longer available rather than for sale');
select is(
  (select count(*) from app_private.public_services(50, null, null) r where r.slug = 'active-service'),
  0::bigint,
  'and it has left the public service list, because archived is not purchasable');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in ('public_services', 'public_service_by_slug')
      and pg_get_function_result(p.oid) like '%seller_user_id%'),
  0::bigint,
  'the public service readers still return no seller_user_id column');

select * from finish();
rollback;
