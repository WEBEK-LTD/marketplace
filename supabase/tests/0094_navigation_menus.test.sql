-- 0094 — Navigation: the named resolver and the authoring functions.
--
-- What is proven here, in order: the two permission predicates apply 0003's requires_mfa rule; only the three
-- served menu keys have a public reader and 0030's free-form key column is untouched; the target-state function
-- answers public / not_public / missing by composing the predicates that already own each question; the public
-- reader returns active items of active served menus in the operator's order, labelled with the D7 fallback,
-- omits an item whose target is not public and omits a child whose parent was omitted — owner decision 3 where
-- it is actually decided — and returns no rows at all for a menu left with nothing; a menu under an unserved key
-- is never read; the staff readers report every item with the state of its target and the manage capability;
-- every writer refuses a caller without the manage key with 42501; a save cannot show or hide anything; the
-- target is replaced as a unit so 0030's CHECK is never left unsatisfiable; a reorder is scoped to its own menu;
-- and the things this increment must NOT do hold — nothing reads a banner, an FAQ, a promotion or anything
-- financial, and `public.banners` keeps its reader-less state.

-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(250);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'navigation_can_read', array['uuid', 'boolean'], 'the read predicate exists');
select has_function('app_private', 'navigation_can_manage', array['uuid', 'boolean'],
  'the manage predicate exists');
select has_function('app_private', 'navigation_menu_key_is_served', array['text'],
  'the served-key predicate exists');
select has_function('app_private', 'navigation_target_state',
  array['text', 'uuid', 'uuid', 'uuid', 'text', 'text'], 'the target-state function exists');
select has_function('app_private', 'public_navigation_items', array['text[]', 'text'],
  'the public reader exists');
select has_function('app_private', 'navigation_menus_for_staff', array['uuid', 'boolean'],
  'the staff menu list exists');
select has_function('app_private', 'navigation_menu_for_staff', array['uuid', 'boolean', 'uuid'],
  'the staff menu detail exists');
select has_function('app_private', 'navigation_items_for_staff', array['uuid', 'boolean', 'uuid', 'text'],
  'the staff item list exists');
select has_function('app_private', 'navigation_menu_save_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'text'], 'the menu save writer exists');
select has_function('app_private', 'navigation_menu_state_for_staff',
  array['uuid', 'boolean', 'uuid', 'boolean'], 'the menu state writer exists');
select has_function('app_private', 'navigation_menu_delete_for_staff', array['uuid', 'boolean', 'uuid'],
  'the menu delete writer exists');
select has_function('app_private', 'navigation_item_save_for_staff',
  array['uuid', 'boolean', 'uuid', 'uuid', 'text', 'text', 'text', 'uuid', 'uuid', 'uuid', 'text', 'uuid',
        'boolean', 'integer'],
  'the item save writer exists');
select has_function('app_private', 'navigation_item_promote_for_staff', array['uuid', 'boolean', 'uuid'],
  'the promote writer exists');
select has_function('app_private', 'navigation_item_state_for_staff',
  array['uuid', 'boolean', 'uuid', 'boolean'], 'the item state writer exists');
select has_function('app_private', 'navigation_items_reorder_for_staff',
  array['uuid', 'boolean', 'uuid', 'uuid[]'], 'the reorder writer exists');
select has_function('app_private', 'navigation_item_delete_for_staff', array['uuid', 'boolean', 'uuid'],
  'the item delete writer exists');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'navigation%' or p.proname like 'public_navigation%')
      and p.prosecdef),
  16, 'all sixteen are security definer');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'navigation%' or p.proname like 'public_navigation%')
      and p.proconfig @> array['search_path=pg_catalog, public']),
  16, 'all sixteen pin search_path to pg_catalog, public');

select is((select count(*)::int from public.audit_attribution_problems()), 0,
  '0094 adds no audit attribution problem');

select matches(pg_get_function_result(p.oid), 'can_manage boolean',
  'the staff menu detail reports the manage capability')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'navigation_menu_for_staff';

select matches(pg_get_function_result(p.oid), 'renderable_item_count integer',
  'the staff menu detail reports how much of the menu the public would be shown')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'navigation_menu_for_staff';

select matches(pg_get_function_result(p.oid), 'target_state text',
  'the staff item list reports the state of each target')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'navigation_items_for_staff';

-- Owner decision 4 lives in the application's route map, so the public reader hands out the slug and derives
-- no address for the three id-bearing kinds.
select matches(pg_get_function_result(p.oid), 'target_slug text',
  'the public reader returns the target slug, so the route map can derive the address')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'public_navigation_items';

-- ---------------------------------------------------------------------------------------------------
-- What this increment must not read
-- ---------------------------------------------------------------------------------------------------
-- Read from the stored bodies rather than asserted by behaviour, because the point is that the code does not
-- mention these things at all.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'navigation%' or p.proname like 'public_navigation%')
      and (p.prosrc ~* 'promotion' or p.prosrc ~* 'placement' or p.prosrc ~* 'wallet'
           or p.prosrc ~* 'ranking' or p.prosrc ~* 'popularity')),
  0, 'no 0094 function mentions a promotion, a placement, a wallet, a ranking or a popularity signal');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'navigation%' or p.proname like 'public_navigation%')
      and (p.prosrc ~* 'ledger' or p.prosrc ~* 'payout' or p.prosrc ~* 'settlement'
           or p.prosrc ~* 'seller_balances' or p.prosrc ~* 'payment')),
  0, 'and none touches a financial table');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'navigation%' or p.proname like 'public_navigation%')
      and (p.prosrc ~ 'public\.banners' or p.prosrc ~ 'public\.faqs' or p.prosrc ~* 'cms_media')),
  0, 'and none reads a banner, an FAQ or a media row');

