-- 0093 — The homepage: the named composer and the authoring functions.
--
-- What is proven here, in order: the two permission predicates apply 0003's requires_mfa rule; the public reader
-- returns only active sections of a served type, in the administrator's order, titled with the D7 fallback;
-- every by-id resolver preserves the chosen order exactly and omits a row that is no longer visible, which is
-- owner decision C where it is actually decided; the staff detail reports how much of a section is still
-- renderable, so a skipped section is explainable from the console; every writer refuses a caller without the
-- manage key with 42501; a save cannot show a section and an edit cannot reorder the homepage; and the three
-- things this increment must NOT do hold — nothing reads a promotion, `banner_strip` is never served, and
-- `public.banners` keeps its reader-less state.

-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(225);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'homepage_can_read', array['uuid', 'boolean'], 'the read predicate exists');
select has_function('app_private', 'homepage_can_manage', array['uuid', 'boolean'],
  'the manage predicate exists');
select has_function('app_private', 'homepage_section_type_is_served', array['text'],
  'the served-type predicate exists');
select has_function('app_private', 'public_homepage_sections', array['text'], 'the public section reader exists');
select has_function('app_private', 'public_homepage_listings', array['uuid[]', 'integer'],
  'the listing resolver exists');
select has_function('app_private', 'public_homepage_latest_listings', array['integer'],
  'the latest-listings reader exists');
select has_function('app_private', 'public_homepage_categories', array['uuid[]', 'text', 'integer'],
  'the category resolver exists');
select has_function('app_private', 'public_homepage_sellers', array['uuid[]', 'integer'],
  'the seller resolver exists');
select has_function('app_private', 'public_homepage_posts', array['text', 'integer'],
  'the post reader exists');
select has_function('app_private', 'homepage_sections_for_staff', array['uuid', 'boolean'],
  'the staff list exists');
select has_function('app_private', 'homepage_section_for_staff', array['uuid', 'boolean', 'uuid'],
  'the staff detail exists');
select has_function('app_private', 'homepage_section_save_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'jsonb', 'integer'],
  'the save writer exists');
select has_function('app_private', 'homepage_section_state_for_staff',
  array['uuid', 'boolean', 'uuid', 'boolean'], 'the state writer exists');
select has_function('app_private', 'homepage_sections_reorder_for_staff', array['uuid', 'boolean', 'uuid[]'],
  'the reorder writer exists');
select has_function('app_private', 'homepage_section_delete_for_staff', array['uuid', 'boolean', 'uuid'],
  'the delete writer exists');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'homepage%' or p.proname like 'public_homepage%')
      and p.prosecdef),
  15, 'all fifteen are security definer');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'homepage%' or p.proname like 'public_homepage%')
      and p.proconfig @> array['search_path=pg_catalog, public']),
  15, 'all fifteen pin search_path to pg_catalog, public');

select is((select count(*)::int from public.audit_attribution_problems()), 0,
  '0093 adds no audit attribution problem');

-- The staff detail reports the renderable count, which is how owner decision C becomes explainable.
select matches(pg_get_function_result(p.oid), 'renderable_count integer',
  'the staff detail reports how much of a section is still renderable')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'homepage_section_for_staff';

select matches(pg_get_function_result(p.oid), 'can_manage boolean',
  'the staff detail reports the manage capability')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'homepage_section_for_staff';

-- ---------------------------------------------------------------------------------------------------
-- Owner decision A — nothing here reads a promotion, a placement, a wallet or a ranking setting
-- ---------------------------------------------------------------------------------------------------
-- Read from the stored function bodies rather than asserted by behaviour, because the point is that the code
-- does not mention them at all: a featured section is editorial and nothing else.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'homepage%' or p.proname like 'public_homepage%')
      and (p.prosrc ~* 'promotion' or p.prosrc ~* 'placement' or p.prosrc ~* 'wallet'
           or p.prosrc ~* 'ranking' or p.prosrc ~* 'promotion_package')),
  0, 'no 0093 function mentions a promotion, a placement, a wallet or a ranking setting');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'homepage%' or p.proname like 'public_homepage%')
      and (p.prosrc ~* 'ledger' or p.prosrc ~* 'payout' or p.prosrc ~* 'settlement'
           or p.prosrc ~* 'seller_balances' or p.prosrc ~* 'payment')),
  0, 'and none touches a financial table either');

-- The promotions module is untouched: its own homepage placement still exists and still has no reader here.
select ok(
  exists (select 1 from pg_constraint where conname = 'promotion_package_placements_allowed'),
  '0025''s placement constraint is untouched, homepage placement included');

