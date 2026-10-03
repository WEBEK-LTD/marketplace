-- 0091 — Per-entity SEO metadata: the named readers and writers.
--
-- What is proven here, in order: the ten functions exist, are definer functions with pinned search paths, and are
-- callable by `app_system` and by nobody else; nothing in 0030 was changed; the two permission predicates apply
-- 0003's `requires_mfa` rule and are genuinely separate keys; **owner decision 1** — a stored `canonical_path` is
-- read for `route` and `page` and withheld for `listing`, `category` and `seller`; **owner decision 2** — a stored
-- directive set can only ever restrict, so `index` and `follow` never leave this schema; every one of 0030's
-- constraints still raises; the publication predicate withholds metadata about anything the public cannot already
-- see; a save is a create-or-replace against whichever partial unique index the kind uses; the blog kinds and
-- `structured_data` have no reader; and the audit trigger fires.
--
-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(184);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'seo_metadata_can_read', array['uuid', 'boolean'], 'the read predicate exists');
select has_function('app_private', 'seo_metadata_can_manage', array['uuid', 'boolean'],
  'the manage predicate exists');
select has_function('app_private', 'seo_canonical_is_honoured', array['text'], 'the canonical rule exists');
select has_function('app_private', 'seo_directives_restrictive_only', array['text[]'],
  'the restrict-only rule exists');
select has_function('app_private', 'public_seo_metadata_for_entity', array['text', 'text', 'text'],
  'the public entity reader exists');
select has_function('app_private', 'public_seo_metadata_for_route', array['text', 'text'],
  'the public route reader exists');
select has_function('app_private', 'seo_metadata_for_staff',
  array['uuid', 'boolean', 'integer', 'text', 'text', 'timestamptz', 'uuid'], 'the staff list exists');
select has_function('app_private', 'seo_metadata_entry_for_staff', array['uuid', 'boolean', 'uuid'],
  'the staff detail exists');
select has_function('app_private', 'seo_metadata_save_for_staff',
  array['uuid', 'boolean', 'text', 'uuid', 'text', 'text', 'text', 'text', 'text', 'text[]', 'text', 'text', 'uuid'],
  'the save writer exists');
select has_function('app_private', 'seo_metadata_delete_for_staff', array['uuid', 'boolean', 'uuid'],
  'the delete writer exists');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'seo_metadata%' or p.proname like 'seo_canonical%'
           or p.proname like 'seo_directives%' or p.proname like 'public_seo_metadata%')
      and p.prosecdef),
  10, 'all ten are security definer');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'seo_metadata%' or p.proname like 'seo_canonical%'
           or p.proname like 'seo_directives%' or p.proname like 'public_seo_metadata%')
      and p.proconfig @> array['search_path=pg_catalog, public']),
  10, 'all ten pin search_path to pg_catalog, public');

select matches(pg_get_function_result(p.oid), 'can_manage boolean',
  'the staff detail reports the manage capability')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'seo_metadata_entry_for_staff';

select matches(pg_get_function_result(p.oid), 'effective_robots_directives text\[\]',
  'and reports what the public would actually receive')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'seo_metadata_entry_for_staff';

-- `seo_metadata.structured_data` has no reader anywhere, which is the deliberate omission this increment states.
--
-- Scoped to the metadata cluster, and `seo_settings%` is excluded explicitly. 0096 gave
-- `seo_settings.organization_structured_data` a *writer*, so an operator can author it — and deliberately no
-- reader and no emitter, for the very reason this increment recorded: what belongs in such a document is fixed by
-- the Blueprint SEO section, and emitting it would mean inventing schema.org shapes. That is a different column on
-- a different table, and the invariant that nothing in 0096 builds a structured-data document, a URL or an origin
-- is asserted in 0096's own suite. This assertion stays exactly as strong about the column it is here for.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like '%seo_metadata%' or p.proname like 'seo_%')
      and p.proname not like 'seo_settings%'
      and pg_get_functiondef(p.oid) ~ 'structured_data'),
  0, 'no function of the metadata cluster reads seo_metadata.structured_data');

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select ok(has_function_privilege('app_system', p.oid, 'execute'),
    format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and (p.proname like 'seo_metadata%' or p.proname like 'seo_canonical%'
        or p.proname like 'seo_directives%' or p.proname like 'public_seo_metadata%')
 order by p.proname;

select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
    format('%s may not execute %s', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_worker')) as r(rolname)
 where n.nspname = 'app_private'
   and (p.proname like 'seo_metadata%' or p.proname like 'seo_canonical%'
        or p.proname like 'seo_directives%' or p.proname like 'public_seo_metadata%')
 order by r.rolname, p.proname;

-- ---------------------------------------------------------------------------------------------------
-- Nothing in 0030 was changed
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'seo_metadata', 'the metadata table is untouched');
select has_function('public', 'seo_metadata_is_public', array['text', 'uuid'],
  '0030''s publication predicate is untouched');
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'seo_metadata'),
  16, 'the table still has exactly its sixteen 0030 columns');
