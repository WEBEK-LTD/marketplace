-- 0089 — The public category feed, the filters, and the facets.
--
-- What is proven here, in order: the subtree is the owner-approved rollup — a level-0 category reaches its
-- grandchildren, a leaf reaches only itself, and a deactivated category takes its whole branch with it; the
-- feed admits exactly what the public surface admits and nothing else, so no filter and no rollup can reach
-- a draft, a rejected listing, an archived one or anything belonging to a seller who is not active; **a
-- filter can only narrow** — every filter is run against the same set and asserted never to add a row; a
-- value the vocabulary does not know empties the whole request rather than quietly widening it; hiding an
-- attribute, an option or a tag removes it from the filters and the facets while the seller's stored answer
-- survives; a price bound compares only inside its own currency; the facet counts are computed under the
-- same visibility and the same active filters as the result set; the cursor walks the same total order the
-- feed is ordered by; and search takes the identical filter document, because it is the same two functions.
--
-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(141);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'public_category_subtree', array['text'], 'the subtree reader exists');
select has_function('app_private', 'catalog_filters_resolve', array['jsonb'], 'the filter resolver exists');
select has_function('app_private', 'catalog_listing_matches', array['uuid', 'jsonb'], 'the filter matcher exists');
select has_function('app_private', 'public_category_feed',
  array['text', 'jsonb', 'integer', 'timestamptz', 'uuid'], 'the category feed exists');
select has_function('app_private', 'public_catalog_search',
  array['text', 'text', 'jsonb', 'integer', 'timestamptz', 'uuid'], 'the filtered search exists');
select has_function('app_private', 'public_category_facets',
  array['text', 'text', 'jsonb'], 'the facet reader exists');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('public_category_subtree', 'catalog_filters_resolve', 'catalog_listing_matches',
                        'public_category_feed', 'public_catalog_search', 'public_category_facets')
      and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog, public']),
  6, 'all six are security definer with the pinned search_path');

select ok(
  has_function_privilege('app_system', p.oid, 'execute'),
  format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('public_category_subtree', 'catalog_filters_resolve', 'catalog_listing_matches',
                     'public_category_feed', 'public_catalog_search', 'public_category_facets');

select ok(
  not has_function_privilege('public', p.oid, 'execute'),
  format('public may not execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('public_category_subtree', 'catalog_filters_resolve', 'catalog_listing_matches',
                     'public_category_feed', 'public_catalog_search', 'public_category_facets');

select ok(
  not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'),
  format('neither anon nor authenticated may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('public_category_subtree', 'catalog_filters_resolve', 'catalog_listing_matches',
                     'public_category_feed', 'public_catalog_search', 'public_category_facets');

-- The feed declares the two card projections and nothing private, exactly as 0051's reader does.
select set_eq(
  $$select a.name from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral unnest(p.proargnames, p.proargmodes) as a(name, mode)
     where n.nspname = 'app_private' and p.proname = 'public_category_feed' and a.mode = 't'$$,
  $$values ('result_type'), ('id'), ('slug'), ('title'), ('city'), ('price_minor'), ('currency_code'),
           ('currency_minor_unit'), ('is_negotiable'), ('listing_type_code'), ('pricing_model'),
           ('delivery_days'), ('revisions_included'), ('created_at')$$,
  'the feed declares the two card projections and nothing else');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     cross join lateral unnest(coalesce(p.proargnames, array[]::text[])) as col(name)
    where n.nspname = 'app_private'
      and p.proname in ('public_category_feed', 'public_catalog_search', 'public_category_facets')
      and col.name in ('seller_user_id', 'status', 'description', 'location', 'view_count',
                       'contact_email', 'contact_phone_e164', 'legal_name', 'rank', 'score')),
  0, 'no private, lifecycle, location or ranking column is declared anywhere here');

-- Nothing here ranks, promotes or caches.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('public_category_subtree', 'catalog_filters_resolve', 'catalog_listing_matches',
                        'public_category_feed', 'public_catalog_search', 'public_category_facets')
      and pg_get_functiondef(p.oid) ~* 'promotion|ranking_settings|slot_cap|similarity|ts_rank|st_distance|st_dwithin'),
  0, 'no function here reads a promotion, a ranking weight, a similarity or a distance');

-- And nothing here writes anything at all: these are readers.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('public_category_subtree', 'catalog_filters_resolve', 'catalog_listing_matches',
                        'public_category_feed', 'public_catalog_search', 'public_category_facets')
      and (p.provolatile <> 's'
           or pg_get_functiondef(p.oid) ~* '\minsert into\M|\mupdate public\M|\mdelete from\M')),
  0, 'all six are stable readers that write nothing');

-- 0051's signature is still there, and still answers.
select has_function('app_private', 'public_search',
  array['text', 'text', 'integer', 'timestamptz', 'uuid'], '0051''s unfiltered search signature is unchanged');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures: a three-level tree, a pruned branch, and listings in every state