-- ---------------------------------------------------------------------------------------------------
-- Owner decision — banner_strip is excluded, and banners keep their reader-less state
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.homepage_section_type_is_served('hero'), 'hero is served');
select ok(app_private.homepage_section_type_is_served('featured_listings'), 'featured_listings is served');
select ok(app_private.homepage_section_type_is_served('featured_categories'), 'featured_categories is served');
select ok(app_private.homepage_section_type_is_served('featured_sellers'), 'featured_sellers is served');
select ok(app_private.homepage_section_type_is_served('latest_listings'), 'latest_listings is served');
select ok(app_private.homepage_section_type_is_served('blog_highlights'), 'blog_highlights is served');
select ok(app_private.homepage_section_type_is_served('value_props'), 'value_props is served');
select ok(app_private.homepage_section_type_is_served('rich_text'), 'rich_text is served');
-- The one exclusion: a banner is its image and no media origin exists to address one with.
select ok(not app_private.homepage_section_type_is_served('banner_strip'), 'banner_strip is not served');
select ok(not app_private.homepage_section_type_is_served('nonsense'), 'nor is a type nobody has');

-- 0030's own constraint still admits all nine, so the exclusion is this increment's and not a schema change.
select ok(
  exists (select 1 from pg_constraint where conname = 'homepage_sections_type_allowed'),
  '0030''s nine-type constraint is untouched');
select has_table('public', 'banners', 'the banners table is untouched');
select has_function('public', 'banner_is_live', array['boolean', 'timestamptz', 'timestamptz'],
  '0030''s banner predicate is untouched');
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

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select ok(has_function_privilege('app_system', p.oid, 'execute'),
    format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and (p.proname like 'homepage%' or p.proname like 'public_homepage%')
 order by p.proname;

select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
    format('%s may not execute %s', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_worker')) as r(rolname)
 where n.nspname = 'app_private' and (p.proname like 'homepage%' or p.proname like 'public_homepage%')
 order by r.rolname, p.proname;

-- ---------------------------------------------------------------------------------------------------
-- Nothing in 0030 was changed
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'homepage_sections', 'the sections table is untouched');
select ok(
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'homepage_sections' and not t.tgisinternal) >= 2,
  '0030''s two homepage_sections triggers are still installed');
select has_function('public', 'listing_status_is_purchasable', array['text'],
  '0011''s purchasability rule is untouched');
select has_function('public', 'is_seller_publicly_visible', array['uuid'],
  '0009''s seller visibility rule is untouched');
select has_function('app_private', 'public_category_visible', array['uuid'],
  '0049''s category visibility rule is untouched');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- An editor who holds both keys through the admin role (0033 grants both to admin and super_admin, and both
-- roles require MFA), and a signed-in person who holds neither.
insert into auth.users (id, email) values
  ('ac000000-0000-4000-8000-000000000001', 'homepage-editor@example.test'),
  ('ac000000-0000-4000-8000-000000000002', 'homepage-nobody@example.test'),
  ('ac000000-0000-4000-8000-00000000000a', 'homepage-seller@example.test'),
  ('ac000000-0000-4000-8000-00000000000b', 'homepage-gone@example.test');
insert into public.user_roles (user_id, role_key) values
  ('ac000000-0000-4000-8000-000000000001', 'admin');

create function pg_temp.editor() returns uuid language sql immutable as
  $f$ select 'ac000000-0000-4000-8000-000000000001'::uuid $f$;
create function pg_temp.nobody() returns uuid language sql immutable as
  $f$ select 'ac000000-0000-4000-8000-000000000002'::uuid $f$;
create function pg_temp.seller() returns uuid language sql immutable as
  $f$ select 'ac000000-0000-4000-8000-00000000000a'::uuid $f$;
create function pg_temp.gone_seller() returns uuid language sql immutable as
  $f$ select 'ac000000-0000-4000-8000-00000000000b'::uuid $f$;