select has_index('public', 'seo_metadata', 'seo_metadata_entity', 'the entity index is untouched');
select has_index('public', 'seo_metadata', 'seo_metadata_route', 'the route index is untouched');
select ok(
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'seo_metadata' and not t.tgisinternal) >= 2,
  '0030''s two metadata triggers are still installed');

-- ---------------------------------------------------------------------------------------------------
-- Owner decision 1 — which kinds honour a canonical
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.seo_canonical_is_honoured('route'), 'a route honours its canonical');
select ok(app_private.seo_canonical_is_honoured('page'), 'and so does a CMS page');
select ok(not app_private.seo_canonical_is_honoured('listing'), 'a listing does not');
select ok(not app_private.seo_canonical_is_honoured('category'), 'nor does a category');
select ok(not app_private.seo_canonical_is_honoured('seller'), 'nor does a seller');
select ok(not app_private.seo_canonical_is_honoured('blog_post'), 'nor does anything else');

-- ---------------------------------------------------------------------------------------------------
-- Owner decision 2 — restrict-only directives
-- ---------------------------------------------------------------------------------------------------
select is(
  app_private.seo_directives_restrictive_only(array['index', 'follow']),
  '{}'::text[], 'the permissive default survives as nothing at all');
select is(
  app_private.seo_directives_restrictive_only(array['noindex', 'follow']),
  array['noindex'], 'a restriction survives and the permission beside it does not');
select is(
  app_private.seo_directives_restrictive_only(array['index', 'nofollow']),
  array['nofollow'], 'and the other way round');
select is(
  app_private.seo_directives_restrictive_only(array['nosnippet', 'noarchive', 'noimageindex']),
  array['noarchive', 'noimageindex', 'nosnippet'], 'every restriction survives, sorted');
select is(
  app_private.seo_directives_restrictive_only(array['index', 'follow', 'max-snippet:-1']),
  '{}'::text[], 'max-snippet:-1 is permissive, so it is dropped too');
select is(
  app_private.seo_directives_restrictive_only(null),
  '{}'::text[], 'and nothing at all is nothing at all');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- An operator holding both keys through the admin role (0033 grants every permission to admin and super_admin,
-- and both roles require MFA); a colleague holding the read key only; and a signed-in person holding neither.
--
-- The read-only colleague is made by granting `seo.metadata.read` to the seeded moderator role **inside this
-- transaction**. That is a fixture and is rolled back: 0033's own grants are not changed and no permission is
-- invented. It is the only way to prove the two keys are genuinely separate, because the roles 0033 grants them
-- to hold both.
insert into auth.users (id, email) values
  ('dddddddd-0000-4000-8000-000000000001', 'metadata-operator@example.test'),
  ('dddddddd-0000-4000-8000-000000000002', 'metadata-reader@example.test'),
  ('dddddddd-0000-4000-8000-000000000003', 'metadata-nobody@example.test'),
  ('dddddddd-0000-4000-8000-00000000000a', 'meta-seller@test.invalid'),
  ('dddddddd-0000-4000-8000-00000000000b', 'meta-gone-seller@test.invalid');
insert into public.user_roles (user_id, role_key) values
  ('dddddddd-0000-4000-8000-000000000001', 'admin'),
  ('dddddddd-0000-4000-8000-000000000002', 'moderator');
insert into public.role_permissions (role_key, permission_key)
values ('moderator', 'seo.metadata.read')
on conflict (role_key, permission_key) do nothing;

create function pg_temp.operator() returns uuid language sql immutable as
  $f$ select 'dddddddd-0000-4000-8000-000000000001'::uuid $f$;
create function pg_temp.reader() returns uuid language sql immutable as
  $f$ select 'dddddddd-0000-4000-8000-000000000002'::uuid $f$;
create function pg_temp.nobody() returns uuid language sql immutable as
  $f$ select 'dddddddd-0000-4000-8000-000000000003'::uuid $f$;

