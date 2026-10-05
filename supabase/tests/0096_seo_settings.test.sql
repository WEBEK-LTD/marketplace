-- 0096 — Site-wide SEO settings: the staff reader and the authoring functions.
--
-- What is proven here, in order: the one permission predicate applies 0003's requires_mfa rule and there is no
-- second key; the staff reader returns one row per **active** locale whether or not it has been authored, default
-- locale first, so the first save has somewhere to happen; the writer replaces one locale's row, stores a blank
-- field as absent, keeps a robots body's interior exactly as authored, and refuses a caller without the manage
-- key with 42501; a delete returns a locale to unauthored; and every one of 0030's constraints still decides what
-- may be stored.
--
-- **The largest block in this file is the robots isolation**, and deliberately so: `/robots.txt` is a live
-- crawler-facing document. What is asserted there, directly rather than by inspection: nothing authored means no
-- row at all; a body authored on the non-default locale changes nothing and never appears in the served answer;
-- a body authored on both serves the default locale's; the writer cannot make a non-default locale served;
-- deleting the default locale's row returns the document to its minimal form; and the staff reader's
-- `robots_is_served` marking agrees with what `public_robots_body()` actually answers, for every locale, so the
-- console's label cannot drift from the document.
--
-- Also proven: 0086's reader is not redefined, nothing here emits structured data or builds a URL, nothing reads
-- `public.site_settings`, nothing writes `public.locales`, and no schema object of 0030 changed.

-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(187);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'seo_settings_can_manage', array['uuid', 'boolean'],
  'the manage predicate exists');
select has_function('app_private', 'seo_settings_for_staff', array['uuid', 'boolean'],
  'the staff reader exists');
select has_function('app_private', 'seo_settings_save_for_staff',
  array['uuid', 'boolean', 'text', 'text', 'text', 'text', 'uuid', 'text', 'text', 'jsonb'],
  'the save writer exists');
select has_function('app_private', 'seo_settings_delete_for_staff', array['uuid', 'boolean', 'text'],
  'the delete writer exists');

-- Owner decision 6: one key, so there is no read predicate to pair with the manage one.
select hasnt_function('app_private', 'seo_settings_can_read', array['uuid', 'boolean'],
  'no read predicate was invented (owner decision 6)');
select is(
  (select count(*)::int from public.permissions where key = 'seo.settings.read'),
  0, 'and no seo.settings.read permission key exists to gate it on');
select is(
  (select count(*)::int from public.permissions where key = 'seo.settings.manage'),
  1, 'while the manage key this surface uses is the one 0033 already seeds');

-- Owner decisions 1-4: this increment adds no public reader. 0086's is the only one, and it is not touched.
select hasnt_function('app_private', 'public_seo_settings', 'no public settings reader was added');
select hasnt_function('app_private', 'public_site_name', 'no public site-name reader was added');
select hasnt_function('app_private', 'public_seo_defaults', 'no public metadata-defaults reader was added');
select hasnt_function('app_private', 'public_organization_structured_data',
  'no structured-data reader was added (owner decision 4)');
select has_function('app_private', 'public_robots_body', array[]::text[],
  '0086''s robots reader is still the only public reader of this table');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seo_settings%'),
  4, 'this increment adds exactly four functions');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seo_settings%' and p.prosecdef),
  4, 'all four are security definer');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seo_settings%'
      and p.proconfig @> array['search_path=pg_catalog, public']),
  4, 'all four pin search_path to pg_catalog, public');

select is((select count(*)::int from public.audit_attribution_problems()), 0,
  '0096 adds no audit attribution problem');

-- The actor is a column of the row, exactly as 0091 records it. The 8-B channel is not named.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seo_settings%' and p.prosrc ~ 'audit_actor'),
  0, 'no 0096 function names the 8-B attribution channel');
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seo_settings_save_for_staff'
      and p.prosrc ~ 'updated_by'),
  1, 'the save writer records the actor in 0030''s own updated_by column instead');