-- ---------------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zf', 'Feed locale', 'Feed locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTF', '963', 'F', 2, true, false, true, true),
       ('XTG', '964', 'G', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZF', 'ZFZ', '995', 'Feedland', 'Feedland', '995', 'XTF', true);

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-0000000000f1', 'feed-seller@test.invalid'),
  ('a0000000-0000-4000-8000-0000000000f2', 'suspended-seller@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, country_code, status, verification_status, verified_at,
   suspended_at, suspension_reason)
values
  ('a0000000-0000-4000-8000-0000000000f1', 'feed-shop', 'Feed Shop', 'ZF', 'active', 'verified', now(),
   null, null),
  ('a0000000-0000-4000-8000-0000000000f2', 'gone-shop', 'Gone Shop', 'ZF', 'suspended', 'verified', now(),
   now(), 'Suspended for the purposes of this test');

-- Level 0 → level 1 → level 2, and a second level-1 branch that will be deactivated.
insert into public.categories (id, parent_id, slug, listing_type_code, is_active, sort_order) values
  ('c0000000-0000-4000-8000-0000000000f0', null, 'feed-electronics', null, true, 1),
  ('c0000000-0000-4000-8000-0000000000f1', 'c0000000-0000-4000-8000-0000000000f0', 'feed-phones', null, true, 1),
  ('c0000000-0000-4000-8000-0000000000f2', 'c0000000-0000-4000-8000-0000000000f1', 'feed-smartphones', null, true, 1),
  ('c0000000-0000-4000-8000-0000000000f3', 'c0000000-0000-4000-8000-0000000000f0', 'feed-audio', null, true, 2),
  ('c0000000-0000-4000-8000-0000000000f4', 'c0000000-0000-4000-8000-0000000000f3', 'feed-headphones', null, true, 1),
  ('c0000000-0000-4000-8000-0000000000f5', null, 'feed-elsewhere', null, true, 3);

insert into public.category_translations (category_id, locale_code, name) values
  ('c0000000-0000-4000-8000-0000000000f0', 'en', 'Electronics'),
  ('c0000000-0000-4000-8000-0000000000f1', 'en', 'Phones'),
  ('c0000000-0000-4000-8000-0000000000f2', 'en', 'Smartphones'),
  ('c0000000-0000-4000-8000-0000000000f3', 'en', 'Audio'),
  ('c0000000-0000-4000-8000-0000000000f4', 'en', 'Headphones'),
  ('c0000000-0000-4000-8000-0000000000f5', 'en', 'Elsewhere');

-- The vocabulary. `note` is filterable text, which must never become a facet; `colour` is filterable but
-- the category does not ask for it filterably; `era` is attached filterably but hidden.
insert into public.attribute_definitions
  (id, key, data_type, unit, name_en, name_ar, is_filterable, is_active, sort_order)
values
  ('d0000000-0000-4000-8000-0000000000f1', 'feed_material', 'single_select', null, 'Material', 'الخامة', true, true, 1),
  ('d0000000-0000-4000-8000-0000000000f2', 'feed_features', 'multi_select', null, 'Features', 'الميزات', true, true, 2),
  ('d0000000-0000-4000-8000-0000000000f3', 'feed_boxed', 'boolean', null, 'Boxed', 'في علبة', true, true, 3),
  ('d0000000-0000-4000-8000-0000000000f4', 'feed_width', 'number', 'cm', 'Width', 'العرض', true, true, 4),
  ('d0000000-0000-4000-8000-0000000000f5', 'feed_note', 'text', null, 'Note', 'ملاحظة', true, true, 5),
  ('d0000000-0000-4000-8000-0000000000f6', 'feed_colour', 'single_select', null, 'Colour', 'اللون', true, true, 6),
  ('d0000000-0000-4000-8000-0000000000f7', 'feed_era', 'single_select', null, 'Era', 'العصر', true, false, 7);

insert into public.attribute_options
  (id, attribute_definition_id, value, label_en, label_ar, sort_order, is_active)
values
  ('e0000000-0000-4000-8000-0000000000f1', 'd0000000-0000-4000-8000-0000000000f1', 'oak', 'Oak', 'بلوط', 1, true),
  ('e0000000-0000-4000-8000-0000000000f2', 'd0000000-0000-4000-8000-0000000000f1', 'pine', 'Pine', 'صنوبر', 2, true),
  ('e0000000-0000-4000-8000-0000000000f3', 'd0000000-0000-4000-8000-0000000000f1', 'teak', 'Teak', 'تيك', 3, false),
  ('e0000000-0000-4000-8000-0000000000f4', 'd0000000-0000-4000-8000-0000000000f2', 'folding', 'Folding', 'قابل للطي', 1, true),
  ('e0000000-0000-4000-8000-0000000000f5', 'd0000000-0000-4000-8000-0000000000f2', 'wireless', 'Wireless', 'لاسلكي', 2, true),
  ('e0000000-0000-4000-8000-0000000000f6', 'd0000000-0000-4000-8000-0000000000f6', 'black', 'Black', 'أسود', 1, true),
  ('e0000000-0000-4000-8000-0000000000f7', 'd0000000-0000-4000-8000-0000000000f7', 'vintage', 'Vintage', 'عتيق', 1, true);

-- The root asks for four attributes filterably, one unfilterably, and one hidden one filterably.
insert into public.category_attributes (category_id, attribute_definition_id, is_required, is_filterable, sort_order) values
  ('c0000000-0000-4000-8000-0000000000f0', 'd0000000-0000-4000-8000-0000000000f1', false, true, 1),
  ('c0000000-0000-4000-8000-0000000000f0', 'd0000000-0000-4000-8000-0000000000f2', false, true, 2),
  ('c0000000-0000-4000-8000-0000000000f0', 'd0000000-0000-4000-8000-0000000000f3', false, true, 3),
  ('c0000000-0000-4000-8000-0000000000f0', 'd0000000-0000-4000-8000-0000000000f4', false, true, 4),
  ('c0000000-0000-4000-8000-0000000000f0', 'd0000000-0000-4000-8000-0000000000f5', false, true, 5),
  ('c0000000-0000-4000-8000-0000000000f0', 'd0000000-0000-4000-8000-0000000000f6', false, false, 6),
  ('c0000000-0000-4000-8000-0000000000f0', 'd0000000-0000-4000-8000-0000000000f7', false, true, 7);

insert into public.tags (id, slug, name_en, name_ar, is_active) values
  ('f0000000-0000-4000-8000-0000000000f1', 'feed-handmade', 'Handmade', 'صناعة يدوية', true),
  ('f0000000-0000-4000-8000-0000000000f2', 'feed-rare', 'Rare', 'نادر', true),
  ('f0000000-0000-4000-8000-0000000000f3', 'feed-retired', 'Retired', 'متقاعد', false);

-- Six visible listings spread across the three levels, and five that must never be reachable.
insert into public.listings
  (id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
   currency_code, price_minor, is_negotiable, status, country_code, city, approved_at, created_at,
   sold_at, archived_at)
values
  -- At the root.
  ('11110000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000f1', 'product',
   'c0000000-0000-4000-8000-0000000000f0', 'feed-root-one', 'Root one widget',
   'A root listing described well enough.', 'en', 'XTF', 10000, true, 'active', 'ZF', 'Cairo', now(), '2026-05-01T10:00:00Z', null, null),
  -- One level down.
  ('11110000-0000-4000-8000-0000000000f2', 'a0000000-0000-4000-8000-0000000000f1', 'product',
   'c0000000-0000-4000-8000-0000000000f1', 'feed-phone-one', 'Phone one widget',
   'A phone listing described well enough.', 'en', 'XTF', 20000, false, 'active', 'ZF', 'Cairo', now(), '2026-05-02T10:00:00Z', null, null),
  -- Two levels down: the grandchild rollup case.
  ('11110000-0000-4000-8000-0000000000f3', 'a0000000-0000-4000-8000-0000000000f1', 'product',
   'c0000000-0000-4000-8000-0000000000f2', 'feed-smart-one', 'Smart one widget',
   'A smartphone listing described well enough.', 'en', 'XTF', 30000, false, 'approved', 'ZF', 'Cairo', now(), '2026-05-03T10:00:00Z', null, null),
  -- The other branch, which will be pruned by deactivating its level-1 category.
  ('11110000-0000-4000-8000-0000000000f4', 'a0000000-0000-4000-8000-0000000000f1', 'product',
   'c0000000-0000-4000-8000-0000000000f3', 'feed-audio-one', 'Audio one widget',
   'An audio listing described well enough.', 'en', 'XTF', 40000, false, 'active', 'ZF', 'Cairo', now(), '2026-05-04T10:00:00Z', null, null),
  ('11110000-0000-4000-8000-0000000000f5', 'a0000000-0000-4000-8000-0000000000f1', 'product',
   'c0000000-0000-4000-8000-0000000000f4', 'feed-head-one', 'Head one widget',
   'A headphone listing described well enough.', 'en', 'XTF', 50000, false, 'active', 'ZF', 'Cairo', now(), '2026-05-05T10:00:00Z', null, null),
  -- A service, so the mixed projection is exercised, priced in the second currency.
  ('11110000-0000-4000-8000-0000000000f6', 'a0000000-0000-4000-8000-0000000000f1', 'service',
   'c0000000-0000-4000-8000-0000000000f1', 'feed-service-one', 'Service one widget',
   'A service listing described well enough.', 'en', 'XTG', 60000, false, 'active', 'ZF', 'Cairo', now(), '2026-05-06T10:00:00Z', null, null),
  -- Never reachable: a draft, a rejected, a sold, an archived, and one of a suspended seller.
  ('11110000-0000-4000-8000-0000000000f7', 'a0000000-0000-4000-8000-0000000000f1', 'product',
   'c0000000-0000-4000-8000-0000000000f1', 'feed-draft', 'Draft widget',
   'A draft listing described well enough.', 'en', 'XTF', 70000, false, 'draft', 'ZF', 'Cairo', null, '2026-05-07T10:00:00Z', null, null),
  ('11110000-0000-4000-8000-0000000000f8', 'a0000000-0000-4000-8000-0000000000f1', 'product',
   'c0000000-0000-4000-8000-0000000000f1', 'feed-rejected', 'Rejected widget',
   'A rejected listing described well enough.', 'en', 'XTF', 80000, false, 'rejected', 'ZF', 'Cairo', null, '2026-05-08T10:00:00Z', null, null),
  ('11110000-0000-4000-8000-0000000000f9', 'a0000000-0000-4000-8000-0000000000f1', 'product',
   'c0000000-0000-4000-8000-0000000000f1', 'feed-sold', 'Sold widget',
   'A sold listing described well enough.', 'en', 'XTF', 90000, false, 'sold', 'ZF', 'Cairo', now(), '2026-05-09T10:00:00Z', now(), null),
  ('11110000-0000-4000-8000-0000000000fa', 'a0000000-0000-4000-8000-0000000000f1', 'product',
   'c0000000-0000-4000-8000-0000000000f1', 'feed-archived', 'Archived widget',
   'An archived listing described well enough.', 'en', 'XTF', 95000, false, 'archived', 'ZF', 'Cairo', now(), '2026-05-10T10:00:00Z', null, now()),
  ('11110000-0000-4000-8000-0000000000fb', 'a0000000-0000-4000-8000-0000000000f2', 'product',
   'c0000000-0000-4000-8000-0000000000f1', 'feed-hidden-seller', 'Hidden seller widget',
   'A listing of a suspended seller, described well enough.', 'en', 'XTF', 15000, false, 'active', 'ZF', 'Cairo', now(), '2026-05-11T10:00:00Z', null, null);

insert into public.listing_service_details (listing_id, pricing_model, delivery_days, revisions_included)
values ('11110000-0000-4000-8000-0000000000f6', 'fixed', 5, 2);

-- Answers. The root listing is oak, boxed, 120cm, folding+wireless, handmade. The phone is pine, not
-- boxed, 200cm, rare. The smartphone answers nothing. The hidden-seller listing is oak too, so a filter
-- that matched it would be visible as a widened result.
insert into public.listing_attribute_values
  (listing_id, attribute_definition_id, value_text, value_number, value_boolean, option_ids)
values
  ('11110000-0000-4000-8000-0000000000f1', 'd0000000-0000-4000-8000-0000000000f1', null, null, null, array['e0000000-0000-4000-8000-0000000000f1']::uuid[]),
  ('11110000-0000-4000-8000-0000000000f1', 'd0000000-0000-4000-8000-0000000000f3', null, null, true, array[]::uuid[]),
  ('11110000-0000-4000-8000-0000000000f1', 'd0000000-0000-4000-8000-0000000000f4', null, 120, null, array[]::uuid[]),
  ('11110000-0000-4000-8000-0000000000f1', 'd0000000-0000-4000-8000-0000000000f2', null, null, null, array['e0000000-0000-4000-8000-0000000000f4','e0000000-0000-4000-8000-0000000000f5']::uuid[]),
  ('11110000-0000-4000-8000-0000000000f2', 'd0000000-0000-4000-8000-0000000000f1', null, null, null, array['e0000000-0000-4000-8000-0000000000f2']::uuid[]),
  ('11110000-0000-4000-8000-0000000000f2', 'd0000000-0000-4000-8000-0000000000f3', null, null, false, array[]::uuid[]),
  ('11110000-0000-4000-8000-0000000000f2', 'd0000000-0000-4000-8000-0000000000f4', null, 200, null, array[]::uuid[]),
  ('11110000-0000-4000-8000-0000000000fb', 'd0000000-0000-4000-8000-0000000000f1', null, null, null, array['e0000000-0000-4000-8000-0000000000f1']::uuid[]),
  -- An answer on the hidden attribute, which must survive every hiding assertion below.
  ('11110000-0000-4000-8000-0000000000f1', 'd0000000-0000-4000-8000-0000000000f7', null, null, null, array['e0000000-0000-4000-8000-0000000000f7']::uuid[]);

insert into public.listing_tags (listing_id, tag_id) values
  ('11110000-0000-4000-8000-0000000000f1', 'f0000000-0000-4000-8000-0000000000f1'),
  ('11110000-0000-4000-8000-0000000000f2', 'f0000000-0000-4000-8000-0000000000f2'),
  ('11110000-0000-4000-8000-0000000000f1', 'f0000000-0000-4000-8000-0000000000f3'),
  ('11110000-0000-4000-8000-0000000000fb', 'f0000000-0000-4000-8000-0000000000f1');

-- ---------------------------------------------------------------------------------------------------
-- The subtree: the owner-approved rollup
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.public_category_subtree('feed-electronics')),
  5, 'a level-0 category covers itself and every descendant');