-- A currency and a country for the listings below.
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default,
                               is_pricing_enabled, is_checkout_enabled)
values ('XTM', '966', 'M', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code,
                              default_currency_code, is_marketplace_enabled)
values ('ZM', 'ZMZ', '997', 'Metaland', 'Metaland', '997', 'XTM', true);

-- One live seller and one suspended one.
insert into public.seller_profiles
  (user_id, slug, display_name, country_code, status, verification_status, verified_at,
   suspended_at, suspension_reason)
values
  ('dddddddd-0000-4000-8000-00000000000a', 'meta-shop', 'Meta Shop', 'ZM', 'active', 'verified', now(), null, null),
  ('dddddddd-0000-4000-8000-00000000000b', 'meta-gone-shop', 'Gone Shop', 'ZM', 'suspended', 'verified', now(),
   now(), 'Suspended for the purposes of this test');

-- One shown category and one switched off.
insert into public.categories (id, parent_id, slug, listing_type_code, is_active, sort_order) values
  ('ddd00000-0000-4000-8000-0000000000c1', null, 'meta-furniture', null, true, 1),
  ('ddd00000-0000-4000-8000-0000000000c2', null, 'meta-hidden', null, false, 2);
insert into public.category_translations (category_id, locale_code, name) values
  ('ddd00000-0000-4000-8000-0000000000c1', 'en', 'Furniture'),
  ('ddd00000-0000-4000-8000-0000000000c2', 'en', 'Hidden');

-- One active listing, one draft, one sold, and one service — a service is a `listings` row, which is why there
-- is no `service` entity kind to test.
insert into public.listings
  (id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
   currency_code, price_minor, is_negotiable, status, country_code, city, approved_at, created_at, sold_at)
values
  ('ddd10000-0000-4000-8000-00000000001a', 'dddddddd-0000-4000-8000-00000000000a', 'product',
   'ddd00000-0000-4000-8000-0000000000c1', 'meta-chair', 'A chair', 'A chair described well enough.', 'en',
   'XTM', 10000, false, 'active', 'ZM', 'Cairo', now(), now(), null),
  ('ddd10000-0000-4000-8000-00000000001b', 'dddddddd-0000-4000-8000-00000000000a', 'product',
   'ddd00000-0000-4000-8000-0000000000c1', 'meta-draft-chair', 'A draft chair',
   'A draft chair described well enough.', 'en', 'XTM', 10000, false, 'draft', 'ZM', 'Cairo', null, now(), null),
  ('ddd10000-0000-4000-8000-00000000001c', 'dddddddd-0000-4000-8000-00000000000a', 'product',
   'ddd00000-0000-4000-8000-0000000000c1', 'meta-sold-chair', 'A sold chair',
   'A sold chair described well enough.', 'en', 'XTM', 10000, false, 'sold', 'ZM', 'Cairo', now(), now(), now()),
  ('ddd10000-0000-4000-8000-00000000001d', 'dddddddd-0000-4000-8000-00000000000a', 'service',
   'ddd00000-0000-4000-8000-0000000000c1', 'meta-haircut', 'A haircut', 'A haircut described well enough.', 'en',
   'XTM', 5000, false, 'active', 'ZM', 'Cairo', now(), now(), null);

-- One published CMS page and one draft.
insert into public.pages (id, slug, status, published_at, template) values
  ('ddd20000-0000-4000-8000-00000000002a', 'meta-about', 'published', now() - interval '1 day', 'standard'),
  ('ddd20000-0000-4000-8000-00000000002b', 'meta-unpublished', 'draft', null, 'standard');

-- A share image, so the media join has something to find.
insert into public.cms_media (id, object_path, mime_type, byte_size, alt_text_en) values
  ('ddd30000-0000-4000-8000-00000000003a', 'cms-media/share/meta-card.png', 'image/png', 4096, 'A share card');

-- ---------------------------------------------------------------------------------------------------
-- The permission predicates
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.seo_metadata_can_read(pg_temp.operator(), true), 'the operator may read at aal2');
select ok(app_private.seo_metadata_can_manage(pg_temp.operator(), true), 'the operator may manage at aal2');
select ok(not app_private.seo_metadata_can_read(pg_temp.operator(), false), 'and neither key at aal1');
select ok(not app_private.seo_metadata_can_manage(pg_temp.operator(), false), 'nor the manage key at aal1');
select ok(app_private.seo_metadata_can_read(pg_temp.reader(), true), 'the read-only colleague may read');
select ok(not app_private.seo_metadata_can_manage(pg_temp.reader(), true),
  'and may not manage: the two keys are separate');