-- The two tables this increment deliberately leaves alone stay reader-less.
select has_table('public', 'banners', 'the banners table is untouched');
select has_table('public', 'faqs', 'the faqs table is untouched');
-- Narrowed in 0098, which gave `cms_media_references` the job of reporting every CMS row that points at one media
-- entry — and two of those six columns are `banners.media_id` and `banners.media_ar_id` (0098's owner decision 5).
-- The invariant is unchanged and is now **pinned rather than counted**: that one read-only reference reader is the
-- only function permitted to name the table, so nothing composes, serves or publishes a banner.
select is(
  (select coalesce(array_agg(p.proname::text order by p.proname), array[]::text[])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc ~ 'public\.banners'),
  array['cms_media_references'],
  'the only function naming public.banners is 0098''s reference reader, so no banner is served');
-- `public.faqs` has readers from 0095 onwards, which is the increment that gave the help centre one. What stays
-- true, and is what this file is actually about, is that **no 0094 function reads it** — asserted above, over the
-- navigation functions themselves. A global claim here would only record which increment came next.
select ok(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'navigation%' or p.proname like 'public_navigation%')
      and p.prosrc ~ 'public\.faqs') = 0,
  'no navigation function reads public.faqs');

-- ---------------------------------------------------------------------------------------------------
-- Owner decision 1 — three fixed keys, and 0030's column is still free-form
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.navigation_menu_key_is_served('header'), 'header is served');
select ok(app_private.navigation_menu_key_is_served('footer'), 'footer is served');
select ok(app_private.navigation_menu_key_is_served('mobile'), 'mobile is served');
select ok(not app_private.navigation_menu_key_is_served('sidebar'), 'sidebar is not served');
select ok(not app_private.navigation_menu_key_is_served('HEADER'), 'nor a different case of one that is');
select ok(not app_private.navigation_menu_key_is_served(null), 'nor a null key');

select ok(
  exists (select 1 from pg_constraint where conname = 'navigation_menus_key_format'),
  '0030''s free-form key format is untouched, so an unserved key stays legal');
select ok(
  exists (select 1 from pg_constraint where conname = 'navigation_items_target_matches_kind'),
  '0030''s target-matches-kind CHECK is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'navigation_items_path_is_relative'),
  '0030''s relative-path CHECK is untouched');
select ok(
  exists (select 1 from pg_trigger where tgname = 'navigation_items_depth'),
  '0030''s two-level depth trigger is untouched');
select has_function('public', 'cms_content_is_public', array['text', 'timestamptz'],
  '0030''s publication rule is untouched');