select is(
  (select count(*)::int from app_private.public_category_subtree('feed-phones')),
  2, 'a level-1 category covers itself and its own child');

select is(
  (select count(*)::int from app_private.public_category_subtree('feed-smartphones')),
  1, 'a leaf covers only itself');

select is_empty(
  $$select * from app_private.public_category_subtree('no-such-category')$$,
  'a slug that names nothing covers nothing');

select is_empty(
  $$select * from app_private.public_category_subtree('')$$,
  'and neither does an empty slug');

-- ---------------------------------------------------------------------------------------------------
-- The feed: rollup, and nothing but what the public may see
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select slug from app_private.public_category_feed('feed-electronics', '{}'::jsonb, 50)$$,
  $$values ('feed-root-one'), ('feed-phone-one'), ('feed-smart-one'), ('feed-audio-one'),
           ('feed-head-one'), ('feed-service-one')$$,
  'the root feed rolls up all three levels and both surfaces');

select set_eq(
  $$select slug from app_private.public_category_feed('feed-phones', '{}'::jsonb, 50)$$,
  $$values ('feed-phone-one'), ('feed-smart-one'), ('feed-service-one')$$,
  'a level-1 feed carries its own and its child''s');

select set_eq(
  $$select slug from app_private.public_category_feed('feed-smartphones', '{}'::jsonb, 50)$$,
  $$values ('feed-smart-one')$$,
  'and a leaf carries only its own');