select ok(not app_private.seo_metadata_can_read(pg_temp.nobody(), true), 'somebody with neither key may not read');
select ok(not app_private.seo_metadata_can_manage(pg_temp.nobody(), true), 'nor manage');

-- ---------------------------------------------------------------------------------------------------
-- Saving
-- ---------------------------------------------------------------------------------------------------
select lives_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, '/listings', 'en',
       'Browse every listing', 'Everything on the marketplace.', '/listings',
       array['index', 'follow'], 'Browse', 'Everything.', 'ddd30000-0000-4000-8000-00000000003a') $$,
  'the operator writes a route override');

select is(
  (select meta_title from public.seo_metadata where route_path = '/listings' and locale_code = 'en'),
  'Browse every listing', 'the title is stored');
select is(
  (select updated_by from public.seo_metadata where route_path = '/listings' and locale_code = 'en'),
  pg_temp.operator(), 'the author is recorded in 0030''s own updated_by column');
select is(
  (select entity_id from public.seo_metadata where route_path = '/listings' and locale_code = 'en'),
  null, 'a route carries no identifier, as 0030''s exclusivity constraint requires');

-- Create and replace are one request, against the route index.
select is(
  (select app_private.seo_metadata_save_for_staff(
     pg_temp.operator(), true, 'route', null, '/listings', 'en', 'Browse everything')),
  (select id from public.seo_metadata where route_path = '/listings' and locale_code = 'en'),
  'saving the same route and locale again returns the same row');
select is(
  (select count(*)::int from public.seo_metadata where route_path = '/listings' and locale_code = 'en'),
  1, 'and there is still one row');
select is(
  (select meta_title from public.seo_metadata where route_path = '/listings' and locale_code = 'en'),
  'Browse everything', 'whose title was replaced');
select is(
  (select meta_description from public.seo_metadata where route_path = '/listings' and locale_code = 'en'),
  null, 'and whose other fields were replaced too: this is a replace, not a patch');

-- The same for an entity, against the other index.
select lives_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'category',
       'ddd00000-0000-4000-8000-0000000000c1', null, 'en', 'Lovely furniture', 'Chairs and tables.') $$,
  'the operator writes a category override');
select is(
  (select app_private.seo_metadata_save_for_staff(
     pg_temp.operator(), true, 'category', 'ddd00000-0000-4000-8000-0000000000c1', null, 'en',
     'Lovely furniture, revised')),
  (select id from public.seo_metadata
    where entity_type = 'category' and entity_id = 'ddd00000-0000-4000-8000-0000000000c1' and locale_code = 'en'),
  'saving the same entity and locale again returns the same row');
select is(
  (select count(*)::int from public.seo_metadata where entity_type = 'category'),
  1, 'and there is still one category row');

-- A second locale of the same entity is a different row, not a replacement.
select lives_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'category',
       'ddd00000-0000-4000-8000-0000000000c1', null, 'ar', 'أثاث جميل') $$,
  'the same entity may be written in a second locale');
select is(
  (select count(*)::int from public.seo_metadata where entity_type = 'category'),
  2, 'which is a second row');

-- Blank text is absent rather than empty, so a surface never carries a blank meta tag.
select lives_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'seller',
       'dddddddd-0000-4000-8000-00000000000a', null, 'en', '   ', '   ', '   ') $$,
  'blank fields are accepted');
select is(
  (select meta_title from public.seo_metadata
    where entity_type = 'seller' and entity_id = 'dddddddd-0000-4000-8000-00000000000a'),
  null, 'and stored as absent rather than as an empty string');

-- The default directive set is 0030's own column default when none is given.
select is(
  (select robots_directives from public.seo_metadata
    where entity_type = 'seller' and entity_id = 'dddddddd-0000-4000-8000-00000000000a'),
  array['index', 'follow'], 'a save with no directives stores 0030''s own default');