insert into public.currencies
  (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTH', '966', 'H', 2, true, false, true, true);
insert into public.countries
  (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZH', 'ZHZ', '996', 'Homeland', 'Homeland', '996', 'XTH', true);

insert into public.seller_profiles
  (user_id, slug, display_name, country_code, city, bio, status, verification_status, verified_at,
   suspended_at, suspension_reason)
values
  (pg_temp.seller(), 'home-shop', 'Home Shop', 'ZH', 'Cairo', 'A good shop.', 'active', 'verified', now(),
   null, null),
  (pg_temp.gone_seller(), 'gone-shop', 'Gone Shop', 'ZH', 'Giza', null, 'suspended', 'verified', now(),
   now(), 'Suspended for the purposes of this test');

-- Two visible categories and one that will be deactivated.
insert into public.categories (id, parent_id, slug, listing_type_code, is_active, sort_order, icon) values
  ('cc000000-0000-4000-8000-000000000001', null, 'home-furniture', null, true, 1, 'sofa'),
  ('cc000000-0000-4000-8000-000000000002', null, 'home-audio', null, true, 2, 'speaker'),
  ('cc000000-0000-4000-8000-000000000003', null, 'home-hidden', null, false, 3, null);
insert into public.category_translations (category_id, locale_code, name) values
  ('cc000000-0000-4000-8000-000000000001', 'en', 'Furniture'),
  ('cc000000-0000-4000-8000-000000000001', 'ar', 'أثاث'),
  ('cc000000-0000-4000-8000-000000000002', 'en', 'Audio'),
  ('cc000000-0000-4000-8000-000000000003', 'en', 'Hidden');

-- One purchasable listing, one sold, and one belonging to the suspended seller.
insert into public.listings
  (id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
   currency_code, price_minor, is_negotiable, status, country_code, city, approved_at, created_at, sold_at)
values
  ('11220000-0000-4000-8000-000000000001', pg_temp.seller(), 'product',
   'cc000000-0000-4000-8000-000000000001', 'home-chair', 'A chair',
   'A chair described well enough to be real.', 'en', 'XTH', 10000, true, 'active', 'ZH', 'Cairo', now(),
   '2026-05-01T10:00:00Z', null),
  ('11220000-0000-4000-8000-000000000002', pg_temp.seller(), 'product',
   'cc000000-0000-4000-8000-000000000001', 'home-table', 'A table',
   'A table described well enough to be real.', 'en', 'XTH', 20000, false, 'active', 'ZH', 'Cairo', now(),
   '2026-05-02T10:00:00Z', null),
  ('11220000-0000-4000-8000-000000000003', pg_temp.seller(), 'product',
   'cc000000-0000-4000-8000-000000000001', 'home-sold', 'A sold lamp',
   'A lamp described well enough to be real.', 'en', 'XTH', 5000, false, 'sold', 'ZH', 'Cairo', now(),
   '2026-05-03T10:00:00Z', now()),
  ('11220000-0000-4000-8000-000000000004', pg_temp.gone_seller(), 'product',
   'cc000000-0000-4000-8000-000000000001', 'home-orphan', 'An orphaned stool',
   'A stool described well enough to be real.', 'en', 'XTH', 7000, false, 'active', 'ZH', 'Giza', now(),
   '2026-05-04T10:00:00Z', null);

-- One published post and one draft, for blog_highlights.
insert into public.blog_posts (id, slug, status, published_at) values
  ('bb000000-0000-4000-8000-000000000001', 'home-post-live', 'published', '2026-05-05T10:00:00Z'),
  ('bb000000-0000-4000-8000-000000000002', 'home-post-draft', 'draft', null);
insert into public.blog_post_translations (blog_post_id, locale_code, title, excerpt, body) values
  ('bb000000-0000-4000-8000-000000000001', 'en', 'A live post', 'Worth reading.', 'The body.'),
  ('bb000000-0000-4000-8000-000000000002', 'en', 'A draft post', null, 'The body.');

-- ---------------------------------------------------------------------------------------------------
-- The permission predicates
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.homepage_can_read(pg_temp.editor(), true), 'the editor may read at aal2');
select ok(app_private.homepage_can_manage(pg_temp.editor(), true), 'the editor may manage at aal2');
-- The admin role requires MFA, so 0003's own rule withholds both keys at aal1.
select ok(not app_private.homepage_can_read(pg_temp.editor(), false), 'the editor reads nothing at aal1');
select ok(not app_private.homepage_can_manage(pg_temp.editor(), false), 'the editor manages nothing at aal1');
select ok(not app_private.homepage_can_read(pg_temp.nobody(), true), 'a person without the role may not read');
select ok(not app_private.homepage_can_manage(pg_temp.nobody(), true),
  'a person without the role may not manage');
select ok(not app_private.homepage_can_read(null, true), 'a null account holds nothing');
select ok(not app_private.homepage_can_manage(null, true), 'a null account manages nothing');

insert into public.user_roles (user_id, role_key, revoked_at) values (pg_temp.nobody(), 'super_admin', now());
select ok(not app_private.homepage_can_read(pg_temp.nobody(), true), 'a revoked role grants no read');
delete from public.user_roles where user_id = pg_temp.nobody();

-- ---------------------------------------------------------------------------------------------------
-- Creating sections
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.homepage_section_save_for_staff(%L, true, null, 'hero', 'hero') $q$,
    pg_temp.nobody()),
  '42501', null, 'a caller without the manage key cannot save a section');
select throws_ok(
  format($q$ select app_private.homepage_section_save_for_staff(%L, false, null, 'hero', 'hero') $q$,
    pg_temp.editor()),
  '42501', null, 'nor the editor at aal1');