select is_empty(
  $$select * from app_private.public_category_feed('feed-elsewhere', '{}'::jsonb, 50)$$,
  'a real but empty category is empty rather than an error');

select is_empty(
  $$select * from app_private.public_category_feed('no-such-category', '{}'::jsonb, 50)$$,
  'and so is one that does not exist');

-- The five that must never appear, asserted by name rather than by count.
select is(
  (select count(*)::int from app_private.public_category_feed('feed-electronics', '{}'::jsonb, 50) f
    where f.slug in ('feed-draft', 'feed-rejected', 'feed-sold', 'feed-archived', 'feed-hidden-seller')),
  0, 'no draft, rejected, sold or archived listing is reachable, and none of a suspended seller''s');

select is(
  (select result_type from app_private.public_category_feed('feed-electronics', '{}'::jsonb, 50) f
    where f.slug = 'feed-service-one'),
  'service', 'a service is reported as one');

select is(
  (select pricing_model from app_private.public_category_feed('feed-electronics', '{}'::jsonb, 50) f
    where f.slug = 'feed-service-one'),
  'fixed', 'and carries its own card fields');

select is(
  (select is_negotiable from app_private.public_category_feed('feed-electronics', '{}'::jsonb, 50) f
    where f.slug = 'feed-service-one'),
  null, 'while leaving a product''s fields null');

select is(
  (select currency_minor_unit from app_private.public_category_feed('feed-electronics', '{}'::jsonb, 50) f
    where f.slug = 'feed-root-one'),
  2::smallint, 'the currency''s decimal places travel with the card');

-- ---------------------------------------------------------------------------------------------------
-- A deactivated category prunes its branch, and cannot widen anything
-- ---------------------------------------------------------------------------------------------------
update public.categories set is_active = false where slug = 'feed-audio';