-- Owner decision 5's marking is a column of the reader, so a console reports the fact rather than guessing it.
select matches(pg_get_function_result(p.oid), 'robots_is_served boolean',
  'the staff reader reports whether a locale''s robots body is the served one (owner decision 5)')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'seo_settings_for_staff';
select matches(pg_get_function_result(p.oid), 'is_authored boolean',
  'and whether the locale has been authored at all, so the first save has somewhere to happen')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'seo_settings_for_staff';
-- Owner decision 8: the identifier and its relative object path, never a URL.
select matches(pg_get_function_result(p.oid), 'default_share_media_id uuid',
  'the stored share-media identifier is reported (owner decision 8)')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'seo_settings_for_staff';
select matches(pg_get_function_result(p.oid), 'share_media_object_path text',
  'with its relative object path, which is not an address')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'seo_settings_for_staff';

-- ---------------------------------------------------------------------------------------------------
-- What this increment must not do
-- ---------------------------------------------------------------------------------------------------
-- Read from the stored bodies rather than asserted by behaviour, because the point is that the code does not
-- mention these things at all.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seo_settings%'
      and (p.prosrc ~* 'promotion' or p.prosrc ~* 'placement' or p.prosrc ~* 'wallet'
           or p.prosrc ~* 'ranking' or p.prosrc ~* 'popularity')),
  0, 'no 0096 function mentions a promotion, a placement, a wallet, a ranking or a popularity signal');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seo_settings%'
      and (p.prosrc ~* 'ledger' or p.prosrc ~* 'payout' or p.prosrc ~* 'settlement'
           or p.prosrc ~* 'seller_balances' or p.prosrc ~* 'payment' or p.prosrc ~* 'finance\.')),
  0, 'and none touches a financial table or names a finance setting');

-- `site_settings` is a different cluster behind different keys, and its rows include a frozen financial flag.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seo_settings%' and p.prosrc ~ 'site_settings'),
  0, 'none reads or writes public.site_settings');

-- Owner decisions 1-4: no emission of any kind, and nothing that could become an absolute address.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seo_settings%'
      and (p.prosrc ~* 'schema\.org' or p.prosrc ~* 'ld\+json' or p.prosrc ~* '@context'
           or p.prosrc ~* 'jsonb_build_object' or p.prosrc ~* 'https?://' or p.prosrc ~* 'origin')),
  0, 'none builds a structured-data document, a URL or an origin (owner decisions 1-4 and 8)');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seo_settings%'
      and (p.prosrc ~* 'storage\.' or p.prosrc ~* 'sign' or p.prosrc ~* 'bucket')),
  0, 'and none creates media-origin or signed-URL behaviour (owner decision 8)');

-- The default locale is read and never written: nothing here can move which locale answers for robots.txt.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seo_settings%'
      and (p.prosrc ~* 'update\s+public\.locales' or p.prosrc ~* 'insert\s+into\s+public\.locales'
           or p.prosrc ~* 'delete\s+from\s+public\.locales')),
  0, 'no 0096 function writes public.locales, so none can change which locale robots.txt reads');

-- The tables this increment deliberately leaves alone stay reader-less.
select has_table('public', 'banners', 'the banners table is untouched');
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
-- 0086's reader is not redefined
-- ---------------------------------------------------------------------------------------------------
-- The isolation is a property of this query's shape, so the shape is asserted as well as the behaviour.
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_robots_body') ~ 'is_default',
  '0086''s robots reader still filters on locales.is_default');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_robots_body') ~ 'limit 1',
  'and still answers with at most one row');
select ok(
  exists (select 1 from pg_class where relname = 'locales_one_default'),
  'and 0002''s unique index makes that filter select at most one locale');
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seo_settings%' and p.prosrc ~ 'public_robots_body'),
  0, 'no 0096 function wraps, calls or shadows it');