create temporary table section_ids as
select
  app_private.homepage_section_save_for_staff(
    pg_temp.editor(), true, null, 'home_hero', 'hero', 'Welcome', 'أهلاً', 'Buy and sell', 'اشترِ وبِع',
    '{"lead":"Find what you need."}'::jsonb, 10) as hero_id,
  app_private.homepage_section_save_for_staff(
    pg_temp.editor(), true, null, 'home_picks', 'featured_listings', 'Our picks', null, null, null,
    format('{"ids":["%s","%s","%s","%s"]}',
      '11220000-0000-4000-8000-000000000002', '11220000-0000-4000-8000-000000000001',
      '11220000-0000-4000-8000-000000000003', '11220000-0000-4000-8000-000000000004')::jsonb, 20)
    as picks_id,
  app_private.homepage_section_save_for_staff(
    pg_temp.editor(), true, null, 'home_shelves', 'featured_categories', 'Shelves', null, null, null,
    format('{"ids":["%s","%s","%s"]}',
      'cc000000-0000-4000-8000-000000000002', 'cc000000-0000-4000-8000-000000000001',
      'cc000000-0000-4000-8000-000000000003')::jsonb, 30) as shelves_id,
  app_private.homepage_section_save_for_staff(
    pg_temp.editor(), true, null, 'home_shops', 'featured_sellers', 'Shops', null, null, null,
    format('{"ids":["%s","%s"]}', pg_temp.gone_seller(), pg_temp.seller())::jsonb, 40) as shops_id,
  app_private.homepage_section_save_for_staff(
    pg_temp.editor(), true, null, 'home_latest', 'latest_listings', 'Just listed', null, null, null,
    '{"count":2}'::jsonb, 50) as latest_id,
  app_private.homepage_section_save_for_staff(
    pg_temp.editor(), true, null, 'home_blog', 'blog_highlights', 'From the blog', null, null, null,
    '{"count":2}'::jsonb, 60) as blog_id,
  app_private.homepage_section_save_for_staff(
    pg_temp.editor(), true, null, 'home_strip', 'banner_strip', 'A strip', null, null, null,
    '{}'::jsonb, 70) as strip_id,
  app_private.homepage_section_save_for_staff(
    pg_temp.editor(), true, null, 'home_empty', 'featured_listings', 'All gone', null, null, null,
    format('{"ids":["%s"]}', '11220000-0000-4000-8000-000000000003')::jsonb, 80) as empty_id;

create function pg_temp.hero() returns uuid language sql stable as $f$ select hero_id from section_ids $f$;
create function pg_temp.picks() returns uuid language sql stable as $f$ select picks_id from section_ids $f$;
create function pg_temp.shelves() returns uuid language sql stable as
  $f$ select shelves_id from section_ids $f$;
create function pg_temp.shops() returns uuid language sql stable as $f$ select shops_id from section_ids $f$;
create function pg_temp.latest() returns uuid language sql stable as $f$ select latest_id from section_ids $f$;
create function pg_temp.blog() returns uuid language sql stable as $f$ select blog_id from section_ids $f$;
create function pg_temp.strip() returns uuid language sql stable as $f$ select strip_id from section_ids $f$;
create function pg_temp.empty_section() returns uuid language sql stable as
  $f$ select empty_id from section_ids $f$;

select isnt(pg_temp.hero(), null, 'saving a new section returns its identifier');
select is((select is_active from public.homepage_sections where id = pg_temp.hero()), false,
  'a new section is always inactive, so a half-configured one cannot reach the public');
select is((select config from public.homepage_sections where id = pg_temp.hero()),
  '{"lead":"Find what you need."}'::jsonb, 'the config is stored as given');
select is((select title_ar from public.homepage_sections where id = pg_temp.hero()), 'أهلاً',
  'the Arabic title is stored as written');
select is((select title_ar from public.homepage_sections where id = pg_temp.picks()), null,
  'an absent Arabic title is stored as null, which D7 allows');

-- 0030's own constraints, not restated by the writer.
select throws_ok(
  format($q$ select app_private.homepage_section_save_for_staff(%L, true, null, 'Bad Key', 'hero') $q$,
    pg_temp.editor()),
  '23514', null, 'the section key format is 0030''s constraint and raises there');
select throws_ok(
  format($q$ select app_private.homepage_section_save_for_staff(%L, true, null, 'home_nope', 'carousel') $q$,
    pg_temp.editor()),
  '23514', null, 'a section type 0030 does not have raises there too');
select throws_ok(
  format($q$ select app_private.homepage_section_save_for_staff(%L, true, null, 'home_hero', 'hero') $q$,
    pg_temp.editor()),
  '23505', null, 'a duplicate section key raises 0030''s unique index');