select set_eq(
  $$select slug from app_private.public_category_feed('feed-electronics', '{}'::jsonb, 50)$$,
  $$values ('feed-root-one'), ('feed-phone-one'), ('feed-smart-one'), ('feed-service-one')$$,
  'deactivating a level-1 category removes it and its child from the root feed');

select is_empty(
  $$select * from app_private.public_category_feed('feed-audio', '{}'::jsonb, 50)$$,
  'the deactivated category itself serves nothing');

select is_empty(
  $$select * from app_private.public_category_feed('feed-headphones', '{}'::jsonb, 50)$$,
  'and neither does its active child, because an ancestor is hidden');

update public.categories set is_active = true where slug = 'feed-audio';

update public.categories set is_active = false where slug = 'feed-electronics';
select is_empty(
  $$select * from app_private.public_category_feed('feed-phones', '{}'::jsonb, 50)$$,
  'a hidden level-0 ancestor hides a level-1 feed too');
update public.categories set is_active = true where slug = 'feed-electronics';

-- ---------------------------------------------------------------------------------------------------
-- Filters narrow, and only narrow
-- ---------------------------------------------------------------------------------------------------
create temporary table unfiltered as
select slug from app_private.public_category_feed('feed-electronics', '{}'::jsonb, 50);

select is((select count(*)::int from unfiltered), 6, 'six listings before any filter');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"listingType":"service"}'::jsonb, 50)$$,
  $$values ('feed-service-one')$$,
  'the listing type narrows to one surface');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"listingType":"product"}'::jsonb, 50)$$,
  $$values ('feed-root-one'), ('feed-phone-one'), ('feed-smart-one'), ('feed-audio-one'), ('feed-head-one')$$,
  'and to the other');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"tags":["feed-handmade"]}'::jsonb, 50)$$,
  $$values ('feed-root-one')$$,
  'a tag narrows to the listings carrying it, and never to a hidden seller''s');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"tags":["feed-handmade","feed-rare"]}'::jsonb, 50)$$,
  $$values ('feed-root-one'), ('feed-phone-one')$$,
  'two tags are alternatives within one dimension');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"attributes":[{"key":"feed_material","options":["oak"]}]}'::jsonb, 50)$$,
  $$values ('feed-root-one')$$,
  'a single-select option narrows to the listings answering it');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"attributes":[{"key":"feed_material","options":["oak","pine"]}]}'::jsonb, 50)$$,
  $$values ('feed-root-one'), ('feed-phone-one')$$,
  'two options of one attribute are alternatives');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"attributes":[{"key":"feed_features","options":["wireless"]}]}'::jsonb, 50)$$,
  $$values ('feed-root-one')$$,
  'a multi-select matches on any one of the listing''s own options');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"attributes":[{"key":"feed_boxed","boolean":true}]}'::jsonb, 50)$$,
  $$values ('feed-root-one')$$,
  'a boolean matches true');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"attributes":[{"key":"feed_boxed","boolean":false}]}'::jsonb, 50)$$,
  $$values ('feed-phone-one')$$,
  'and false, which is an answer rather than an absence');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"attributes":[{"key":"feed_width","min":150}]}'::jsonb, 50)$$,
  $$values ('feed-phone-one')$$,
  'a lower bound on a number narrows');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"attributes":[{"key":"feed_width","max":150}]}'::jsonb, 50)$$,
  $$values ('feed-root-one')$$,
  'an upper bound narrows the other way');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"attributes":[{"key":"feed_width","min":120,"max":200}]}'::jsonb, 50)$$,
  $$values ('feed-root-one'), ('feed-phone-one')$$,
  'and a range is inclusive at both ends');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics',
      '{"attributes":[{"key":"feed_material","options":["oak","pine"]},{"key":"feed_boxed","boolean":true}]}'::jsonb,
      50)$$,
  $$values ('feed-root-one')$$,
  'two attributes accumulate, where two values of one attribute would not');

select is_empty(
  $$select * from app_private.public_category_feed(
      'feed-electronics',
      '{"attributes":[{"key":"feed_material","options":["pine"]},{"key":"feed_boxed","boolean":true}]}'::jsonb,
      50)$$,
  'and a combination nothing answers returns nothing rather than either half');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"tags":["feed-rare"],"attributes":[{"key":"feed_width","min":150}]}'::jsonb, 50)$$,
  $$values ('feed-phone-one')$$,
  'a tag and an attribute accumulate too');

-- The whole point, stated as an assertion: whatever the filter, the result is a subset.
select is(
  (select count(*)::int
     from (
       select slug from app_private.public_category_feed('feed-electronics', '{"listingType":"product"}'::jsonb, 50)
       union all
       select slug from app_private.public_category_feed('feed-electronics', '{"tags":["feed-handmade","feed-rare"]}'::jsonb, 50)
       union all
       select slug from app_private.public_category_feed('feed-electronics', '{"attributes":[{"key":"feed_material","options":["oak","pine"]}]}'::jsonb, 50)
       union all
       select slug from app_private.public_category_feed('feed-electronics', '{"attributes":[{"key":"feed_width","min":0,"max":1000}]}'::jsonb, 50)
       union all
       select slug from app_private.public_category_feed('feed-electronics', '{"price":{"currency":"XTF","min":"0"}}'::jsonb, 50)
     ) filtered
    where filtered.slug not in (select slug from unfiltered)),
  0, 'no filter, in any combination, returns a row the unfiltered feed did not');