-- ---------------------------------------------------------------------------------------------------
-- Nothing in 0030 was changed
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'seo_settings', 'the settings table is untouched');
select col_is_pk('public', 'seo_settings', 'locale_code', 'its primary key is still the locale');
select col_not_null('public', 'seo_settings', 'site_name', 'the site name is still required');
select col_default_is('public', 'seo_settings', 'organization_structured_data', '{}',
  '0030''s empty-object default is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'seo_settings_site_name_length'),
  '0030''s 1-120 site name rule is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'seo_settings_default_meta_title_length'),
  '0030''s 70-character default title rule is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'seo_settings_default_meta_description_length'),
  '0030''s 320-character default description rule is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'seo_settings_twitter_site_format'),
  '0030''s handle format is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'seo_settings_structured_data_is_object'),
  '0030''s JSON-object rule is untouched');
select ok(
  exists (select 1 from pg_trigger where tgname = 'seo_settings_audit'),
  '0030''s audit trigger is still installed');
select ok(
  exists (select 1 from pg_trigger where tgname = 'seo_settings_set_updated_at'),
  '0030''s updated_at trigger is still installed');
select ok(
  exists (select 1 from pg_policies where tablename = 'seo_settings' and policyname = 'seo_settings_admin_write'),
  '0030''s write policy naming seo.settings.manage is untouched');
select ok(
  exists (select 1 from pg_policies where tablename = 'seo_settings' and policyname = 'seo_settings_public_read'),
  'and so is its read policy');
select has_table('public', 'site_settings', 'the operational settings table still exists and is untouched');

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select ok(has_function_privilege('app_system', p.oid, 'execute'),
    format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname like 'seo_settings%'
 order by p.proname;

select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
    format('%s may not execute %s', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_worker')) as r(rolname)
 where n.nspname = 'app_private' and p.proname like 'seo_settings%'
 order by r.rolname, p.proname;

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- An operator who holds the one key through the admin role (0033 grants it to admin and super_admin, and both
-- roles require MFA), and a signed-in person who holds nothing here.
insert into auth.users (id, email) values
  ('af100000-0000-4000-8000-000000000001', 'seo-operator@example.test'),
  ('af100000-0000-4000-8000-000000000002', 'seo-nobody@example.test');
insert into public.user_roles (user_id, role_key) values
  ('af100000-0000-4000-8000-000000000001', 'admin');

create function pg_temp.operator() returns uuid language sql immutable as
  $f$ select 'af100000-0000-4000-8000-000000000001'::uuid $f$;
create function pg_temp.nobody() returns uuid language sql immutable as
  $f$ select 'af100000-0000-4000-8000-000000000002'::uuid $f$;

-- One media row, so the share-image identifier has something real to point at.
insert into public.cms_media (id, object_path, mime_type, byte_size) values
  ('af200000-0000-4000-8000-000000000001', 'cms-media/share/default.png', 'image/png', 4096);

create function pg_temp.media() returns uuid language sql immutable as
  $f$ select 'af200000-0000-4000-8000-000000000001'::uuid $f$;

-- The seeded locales, restated so the assertions below rest on a known state rather than on the seed's order.
select is((select code from public.locales where is_default), 'en', 'English is the default locale');
select ok((select is_active from public.locales where code = 'ar'), 'and Arabic is active and not the default');
select is((select count(*)::int from public.locales where is_active), 2, 'two locales are active');
select is((select count(*)::int from public.seo_settings), 0,
  'and the settings table ships empty, which is why the reader starts from the locales');

-- ---------------------------------------------------------------------------------------------------
-- The permission predicate
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.seo_settings_can_manage(pg_temp.operator(), true),
  'the operator holds seo.settings.manage at aal2');
select ok(not app_private.seo_settings_can_manage(pg_temp.operator(), false),
  'and holds nothing at aal1, because the role requires MFA');
select ok(not app_private.seo_settings_can_manage(pg_temp.operator(), null),
  'a null assurance level is not an assurance');
select ok(not app_private.seo_settings_can_manage(pg_temp.nobody(), true),
  'a signed-in person without the key holds nothing');
select ok(not app_private.seo_settings_can_manage(null, true), 'and neither does nobody at all');

-- A revoked grant is not a grant.
insert into public.user_roles (user_id, role_key, revoked_at) values
  ('af100000-0000-4000-8000-000000000002', 'admin', '2026-01-01T00:00:00Z');
select ok(not app_private.seo_settings_can_manage(pg_temp.nobody(), true),
  'a revoked role grants nothing');
delete from public.user_roles where user_id = pg_temp.nobody();

-- ---------------------------------------------------------------------------------------------------
-- The staff reader, before anything is authored
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.seo_settings_for_staff(pg_temp.nobody(), true)), 0,
  'a caller without the key reads nothing at all');