select throws_ok(
  format($q$ select app_private.homepage_section_save_for_staff(%L, true, null, 'home_long', 'hero', %L) $q$,
    pg_temp.editor(), repeat('x', 161)),
  '23514', null, 'a title longer than the column raises 0030''s constraint');
select throws_ok(
  format($q$ select app_private.homepage_section_save_for_staff(%L, true, null, 'home_arr', 'hero', null, null, null, null, '[]'::jsonb) $q$,
    pg_temp.editor()),
  '23514', null, 'a config that is not an object raises 0030''s own check');

select is(
  app_private.homepage_section_save_for_staff(
    pg_temp.editor(), true, 'ac000000-0000-4000-8000-00000000dead', 'home_ghost', 'hero'),
  null, 'saving a section that does not exist returns null rather than creating one');

-- ---------------------------------------------------------------------------------------------------
-- Replacing a section
-- ---------------------------------------------------------------------------------------------------
-- The defaults are null for a reason: an omitted argument must leave the stored value alone. A default of 0
-- would silently move a section to the top of the homepage every time somebody corrected its title.
select is(
  app_private.homepage_section_save_for_staff(pg_temp.editor(), true, pg_temp.hero(), null, null, 'Welcome back'),
  pg_temp.hero(), 'saving an existing section returns the same identifier');
select is((select title_en from public.homepage_sections where id = pg_temp.hero()), 'Welcome back',
  'the English title was replaced');
select is((select sort_order from public.homepage_sections where id = pg_temp.hero()), 10,
  'and an omitted sort order left the position alone');
select is((select section_key from public.homepage_sections where id = pg_temp.hero()), 'home_hero',
  'and an omitted key left the key alone');
select is((select config from public.homepage_sections where id = pg_temp.hero()),
  '{"lead":"Find what you need."}'::jsonb, 'and an omitted config left the document alone');

-- A save cannot show a section, which is what keeps an edit from publishing one.
select is((select is_active from public.homepage_sections where id = pg_temp.hero()), false,
  'and the section is still hidden after every save above');

select throws_ok(
  format($q$ select app_private.homepage_section_save_for_staff(%L, true, %L, null, null, 'x') $q$,
    pg_temp.nobody(), pg_temp.hero()),
  '42501', null, 'a caller without the manage key cannot replace a section');

-- ---------------------------------------------------------------------------------------------------
-- Showing and hiding
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.homepage_section_state_for_staff(%L, true, %L, true) $q$,
    pg_temp.nobody(), pg_temp.hero()),
  '42501', null, 'a caller without the manage key cannot show a section');
select ok(
  not app_private.homepage_section_state_for_staff(
    pg_temp.editor(), true, 'ac000000-0000-4000-8000-00000000dead', true),
  'showing a section that does not exist answers false');

select ok(app_private.homepage_section_state_for_staff(pg_temp.editor(), true, pg_temp.hero(), true),
  'the editor shows the hero');
select is((select is_active from public.homepage_sections where id = pg_temp.hero()), true, 'and it is shown');
select ok(app_private.homepage_section_state_for_staff(pg_temp.editor(), true, pg_temp.hero(), false),
  'and hides it again');
select is((select is_active from public.homepage_sections where id = pg_temp.hero()), false, 'and it is hidden');

-- Everything on, for the reader assertions below.
update public.homepage_sections set is_active = true;

-- ---------------------------------------------------------------------------------------------------
-- The public section reader
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.public_homepage_sections('en')), 7,
  'seven of the eight stored sections are served: the banner strip is not');
select is(
  (select count(*)::int from app_private.public_homepage_sections('en') where section_type = 'banner_strip'),
  0, 'a banner_strip section is never returned, however it is authored');
select is(
  (select array_agg(section_key order by sort_order) from app_private.public_homepage_sections('en')),
  array['home_hero', 'home_picks', 'home_shelves', 'home_shops', 'home_latest', 'home_blog', 'home_empty'],
  'and the rest come back in the administrator''s own order');
select is(
  (select title from app_private.public_homepage_sections('en') where section_key = 'home_hero'),
  'Welcome back', 'titled in English for an English request');
select is(
  (select title from app_private.public_homepage_sections('ar') where section_key = 'home_hero'),
  'أهلاً', 'and in Arabic for an Arabic one');
select is(
  (select subtitle from app_private.public_homepage_sections('ar') where section_key = 'home_hero'),
  'اشترِ وبِع', 'subtitles follow the same rule');
select is(
  (select title from app_private.public_homepage_sections('ar') where section_key = 'home_picks'),
  'Our picks', 'and an Arabic request falls back to the English title where no Arabic one was written');
select is(
  (select config from app_private.public_homepage_sections('en') where section_key = 'home_hero'),
  '{"lead":"Find what you need."}'::jsonb, 'the config is served as stored, uninterpreted');