-- ---------------------------------------------------------------------------------------------------
-- 0030's constraints still decide every rule
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'widget', null, '/x', 'en') $$,
  '23514', null, 'an entity type 0030 does not list is refused');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, 'not-a-path', 'en') $$,
  '23514', null, 'a route path that is not relative is refused');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, '//evil.test', 'en') $$,
  '23514', null, 'a protocol-relative route path cannot leave the site');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, '/fine', 'en',
       null, null, 'https://evil.test/') $$,
  '23514', null, 'an external canonical is refused: no outside URL can be injected');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, '/fine', 'en',
       null, null, '//evil.test') $$,
  '23514', null, 'nor a protocol-relative one');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, '/fine', 'en', repeat('t', 71)) $$,
  '23514', null, 'a meta title past seventy characters is refused');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, '/fine', 'en',
       null, repeat('d', 321)) $$,
  '23514', null, 'a meta description past three hundred and twenty is refused');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, '/fine', 'en',
       null, null, null, array['index', 'follow'], repeat('o', 121)) $$,
  '23514', null, 'an OpenGraph title past one hundred and twenty is refused');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, '/fine', 'en',
       null, null, null, '{}'::text[]) $$,
  '23514', null, 'an empty directive set is refused');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, '/fine', 'en',
       null, null, null, array['index', 'sometimes']) $$,
  '23514', null, 'a directive 0030 does not list is refused');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, '/fine', 'en',
       null, null, null, array['index', 'noindex']) $$,
  '23514', null, 'index and noindex together are refused');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, '/fine', 'en',
       null, null, null, array['follow', 'nofollow']) $$,
  '23514', null, 'and so are follow and nofollow');

-- 0030's exclusivity constraint never has to fire on this path, because the writer cannot propose a row that
-- would break it: a route carries a path and no identifier, everything else carries an identifier and no path,
-- and the branch is chosen by kind rather than by what the caller sent. A route path handed in for a category is
-- therefore ignored rather than refused — which is the stronger outcome, and this asserts it.
select lives_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'category',
       'ddd00000-0000-4000-8000-0000000000c2', '/also-a-path', 'en', 'Hidden with a stray path') $$,
  'a route path handed in for a category is ignored rather than refused');
select is(
  (select route_path from public.seo_metadata
    where entity_type = 'category' and entity_id = 'ddd00000-0000-4000-8000-0000000000c2'),
  null, 'and the stored row carries no route path, so 0030''s exclusivity rule is never even tested');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, true, 'route', null, '/fine', 'zz') $$,
  '23503', null, 'a locale that is not seeded is refused by the foreign key');

-- ---------------------------------------------------------------------------------------------------
-- Every writer refuses a caller without the manage key
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000002'::uuid, true, 'route', null, '/reader-tried', 'en') $$,
  '42501', null, 'the read-only colleague may not save');

select throws_ok(
  $$ select app_private.seo_metadata_save_for_staff(
       'dddddddd-0000-4000-8000-000000000001'::uuid, false, 'route', null, '/aal1-tried', 'en') $$,
  '42501', null, 'and neither may the operator at aal1');

select throws_ok(
  $$ select app_private.seo_metadata_delete_for_staff(
       'dddddddd-0000-4000-8000-000000000002'::uuid, true,
       (select id from public.seo_metadata where route_path = '/listings')) $$,
  '42501', null, 'nor may the read-only colleague remove one');

select is(
  (select count(*)::int from public.seo_metadata where route_path = '/listings'),
  1, 'and none of those refusals changed anything');

-- ---------------------------------------------------------------------------------------------------
-- The public reader — owner decision 1 in practice
-- ---------------------------------------------------------------------------------------------------
-- A route honours its canonical, because there is no derived one to contradict.
select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'route', null, '/marketplace', 'en',
  'The marketplace', 'Everything, in one place.', '/marketplace', array['index', 'follow'],
  'The marketplace', 'Everything.', 'ddd30000-0000-4000-8000-00000000003a');
select is(
  (select canonical_path from app_private.public_seo_metadata_for_route('/marketplace', 'en')),
  '/marketplace', 'a route''s canonical is read');
select is(
  (select share_object_path from app_private.public_seo_metadata_for_route('/marketplace', 'en')),
  'cms-media/share/meta-card.png', 'and its share image comes back as a relative object path');
select is(
  (select og_title from app_private.public_seo_metadata_for_route('/marketplace', 'en')),
  'The marketplace', 'with its OpenGraph title');

-- A CMS page honours its canonical too.
select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'page', 'ddd20000-0000-4000-8000-00000000002a', null, 'en',
  'About the marketplace', null, '/about');
select is(
  (select canonical_path from app_private.public_seo_metadata_for_entity('page', 'meta-about', 'en')),
  '/about', 'a CMS page''s canonical is read');

-- The three catalogue kinds do not, however it was stored.
select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'listing', 'ddd10000-0000-4000-8000-00000000001a', null, 'en',
  'A lovely chair', 'A chair worth having.', '/somewhere-else');
