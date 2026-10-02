-- pgTAP — migration 0046: the public listing readers (Phase 4-B).
--
-- Two readers, and between them the whole of what a guest may learn about a listing. The assertions
-- fall into four groups: the boundary (who may call them, what columns they even declare), which
-- listings each one admits, what a detail answer contains and — as much as anything — what it does not.
--
-- The projection assertions matter most. A leak here is not a broken page, it is a seller's private
-- contact details on a public URL, so the tests check the declared columns of the functions rather than
-- only the values that happen to come back from these fixtures.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(53);

-- Fixtures ------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('b0000000-0000-4000-8000-000000000001', 'active-seller@test.invalid'),
  ('b0000000-0000-4000-8000-000000000002', 'suspended-seller@test.invalid');

-- An active seller must be verified, and a suspended one must carry its suspension time (0009).
insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, suspended_at, verification_status, verified_at)
values
  ('b0000000-0000-4000-8000-000000000001', 'good-shop', 'Good Shop', 'Good Shop LLC',
   'seller@test.invalid', '+201000000001', 'EG', 'active', null, 'verified', now() - interval '10 days'),
  ('b0000000-0000-4000-8000-000000000002', 'gone-shop', 'Gone Shop', 'Gone Shop LLC',
   'gone@test.invalid', '+201000000002', 'EG', 'suspended', now() - interval '1 day',
   'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c1000000-0000-4000-8000-000000000001', null, 'furniture', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('c1000000-0000-4000-8000-000000000001', 'en', 'Furniture'),
  ('c1000000-0000-4000-8000-000000000001', 'ar', 'أثاث');

insert into public.attribute_definitions (id, key, data_type, unit, name_en, name_ar) values
  ('d1000000-0000-4000-8000-000000000001', 'width', 'number', 'cm', 'Width', 'العرض'),
  ('d1000000-0000-4000-8000-000000000002', 'assembled', 'boolean', null, 'Assembled', 'مُجمَّع'),
  ('d1000000-0000-4000-8000-000000000003', 'material', 'single_select', null, 'Material', 'الخامة');
insert into public.attribute_options (id, attribute_definition_id, value, label_en, label_ar, sort_order) values
  ('e1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'wood', 'Wood', 'خشب', 1);

insert into public.tags (id, slug, name_en, name_ar) values
  ('f1000000-0000-4000-8000-000000000001', 'handmade', 'Handmade', 'صناعة يدوية'),
  ('f1000000-0000-4000-8000-000000000002', 'retired-tag', 'Retired', 'متقاعد');
update public.tags set is_active = false where slug = 'retired-tag';

/** One listing, since every column but status, slug, price and seller is the same across the set. */
create or replace function pg_temp.listing(
  p_id uuid, p_slug text, p_status text, p_seller uuid, p_price bigint, p_created timestamptz,
  p_negotiable boolean default false
) returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at,
    approved_at, sold_at, archived_at, deleted_at
  ) values (
    p_id, p_seller, 'product', 'c1000000-0000-4000-8000-000000000001', p_slug,
    'A listing title', 'A description long enough to satisfy the length rule.', 'en',
    'EGP', p_price, p_negotiable, p_status, 'EG', 'Cairo', p_created,
    case when p_status in ('approved','active','sold','expired','archived') then p_created else null end,
    case when p_status = 'sold' then p_created else null end,
    case when p_status = 'archived' then p_created else null end,
    case when p_status = 'deleted' then p_created else null end
  );
end;
$$;

select pg_temp.listing('11110000-0000-4000-8000-000000000001', 'sofa', 'active',
  'b0000000-0000-4000-8000-000000000001', 250000, now() - interval '1 hour', true);
select pg_temp.listing('11110000-0000-4000-8000-000000000002', 'table', 'approved',
  'b0000000-0000-4000-8000-000000000001', 125000, now() - interval '2 hours');
select pg_temp.listing('11110000-0000-4000-8000-000000000003', 'chair', 'sold',
  'b0000000-0000-4000-8000-000000000001', 50000, now() - interval '3 hours');
select pg_temp.listing('11110000-0000-4000-8000-000000000004', 'lamp', 'archived',
  'b0000000-0000-4000-8000-000000000001', 20000, now() - interval '4 hours');
select pg_temp.listing('11110000-0000-4000-8000-000000000005', 'draft-desk', 'draft',
  'b0000000-0000-4000-8000-000000000001', null, now() - interval '5 hours');
select pg_temp.listing('11110000-0000-4000-8000-000000000006', 'rejected-rug', 'rejected',
  'b0000000-0000-4000-8000-000000000001', null, now() - interval '6 hours');
select pg_temp.listing('11110000-0000-4000-8000-000000000007', 'hidden-shelf', 'active',
  'b0000000-0000-4000-8000-000000000002', 30000, now() - interval '7 hours');

insert into public.listing_attribute_values (listing_id, attribute_definition_id, value_number) values
  ('11110000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 180);
insert into public.listing_attribute_values (listing_id, attribute_definition_id, value_boolean) values
  ('11110000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', true);
insert into public.listing_attribute_values (listing_id, attribute_definition_id, option_ids) values
  ('11110000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003',
   array['e1000000-0000-4000-8000-000000000001'::uuid]);
insert into public.listing_tags (listing_id, tag_id) values
  ('11110000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001'),
  ('11110000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002');

insert into public.listing_slug_history (listing_id, slug) values
  ('11110000-0000-4000-8000-000000000001', 'old-sofa'),
  ('11110000-0000-4000-8000-000000000006', 'old-rug');

-- ---------------------------------------------------------------------------------------------------
-- Boundary
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'public_listings', array['integer','timestamptz','uuid'],
  'app_private.public_listings exists');
select has_function('app_private', 'public_listing_by_slug', array['text','text'],
  'app_private.public_listing_by_slug exists');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('public_listings', 'public_listing_by_slug')
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'both are SECURITY DEFINER with the pinned search_path');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('public_listings', 'public_listing_by_slug')
      and p.provolatile <> 's'),
  0::bigint,
  'and both are STABLE: browsing never writes');