select is((select count(*)::int from app_private.seo_settings_for_staff(pg_temp.operator(), false)), 0,
  'and neither does the operator at aal1');
select is((select count(*)::int from app_private.seo_settings_for_staff(pg_temp.operator(), true)), 2,
  'the operator sees one row per active locale even though nothing is authored');
select is(
  (select array_agg(locale_code order by ordinality)
     from app_private.seo_settings_for_staff(pg_temp.operator(), true) with ordinality),
  array['en', 'ar'], 'default locale first, so the row that answers robots.txt is the one in front');
select is(
  (select count(*)::int from app_private.seo_settings_for_staff(pg_temp.operator(), true) where is_authored),
  0, 'no locale is authored yet');
select is(
  (select count(*)::int from app_private.seo_settings_for_staff(pg_temp.operator(), true) where site_name is null),
  2, 'so no locale has a site name');
select ok(
  (select robots_is_served from app_private.seo_settings_for_staff(pg_temp.operator(), true)
    where locale_code = 'en'),
  'the default locale is marked as the served one (owner decision 5)');
select ok(
  not (select robots_is_served from app_private.seo_settings_for_staff(pg_temp.operator(), true)
        where locale_code = 'ar'),
  'and the non-default locale is marked as not served');

-- An inactive locale is not part of this surface, and the writer agrees with the reader about that.
insert into public.locales (code, name_en, name_native, direction, is_active, sort_order)
values ('fr', 'French', 'Français', 'ltr', false, 3);
select is((select count(*)::int from app_private.seo_settings_for_staff(pg_temp.operator(), true)), 2,
  'an inactive locale is not shown');
select ok(
  not app_private.seo_settings_save_for_staff(pg_temp.operator(), true, 'fr', 'Marché'),
  'and settings cannot be authored for it');
select is((select count(*)::int from public.seo_settings where locale_code = 'fr'), 0,
  'nothing was written for it either');
update public.locales set is_active = true where code = 'fr';
select is((select count(*)::int from app_private.seo_settings_for_staff(pg_temp.operator(), true)), 3,
  'activating it brings it into the surface');
select ok(
  app_private.seo_settings_save_for_staff(pg_temp.operator(), true, 'fr', 'Marché'),
  'and now its settings can be authored');
delete from public.seo_settings where locale_code = 'fr';
update public.locales set is_active = false where code = 'fr';

-- ---------------------------------------------------------------------------------------------------
-- The writer
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.seo_settings_save_for_staff(%L, true, 'en', 'Market') $q$, pg_temp.nobody()),
  '42501', null, 'a caller without the manage key cannot author settings');
select throws_ok(
  format($q$ select app_private.seo_settings_save_for_staff(%L, false, 'en', 'Market') $q$, pg_temp.operator()),
  '42501', null, 'nor the operator at aal1');
select is((select count(*)::int from public.seo_settings), 0, 'and neither attempt wrote anything');

select ok(
  not app_private.seo_settings_save_for_staff(pg_temp.operator(), true, 'zz', 'Market'),
  'a locale that does not exist is reported as an absence rather than created');
select ok(
  not app_private.seo_settings_save_for_staff(pg_temp.operator(), true, null, 'Market'),
  'and so is no locale at all');
select ok(
  not app_private.seo_settings_save_for_staff(pg_temp.operator(), true, '   ', 'Market'),
  'and so is a blank one');
select is((select count(*)::int from public.seo_settings), 0, 'none of the three wrote anything');

-- The first save creates the row.
select ok(
  app_private.seo_settings_save_for_staff(
    pg_temp.operator(), true, 'en', '  Egypt Market  ',
    'Buy and sell in Egypt', 'Everything for sale, in one place.',
    pg_temp.media(), '@egyptmarket', E'\n  User-agent: *\nDisallow: /dashboard\n  ',
    '{"name": "Egypt Market"}'::jsonb),
  'the first save creates the row');