select has_function('app_private', 'public_category_visible', array['uuid'],
  '0049''s category visibility rule is untouched');

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select ok(has_function_privilege('app_system', p.oid, 'execute'),
    format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and (p.proname like 'navigation%' or p.proname like 'public_navigation%')
 order by p.proname;

select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
    format('%s may not execute %s', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_worker')) as r(rolname)
 where n.nspname = 'app_private' and (p.proname like 'navigation%' or p.proname like 'public_navigation%')
 order by r.rolname, p.proname;

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- An editor who holds both keys through the admin role (0033 grants both to admin and super_admin, and both
-- roles require MFA), and a signed-in person who holds neither.
insert into auth.users (id, email) values
  ('ad000000-0000-4000-8000-000000000001', 'nav-editor@example.test'),
  ('ad000000-0000-4000-8000-000000000002', 'nav-nobody@example.test');
insert into public.user_roles (user_id, role_key) values
  ('ad000000-0000-4000-8000-000000000001', 'admin');

create function pg_temp.editor() returns uuid language sql immutable as
  $f$ select 'ad000000-0000-4000-8000-000000000001'::uuid $f$;
create function pg_temp.nobody() returns uuid language sql immutable as
  $f$ select 'ad000000-0000-4000-8000-000000000002'::uuid $f$;

-- Two pages: one published at an address the web application serves, one still a draft.
insert into public.pages (id, slug, status, published_at, template) values
  ('ae000000-0000-4000-8000-000000000001', 'about', 'published', '2026-05-01T10:00:00Z', 'standard'),
  ('ae000000-0000-4000-8000-000000000002', 'nav-draft-page', 'draft', null, 'standard');
insert into public.page_translations (page_id, locale_code, title, body) values
  ('ae000000-0000-4000-8000-000000000001', 'en', 'About us', 'The body.'),
  ('ae000000-0000-4000-8000-000000000001', 'ar', 'من نحن', 'النص.'),
  ('ae000000-0000-4000-8000-000000000002', 'en', 'A draft page', 'The body.');

-- Two posts: one published, one archived.
insert into public.blog_posts (id, slug, status, published_at, archived_at) values
  ('af000000-0000-4000-8000-000000000001', 'nav-post-live', 'published', '2026-05-02T10:00:00Z', null),
  ('af000000-0000-4000-8000-000000000002', 'nav-post-gone', 'archived', null, now());
insert into public.blog_post_translations (blog_post_id, locale_code, title, body) values
  ('af000000-0000-4000-8000-000000000001', 'en', 'A live post', 'The body.'),
  ('af000000-0000-4000-8000-000000000002', 'en', 'An archived post', 'The body.');

-- Two categories: one visible, one under a deactivated parent.
insert into public.categories (id, parent_id, slug, listing_type_code, is_active, sort_order) values
  ('b0000000-0000-4000-8000-000000000001', null, 'nav-furniture', null, true, 1),
  ('b0000000-0000-4000-8000-000000000002', null, 'nav-closed-parent', null, false, 2),
  ('b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002', 'nav-child', null, true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('b0000000-0000-4000-8000-000000000001', 'en', 'Furniture'),
  ('b0000000-0000-4000-8000-000000000001', 'ar', 'أثاث'),
  ('b0000000-0000-4000-8000-000000000003', 'en', 'A child');

-- ---------------------------------------------------------------------------------------------------
-- The permission predicates
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.navigation_can_read(pg_temp.editor(), true), 'the editor may read at aal2');
select ok(app_private.navigation_can_manage(pg_temp.editor(), true), 'the editor may manage at aal2');
-- The admin role requires MFA, so 0003's own rule withholds both keys at aal1.
select ok(not app_private.navigation_can_read(pg_temp.editor(), false), 'the editor reads nothing at aal1');
select ok(not app_private.navigation_can_manage(pg_temp.editor(), false), 'the editor manages nothing at aal1');
select ok(not app_private.navigation_can_read(pg_temp.nobody(), true), 'a person without the role may not read');
select ok(not app_private.navigation_can_manage(pg_temp.nobody(), true),
  'a person without the role may not manage');
select ok(not app_private.navigation_can_read(null, true), 'a null account holds nothing');
select ok(not app_private.navigation_can_manage(null, true), 'a null account manages nothing');

insert into public.user_roles (user_id, role_key, revoked_at) values (pg_temp.nobody(), 'super_admin', now());
select ok(not app_private.navigation_can_read(pg_temp.nobody(), true), 'a revoked role grants no read');
delete from public.user_roles where user_id = pg_temp.nobody();

-- ---------------------------------------------------------------------------------------------------
-- The target-state function
-- ---------------------------------------------------------------------------------------------------
select is(
  (select state from app_private.navigation_target_state(
     'page', 'ae000000-0000-4000-8000-000000000001', null, null, null, 'en')),
  'public', 'a published page is public');
select is(
  (select slug from app_private.navigation_target_state(
     'page', 'ae000000-0000-4000-8000-000000000001', null, null, null, 'en')),
  'about', 'and its slug comes back, which is what the route map needs');
select is(
  (select target_title from app_private.navigation_target_state(
     'page', 'ae000000-0000-4000-8000-000000000001', null, null, null, 'ar')),
  'من نحن', 'the console sees the target''s own Arabic title where one exists');
select is(
  (select state from app_private.navigation_target_state(
     'page', 'ae000000-0000-4000-8000-000000000002', null, null, null, 'en')),
  'not_public', 'a draft page is not public');
select is(
  (select state from app_private.navigation_target_state(
     'page', 'b0000000-0000-4000-8000-00000000ffff', null, null, null, 'en')),
  'missing', 'a page id that names nothing is missing, not merely unpublished');
select is(
  (select state from app_private.navigation_target_state(
     'blog_post', null, 'af000000-0000-4000-8000-000000000001', null, null, 'en')),
  'public', 'a published post is public');
select is(
  (select state from app_private.navigation_target_state(
     'blog_post', null, 'af000000-0000-4000-8000-000000000002', null, null, 'en')),
  'not_public', 'an archived post is not');
select is(
  (select state from app_private.navigation_target_state(
     'category', null, null, 'b0000000-0000-4000-8000-000000000001', null, 'en')),
  'public', 'an active category is public');
select is(
  (select state from app_private.navigation_target_state(
     'category', null, null, 'b0000000-0000-4000-8000-000000000003', null, 'en')),
  'not_public', 'a category under a deactivated parent is not — 0049''s ancestry rule, composed and not rewritten');
select is(
  (select state from app_private.navigation_target_state('path', null, null, null, '/listings', 'en')),
  'public', 'a path item with a path is public');
select is(
  (select slug from app_private.navigation_target_state('path', null, null, null, '/listings', 'en')),
  null, 'a path item has no slug');
select is(
  (select state from app_private.navigation_target_state('path', null, null, null, '   ', 'en')),
  'missing', 'a path item with nothing in it is missing');

-- ---------------------------------------------------------------------------------------------------
-- Creating menus
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.navigation_menu_save_for_staff(%L, true, null, 'header', 'Header') $q$,
    pg_temp.nobody()),
  '42501', null, 'a caller without the manage key cannot save a menu');
select throws_ok(
  format($q$ select app_private.navigation_menu_save_for_staff(%L, false, null, 'header', 'Header') $q$,
    pg_temp.editor()),
  '42501', null, 'nor the editor at aal1');