select is(
  (select resolved.title from app_private.public_homepage_sections('xx') as resolved
    where resolved.section_key = 'home_hero'),
  'Welcome back', 'an unrecognised locale falls back to the default');

-- A hidden section is absent, which is the one thing `is_active` decides.
update public.homepage_sections set is_active = false where id = pg_temp.hero();
select is(
  (select count(*)::int from app_private.public_homepage_sections('en') where section_key = 'home_hero'),
  0, 'a hidden section is absent from the public reader');
update public.homepage_sections set is_active = true where id = pg_temp.hero();

-- ---------------------------------------------------------------------------------------------------
-- The listing resolver — order, and owner decision C
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_agg(slug order by chosen_position) from app_private.public_homepage_listings(
     array['11220000-0000-4000-8000-000000000002'::uuid, '11220000-0000-4000-8000-000000000001'::uuid])),
  array['home-table', 'home-chair'],
  'the chosen listings come back in the chosen order, not the table''s');
select is(
  (select count(*)::int from app_private.public_homepage_listings(
     array['11220000-0000-4000-8000-000000000003'::uuid])),
  0, 'a sold listing is omitted, which is 0011''s purchasability rule rather than a decision here');
select is(
  (select count(*)::int from app_private.public_homepage_listings(
     array['11220000-0000-4000-8000-000000000004'::uuid])),
  0, 'and so is a listing whose seller has been suspended');
select is(
  (select count(*)::int from app_private.public_homepage_listings(
     array['ac000000-0000-4000-8000-00000000dead'::uuid])),
  0, 'an id that names nothing resolves to nothing rather than raising');
select is(
  (select array_agg(slug order by chosen_position) from app_private.public_homepage_listings(
     array['11220000-0000-4000-8000-000000000002'::uuid, '11220000-0000-4000-8000-000000000003'::uuid,
           '11220000-0000-4000-8000-000000000001'::uuid])),
  array['home-table', 'home-chair'],
  'a gap left by an omitted row does not disturb the order of the rest');
select is((select count(*)::int from app_private.public_homepage_listings(null)), 0,
  'a null array resolves to nothing');
select is((select count(*)::int from app_private.public_homepage_listings('{}'::uuid[])), 0,
  'and so does an empty one');
select is(
  (select count(*)::int from app_private.public_homepage_listings(
     array['11220000-0000-4000-8000-000000000001'::uuid, '11220000-0000-4000-8000-000000000002'::uuid], 1)),
  1, 'the limit is honoured');
select is(
  (select result_type from app_private.public_homepage_listings(
     array['11220000-0000-4000-8000-000000000001'::uuid])),
  'listing', 'a product reports itself as a listing');
select is(
  (select currency_minor_unit from app_private.public_homepage_listings(
     array['11220000-0000-4000-8000-000000000001'::uuid])),
  2::smallint, 'and carries its currency''s own minor unit rather than an assumed one');

-- The card fields and nothing more: no seller, no location beyond the city, no view count.
select ok(
  pg_get_function_result(p.oid) !~ 'seller' and pg_get_function_result(p.oid) !~ 'view_count'
    and pg_get_function_result(p.oid) !~ 'location',
  'the listing resolver returns card fields only, never the seller, the location or a view count')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'public_homepage_listings';

-- ---------------------------------------------------------------------------------------------------
-- The latest-listings reader
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_agg(slug order by created_at desc) from app_private.public_homepage_latest_listings(10)),
  array['home-table', 'home-chair'],
  'the newest purchasable listings of visible sellers, newest first');
select is((select count(*)::int from app_private.public_homepage_latest_listings(1)), 1,
  'the count is honoured');
select is((select count(*)::int from app_private.public_homepage_latest_listings(0)), 0,
  'and a count of zero returns nothing rather than everything');

-- ---------------------------------------------------------------------------------------------------
-- The category resolver
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_agg(slug order by chosen_position) from app_private.public_homepage_categories(
     array['cc000000-0000-4000-8000-000000000002'::uuid, 'cc000000-0000-4000-8000-000000000001'::uuid])),
  array['home-audio', 'home-furniture'], 'the chosen categories come back in the chosen order');
select is(
  (select name from app_private.public_homepage_categories(
     array['cc000000-0000-4000-8000-000000000001'::uuid], 'ar')),
  'أثاث', 'named in the requested locale');
select is(
  (select name from app_private.public_homepage_categories(
     array['cc000000-0000-4000-8000-000000000002'::uuid], 'ar')),
  'Audio', 'falling back to English where no translation exists');
select is(
  (select count(*)::int from app_private.public_homepage_categories(
     array['cc000000-0000-4000-8000-000000000003'::uuid])),
  0, 'a deactivated category is omitted, which is 0049''s own ancestry rule');
