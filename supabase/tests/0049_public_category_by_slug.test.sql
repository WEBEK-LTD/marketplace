-- pgTAP — migration 0049: the public category-by-slug reader (Phase 4-D).
--
-- The landing page reads one category rather than the whole tree, so the assertions are about the three
-- things that page depends on: that the same categories are visible here as in 0045's tree, that the
-- projection carries the approved fields and no others, and that an inactive category is indistinguishable
-- from one that never existed.
--
-- The agreement assertion is the important one. 0045 is frozen and expresses visibility as a recursive
-- CTE inside its own query; 0049 expresses the same rule as a function. Two expressions of one rule can
-- drift, so the set of ids each admits is compared directly. A change to one that is not made to the
-- other fails here rather than in production.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(42);

-- Fixtures ------------------------------------------------------------------------------------------
-- A three-level tree (the schema allows depth 0..2), plus a deactivated branch and a deactivated leaf.
insert into public.categories (id, parent_id, depth, slug, is_active, sort_order) values
  ('c0000000-0000-4000-8000-000000000001', null, 0, 'furniture', true, 1),
  ('c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 1, 'seating', true, 1),
  ('c0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001', 1, 'tables', true, 2),
  ('c0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000002', 2, 'sofas', true, 1),
  -- Ordering: a lower sort_order wins, and the slug breaks a tie.
  ('c0000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002', 2, 'armchairs', true, 1),
  -- A leaf with no children of its own: still a valid page.
  ('c0000000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-000000000003', 2, 'desks', true, 1),
  -- Deactivated root, with an active child underneath it.
  ('c0000000-0000-4000-8000-000000000007', null, 0, 'retired-root', false, 9),
  ('c0000000-0000-4000-8000-000000000008', 'c0000000-0000-4000-8000-000000000007', 1, 'orphan', true, 1),
  -- Deactivated leaf under an active parent.
  ('c0000000-0000-4000-8000-000000000009', 'c0000000-0000-4000-8000-000000000003', 2, 'retired-leaf', false, 2);

insert into public.category_translations
  (category_id, locale_code, name, description, meta_title, meta_description)
values
  ('c0000000-0000-4000-8000-000000000001', 'en', 'Furniture', 'Everything for the home.',
   'Furniture | Marketplace', 'Browse furniture on the marketplace.'),
  ('c0000000-0000-4000-8000-000000000001', 'ar', 'أثاث', 'كل ما يخص المنزل.',
   'أثاث | السوق', 'تصفح الأثاث في السوق.'),
  ('c0000000-0000-4000-8000-000000000002', 'en', 'Seating', null, null, null),
  ('c0000000-0000-4000-8000-000000000002', 'ar', 'جلوس', null, null, null),
  ('c0000000-0000-4000-8000-000000000003', 'en', 'Tables', 'Tables of every size.', null, null),
  ('c0000000-0000-4000-8000-000000000004', 'en', 'Sofas', null, null, null),
  ('c0000000-0000-4000-8000-000000000005', 'en', 'Armchairs', null, null, null),
  ('c0000000-0000-4000-8000-000000000006', 'en', 'Desks', null, null, null),
  ('c0000000-0000-4000-8000-000000000008', 'en', 'Orphan', null, null, null);

-- ---------------------------------------------------------------------------------------------------
-- Boundary
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'public_category_by_slug', array['text','text'],
  'app_private.public_category_by_slug exists');
select has_function('app_private', 'public_category_visible', array['uuid'],
  'app_private.public_category_visible exists');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('public_category_by_slug', 'public_category_visible')
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'both are SECURITY DEFINER with the pinned search_path');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('public_category_by_slug', 'public_category_visible')
      and has_function_privilege('public', p.oid, 'execute')),
  0::bigint,
  'neither is executable by public');

select ok(
  has_function_privilege('app_system', 'app_private.public_category_by_slug(text,text)', 'execute'),
  'app_system may read a category by slug');
select ok(
  not has_function_privilege('anon', 'app_private.public_category_by_slug(text,text)', 'execute'),
  'anon may not read a category by slug');
select ok(
  not has_function_privilege('authenticated', 'app_private.public_category_by_slug(text,text)', 'execute'),
  'authenticated may not read a category by slug either');

-- ---------------------------------------------------------------------------------------------------
-- The declared projection
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select a.name from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral unnest(p.proargnames, p.proargmodes) as a(name, mode)
     where n.nspname = 'app_private' and p.proname = 'public_category_by_slug' and a.mode = 't'$$,
  $$values ('outcome'), ('id'), ('slug'), ('name'), ('description'), ('meta_title'),
           ('meta_description'), ('parent'), ('children')$$,
  'the reader declares the approved projection and nothing else');

select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral unnest(coalesce(p.proargnames, array[]::text[])) as col(name)
    where n.nspname = 'app_private'
      and p.proname = 'public_category_by_slug'
      and col.name in ('is_active', 'sort_order', 'depth', 'listing_type_code', 'icon',
                       'image_object_path', 'created_at', 'updated_at', 'listing_count')),
  0::bigint,
  'no private, ordering, type or count column is declared');

-- ---------------------------------------------------------------------------------------------------
-- The visibility rule agrees with 0045's tree
-- ---------------------------------------------------------------------------------------------------
-- Two expressions of one rule. If they ever disagree, this is where it shows.
select set_eq(
  $$select id from app_private.public_categories('en')$$,
  $$select c.id from public.categories c where app_private.public_category_visible(c.id)$$,
  'the tree reader and the visibility function admit exactly the same categories');