create temporary table menu_ids as
select
  app_private.navigation_menu_save_for_staff(pg_temp.editor(), true, null, 'header', 'Header', 'الرأس')
    as header_id,
  app_private.navigation_menu_save_for_staff(pg_temp.editor(), true, null, 'footer', 'Footer', null)
    as footer_id,
  app_private.navigation_menu_save_for_staff(pg_temp.editor(), true, null, 'mobile', 'Mobile', null)
    as mobile_id,
  app_private.navigation_menu_save_for_staff(pg_temp.editor(), true, null, 'sidebar', 'Sidebar', null)
    as sidebar_id;

create function pg_temp.header() returns uuid language sql stable as
  $f$ select header_id from menu_ids $f$;
create function pg_temp.footer() returns uuid language sql stable as
  $f$ select footer_id from menu_ids $f$;
create function pg_temp.mobile() returns uuid language sql stable as
  $f$ select mobile_id from menu_ids $f$;
create function pg_temp.sidebar() returns uuid language sql stable as
  $f$ select sidebar_id from menu_ids $f$;

select isnt(pg_temp.header(), null, 'the header menu was created');
select is((select count(*)::int from public.navigation_menus), 4, 'four menus exist');

-- 0030 defaults a navigation menu to active, and the writer does not override its own schema.
select ok(
  (select m.is_active from public.navigation_menus m where m.id = pg_temp.header()),
  'a new menu is active, which is 0030''s default and not this writer''s opinion');

select throws_ok(
  format($q$ select app_private.navigation_menu_save_for_staff(%L, true, null, 'header', 'Again') $q$,
    pg_temp.editor()),
  '23505', null, 'a duplicate menu key is refused by 0030''s unique index');
select throws_ok(
  format($q$ select app_private.navigation_menu_save_for_staff(%L, true, null, 'Header Menu', 'Bad') $q$,
    pg_temp.editor()),
  '23514', null, 'and a key that is not the schema''s shape is refused by its CHECK');

select is(
  app_private.navigation_menu_save_for_staff(
    pg_temp.editor(), true, 'b1000000-0000-4000-8000-0000000000ff', 'header', 'No such menu'),
  null, 'saving a menu that does not exist returns null rather than creating one');

-- An edit leaves what it was not given alone.
select is(
  app_private.navigation_menu_save_for_staff(pg_temp.editor(), true, pg_temp.footer(), null, 'Site footer'),
  pg_temp.footer(), 'an edit returns the same id');
select is((select m.menu_key from public.navigation_menus m where m.id = pg_temp.footer()), 'footer',
  'and leaves the key alone when none was sent');
select is((select m.label_en from public.navigation_menus m where m.id = pg_temp.footer()), 'Site footer',
  'while changing the label that was');

-- ---------------------------------------------------------------------------------------------------
-- Creating items
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.navigation_item_save_for_staff(%L, true, null, %L, 'Home', null, 'path',
            null, null, null, '/') $q$, pg_temp.nobody(), pg_temp.header()),
  '42501', null, 'a caller without the manage key cannot save an item');

create temporary table item_ids as
select
  -- The header: a path item, a page item, a post item, a category item, and a draft-page item that must vanish.
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, null, (select header_id from menu_ids), 'Home', 'الرئيسية', 'path',
    null, null, null, '/', null, false, 10) as home_id,
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, null, (select header_id from menu_ids), 'About', 'من نحن', 'page',
    'ae000000-0000-4000-8000-000000000001', null, null, null, null, false, 20) as about_id,
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, null, (select header_id from menu_ids), 'Furniture', null, 'category',
    null, null, 'b0000000-0000-4000-8000-000000000001', null, null, false, 30) as furniture_id,
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, null, (select header_id from menu_ids), 'A post', null, 'blog_post',
    null, 'af000000-0000-4000-8000-000000000001', null, null, null, true, 40) as post_id,
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, null, (select header_id from menu_ids), 'Secret', null, 'page',
    'ae000000-0000-4000-8000-000000000002', null, null, null, null, false, 50) as draft_id,
  -- The footer: a heading whose own target is a path, with two children under it.
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, null, (select footer_id from menu_ids), 'Company', null, 'path',
    null, null, null, '/about', null, false, 10) as company_id,
  -- A heading whose target is the archived post: it and its child must both disappear.
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, null, (select footer_id from menu_ids), 'Gone heading', null, 'blog_post',
    null, 'af000000-0000-4000-8000-000000000002', null, null, null, false, 20) as gone_heading_id,
  -- The unserved menu, which must never be read publicly however correct its items are.
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, null, (select sidebar_id from menu_ids), 'Sidebar home', null, 'path',
    null, null, null, '/', null, false, 10) as sidebar_item_id;

create function pg_temp.home_item() returns uuid language sql stable as
  $f$ select home_id from item_ids $f$;
create function pg_temp.about_item() returns uuid language sql stable as
  $f$ select about_id from item_ids $f$;
create function pg_temp.furniture_item() returns uuid language sql stable as
  $f$ select furniture_id from item_ids $f$;
create function pg_temp.post_item() returns uuid language sql stable as
  $f$ select post_id from item_ids $f$;