select is(
  (select icon from app_private.public_homepage_categories(
     array['cc000000-0000-4000-8000-000000000001'::uuid])),
  'sofa', 'the icon comes with the category');

-- A category under a deactivated ancestor goes too, without this function knowing how that is decided.
insert into public.categories (id, parent_id, slug, listing_type_code, is_active, sort_order)
values ('cc000000-0000-4000-8000-000000000004', 'cc000000-0000-4000-8000-000000000003', 'home-buried', null,
        true, 1);
select is(
  (select count(*)::int from app_private.public_homepage_categories(
     array['cc000000-0000-4000-8000-000000000004'::uuid])),
  0, 'an active category under a deactivated ancestor is omitted too');

-- ---------------------------------------------------------------------------------------------------
-- The seller resolver
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_agg(slug order by chosen_position) from app_private.public_homepage_sellers(
     array[pg_temp.seller()])),
  array['home-shop'], 'a publicly visible seller resolves');
select is((select count(*)::int from app_private.public_homepage_sellers(array[pg_temp.gone_seller()])), 0,
  'a suspended seller is omitted, which is 0009''s own rule');
select is(
  (select array_agg(slug order by chosen_position) from app_private.public_homepage_sellers(
     array[pg_temp.gone_seller(), pg_temp.seller()])),
  array['home-shop'], 'and the remaining order is undisturbed');
select is((select display_name from app_private.public_homepage_sellers(array[pg_temp.seller()])), 'Home Shop',
  'the display name comes with the seller');
select ok(
  pg_get_function_result(p.oid) !~ 'logo' and pg_get_function_result(p.oid) !~ 'banner',
  'the seller resolver returns no logo or banner path: no media origin exists to address one')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'public_homepage_sellers';

-- ---------------------------------------------------------------------------------------------------
-- The post reader
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.public_homepage_posts('en', 10)), 1,
  'only a public post is highlighted');
select is((select slug from app_private.public_homepage_posts('en', 10)), 'home-post-live',
  'and it is the published one');
select is((select title from app_private.public_homepage_posts('en', 10)), 'A live post', 'with its title');
select is((select resolved_locale from app_private.public_homepage_posts('ar', 10)), 'en',
  'an Arabic request falls back to the English text and says so');
select is((select count(*)::int from app_private.public_homepage_posts('en', 0)), 0,
  'a count of zero returns nothing');

-- A post whose moment has not arrived is not public, which is 0030's predicate rather than a status check.
update public.blog_posts set published_at = now() + interval '1 day'
 where id = 'bb000000-0000-4000-8000-000000000001';
select is((select count(*)::int from app_private.public_homepage_posts('en', 10)), 0,
  'a future publication moment is omitted, which is cms_content_is_public''s own rule');
update public.blog_posts set published_at = '2026-05-05T10:00:00Z'
 where id = 'bb000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------------------------------
-- The staff surfaces
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.homepage_sections_for_staff(pg_temp.nobody(), true)), 0,
  'a caller without the read key sees no sections at all');
select is((select count(*)::int from app_private.homepage_sections_for_staff(pg_temp.editor(), false)), 0,
  'and neither does the editor at aal1');
select is((select count(*)::int from app_private.homepage_sections_for_staff(pg_temp.editor(), true)), 8,
  'the editor sees every section, the unserved banner strip included');
select is(
  (select is_served from app_private.homepage_sections_for_staff(pg_temp.editor(), true)
    where section_key = 'home_strip'),
  false, 'and the strip is marked as one the public homepage will not render');
select is(
  (select is_served from app_private.homepage_sections_for_staff(pg_temp.editor(), true)
    where section_key = 'home_hero'),
  true, 'while a served type is marked as such');
select is(
  (select array_agg(section_key order by sort_order)
     from app_private.homepage_sections_for_staff(pg_temp.editor(), true)),
  array['home_hero', 'home_picks', 'home_shelves', 'home_shops', 'home_latest', 'home_blog', 'home_strip',
        'home_empty'],
  'the staff list is in the homepage''s own order');

select is(
  (select count(*)::int from app_private.homepage_section_for_staff(pg_temp.nobody(), true, pg_temp.hero())),
  0, 'a caller without the read key gets no detail');
select is(
  (select count(*)::int
     from app_private.homepage_section_for_staff(
       pg_temp.editor(), true, 'ac000000-0000-4000-8000-00000000dead')),
  0, 'and a section that does not exist gets none either, so the two are indistinguishable');
select is(
  (select can_manage from app_private.homepage_section_for_staff(pg_temp.editor(), true, pg_temp.hero())),
  true, 'the detail reports the manage capability');