select is(
  (select meta_title from app_private.public_seo_metadata_for_entity('listing', 'meta-chair', 'en')),
  'A lovely chair', 'a listing''s title override is read');
select is(
  (select canonical_path from app_private.public_seo_metadata_for_entity('listing', 'meta-chair', 'en')),
  null, 'and its stored canonical is withheld: the listing keeps its self-referencing one');
select is(
  (select canonical_path from public.seo_metadata
    where entity_type = 'listing' and entity_id = 'ddd10000-0000-4000-8000-00000000001a'),
  '/somewhere-else', 'while the stored value is still there, untouched');

select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'category', 'ddd00000-0000-4000-8000-0000000000c1', null, 'en',
  'Lovely furniture', 'Chairs and tables.', '/elsewhere');
select is(
  (select canonical_path from app_private.public_seo_metadata_for_entity('category', 'meta-furniture', 'en')),
  null, 'a category''s stored canonical is withheld too');

select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'seller', 'dddddddd-0000-4000-8000-00000000000a', null, 'en',
  'Meta Shop', 'A good shop.', '/elsewhere');
select is(
  (select canonical_path from app_private.public_seo_metadata_for_entity('seller', 'meta-shop', 'en')),
  null, 'and so is a seller''s');
select is(
  (select meta_description from app_private.public_seo_metadata_for_entity('seller', 'meta-shop', 'en')),
  'A good shop.', 'while everything else about the seller override is read');

-- ---------------------------------------------------------------------------------------------------
-- The public reader — owner decision 2 in practice
-- ---------------------------------------------------------------------------------------------------
select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'listing', 'ddd10000-0000-4000-8000-00000000001d', null, 'en',
  'A haircut', null, null, array['index', 'follow']);
select is(
  (select robots_directives from app_private.public_seo_metadata_for_entity('listing', 'meta-haircut', 'en')),
  '{}'::text[], 'a stored index and follow reach the public as nothing: they cannot widen anything');

select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'listing', 'ddd10000-0000-4000-8000-00000000001d', null, 'en',
  'A haircut', null, null, array['noindex', 'nosnippet']);
select is(
  (select robots_directives from app_private.public_seo_metadata_for_entity('listing', 'meta-haircut', 'en')),
  array['noindex', 'nosnippet'], 'while restrictions reach it intact');

select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'listing', 'ddd10000-0000-4000-8000-00000000001d', null, 'en',
  'A haircut', null, null, array['index', 'nosnippet']);
select is(
  (select robots_directives from app_private.public_seo_metadata_for_entity('listing', 'meta-haircut', 'en')),
  array['nosnippet'], 'and a mixed set arrives with only its restrictive half');

-- ---------------------------------------------------------------------------------------------------
-- The public reader — publicness is 0030's predicate and nothing else
-- ---------------------------------------------------------------------------------------------------
select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'page', 'ddd20000-0000-4000-8000-00000000002b', null, 'en', 'Not published yet');
select is(
  (select count(*)::int from app_private.public_seo_metadata_for_entity('page', 'meta-unpublished', 'en')),
  0, 'a draft page''s override is withheld: its title would be a leak');

select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'category', 'ddd00000-0000-4000-8000-0000000000c2', null, 'en', 'Hidden');
select is(
  (select count(*)::int from app_private.public_seo_metadata_for_entity('category', 'meta-hidden', 'en')),
  0, 'and so is a category that is switched off');

select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'seller', 'dddddddd-0000-4000-8000-00000000000b', null, 'en', 'Gone Shop');
select is(
  (select count(*)::int from app_private.public_seo_metadata_for_entity('seller', 'meta-gone-shop', 'en')),
  0, 'and so is a suspended seller''s');

select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'listing', 'ddd10000-0000-4000-8000-00000000001b', null, 'en', 'A draft chair');
select is(
  (select count(*)::int from app_private.public_seo_metadata_for_entity('listing', 'meta-draft-chair', 'en')),
  0, 'and so is a draft listing''s');

-- A sold listing's page is public per the state table, and 0030's predicate admits it.
select app_private.seo_metadata_save_for_staff(
  pg_temp.operator(), true, 'listing', 'ddd10000-0000-4000-8000-00000000001c', null, 'en', 'A sold chair');
select is(
  (select meta_title from app_private.public_seo_metadata_for_entity('listing', 'meta-sold-chair', 'en')),
  'A sold chair', 'a sold listing''s override is read, because its page is still public');