create function pg_temp.draft_item() returns uuid language sql stable as
  $f$ select draft_id from item_ids $f$;
create function pg_temp.company_item() returns uuid language sql stable as
  $f$ select company_id from item_ids $f$;
create function pg_temp.gone_heading() returns uuid language sql stable as
  $f$ select gone_heading_id from item_ids $f$;

-- The children, created once their parents exist.
create temporary table child_ids as
select
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, null, pg_temp.footer(), 'About us', null, 'page',
    'ae000000-0000-4000-8000-000000000001', null, null, null, pg_temp.company_item(), false, 10)
    as about_child_id,
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, null, pg_temp.footer(), 'Our blog', null, 'path',
    null, null, null, '/blog', pg_temp.company_item(), false, 20) as blog_child_id,
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, null, pg_temp.footer(), 'Orphan', null, 'path',
    null, null, null, '/terms', pg_temp.gone_heading(), false, 10) as orphan_child_id;

create function pg_temp.about_child() returns uuid language sql stable as
  $f$ select about_child_id from child_ids $f$;
create function pg_temp.blog_child() returns uuid language sql stable as
  $f$ select blog_child_id from child_ids $f$;
create function pg_temp.orphan_child() returns uuid language sql stable as
  $f$ select orphan_child_id from child_ids $f$;

select isnt(pg_temp.home_item(), null, 'the header items were created');
select ok(
  (select i.is_active from public.navigation_items i where i.id = pg_temp.home_item()),
  'a new item is active, which is 0030''s default');
select is(
  (select i.target_kind from public.navigation_items i where i.id = pg_temp.about_item()), 'page',
  'a page item records its kind');
select is(
  (select i.page_id from public.navigation_items i where i.id = pg_temp.about_item()),
  'ae000000-0000-4000-8000-000000000001'::uuid, 'and the page it points at');
select is(
  (select i.path from public.navigation_items i where i.id = pg_temp.about_item()), null,
  'and nothing else: the other three target columns stay empty');
select ok(
  (select i.opens_in_new_tab from public.navigation_items i where i.id = pg_temp.post_item()),
  'opens_in_new_tab is stored as given (owner decision 6)');

-- A target column that does not belong to the kind is dropped rather than written, so 0030's CHECK holds.
select is(
  (select i.category_id from public.navigation_items i
    where i.id = app_private.navigation_item_save_for_staff(
      pg_temp.editor(), true, null, pg_temp.sidebar(), 'Mixed', null, 'path',
      'ae000000-0000-4000-8000-000000000001', 'af000000-0000-4000-8000-000000000001',
      'b0000000-0000-4000-8000-000000000001', '/listings', null, false, 90)),
  null, 'a save that names a path drops the page, post and category it was also handed');

select throws_ok(
  format($q$ select app_private.navigation_item_save_for_staff(%L, true, null, %L, 'Offsite', null, 'path',
            null, null, null, '//evil.example') $q$, pg_temp.editor(), pg_temp.header()),
  '23514', null, 'a protocol-relative path is refused by 0030''s relative-path CHECK');

select throws_ok(
  format($q$ select app_private.navigation_item_save_for_staff(%L, true, null, %L, 'Deep', null, 'path',
            null, null, null, '/deep', %L) $q$, pg_temp.editor(), pg_temp.footer(), pg_temp.about_child()),
  '23514', null, 'a third level is refused by 0030''s depth trigger');

select throws_ok(
  format($q$ select app_private.navigation_item_save_for_staff(%L, true, null, %L, 'Crossed', null, 'path',
            null, null, null, '/crossed', %L) $q$, pg_temp.editor(), pg_temp.header(), pg_temp.company_item()),
  '23514', null, 'and a child in a different menu from its parent is refused by the same trigger');

-- ---------------------------------------------------------------------------------------------------
-- The public reader — owner decision 3
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.public_navigation_items(array['header'], 'en')),
  4, 'the header serves its four renderable items and not the one pointing at a draft page');

select is(
  (select array_agg(label order by sort_order)
     from app_private.public_navigation_items(array['header'], 'en')),
  array['Home', 'About', 'Furniture', 'A post'],
  'in the operator''s own order, with the operator''s own labels');

select is(
  (select array_agg(label order by sort_order)
     from app_private.public_navigation_items(array['header'], 'ar')),
  array['الرئيسية', 'من نحن', 'Furniture', 'A post'],
  'the Arabic label where one was written and the English one where none was (D7)');

select is(
  (select menu_label from app_private.public_navigation_items(array['header'], 'ar') limit 1),
  'الرأس', 'the menu''s own label follows the same fallback');

select ok(
  not exists (select 1 from app_private.public_navigation_items(array['header'], 'en')
               where item_id = pg_temp.draft_item()),
  'an item whose page is still a draft is omitted entirely (owner decision 3)');

select is(
  (select target_slug from app_private.public_navigation_items(array['header'], 'en')
    where item_id = pg_temp.about_item()),
  'about', 'a page item carries its slug, not an address');
select is(
  (select target_path from app_private.public_navigation_items(array['header'], 'en')
    where item_id = pg_temp.about_item()),
  null, 'and no literal path, because the route map is the caller''s');