select is((select site_name from public.seo_settings where locale_code = 'en'), 'Egypt Market',
  'the site name is stored trimmed');
select is((select default_meta_title from public.seo_settings where locale_code = 'en'), 'Buy and sell in Egypt',
  'the default title is stored');
select is((select default_meta_description from public.seo_settings where locale_code = 'en'),
  'Everything for sale, in one place.', 'the default description is stored');
select is((select default_share_media_id from public.seo_settings where locale_code = 'en'), pg_temp.media(),
  'the share media identifier is stored (owner decision 8)');
select is((select twitter_site from public.seo_settings where locale_code = 'en'), '@egyptmarket',
  'the handle is stored');
select is((select organization_structured_data from public.seo_settings where locale_code = 'en'),
  '{"name": "Egypt Market"}'::jsonb, 'the structured-data document is stored');
select is((select updated_by from public.seo_settings where locale_code = 'en'), pg_temp.operator(),
  'the actor is recorded in 0030''s own column');

-- The robots body: ends trimmed, interior exactly as authored.
select is((select robots_txt_body from public.seo_settings where locale_code = 'en'),
  E'User-agent: *\nDisallow: /dashboard',
  'the robots body keeps its interior newline and loses only the surrounding whitespace');
select ok(
  (select robots_txt_body from public.seo_settings where locale_code = 'en') not like E'%\n  ',
  'and carries no trailing indentation a crawler would receive');

-- The reader now reports the authored row, including the media path owner decision 8 asks for.
select ok(
  (select is_authored from app_private.seo_settings_for_staff(pg_temp.operator(), true)
    where locale_code = 'en'),
  'the reader reports the locale as authored');
select is(
  (select share_media_object_path from app_private.seo_settings_for_staff(pg_temp.operator(), true)
    where locale_code = 'en'),
  'cms-media/share/default.png', 'with the media row''s relative object path');
select ok(
  (select share_media_object_path from app_private.seo_settings_for_staff(pg_temp.operator(), true)
    where locale_code = 'en') not like 'http%',
  'which is a path inside a private bucket and not an address');
select ok(
  (select updated_at from app_private.seo_settings_for_staff(pg_temp.operator(), true) where locale_code = 'en')
    is not null,
  'and the time it was last changed');
select ok(
  not (select is_authored from app_private.seo_settings_for_staff(pg_temp.operator(), true)
        where locale_code = 'ar'),
  'while the other locale is still unauthored');

-- A save is a replace: an omitted field is stored as absent, so the form is the row.
select ok(
  app_private.seo_settings_save_for_staff(pg_temp.operator(), true, 'en', 'Egypt Market'),
  'a second save with only the required field succeeds');
select is((select count(*)::int from public.seo_settings), 1, 'without creating a second row');
select is((select default_meta_title from public.seo_settings where locale_code = 'en'), null,
  'the omitted default title is cleared, because a save is a replace');
select is((select default_meta_description from public.seo_settings where locale_code = 'en'), null,
  'and so is the description');
select is((select default_share_media_id from public.seo_settings where locale_code = 'en'), null,
  'and the share image');
select is((select twitter_site from public.seo_settings where locale_code = 'en'), null, 'and the handle');
select is((select robots_txt_body from public.seo_settings where locale_code = 'en'), null,
  'and the robots body, which is how an authored crawl policy is withdrawn without deleting the row');
select is((select organization_structured_data from public.seo_settings where locale_code = 'en'),
  '{}'::jsonb, 'while the structured-data document returns to 0030''s empty object rather than null');

-- A blank field is absent, never an empty string: no surface could carry an empty tag.
select ok(
  app_private.seo_settings_save_for_staff(
    pg_temp.operator(), true, 'en', 'Egypt Market', '   ', '', null, '  ', '   '),
  'a save whose optional fields are blank succeeds');
select is((select default_meta_title from public.seo_settings where locale_code = 'en'), null,
  'a blank default title is stored as absent');