-- ---------------------------------------------------------------------------------------------------
-- The public reader — what it answers nothing for
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.public_seo_metadata_for_entity('listing', 'no-such-slug', 'en')),
  0, 'a slug that names nothing answers nothing');
select is(
  (select count(*)::int from app_private.public_seo_metadata_for_entity('listing', null, 'en')),
  0, 'and so does no slug at all');
select is(
  (select count(*)::int from app_private.public_seo_metadata_for_entity('listing', 'meta-chair', 'ar')),
  0, 'a locale with no row is no override, never a fallback to the other language');
select is(
  (select count(*)::int from app_private.public_seo_metadata_for_route('/nowhere', 'en')),
  0, 'a route with no row answers nothing');
select is(
  (select count(*)::int from app_private.public_seo_metadata_for_entity('blog_post', 'anything', 'en')),
  0, 'a blog kind answers nothing, because no blog surface exists yet');
select is(
  (select count(*)::int from app_private.public_seo_metadata_for_entity('route', '/listings', 'en')),
  0, 'and a route is not addressed by slug: it has its own reader');

-- A service is a listing, so the same reader answers for it.
select is(
  (select meta_title from app_private.public_seo_metadata_for_entity('listing', 'meta-haircut', 'en')),
  'A haircut', 'a service resolves through the listing kind, because 0030 has no service kind');

-- ---------------------------------------------------------------------------------------------------
-- The staff list
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 100)) >= 8,
  'the operator sees the entries');
select ok(
  (select count(*) from app_private.seo_metadata_for_staff(pg_temp.reader(), true, 100)) >= 8,
  'and so does the read-only colleague');
select is(
  (select count(*)::int from app_private.seo_metadata_for_staff(pg_temp.nobody(), true, 100)),
  0, 'somebody without the read key sees nothing rather than being told so');
select is(
  (select count(*)::int from app_private.seo_metadata_for_staff(pg_temp.operator(), false, 100)),
  0, 'and nor does the operator at aal1');
select is(
  (select count(*)::int from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 3)),
  3, 'the limit is honoured');
select is(
  (select entry_id from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 1)),
  (select m.id from public.seo_metadata m order by m.updated_at desc, m.id desc limit 1),
  'the list is newest edit first');

-- The target is named, not left as an identifier.
select is(
  (select target_slug from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 100, 'listing', 'en')
    where entity_id = 'ddd10000-0000-4000-8000-00000000001a'),
  'meta-chair', 'a listing entry names the listing it points at');
select is(
  (select target_slug from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 100, 'seller', 'en')
    where entity_id = 'dddddddd-0000-4000-8000-00000000000a'),
  'meta-shop', 'a seller entry resolves through user_id, which is the profile''s key');

select is(
  (select count(*)::int from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 100, 'category')),
  3, 'the entity-type filter narrows to one kind');
select is(
  (select count(*)::int from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 100, 'category', 'ar')),
  1, 'and the locale filter narrows further');
select is(
  (select count(*)::int from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 100, 'widget')),
  0, 'an unknown kind matches nothing rather than being refused');

-- The list reports what was stored, not what the public gets: an operator must see their own work.
select is(
  (select canonical_path from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 100, 'listing', 'en')
    where entity_id = 'ddd10000-0000-4000-8000-00000000001a'),
  '/somewhere-else', 'the list shows the stored canonical even where the public will not receive it');
select ok(
  (select not canonical_is_honoured
     from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 100, 'listing', 'en')
    where entity_id = 'ddd10000-0000-4000-8000-00000000001a'),
  'and says that this kind does not honour it');

-- The cursor pages without repeating or skipping a row.
select is(
  (select count(*)::int from (
     select entry_id from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 3)
     union
     select entry_id from app_private.seo_metadata_for_staff(
       pg_temp.operator(), true, 100, null, null,
       (select updated_at from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 3)
         order by updated_at, entry_id limit 1),
       (select entry_id from app_private.seo_metadata_for_staff(pg_temp.operator(), true, 3)
         order by updated_at, entry_id limit 1))
   ) as everything),
  (select count(*)::int from public.seo_metadata),
  'the first page and the rest after its cursor are every entry exactly once');

-- ---------------------------------------------------------------------------------------------------
-- The staff detail
-- ---------------------------------------------------------------------------------------------------
select is(
  (select entity_type from app_private.seo_metadata_entry_for_staff(
     pg_temp.operator(), true,
     (select id from public.seo_metadata where route_path = '/marketplace'))),
  'route', 'the operator reads one entry');