select is(
  (select target_path from app_private.public_navigation_items(array['header'], 'en')
    where item_id = pg_temp.home_item()),
  '/', 'a path item carries exactly the path it was given');
select is(
  (select depth from app_private.public_navigation_items(array['header'], 'en')
    where item_id = pg_temp.home_item()),
  1, 'a top-level item is depth 1');

-- The footer: the surviving heading with its two children, and nothing from the heading that disappeared.
select is(
  (select count(*)::int from app_private.public_navigation_items(array['footer'], 'en')),
  3, 'the footer serves its heading and two children');
select is(
  (select array_agg(label order by root_sort_order, root_item_id, depth, sort_order)
     from app_private.public_navigation_items(array['footer'], 'en')),
  array['Company', 'About us', 'Our blog'], 'a parent comes before the children that sit under it');
select is(
  (select depth from app_private.public_navigation_items(array['footer'], 'en')
    where item_id = pg_temp.about_child()),
  2, 'a child is depth 2 (owner decision 5: two levels, and 0030 enforces the limit)');
select is(
  (select parent_item_id from app_private.public_navigation_items(array['footer'], 'en')
    where item_id = pg_temp.about_child()),
  pg_temp.company_item(), 'and reports the parent it belongs to');
select ok(
  not exists (select 1 from app_private.public_navigation_items(array['footer'], 'en')
               where item_id = pg_temp.gone_heading()),
  'a heading whose post was archived is omitted');
select ok(
  not exists (select 1 from app_private.public_navigation_items(array['footer'], 'en')
               where item_id = pg_temp.orphan_child()),
  'and its child goes with it, because an entry without its heading is not what was arranged');

-- Several menus in one read, which is what lets a page render its chrome with one round trip.
select is(
  (select count(distinct menu_key)::int
     from app_private.public_navigation_items(array['header', 'footer', 'mobile'], 'en')),
  2, 'asking for three menus returns the two that have renderable items');
select ok(
  not exists (select 1 from app_private.public_navigation_items(array['header', 'footer', 'mobile'], 'en')
               where menu_key = 'mobile'),
  'a menu with no items at all returns no rows, which is how it disappears (owner decision 3)');

-- Owner decision 1 again, from the other side.
select is(
  (select count(*)::int from app_private.public_navigation_items(array['sidebar'], 'en')),
  0, 'a menu under an unserved key is never read publicly, however correct its items are');
select is(
  (select count(*)::int from app_private.public_navigation_items(array['header', 'sidebar'], 'en')),
  4, 'and asking for it alongside a served key does not smuggle it in');
select is(
  (select count(*)::int from app_private.public_navigation_items(null, 'en')),
  0, 'a null key list reads nothing rather than everything');
select is(
  (select count(*)::int from app_private.public_navigation_items(array[]::text[], 'en')),
  0, 'and so does an empty one');

-- Hiding things, at each level.
select ok(app_private.navigation_item_state_for_staff(pg_temp.editor(), true, pg_temp.home_item(), false),
  'an item can be hidden');
select is(
  (select count(*)::int from app_private.public_navigation_items(array['header'], 'en')),
  3, 'and leaves the public menu at once');
select ok(app_private.navigation_item_state_for_staff(pg_temp.editor(), true, pg_temp.home_item(), true),
  'and can be shown again');

select ok(app_private.navigation_item_state_for_staff(pg_temp.editor(), true, pg_temp.company_item(), false),
  'a heading can be hidden');
select is(
  (select count(*)::int from app_private.public_navigation_items(array['footer'], 'en')),
  0, 'which takes its children off the public menu and empties the footer');
select ok(app_private.navigation_item_state_for_staff(pg_temp.editor(), true, pg_temp.company_item(), true),
  'and shown again');

select ok(app_private.navigation_menu_state_for_staff(pg_temp.editor(), true, pg_temp.header(), false),
  'a menu can be hidden');
select is(
  (select count(*)::int from app_private.public_navigation_items(array['header'], 'en')),
  0, 'and the whole menu leaves the public surfaces at once');
select ok(app_private.navigation_menu_state_for_staff(pg_temp.editor(), true, pg_temp.header(), true),
  'and shown again');

-- Content going away is enough on its own: nothing has to be edited for the menu to correct itself.
update public.categories set is_active = false where id = 'b0000000-0000-4000-8000-000000000001';
select ok(
  not exists (select 1 from app_private.public_navigation_items(array['header'], 'en')
               where item_id = pg_temp.furniture_item()),
  'deactivating a category removes the item that pointed at it, with no edit to the menu');
update public.categories set is_active = true where id = 'b0000000-0000-4000-8000-000000000001';

update public.blog_posts set status = 'archived', archived_at = now(), published_at = null
 where id = 'af000000-0000-4000-8000-000000000001';
select ok(
  not exists (select 1 from app_private.public_navigation_items(array['header'], 'en')
               where item_id = pg_temp.post_item()),
  'and archiving a post removes the item that pointed at it');
update public.blog_posts set status = 'published', published_at = '2026-05-02T10:00:00Z', archived_at = null
 where id = 'af000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from app_private.public_navigation_items(array['header'], 'en')),
  4, 'and publishing it again brings the item back');