select function_privs_are('app_private', 'public_listings', array['integer','timestamptz','uuid'],
  'app_system', array['EXECUTE'], 'app_system may read the browse list');
select function_privs_are('app_private', 'public_listings', array['integer','timestamptz','uuid'],
  'anon', array[]::text[], 'anon may not');
select function_privs_are('app_private', 'public_listings', array['integer','timestamptz','uuid'],
  'authenticated', array[]::text[], 'and neither may a signed-in browser role');
select function_privs_are('app_private', 'public_listing_by_slug', array['text','text'],
  'app_system', array['EXECUTE'], 'app_system may read one listing');
select function_privs_are('app_private', 'public_listing_by_slug', array['text','text'],
  'anon', array[]::text[], 'anon may not');
select function_privs_are('app_private', 'public_listing_by_slug', array['text','text'],
  'public', array[]::text[], 'nor PUBLIC');
select table_privs_are('public', 'listings', 'anon', array[]::text[],
  'anon holds no privilege on listings');
select table_privs_are('public', 'seller_profiles', 'anon', array[]::text[],
  'nor on seller_profiles');

-- ---------------------------------------------------------------------------------------------------
-- The projection: what the functions may even return
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select a.name::text from (
      select unnest(p.proargnames) as name, unnest(p.proargmodes) as mode
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app_private' and p.proname = 'public_listings') a
     where a.mode = 't'$$,
  $$values ('id'), ('slug'), ('title'), ('city'), ('price_minor'), ('currency_code'),
           ('currency_minor_unit'), ('is_negotiable'), ('listing_type_code'), ('created_at')$$,
  'the card carries exactly the approved fields');