-- Owner decision C, made visible: four listings chosen, two of them still renderable.
select is(
  (select chosen_count from app_private.homepage_section_for_staff(pg_temp.editor(), true, pg_temp.picks())),
  4, 'the detail reports how many rows the section names');
select is(
  (select renderable_count
     from app_private.homepage_section_for_staff(pg_temp.editor(), true, pg_temp.picks())),
  2, 'and how many of those are still renderable');
select is(
  (select renderable_count
     from app_private.homepage_section_for_staff(pg_temp.editor(), true, pg_temp.empty_section())),
  0, 'a section whose every row has gone reports zero, which is why the public homepage skips it');
select is(
  (select chosen_count
     from app_private.homepage_section_for_staff(pg_temp.editor(), true, pg_temp.empty_section())),
  1, 'while still reporting that it names one');
select is(
  (select renderable_count from app_private.homepage_section_for_staff(pg_temp.editor(), true, pg_temp.shelves())),
  2, 'a category section counts only the visible categories');
select is(
  (select renderable_count from app_private.homepage_section_for_staff(pg_temp.editor(), true, pg_temp.shops())),
  1, 'and a seller section only the visible sellers');
select is(
  (select renderable_count from app_private.homepage_section_for_staff(pg_temp.editor(), true, pg_temp.hero())),
  0, 'a type that names no rows reports zero chosen and zero renderable');

-- A malformed stored document must not make the reader fail: the console is where that is reported.
update public.homepage_sections set config = '{"ids":"not-an-array"}'::jsonb where id = pg_temp.picks();
select lives_ok(
  format($q$ select * from app_private.homepage_section_for_staff(%L, true, %L) $q$,
    pg_temp.editor(), pg_temp.picks()),
  'a config whose ids are not an array is read without raising');
select is(
  (select chosen_count from app_private.homepage_section_for_staff(pg_temp.editor(), true, pg_temp.picks())),
  0, 'and reports nothing chosen rather than failing');
update public.homepage_sections set config = '{"ids":["not-a-uuid","11220000-0000-4000-8000-000000000001"]}'::jsonb
 where id = pg_temp.picks();
select is(
  (select renderable_count from app_private.homepage_section_for_staff(pg_temp.editor(), true, pg_temp.picks())),
  1, 'an entry that is not an identifier is skipped and the rest still resolve');

-- ---------------------------------------------------------------------------------------------------
-- Reordering
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.homepage_sections_reorder_for_staff(%L, true, array[%L::uuid]) $q$,
    pg_temp.nobody(), pg_temp.hero()),
  '42501', null, 'a caller without the manage key cannot reorder the homepage');

select is(
  app_private.homepage_sections_reorder_for_staff(
    pg_temp.editor(), true, array[pg_temp.blog(), pg_temp.hero(), pg_temp.picks()]),
  3, 'the reorder reports how many sections moved');
select is((select sort_order from public.homepage_sections where id = pg_temp.blog()), 0,
  'the first named section is first');
select is((select sort_order from public.homepage_sections where id = pg_temp.hero()), 10,
  'the second is second');
select is((select sort_order from public.homepage_sections where id = pg_temp.picks()), 20,
  'and positions are spaced so a later insertion needs no rewrite');
select is(
  (select array_agg(section_key order by sort_order) from app_private.public_homepage_sections('en') limit 1),
  array['home_blog', 'home_hero', 'home_picks', 'home_shelves', 'home_shops', 'home_latest', 'home_empty'],
  'and the public homepage follows the new order');
select is(
  app_private.homepage_sections_reorder_for_staff(
    pg_temp.editor(), true, array['ac000000-0000-4000-8000-00000000dead'::uuid]),
  0, 'an id that names no section moves nothing');
select is(app_private.homepage_sections_reorder_for_staff(pg_temp.editor(), true, null), 0,
  'and a null order moves nothing');

-- ---------------------------------------------------------------------------------------------------
-- Deleting
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.homepage_section_delete_for_staff(%L, true, %L) $q$,
    pg_temp.nobody(), pg_temp.strip()),
  '42501', null, 'a caller without the manage key cannot delete a section');
select ok(
  not app_private.homepage_section_delete_for_staff(
    pg_temp.editor(), true, 'ac000000-0000-4000-8000-00000000dead'),
  'deleting a section that does not exist answers false');
select ok(app_private.homepage_section_delete_for_staff(pg_temp.editor(), true, pg_temp.strip()),
  'the editor deletes the banner strip');
select is((select count(*)::int from public.homepage_sections where id = pg_temp.strip()), 0,
  'and it is really gone');
select is((select count(*)::int from app_private.homepage_sections_for_staff(pg_temp.editor(), true)), 7,
  'so the staff list is one shorter');

select * from finish();
rollback;