-- ---------------------------------------------------------------------------------------------------
-- The staff readers
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.navigation_menus_for_staff(pg_temp.editor(), true)),
  4, 'the staff list shows every menu, served or not');
select is(
  (select array_agg(menu_key order by ordinality)
     from (select menu_key, row_number() over () as ordinality
             from app_private.navigation_menus_for_staff(pg_temp.editor(), true)) ordered),
  array['footer', 'header', 'mobile', 'sidebar'], 'served menus first, then the rest, each set by key');
select ok(
  (select is_served from app_private.navigation_menus_for_staff(pg_temp.editor(), true)
    where menu_key = 'header'), 'the header is marked as served');
select ok(
  not (select is_served from app_private.navigation_menus_for_staff(pg_temp.editor(), true)
        where menu_key = 'sidebar'), 'and the sidebar is marked as one the public site does not place');
select is(
  (select item_count from app_private.navigation_menus_for_staff(pg_temp.editor(), true)
    where menu_key = 'header'), 5, 'the header holds five items');
select is(
  (select renderable_item_count from app_private.navigation_menus_for_staff(pg_temp.editor(), true)
    where menu_key = 'header'), 4, 'four of which the public would be shown');
select is(
  (select renderable_item_count from app_private.navigation_menus_for_staff(pg_temp.editor(), true)
    where menu_key = 'mobile'), 0, 'and an empty menu says so, which is why it is skipped');

select is(
  (select count(*)::int from app_private.navigation_menus_for_staff(pg_temp.nobody(), true)),
  0, 'a caller without the read key sees no menu at all');
select is(
  (select count(*)::int from app_private.navigation_menus_for_staff(pg_temp.editor(), false)),
  0, 'and neither does the editor at aal1');

select is(
  (select menu_key from app_private.navigation_menu_for_staff(pg_temp.editor(), true, pg_temp.header())),
  'header', 'the staff detail returns the menu');
select ok(
  (select can_manage from app_private.navigation_menu_for_staff(pg_temp.editor(), true, pg_temp.header())),
  'and reports that this caller may change it');
select is(
  (select count(*)::int
     from app_private.navigation_menu_for_staff(pg_temp.editor(), true,
       'b1000000-0000-4000-8000-0000000000ff')),
  0, 'a menu that does not exist is no row');
select is(
  (select count(*)::int from app_private.navigation_menu_for_staff(pg_temp.nobody(), true, pg_temp.header())),
  0, 'and so is a menu the caller may not read, so the two look alike');

select is(
  (select count(*)::int from app_private.navigation_items_for_staff(pg_temp.editor(), true, pg_temp.header())),
  5, 'the staff item list shows every item of the menu, including the one the public never sees');
select is(
  (select target_state from app_private.navigation_items_for_staff(pg_temp.editor(), true, pg_temp.header())
    where item_id = pg_temp.draft_item()),
  'not_public', 'and says why: its page is not published (owner decision 3''s console requirement)');
select is(
  (select target_title from app_private.navigation_items_for_staff(pg_temp.editor(), true, pg_temp.header())
    where item_id = pg_temp.draft_item()),
  'A draft page', 'with the target''s own title, so an operator can recognise the row');
select is(
  (select target_slug from app_private.navigation_items_for_staff(pg_temp.editor(), true, pg_temp.header())
    where item_id = pg_temp.draft_item()),
  'nav-draft-page', 'and its slug, which is how an unservable address is recognised in the console');
select is(
  (select count(*)::int from app_private.navigation_items_for_staff(pg_temp.nobody(), true, pg_temp.header())),
  0, 'a caller without the read key sees no item');

-- A target row that is deleted outright is reported as missing rather than vanishing from the console.
delete from public.pages where id = 'ae000000-0000-4000-8000-000000000002';
select is(
  (select target_state from app_private.navigation_items_for_staff(pg_temp.editor(), true, pg_temp.header())
    where item_id = pg_temp.draft_item()),
  null, 'deleting the page cascades the item away, which is 0030''s own on delete cascade');
select is(
  (select count(*)::int from app_private.navigation_items_for_staff(pg_temp.editor(), true, pg_temp.header())),
  4, 'so the menu has one fewer item and nothing dangles');

-- ---------------------------------------------------------------------------------------------------
-- Editing an item
-- ---------------------------------------------------------------------------------------------------
-- Changing the target kind replaces all four columns at once, so the CHECK is never momentarily unsatisfiable.
select is(
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, pg_temp.about_item(), null, null, null, 'path',
    null, null, null, '/about-us'),
  pg_temp.about_item(), 'an item can be turned from a page item into a path item');
select is(
  (select i.page_id from public.navigation_items i where i.id = pg_temp.about_item()), null,
  'and the page it used to point at is cleared in the same statement');
select is(
  (select i.path from public.navigation_items i where i.id = pg_temp.about_item()), '/about-us',
  'while the path is filled');
select is(
  (select i.label_en from public.navigation_items i where i.id = pg_temp.about_item()), 'About',
  'and the label nobody sent is left alone');

-- Omitting the kind leaves the target entirely alone, which is what editing a label is.
select is(
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, pg_temp.about_item(), null, 'About this site'),
  pg_temp.about_item(), 'an item''s label can be edited on its own');