select is((select default_meta_description from public.seo_settings where locale_code = 'en'), null,
  'and so is a blank description');
select is((select twitter_site from public.seo_settings where locale_code = 'en'), null,
  'and a blank handle');
select is((select robots_txt_body from public.seo_settings where locale_code = 'en'), null,
  'and a robots body of nothing but whitespace, rather than a document that silently says nothing');
select ok(
  app_private.seo_settings_save_for_staff(
    pg_temp.operator(), true, 'en', 'Egypt Market', null, null, null, null, E'\n\t \n'),
  'a robots body of newlines and tabs is accepted');
select is((select robots_txt_body from public.seo_settings where locale_code = 'en'), null,
  'and stored as absent too');

-- 0030's constraints still decide what may be stored. Each arrives as the refusal the database made.
select throws_ok(
  format($q$ select app_private.seo_settings_save_for_staff(%L, true, 'en', '   ') $q$, pg_temp.operator()),
  '23514', null, 'a blank site name is refused by 0030''s own length rule');
select throws_ok(
  format($q$ select app_private.seo_settings_save_for_staff(%L, true, 'en', %L) $q$,
    pg_temp.operator(), repeat('n', 121)),
  '23514', null, 'and a site name past 120 characters');
select throws_ok(
  format($q$ select app_private.seo_settings_save_for_staff(%L, true, 'en', 'Egypt Market', %L) $q$,
    pg_temp.operator(), repeat('t', 71)),
  '23514', null, 'a default title past 70 characters is refused');
select throws_ok(
  format($q$ select app_private.seo_settings_save_for_staff(%L, true, 'en', 'Egypt Market', null, %L) $q$,
    pg_temp.operator(), repeat('d', 321)),
  '23514', null, 'and a default description past 320 characters');
select throws_ok(
  format($q$ select app_private.seo_settings_save_for_staff(
    %L, true, 'en', 'Egypt Market', null, null, null, 'egyptmarket') $q$, pg_temp.operator()),
  '23514', null, 'a handle without its leading @ is refused by 0030''s format rule');
select throws_ok(
  format($q$ select app_private.seo_settings_save_for_staff(
    %L, true, 'en', 'Egypt Market', null, null, null, '@way-too-long-for-a-handle') $q$, pg_temp.operator()),
  '23514', null, 'and so is one past fifteen characters');
select throws_ok(
  format($q$ select app_private.seo_settings_save_for_staff(
    %L, true, 'en', 'Egypt Market', null, null, null, null, null, '[]'::jsonb) $q$, pg_temp.operator()),
  '23514', null, 'a structured-data value that is not a JSON object is refused');
select throws_ok(
  format($q$ select app_private.seo_settings_save_for_staff(
    %L, true, 'en', 'Egypt Market', null, null, 'af200000-0000-4000-8000-0000000000fe'::uuid) $q$,
    pg_temp.operator()),
  '23503', null, 'and a share image that is not a media row');

-- A refused save changed nothing: the row an operator had is the row they still have.
select is((select site_name from public.seo_settings where locale_code = 'en'), 'Egypt Market',
  'none of the refusals changed the stored row');
select is((select count(*)::int from public.seo_settings), 1, 'and none created a second one');

-- ---------------------------------------------------------------------------------------------------
-- The robots isolation — owner decision 5, asserted directly
-- ---------------------------------------------------------------------------------------------------
-- `/robots.txt` is a live crawler-facing document, so this block proves the behaviour rather than describing it.
delete from public.seo_settings;
select is((select count(*)::int from app_private.public_robots_body()), 0,
  'nothing authored is no row at all, which is how the minimal document gets served');

-- A body on the non-default locale alone.
select ok(
  app_private.seo_settings_save_for_staff(
    pg_temp.operator(), true, 'ar', 'سوق مصر', null, null, null, null,
    E'User-agent: *\nDisallow: /arabic-only'),
  'the Arabic locale may be authored with a robots body (owner decision 5)');
select is((select count(*)::int from public.seo_settings where locale_code = 'ar'), 1, 'and it is stored');
select is((select robots_txt_body from public.seo_settings where locale_code = 'ar'),
  E'User-agent: *\nDisallow: /arabic-only', 'verbatim');