select is(
  (select count(*) from (
     select unnest(p.proargnames) as name, unnest(p.proargmodes) as mode
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname in ('public_listings', 'public_listing_by_slug')) a
    where a.mode = 't'
      and a.name in ('seller_user_id', 'view_count', 'location', 'submitted_at', 'approved_at',
                     'published_at', 'sold_at', 'expires_at', 'archived_at', 'deleted_at', 'status',
                     'contact_email', 'contact_phone_e164', 'legal_name', 'verification_status')),
  0::bigint,
  'neither reader declares a forbidden column');

-- ---------------------------------------------------------------------------------------------------
-- The browse list
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select slug from app_private.public_listings(50, null, null)$$,
  $$values ('sofa'), ('table')$$,
  'the list shows purchasable listings of visible sellers, and only those');
select is(
  (select count(*) from app_private.public_listings(50, null, null) l where l.slug = 'chair'),
  0::bigint,
  'a sold listing is not in the browse list: the card has no availability marker to warn with');
select is(
  (select count(*) from app_private.public_listings(50, null, null) l where l.slug = 'lamp'),
  0::bigint,
  'and neither is an archived one');
select is(
  (select count(*) from app_private.public_listings(50, null, null) l
    where l.slug in ('draft-desk', 'rejected-rug')),
  0::bigint,
  'a draft and a rejected listing never appear');
select is(
  (select count(*) from app_private.public_listings(50, null, null) l where l.slug = 'hidden-shelf'),
  0::bigint,
  'and an active listing of a suspended seller is not listed');

select is(
  (select array_agg(t.slug) from (select slug from app_private.public_listings(50, null, null)) t),
  array['sofa', 'table'],
  'newest first, in the order the reader returned them');
select is((select count(*) from app_private.public_listings(1, null, null)), 1::bigint,
  'the limit is applied');
select is((select count(*) from app_private.public_listings(0, null, null)), 0::bigint,
  'a limit of zero returns nothing rather than everything');

-- Paging with the cursor lands exactly on the next row, with no overlap and no gap.
select is(
  (select slug from app_private.public_listings(
     1,
     (select created_at from app_private.public_listings(1, null, null)),
     (select id from app_private.public_listings(1, null, null)))),
  'table',
  'the cursor continues after the last row of the previous page');
select is(
  (select count(*) from app_private.public_listings(
     50,
     (select created_at from app_private.public_listings(50, null, null) order by created_at limit 1),
     (select id from app_private.public_listings(50, null, null) order by created_at limit 1))),
  0::bigint,
  'and paging past the last row returns nothing');

select is(
  (select l.currency_minor_unit from app_private.public_listings(50, null, null) l where l.slug = 'sofa'),
  2::smallint,
  'the currency minor unit travels with the price, because the money package has no currency table');
select is(
  (select l.is_negotiable from app_private.public_listings(50, null, null) l where l.slug = 'sofa'),
  true,
  'and the negotiable flag comes through');

-- ---------------------------------------------------------------------------------------------------
-- The detail page
-- ---------------------------------------------------------------------------------------------------
select is((select outcome from app_private.public_listing_by_slug('sofa')), 'found',
  'a current slug of a visible listing is found');
select is((select availability from app_private.public_listing_by_slug('sofa')), 'available',
  'an active listing is available');
select is((select availability from app_private.public_listing_by_slug('chair')), 'no_longer_available',
  'a sold listing is reachable and marked no longer available (D2)');
select is((select availability from app_private.public_listing_by_slug('lamp')), 'no_longer_available',
  'and so is an archived one (N7)');

select is((select outcome from app_private.public_listing_by_slug('draft-desk')), 'not_found',
  'a draft is not found');
select is((select outcome from app_private.public_listing_by_slug('rejected-rug')), 'not_found',
  'a rejected listing is not found');
select is((select outcome from app_private.public_listing_by_slug('hidden-shelf')), 'not_found',
  'a listing of a suspended seller is not found');