select is(
  (select i.path from public.navigation_items i where i.id = pg_temp.about_item()), '/about-us',
  'and the target is untouched');
select is(
  (select i.sort_order from public.navigation_items i where i.id = pg_temp.about_item()), 20,
  'and so is its position — the 0092 lesson: an omitted argument must not reorder anything');
select ok(
  (select i.is_active from public.navigation_items i where i.id = pg_temp.about_item()),
  'and a save cannot change whether it is shown');

select is(
  app_private.navigation_item_save_for_staff(
    pg_temp.editor(), true, 'b1000000-0000-4000-8000-0000000000fe', null, 'Nothing'),
  null, 'saving an item that does not exist returns null rather than creating one');

-- Promoting a child, which the save deliberately cannot express.
select ok(app_private.navigation_item_promote_for_staff(pg_temp.editor(), true, pg_temp.blog_child()),
  'a second-level item can be promoted to the top level');
select is(
  (select i.parent_id from public.navigation_items i where i.id = pg_temp.blog_child()), null,
  'and its parent is cleared');
select ok(
  not app_private.navigation_item_promote_for_staff(pg_temp.editor(), true, pg_temp.blog_child()),
  'promoting one that is already at the top level reports that nothing changed');
select throws_ok(
  format($q$ select app_private.navigation_item_promote_for_staff(%L, true, %L) $q$,
    pg_temp.nobody(), pg_temp.about_child()),
  '42501', null, 'and a caller without the manage key cannot promote anything');

-- ---------------------------------------------------------------------------------------------------
-- Reordering
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.navigation_items_reorder_for_staff(%L, true, %L, array[%L]::uuid[]) $q$,
    pg_temp.nobody(), pg_temp.header(), pg_temp.about_item()),
  '42501', null, 'a caller without the manage key cannot reorder');

select is(
  app_private.navigation_items_reorder_for_staff(
    pg_temp.editor(), true, pg_temp.header(),
    array[pg_temp.post_item(), pg_temp.about_item(), pg_temp.furniture_item(), pg_temp.home_item()]),
  4, 'a reorder moves exactly the items it named');
select is(
  (select array_agg(label order by sort_order)
     from app_private.public_navigation_items(array['header'], 'en')),
  array['A post', 'About this site', 'Furniture', 'Home'], 'and the public order is the one that was sent');
select is(
  (select array_agg(i.sort_order order by i.sort_order) from public.navigation_items i
    where i.menu_id = pg_temp.header()),
  array[0, 10, 20, 30], 'with positions spaced by ten so a later insertion needs no rewrite');

-- Scoped to its own menu: an id from elsewhere moves nothing.
select is(
  app_private.navigation_items_reorder_for_staff(
    pg_temp.editor(), true, pg_temp.header(), array[pg_temp.company_item()]),
  0, 'an id belonging to another menu moves nothing');
select is(
  (select i.sort_order from public.navigation_items i where i.id = pg_temp.company_item()), 10,
  'and that item keeps the position it had');
select is(
  app_private.navigation_items_reorder_for_staff(pg_temp.editor(), true, pg_temp.header(), null),
  0, 'a null order moves nothing rather than flattening the menu');

-- ---------------------------------------------------------------------------------------------------
-- Deleting
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.navigation_item_delete_for_staff(%L, true, %L) $q$,
    pg_temp.nobody(), pg_temp.about_item()),
  '42501', null, 'a caller without the manage key cannot delete an item');
select ok(app_private.navigation_item_delete_for_staff(pg_temp.editor(), true, pg_temp.about_item()),
  'an item can be deleted');
select ok(
  not app_private.navigation_item_delete_for_staff(pg_temp.editor(), true, pg_temp.about_item()),
  'and deleting it twice reports that nothing matched');
select is(
  (select count(*)::int from app_private.public_navigation_items(array['header'], 'en')),
  3, 'and it is gone from the public menu');

-- A heading's children go with it, which is 0030's self-reference cascade.
select ok(app_private.navigation_item_delete_for_staff(pg_temp.editor(), true, pg_temp.company_item()),
  'a heading can be deleted');
select is(
  (select count(*)::int from public.navigation_items i where i.id = pg_temp.about_child()),
  0, 'and the entries under it go with it (0030''s cascade)');

select throws_ok(
  format($q$ select app_private.navigation_menu_delete_for_staff(%L, true, %L) $q$,
    pg_temp.nobody(), pg_temp.sidebar()),
  '42501', null, 'a caller without the manage key cannot delete a menu');
select ok(app_private.navigation_menu_delete_for_staff(pg_temp.editor(), true, pg_temp.sidebar()),
  'a menu can be deleted');
select is(
  (select count(*)::int from public.navigation_items i where i.menu_id = pg_temp.sidebar()),
  0, 'and its items go with it');
select ok(
  not app_private.navigation_menu_delete_for_staff(pg_temp.editor(), true, pg_temp.sidebar()),
  'deleting it twice reports that nothing matched');

-- ---------------------------------------------------------------------------------------------------
-- Nothing else moved
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from public.audit_attribution_problems()), 0,
  'and the attribution contract still holds after every write above');
select is(app_private.assert_security_contract(), 0, 'the security contract still holds');

select * from finish();
rollback;