select is((select count(*)::int from app_private.public_robots_body()), 0,
  'yet robots.txt still has no row to serve, because the default locale is unauthored');
select ok(
  not exists (select 1 from app_private.public_robots_body() where robots_txt_body like '%arabic-only%'),
  'and the Arabic body appears nowhere in the served answer');
select ok(
  not (select robots_is_served from app_private.seo_settings_for_staff(pg_temp.operator(), true)
        where locale_code = 'ar'),
  'which is exactly what the console is told about that row');

-- Both authored: the default locale's body is the one that is served.
select ok(
  app_private.seo_settings_save_for_staff(
    pg_temp.operator(), true, 'en', 'Egypt Market', null, null, null, null,
    E'User-agent: *\nDisallow: /dashboard'),
  'the default locale is authored too');
select is((select count(*)::int from app_private.public_robots_body()), 1,
  'robots.txt now has exactly one row to serve');
select is((select locale_code from app_private.public_robots_body()), 'en',
  'and it is the default locale''s');
select is((select robots_txt_body from app_private.public_robots_body()),
  E'User-agent: *\nDisallow: /dashboard', 'with the body authored for that locale, verbatim');
select ok(
  not exists (select 1 from app_private.public_robots_body() where robots_txt_body like '%arabic-only%'),
  'and still nothing from the non-default locale');

-- Changing the non-default locale cannot change the served document.
select ok(
  app_private.seo_settings_save_for_staff(
    pg_temp.operator(), true, 'ar', 'سوق مصر', null, null, null, null, E'User-agent: *\nDisallow: /'),
  'the Arabic body is changed to one that would disallow everything');
select is((select robots_txt_body from app_private.public_robots_body()),
  E'User-agent: *\nDisallow: /dashboard',
  'and the served document is unchanged: a non-default locale cannot de-index the site');
select is((select locale_code from app_private.public_robots_body()), 'en', 'nor change which locale answers');

-- Deleting the non-default locale cannot change it either.
select ok(app_private.seo_settings_delete_for_staff(pg_temp.operator(), true, 'ar'),
  'the Arabic settings are deleted');
select is((select robots_txt_body from app_private.public_robots_body()),
  E'User-agent: *\nDisallow: /dashboard', 'and the served document is still unchanged');

-- The marking and the document agree, for every locale. This is the assertion that keeps them from drifting.
select is(
  (select array_agg(locale_code order by locale_code)
     from app_private.seo_settings_for_staff(pg_temp.operator(), true) where robots_is_served),
  array['en'], 'exactly one locale is marked as served');
select is(
  (select locale_code from app_private.seo_settings_for_staff(pg_temp.operator(), true) where robots_is_served),
  (select locale_code from app_private.public_robots_body()),
  'and it is the very locale robots.txt answers from, so the console cannot drift from the document');

-- An authored row with no body is a row, and its body is null — 0086's own shape, unchanged.
select ok(
  app_private.seo_settings_save_for_staff(pg_temp.operator(), true, 'en', 'Egypt Market'),
  'the default locale''s robots body is withdrawn by saving without one');
select is((select count(*)::int from app_private.public_robots_body()), 1,
  'the row is still there, because the locale is still authored');
select is((select robots_txt_body from app_private.public_robots_body()), null,
  'with no body, which the web app serves as the minimal document');
select is((select locale_code from app_private.public_robots_body()), 'en',
  'and the locale is still reported');

-- ---------------------------------------------------------------------------------------------------
-- The delete — owner decision 7
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.seo_settings_delete_for_staff(%L, true, 'en') $q$, pg_temp.nobody()),
  '42501', null, 'a caller without the manage key cannot delete a locale''s settings');
select throws_ok(
  format($q$ select app_private.seo_settings_delete_for_staff(%L, false, 'en') $q$, pg_temp.operator()),
  '42501', null, 'nor the operator at aal1');
select is((select count(*)::int from public.seo_settings where locale_code = 'en'), 1,
  'and neither attempt deleted anything');