select is((select outcome from app_private.public_listing_by_slug('no-such-listing')), 'not_found',
  'and neither is a slug that names nothing');

select is((select outcome from app_private.public_listing_by_slug('old-sofa')), 'moved',
  'a previous slug reports a redirect');
select is((select canonical_slug from app_private.public_listing_by_slug('old-sofa')), 'sofa',
  'to the listing’s current slug');
select is((select outcome from app_private.public_listing_by_slug('old-rug')), 'not_found',
  'a previous slug of a non-public listing is not found: a 301 to a 404 would confirm it exists');

-- What the answer carries.
select is((select title from app_private.public_listing_by_slug('sofa')), 'A listing title',
  'the title is returned');
select is((select category ->> 'name' from app_private.public_listing_by_slug('sofa', 'en')), 'Furniture',
  'the category name follows the requested locale');
select is((select category ->> 'name' from app_private.public_listing_by_slug('sofa', 'ar')), 'أثاث',
  'in Arabic too');
select is((select seller from app_private.public_listing_by_slug('sofa')),
  '{"slug": "good-shop", "displayName": "Good Shop"}'::jsonb,
  'the seller projection is the display name and the slug, and nothing else');
select is((select price_minor from app_private.public_listing_by_slug('sofa')), 250000::bigint,
  'the price is the stored minor amount');
select is((select currency_code from app_private.public_listing_by_slug('sofa')), 'EGP',
  'in the listing’s own stored currency, with no conversion');

select is(
  (select jsonb_array_length(attributes) from app_private.public_listing_by_slug('sofa')),
  3,
  'every attribute the listing answered comes back');
select is(
  (select a ->> 'text' from app_private.public_listing_by_slug('sofa') l,
        jsonb_array_elements(l.attributes) a where a ->> 'key' = 'width'),
  '180',
  'a number attribute arrives as a plain value, with no invented formatting');
select is(
  (select a ->> 'unit' from app_private.public_listing_by_slug('sofa') l,
        jsonb_array_elements(l.attributes) a where a ->> 'key' = 'width'),
  'cm',
  'with its unit');
select is(
  (select a -> 'options' from app_private.public_listing_by_slug('sofa', 'ar') l,
        jsonb_array_elements(l.attributes) a where a ->> 'key' = 'material'),
  '["خشب"]'::jsonb,
  'a select attribute returns its option labels in the requested locale');
select is(
  (select a ->> 'label' from app_private.public_listing_by_slug('sofa', 'ar') l,
        jsonb_array_elements(l.attributes) a where a ->> 'key' = 'assembled'),
  'مُجمَّع',
  'and the attribute label follows the locale as well');

select is((select tags from app_private.public_listing_by_slug('sofa', 'en')),
  '[{"name": "Handmade", "slug": "handmade"}]'::jsonb,
  'only active tags are returned');

-- Nothing private, in the values as well as in the declaration.
select is(
  (select count(*) from app_private.public_listing_by_slug('sofa') l
    where l.seller::text like '%Good Shop LLC%'
       or l.seller::text like '%seller@test.invalid%'
       or l.seller::text like '%+201000000001%'
       or l.seller::text like '%verified%'),
  0::bigint,
  'the seller’s legal name, contact details and verification status never appear');

-- Reading past the end of the catalogue is an empty answer, not a failure. (The listing tables cannot
-- simply be emptied here: `listing_slug_history` is append-only by trigger, and a cascade would trip it.)
select is(
  (select count(*) from app_private.public_listings(
     50, now() - interval '100 years', '00000000-0000-4000-8000-000000000000')),
  0::bigint,
  'a cursor older than everything lists nothing rather than failing');
select lives_ok($$select * from app_private.public_listings(20, null, null)$$,
  'and the reader can be asked again');
select is(
  (select count(*) from app_private.public_listings(50, null, null) l where l.price_minor is null),
  0::bigint,
  'no listed card carries a null price: a live listing must have one (0011)');

select * from finish();
rollback;