-- ---------------------------------------------------------------------------------------------------
-- Price: inside one currency, and no further
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"price":{"currency":"XTF","min":"25000"}}'::jsonb, 50)$$,
  $$values ('feed-smart-one'), ('feed-audio-one'), ('feed-head-one')$$,
  'a price floor narrows within the currency it names');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"price":{"currency":"XTF","min":"25000","max":"45000"}}'::jsonb, 50)$$,
  $$values ('feed-smart-one'), ('feed-audio-one')$$,
  'and a range is inclusive at both ends');

select set_eq(
  $$select slug from app_private.public_category_feed(
      'feed-electronics', '{"price":{"currency":"XTG","min":"0"}}'::jsonb, 50)$$,
  $$values ('feed-service-one')$$,
  'a bound in the other currency reaches only the listing priced in it');

select is_empty(
  $$select * from app_private.public_category_feed(
      'feed-electronics', '{"price":{"currency":"XTG","min":"100000"}}'::jsonb, 50)$$,
  'and never compares one currency''s number against another''s: there is no conversion anywhere');

select is(
  (select count(*)::int from app_private.public_category_feed(
     'feed-electronics', '{"price":{"currency":"XTF","min":"0","max":"999999999999999999"}}'::jsonb, 50)),
  5, 'a bound spanning every price the contract allows still admits only that currency''s listings');

-- ---------------------------------------------------------------------------------------------------
-- A value the vocabulary does not know empties the request
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.catalog_filters_resolve('{}'::jsonb), 'an empty document resolves');
select ok(app_private.catalog_filters_resolve(null), 'and so does none at all');
select ok(not app_private.catalog_filters_resolve('[]'::jsonb), 'a document that is not an object does not');
select ok(not app_private.catalog_filters_resolve('{"listingType":"vehicle"}'::jsonb),
  'an unseeded listing type does not resolve');
select ok(not app_private.catalog_filters_resolve('{"tags":["no-such-tag"]}'::jsonb),
  'an unknown tag does not resolve');
select ok(not app_private.catalog_filters_resolve('{"tags":["feed-retired"]}'::jsonb),
  'nor a hidden one');
select ok(not app_private.catalog_filters_resolve('{"attributes":[{"key":"no_such_key","boolean":true}]}'::jsonb),
  'an unknown attribute does not resolve');
select ok(not app_private.catalog_filters_resolve('{"attributes":[{"key":"feed_era","options":["vintage"]}]}'::jsonb),
  'nor a hidden attribute');
select ok(not app_private.catalog_filters_resolve('{"attributes":[{"key":"feed_material","options":["mahogany"]}]}'::jsonb),
  'nor an option that does not exist');
select ok(not app_private.catalog_filters_resolve('{"attributes":[{"key":"feed_material","options":["teak"]}]}'::jsonb),
  'nor a hidden option');
select ok(not app_private.catalog_filters_resolve('{"attributes":[{"key":"feed_material","options":["folding"]}]}'::jsonb),
  'nor an option belonging to another attribute');
select ok(not app_private.catalog_filters_resolve('{"attributes":[{"key":"feed_material","boolean":true}]}'::jsonb),
  'a select attribute cannot be filtered as a boolean');
select ok(not app_private.catalog_filters_resolve('{"attributes":[{"key":"feed_boxed","min":1}]}'::jsonb),
  'nor a boolean as a range');
select ok(not app_private.catalog_filters_resolve('{"attributes":[{"key":"feed_width","options":["oak"]}]}'::jsonb),
  'nor a number as a list');
select ok(not app_private.catalog_filters_resolve('{"attributes":[{"key":"feed_material"}]}'::jsonb),
  'an attribute named with nothing to match on does not resolve');
select ok(not app_private.catalog_filters_resolve('{"price":{"min":"100"}}'::jsonb),
  'a price bound with no currency does not resolve');
select ok(not app_private.catalog_filters_resolve('{"price":{"currency":"XNX","min":"100"}}'::jsonb),
  'nor one naming a currency nothing is priced in');
select ok(app_private.catalog_filters_resolve('{"price":{"currency":"XTF"}}'::jsonb),
  'a currency with no bounds resolves: it is a dimension with no limit yet');

-- And each of those empties the feed rather than widening it.
select is_empty(
  $$select * from app_private.public_category_feed('feed-electronics', '{"tags":["no-such-tag"]}'::jsonb, 50)$$,
  'an unknown tag returns nothing at all');

select is_empty(
  $$select * from app_private.public_category_feed(
      'feed-electronics', '{"tags":["feed-handmade","no-such-tag"]}'::jsonb, 50)$$,
  'and one unknown value among known ones still returns nothing, rather than quietly widening to the rest');

select is_empty(
  $$select * from app_private.public_category_feed(
      'feed-electronics', '{"attributes":[{"key":"feed_era","options":["vintage"]}]}'::jsonb, 50)$$,
  'a hidden attribute filters nothing, even though a listing answers it');

select is(
  (select count(*)::int from public.listing_attribute_values v
    where v.attribute_definition_id = 'd0000000-0000-4000-8000-0000000000f7'),
  1, 'while that stored answer is untouched, and comes back if the attribute is shown again');

-- ---------------------------------------------------------------------------------------------------
-- Cursor pagination walks the order the feed declares
-- ---------------------------------------------------------------------------------------------------
select is(
  (select slug from app_private.public_category_feed('feed-electronics', '{}'::jsonb, 1)),
  'feed-service-one', 'the first page is the newest');

select is(
  (select slug from app_private.public_category_feed(
     'feed-electronics', '{}'::jsonb, 1, '2026-05-06T10:00:00Z'::timestamptz,
     '11110000-0000-4000-8000-0000000000f6')),
  'feed-head-one', 'and the cursor continues from that position');

select is(
  (select count(*)::int from app_private.public_category_feed(
     'feed-electronics', '{}'::jsonb, 50, '2026-05-01T10:00:00Z'::timestamptz,
     '11110000-0000-4000-8000-0000000000f1')),
  0, 'a cursor at the oldest row ends the walk');