select is(
  (select can_manage from app_private.seo_metadata_entry_for_staff(
     pg_temp.operator(), true,
     (select id from public.seo_metadata where route_path = '/marketplace'))),
  true, 'and is told they may change it');
select is(
  (select can_manage from app_private.seo_metadata_entry_for_staff(
     pg_temp.reader(), true,
     (select id from public.seo_metadata where route_path = '/marketplace'))),
  false, 'while the read-only colleague is told they may not');
select is(
  (select share_object_path from app_private.seo_metadata_entry_for_staff(
     pg_temp.operator(), true,
     (select id from public.seo_metadata where route_path = '/marketplace'))),
  'cms-media/share/meta-card.png', 'the share image is named as a relative object path');

-- The detail shows the stored value beside what the public will receive, which is the point of it.
select is(
  (select canonical_path from app_private.seo_metadata_entry_for_staff(
     pg_temp.operator(), true,
     (select id from public.seo_metadata where entity_type = 'listing'
       and entity_id = 'ddd10000-0000-4000-8000-00000000001a'))),
  '/somewhere-else', 'a withheld canonical is shown as stored');
select is(
  (select effective_canonical_path from app_private.seo_metadata_entry_for_staff(
     pg_temp.operator(), true,
     (select id from public.seo_metadata where entity_type = 'listing'
       and entity_id = 'ddd10000-0000-4000-8000-00000000001a'))),
  null, 'and as nothing in effect');
select is(
  (select effective_robots_directives from app_private.seo_metadata_entry_for_staff(
     pg_temp.operator(), true,
     (select id from public.seo_metadata where entity_type = 'listing'
       and entity_id = 'ddd10000-0000-4000-8000-00000000001d'))),
  array['nosnippet'], 'and a permissive directive is shown as having no effect');

select is(
  (select count(*)::int from app_private.seo_metadata_entry_for_staff(
     pg_temp.nobody(), true, (select id from public.seo_metadata where route_path = '/marketplace'))),
  0, 'somebody without the read key gets no row');
select is(
  (select count(*)::int from app_private.seo_metadata_entry_for_staff(
     pg_temp.operator(), true, '00000000-0000-4000-8000-000000000000'::uuid)),
  0, 'and so does an entry that does not exist: one answer for absence and for a missing permission');

-- ---------------------------------------------------------------------------------------------------
-- Removing
-- ---------------------------------------------------------------------------------------------------
select is(
  (select app_private.seo_metadata_delete_for_staff(
     pg_temp.operator(), true, (select id from public.seo_metadata where route_path = '/listings'))),
  true, 'the operator removes an override');
select is(
  (select count(*)::int from public.seo_metadata where route_path = '/listings'),
  0, 'and it is gone');
select is(
  (select count(*)::int from app_private.public_seo_metadata_for_route('/listings', 'en')),
  0, 'so the route is back to the metadata it derives from its own content');
select is(
  (select app_private.seo_metadata_delete_for_staff(
     pg_temp.operator(), true, '00000000-0000-4000-8000-000000000000'::uuid)),
  false, 'removing an entry that does not exist says so');

-- ---------------------------------------------------------------------------------------------------
-- 0030's audit trigger still fires
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from audit.audit_logs where table_name = 'seo_metadata' and action = 'insert') >= 1,
  'writing an override is audited');
select ok(
  (select count(*) from audit.audit_logs where table_name = 'seo_metadata' and action = 'update') >= 1,
  'replacing one is audited');
select ok(
  (select count(*) from audit.audit_logs where table_name = 'seo_metadata' and action = 'delete') >= 1,
  'and so is removing one');

-- ---------------------------------------------------------------------------------------------------
-- Nothing financial, and nothing that reads a caller identity on the public path
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'seo_%' or p.proname like 'public_seo_%')
      and pg_get_functiondef(p.oid) ~* 'ledger_entries|ledger_journals|seller_balances|payouts|payments|settlement|withdrawal|commission_rules|tax_rules|coupons'),
  0, 'no function here names a financial function or table');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'public_seo_metadata%'
      and pg_get_functiondef(p.oid) ~* 'current_user_id|auth\.uid|app\.user_id|audit_actor'),
  0, 'and the public readers read no caller identity: they answer the same for everybody');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'seo_%' or p.proname like 'public_seo_%')
      and pg_get_functiondef(p.oid) ~* 'audit_actor'),
  0, 'and no writer names the 8-B attribution channel');

select * from finish();
rollback;
