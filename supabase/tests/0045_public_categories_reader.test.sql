-- pgTAP — migration 0045: the public category reader (Phase 4-A).
--
-- This is the first function a guest's request reaches, so the assertions divide into two halves that
-- matter equally: nobody but `app_system` can call it and no browser role can reach the tables behind
-- it; and what comes back is the published tree and nothing else — no deactivated branch, no
-- administrative column, no SEO field, no image path.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(34);

-- A three-level tree, plus a deactivated branch with an active child under it.
insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('aa000000-0000-4000-8000-000000000001', null, 'electronics', true, 2),
  ('aa000000-0000-4000-8000-000000000002', null, 'home', true, 1),
  ('aa000000-0000-4000-8000-000000000003', 'aa000000-0000-4000-8000-000000000001', 'phones', true, 1),
  ('aa000000-0000-4000-8000-000000000004', 'aa000000-0000-4000-8000-000000000003', 'smartphones', true, 1),
  ('aa000000-0000-4000-8000-000000000005', null, 'retired', false, 9),
  ('aa000000-0000-4000-8000-000000000006', 'aa000000-0000-4000-8000-000000000005', 'retired-child', true, 1),
  ('aa000000-0000-4000-8000-000000000007', 'aa000000-0000-4000-8000-000000000001', 'untranslated', true, 2);

insert into public.category_translations (category_id, locale_code, name, description, meta_title, meta_description) values
  ('aa000000-0000-4000-8000-000000000001', 'en', 'Electronics', 'internal description', 'meta title', 'meta description'),
  ('aa000000-0000-4000-8000-000000000001', 'ar', 'إلكترونيات', null, null, null),
  ('aa000000-0000-4000-8000-000000000002', 'en', 'Home', null, null, null),
  ('aa000000-0000-4000-8000-000000000003', 'en', 'Phones', null, null, null),
  ('aa000000-0000-4000-8000-000000000004', 'en', 'Smartphones', null, null, null),
  ('aa000000-0000-4000-8000-000000000005', 'en', 'Retired', null, null, null),
  ('aa000000-0000-4000-8000-000000000006', 'en', 'Retired child', null, null, null);

-- ---------------------------------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'public_categories', array['text'],
  'app_private.public_categories exists');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname = 'public_categories'
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'it is SECURITY DEFINER with the pinned search_path');
select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_categories'),
  's'::"char",
  'and STABLE: reading the catalogue never writes to it');

select function_privs_are('app_private', 'public_categories', array['text'],
  'app_system', array['EXECUTE'], 'app_system may read the public tree');
select function_privs_are('app_private', 'public_categories', array['text'],
  'anon', array[]::text[], 'anon may not: a guest reaches this only through the API');
select function_privs_are('app_private', 'public_categories', array['text'],
  'authenticated', array[]::text[], 'and neither may a signed-in browser role');
select function_privs_are('app_private', 'public_categories', array['text'],
  'public', array[]::text[], 'nor PUBLIC');
select function_privs_are('app_private', 'public_categories', array['text'],
  'app_worker', array[]::text[], 'nor the worker');

-- The tables behind it stay out of reach for the roles a browser can hold.
select table_privs_are('public', 'categories', 'anon', array[]::text[],
  'anon holds no privilege on categories');
select table_privs_are('public', 'category_translations', 'anon', array[]::text[],
  'nor on category_translations');
select is(
  (select count(*) from pg_namespace n, aclexplode(n.nspacl) a
    where n.nspname = 'app_private' and a.grantee::regrole::text in ('anon', 'authenticated')),
  0::bigint,
  'and no browser role holds USAGE on app_private, so the function is unreachable from a browser');
select table_privs_are('public', 'categories', 'app_system', array[]::text[],
  'app_system itself holds no table privilege: the function is the only way in');

-- ---------------------------------------------------------------------------------------------------
-- The projection is fixed and minimal
-- ---------------------------------------------------------------------------------------------------
-- The declared OUT columns of the function itself, read from the catalog rather than from a result.
select set_eq(
  $$select a.name::text from (
      select unnest(p.proargnames) as name, unnest(p.proargmodes) as mode
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app_private' and p.proname = 'public_categories') a
     where a.mode = 't'$$,
  $$values ('id'), ('parent_id'), ('slug'), ('name')$$,
  'exactly four columns come back: id, parent_id, slug, name');

-- Nothing administrative can leak, because nothing administrative is declared. These are the columns
-- 0010 stores that a guest must never see.
select is(
  (select count(*) from (
     select unnest(p.proargnames) as name, unnest(p.proargmodes) as mode
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname = 'public_categories') a
    where a.mode = 't'
      and a.name in ('is_active', 'icon', 'image_object_path', 'listing_type_code', 'depth',
                     'sort_order', 'created_at', 'updated_at', 'description', 'meta_title',
                     'meta_description')),
  0::bigint,
  'no administrative, media or SEO column is exposed');

-- ---------------------------------------------------------------------------------------------------
-- Which categories are returned
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.public_categories('en')),
  5::bigint,
  'the five published categories come back');