select is(
  (select count(*)::int from (
     select slug from app_private.public_category_feed('feed-electronics', '{}'::jsonb, 3)
     union
     select slug from app_private.public_category_feed(
       'feed-electronics', '{}'::jsonb, 3, '2026-05-04T10:00:00Z'::timestamptz,
       '11110000-0000-4000-8000-0000000000f4')
   ) both_pages),
  6, 'two pages of three cover the whole feed exactly once');

select is(
  (select count(*)::int from app_private.public_category_feed('feed-electronics', '{}'::jsonb, 0)),
  0, 'a limit of zero returns nothing rather than everything');

-- ---------------------------------------------------------------------------------------------------
-- The facets
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select distinct attribute_key from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
     where facet_kind = 'attribute'$$,
  $$values ('feed_material'), ('feed_features'), ('feed_boxed'), ('feed_width')$$,
  'the attributes offered are the ones the category asks for filterably and the vocabulary means to filter');

select is(
  (select count(*)::int from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
    where attribute_key = 'feed_note'),
  0, 'a text attribute is never offered: there is nothing to enumerate');

select is(
  (select count(*)::int from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
    where attribute_key = 'feed_colour'),
  0, 'nor one the category asks for unfilterably');

select is(
  (select count(*)::int from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
    where attribute_key = 'feed_era'),
  0, 'nor a hidden one, however it is attached');

select set_eq(
  $$select value from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
     where attribute_key = 'feed_material'$$,
  $$values ('oak'), ('pine')$$,
  'a select attribute offers its active options, and not its hidden one');

select is(
  (select match_count from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
    where attribute_key = 'feed_material' and value = 'oak'),
  1, 'an option counts the visible listings answering it — never the suspended seller''s');

select set_eq(
  $$select value from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
     where attribute_key = 'feed_boxed'$$,
  $$values ('true'), ('false')$$,
  'a boolean offers both answers');

select is(
  (select number_max from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
    where attribute_key = 'feed_width'),
  200::numeric, 'a number offers the range its matching listings span');

select is(
  (select number_min from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
    where attribute_key = 'feed_width'),
  120::numeric, 'at both ends');

select set_eq(
  $$select value from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
     where facet_kind = 'tag'$$,
  $$values ('feed-handmade'), ('feed-rare')$$,
  'the tags offered are those some visible listing carries, and the hidden one is absent');

select set_eq(
  $$select value from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
     where facet_kind = 'listing_type'$$,
  $$values ('product'), ('service')$$,
  'both surfaces are offered in a category that holds both');

select set_eq(
  $$select value from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
     where facet_kind = 'currency'$$,
  $$values ('XTF'), ('XTG')$$,
  'and the currencies are read from the listings themselves, never named in source');

select is(
  (select value_sort_order from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
    where facet_kind = 'currency' and value = 'XTF'),
  2, 'a currency facet carries its decimal places, so a price box can be drawn');

select is(
  (select number_min from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
    where facet_kind = 'currency' and value = 'XTF'),
  10000::numeric, 'and the span of prices in it');

-- Localization: the labels follow the locale, and only the labels.
select is(
  (select label from app_private.public_category_facets('feed-electronics', 'ar', '{}'::jsonb)
    where attribute_key = 'feed_material' and value = 'oak'),
  'بلوط', 'an option is labelled in Arabic when Arabic is asked for');

select is(
  (select attribute_label from app_private.public_category_facets('feed-electronics', 'ar', '{}'::jsonb)
    where attribute_key = 'feed_material' limit 1),
  'الخامة', 'and so is the attribute');

select is(
  (select attribute_label from app_private.public_category_facets('feed-electronics', 'zf', '{}'::jsonb)
    where attribute_key = 'feed_material' limit 1),
  'Material', 'an unknown locale falls back to English rather than failing');

-- Counts move with the active filters; the values offered do not.
select is(
  (select match_count from app_private.public_category_facets(
     'feed-electronics', 'en', '{"listingType":"service"}'::jsonb)
    where attribute_key = 'feed_material' and value = 'oak'),
  0, 'a count falls to zero under a filter that excludes it');

select is(
  (select count(*)::int from app_private.public_category_facets(
     'feed-electronics', 'en', '{"listingType":"service"}'::jsonb)
    where attribute_key = 'feed_material' and value = 'oak'),
  1, 'while the option is still offered, so the visitor can undo their own filter');

select is(
  (select match_count from app_private.public_category_facets(
     'feed-electronics', 'en', '{"tags":["feed-handmade"]}'::jsonb)
    where facet_kind = 'tag' and value = 'feed-rare'),
  0, 'a tag count is computed under the active filters too');

select is(
  (select match_count from app_private.public_category_facets(
     'feed-electronics', 'en', '{"attributes":[{"key":"feed_boxed","boolean":true}]}'::jsonb)
    where attribute_key = 'feed_material' and value = 'oak'),
  1, 'and a count that survives the filter is still exactly the number of matching listings');

select is(
  (select sum(match_count)::int from app_private.public_category_facets(
     'feed-electronics', 'en', '{}'::jsonb)
    where facet_kind = 'listing_type'),
  6, 'the listing-type counts add up to the unfiltered feed, because a listing has one type');

-- A filter that does not resolve empties the counts as well as the results.
select is(
  (select coalesce(sum(match_count), 0)::int from app_private.public_category_facets(
     'feed-electronics', 'en', '{"tags":["no-such-tag"]}'::jsonb)),
  0, 'an unresolvable filter leaves every count at zero, matching an empty result set');