select ok(app_private.public_category_visible('c0000000-0000-4000-8000-000000000001'),
  'an active root is visible');
select ok(app_private.public_category_visible('c0000000-0000-4000-8000-000000000004'),
  'an active leaf under active ancestors is visible');
select ok(not app_private.public_category_visible('c0000000-0000-4000-8000-000000000007'),
  'a deactivated root is not visible');
select ok(not app_private.public_category_visible('c0000000-0000-4000-8000-000000000008'),
  'an active child of a deactivated root is not visible either');
select ok(not app_private.public_category_visible('c0000000-0000-4000-8000-000000000009'),
  'a deactivated leaf is not visible');
select ok(not app_private.public_category_visible('00000000-0000-4000-8000-00000000ffff'),
  'a category that does not exist is not visible, rather than null');

-- ---------------------------------------------------------------------------------------------------
-- Resolving a category
-- ---------------------------------------------------------------------------------------------------
select is((select outcome from app_private.public_category_by_slug('furniture')), 'found',
  'an active root resolves');
select is((select outcome from app_private.public_category_by_slug('desks')), 'found',
  'an active leaf resolves');

select is((select name from app_private.public_category_by_slug('furniture', 'en')), 'Furniture',
  'the name follows the locale asked for');
select is((select name from app_private.public_category_by_slug('furniture', 'ar')), 'أثاث',
  'and the Arabic name in Arabic');
select is((select description from app_private.public_category_by_slug('furniture', 'ar')), 'كل ما يخص المنزل.',
  'the description is localized too');

select is((select name from app_private.public_category_by_slug('sofas', 'ar')), 'Sofas',
  'a category with no Arabic translation falls back to the default locale');
select is((select name from app_private.public_category_by_slug('retired-leaf', 'en')), null::text,
  'a category nobody may see has no name to fall back to, because it is not returned at all');

select is((select description from app_private.public_category_by_slug('seating')), null::text,
  'a category with no description states none rather than an empty string');

-- ---------------------------------------------------------------------------------------------------
-- SEO metadata
-- ---------------------------------------------------------------------------------------------------
select is(
  (select meta_title from app_private.public_category_by_slug('furniture', 'en')),
  'Furniture | Marketplace',
  'the meta title is available to the page');
select is(
  (select meta_description from app_private.public_category_by_slug('furniture', 'ar')),
  'تصفح الأثاث في السوق.',
  'and the meta description in the locale asked for');
select is(
  (select meta_title from app_private.public_category_by_slug('tables')),
  null::text,
  'a category with no meta title states none, leaving the page to fall back to its name');

-- ---------------------------------------------------------------------------------------------------
-- Parent and children
-- ---------------------------------------------------------------------------------------------------
select is(
  (select parent from app_private.public_category_by_slug('furniture')),
  null::jsonb,
  'a root has no parent');

select is(
  (select parent ->> 'slug' from app_private.public_category_by_slug('seating')),
  'furniture',
  'a child names its parent');
select is(
  (select parent ->> 'name' from app_private.public_category_by_slug('seating', 'ar')),
  'أثاث',
  'and the parent name is localized');
select set_eq(
  $$select jsonb_object_keys(parent) from app_private.public_category_by_slug('seating')$$,
  $$values ('id'), ('slug'), ('name')$$,
  'the parent projection is three fields');

select is(
  (select jsonb_array_length(children) from app_private.public_category_by_slug('furniture')),
  2,
  'a category lists its direct children only, never its grandchildren');
select is(
  (select array_agg(c ->> 'slug')
     from app_private.public_category_by_slug('furniture'), jsonb_array_elements(children) c),
  array['seating', 'tables'],
  'children come back in the catalogue order the admin set');
select is(
  (select array_agg(c ->> 'slug')
     from app_private.public_category_by_slug('seating'), jsonb_array_elements(children) c),
  array['armchairs', 'sofas'],
  'and the slug breaks a tie when the order is equal');

select is(
  (select jsonb_array_length(children) from app_private.public_category_by_slug('desks')),
  0,
  'a leaf has an empty child list, not a null one: it is still a valid page');

select is(
  (select array_agg(c ->> 'slug')
     from app_private.public_category_by_slug('tables'), jsonb_array_elements(children) c),
  array['desks'],
  'a deactivated child is left out of its parent’s child list');

select set_eq(
  $$select jsonb_object_keys(c) from app_private.public_category_by_slug('furniture'),
        jsonb_array_elements(children) c$$,
  $$values ('id'), ('slug'), ('name')$$,
  'the child projection is three fields');

-- ---------------------------------------------------------------------------------------------------
-- What the public may not see
-- ---------------------------------------------------------------------------------------------------
select is((select outcome from app_private.public_category_by_slug('retired-root')), 'not_found',
  'a deactivated category is not found');
select is((select outcome from app_private.public_category_by_slug('orphan')), 'not_found',
  'an active category under a deactivated ancestor is not found');
select is((select outcome from app_private.public_category_by_slug('retired-leaf')), 'not_found',
  'a deactivated leaf is not found');
select is((select outcome from app_private.public_category_by_slug('no-such-category')), 'not_found',
  'a slug that names nothing is not found');

select is(
  (select count(*) from app_private.public_category_by_slug('retired-root') c
    where c.id is not null or c.name is not null or c.children is not null or c.parent is not null),
  0::bigint,
  'a not-found answer carries no field of the category it refused: inactive and absent look identical');

select finish();
rollback;