select is(
  (select count(*) from app_private.public_categories('en') c where c.slug = 'retired'),
  0::bigint,
  'a deactivated category is absent');
select is(
  (select count(*) from app_private.public_categories('en') c where c.slug = 'retired-child'),
  0::bigint,
  'and so is its active child: visibility is inherited, not per row');

-- ---------------------------------------------------------------------------------------------------
-- Hierarchy
-- ---------------------------------------------------------------------------------------------------
select is(
  (select c.parent_id from app_private.public_categories('en') c where c.slug = 'electronics'),
  null,
  'a root category has no parent');
select is(
  (select c.parent_id from app_private.public_categories('en') c where c.slug = 'phones'),
  'aa000000-0000-4000-8000-000000000001'::uuid,
  'a child names its parent');
select is(
  (select c.parent_id from app_private.public_categories('en') c where c.slug = 'smartphones'),
  'aa000000-0000-4000-8000-000000000003'::uuid,
  'and a grandchild names its own parent, so three levels can be rebuilt');
select is(
  (select array_agg(c.slug order by ordinality) from app_private.public_categories('en') with ordinality c(id, parent_id, slug, name, ordinality)),
  array['home', 'electronics', 'phones', 'untranslated', 'smartphones'],
  'rows arrive shallowest first and, within a level, in sort order then slug');
select is(
  (select count(*) from app_private.public_categories('en') c
    where c.parent_id is not null
      and c.parent_id not in (select p.id from app_private.public_categories('en') p)),
  0::bigint,
  'every returned parent is itself returned, so the tree can never be built with a dangling branch');

-- ---------------------------------------------------------------------------------------------------
-- Names follow the requested locale
-- ---------------------------------------------------------------------------------------------------
select is(
  (select c.name from app_private.public_categories('en') c where c.slug = 'electronics'),
  'Electronics',
  'English is used for the default locale');
select is(
  (select c.name from app_private.public_categories('ar') c where c.slug = 'electronics'),
  'إلكترونيات',
  'Arabic is used for /ar');
select is(
  (select c.name from app_private.public_categories('ar') c where c.slug = 'home'),
  'Home',
  'a category with no Arabic translation falls back to the default locale rather than disappearing');
select is(
  (select c.name from app_private.public_categories('en') c where c.slug = 'untranslated'),
  'untranslated',
  'and one with no translation at all falls back to its slug');
select is(
  (select c.name from app_private.public_categories('de') c where c.slug = 'electronics'),
  'Electronics',
  'an unknown locale resolves to the default: a locale is a representation, not an authorisation');
select is(
  (select c.name from app_private.public_categories(null) c where c.slug = 'electronics'),
  'Electronics',
  'and so does no locale at all');
select is(
  (select c.name from app_private.public_categories('  AR  ') c where c.slug = 'electronics'),
  'إلكترونيات',
  'the locale is trimmed and lower-cased before it is matched');

-- An inactive locale is not a usable representation either.
update public.locales set is_active = false where code = 'ar';
select is(
  (select c.name from app_private.public_categories('ar') c where c.slug = 'electronics'),
  'Electronics',
  'a deactivated locale falls back to the default');
update public.locales set is_active = true where code = 'ar';

-- ---------------------------------------------------------------------------------------------------
-- Nothing private appears in the answer itself
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.public_categories('en') c
    where c.name in ('internal description', 'meta title', 'meta description')),
  0::bigint,
  'the description and SEO fields never arrive as a name');

select is(
  (select count(*) from app_private.public_categories('en')),
  (select count(*) from app_private.public_categories('ar')),
  'the locale changes the names, never which categories are visible');

-- An empty catalogue is an empty answer, not an error: the page renders its empty state.
delete from public.categories;
select is((select count(*) from app_private.public_categories('en')), 0::bigint,
  'an empty catalogue returns no rows rather than failing');
select lives_ok($$select * from app_private.public_categories('en')$$,
  'and asking again still succeeds');

select * from finish();
rollback;