select ok(not app_private.seo_settings_delete_for_staff(pg_temp.operator(), true, 'ar'),
  'deleting a locale that was never authored reports that nothing changed');
select ok(not app_private.seo_settings_delete_for_staff(pg_temp.operator(), true, 'zz'),
  'and so does a locale that does not exist');
select ok(not app_private.seo_settings_delete_for_staff(pg_temp.operator(), true, null),
  'and so does no locale at all');

select ok(app_private.seo_settings_delete_for_staff(pg_temp.operator(), true, 'en'),
  'the default locale''s settings are deleted');
select is((select count(*)::int from public.seo_settings), 0, 'the row is gone');
select is((select count(*)::int from app_private.public_robots_body()), 0,
  'and robots.txt is back to no row at all — the minimal document (owner decision 7)');
select is((select count(*)::int from app_private.seo_settings_for_staff(pg_temp.operator(), true)), 2,
  'while the console still offers both locales, so the settings can be authored again');
select is(
  (select count(*)::int from app_private.seo_settings_for_staff(pg_temp.operator(), true) where is_authored),
  0, 'with neither one authored');

-- Deleting one locale leaves the other alone.
select ok(app_private.seo_settings_save_for_staff(pg_temp.operator(), true, 'en', 'Egypt Market'), 'en authored');
select ok(app_private.seo_settings_save_for_staff(pg_temp.operator(), true, 'ar', 'سوق مصر'), 'ar authored');
select ok(app_private.seo_settings_delete_for_staff(pg_temp.operator(), true, 'ar'), 'ar deleted');
select is((select count(*)::int from public.seo_settings), 1, 'one row remains');
select is((select locale_code from public.seo_settings), 'en', 'and it is the other locale''s');

-- A locale removed from the platform takes its settings with it, which is 0030's own cascade and not this
-- increment's: the row cannot outlive the locale it is keyed by.
select ok(app_private.seo_settings_save_for_staff(pg_temp.operator(), true, 'ar', 'سوق مصر'), 'ar authored again');
delete from public.locales where code = 'fr';
select is((select count(*)::int from public.seo_settings), 2, 'removing an unrelated locale changes nothing');

-- The asymmetry between the writer and the delete, asserted rather than only described. Authoring settings for a
-- locale nobody can see would create a row nobody could correct, so the writer refuses it; withdrawing one can only
-- ever return things to "nothing authored". So a row cannot outlive the ability to remove it.
update public.locales set is_active = false where code = 'ar';
select is((select count(*)::int from app_private.seo_settings_for_staff(pg_temp.operator(), true)), 1,
  'deactivating a locale takes it out of the console');
select ok(not app_private.seo_settings_save_for_staff(pg_temp.operator(), true, 'ar', 'سوق مصر'),
  'and its settings can no longer be authored');
select ok(app_private.seo_settings_delete_for_staff(pg_temp.operator(), true, 'ar'),
  'but they can still be deleted, so no row is ever stuck behind an inactive locale');
select is((select count(*)::int from public.seo_settings), 1, 'and the deletion took effect');
update public.locales set is_active = true where code = 'ar';

-- ---------------------------------------------------------------------------------------------------
-- The audit trail
-- ---------------------------------------------------------------------------------------------------
-- 0030's trigger records the changes, and the actor travels inside the audited payload because it is a column of
-- the row. Nothing here writes the 8-B channel.
select ok(
  (select count(*) from audit.audit_logs where table_name = 'seo_settings' and action = 'insert') >= 1,
  'authoring a locale''s settings is audited');
select ok(
  (select count(*) from audit.audit_logs where table_name = 'seo_settings' and action = 'update') >= 1,
  'replacing them is audited');
select ok(
  (select count(*) from audit.audit_logs where table_name = 'seo_settings' and action = 'delete') >= 1,
  'and so is deleting them');
select ok(
  exists (
    select 1 from audit.audit_logs
     where table_name = 'seo_settings' and action = 'insert'
       and new_values ->> 'updated_by' = pg_temp.operator()::text),
  'and the actor travels inside the audited payload, because it is a column of the row');

select * from finish();
rollback;