-- The facet reader obeys the rollup and the pruning exactly as the feed does.
select is(
  (select match_count from app_private.public_category_facets('feed-smartphones', 'en', '{}'::jsonb)
    where facet_kind = 'listing_type' and value = 'product'),
  1, 'a leaf''s facets count only the leaf''s own listings');

select is_empty(
  $$select * from app_private.public_category_facets('no-such-category', 'en', '{}'::jsonb)$$,
  'and a category that does not exist offers no facets at all');

update public.categories set is_active = false where slug = 'feed-audio';
select is(
  (select sum(match_count)::int from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
    where facet_kind = 'listing_type'),
  4, 'deactivating a branch removes its listings from the counts');
update public.categories set is_active = true where slug = 'feed-audio';

-- ---------------------------------------------------------------------------------------------------
-- Hiding a value removes it from the filters and the facets, and keeps the answer
-- ---------------------------------------------------------------------------------------------------
update public.attribute_options set is_active = false where id = 'e0000000-0000-4000-8000-0000000000f1';

select is(
  (select count(*)::int from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
    where attribute_key = 'feed_material' and value = 'oak'),
  0, 'a hidden option leaves the facets');

select is_empty(
  $$select * from app_private.public_category_feed(
      'feed-electronics', '{"attributes":[{"key":"feed_material","options":["oak"]}]}'::jsonb, 50)$$,
  'and can no longer be filtered by');

select is(
  (select cardinality(v.option_ids) from public.listing_attribute_values v
    where v.listing_id = '11110000-0000-4000-8000-0000000000f1'
      and v.attribute_definition_id = 'd0000000-0000-4000-8000-0000000000f1'),
  1, 'while the seller''s stored answer is exactly as they left it');

update public.attribute_options set is_active = true where id = 'e0000000-0000-4000-8000-0000000000f1';

update public.tags set is_active = false where slug = 'feed-handmade';

select is(
  (select count(*)::int from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
    where facet_kind = 'tag' and value = 'feed-handmade'),
  0, 'a hidden tag leaves the facets');

select is(
  (select count(*)::int from public.listing_tags lt
    where lt.tag_id = 'f0000000-0000-4000-8000-0000000000f1'),
  2, 'while the listings keep carrying it');

update public.tags set is_active = true where slug = 'feed-handmade';

update public.attribute_definitions set is_active = false where key = 'feed_material';

select is(
  (select count(*)::int from app_private.public_category_facets('feed-electronics', 'en', '{}'::jsonb)
    where attribute_key = 'feed_material'),
  0, 'hiding a definition removes the whole facet');

select is_empty(
  $$select * from app_private.public_category_feed(
      'feed-electronics', '{"attributes":[{"key":"feed_material","options":["oak"]}]}'::jsonb, 50)$$,
  'and the filter with it');

update public.attribute_definitions set is_active = true where key = 'feed_material';

-- ---------------------------------------------------------------------------------------------------
-- Search takes the same document, because it is the same two functions
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select slug from app_private.public_catalog_search('widget', 'en', '{}'::jsonb, 50)$$,
  $$values ('feed-root-one'), ('feed-phone-one'), ('feed-smart-one'), ('feed-audio-one'),
           ('feed-head-one'), ('feed-service-one')$$,
  'unfiltered search finds every visible listing that matches the words');

select set_eq(
  $$select slug from app_private.public_catalog_search('widget', 'en', '{"listingType":"service"}'::jsonb, 50)$$,
  $$values ('feed-service-one')$$,
  'and narrows by the same listing-type filter');

select set_eq(
  $$select slug from app_private.public_catalog_search(
      'widget', 'en', '{"attributes":[{"key":"feed_width","min":150}]}'::jsonb, 50)$$,
  $$values ('feed-phone-one')$$,
  'by the same attribute filter');

select set_eq(
  $$select slug from app_private.public_catalog_search(
      'widget', 'en', '{"price":{"currency":"XTG","min":"0"}}'::jsonb, 50)$$,
  $$values ('feed-service-one')$$,
  'and by the same price filter, inside one currency');

select is_empty(
  $$select * from app_private.public_catalog_search('widget', 'en', '{"tags":["no-such-tag"]}'::jsonb, 50)$$,
  'an unresolvable filter empties a search exactly as it empties a feed');

select is(
  (select count(*)::int from app_private.public_catalog_search('widget', 'en', '{}'::jsonb, 50) s
    where s.slug in ('feed-draft', 'feed-rejected', 'feed-sold', 'feed-archived', 'feed-hidden-seller')),
  0, 'and search still admits nothing the public may not see');

-- 0051's signature answers exactly what it did, through the shared body.
select set_eq(
  $$select slug from app_private.public_search('widget', 'en', 50)$$,
  $$select slug from app_private.public_catalog_search('widget', 'en', '{}'::jsonb, 50)$$,
  'the unfiltered signature and an empty filter document are the same answer');

select is(
  (select count(*)::int from app_private.public_search('widget', 'en', 1)),
  1, 'and it still pages');

-- ---------------------------------------------------------------------------------------------------
-- Nothing financial, and nothing authenticated
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('public_category_subtree', 'catalog_filters_resolve', 'catalog_listing_matches',
                        'public_category_feed', 'public_catalog_search', 'public_category_facets')
      and pg_get_functiondef(p.oid) ~* 'ledger_entries|settle_payout|transition_withdrawal|reconcile_settlement|seller_balances|commission_rules|tax_rules|coupons'),
  0, 'no function here names a financial function or table');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('public_category_feed', 'public_catalog_search', 'public_category_facets')
      and pg_get_functiondef(p.oid) ~* 'current_user_id|auth\.uid|app\.user_id|audit_actor_id'),
  0, 'and none reads a caller identity: these surfaces are the same for everybody');

select * from finish();
rollback;
