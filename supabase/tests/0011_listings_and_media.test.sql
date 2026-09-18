-- pgTAP — migration 0011: listing lifecycle, visibility, slug history, attribute values, tags and media.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(25);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zz', 'Test locale', 'Test locale', 'ltr', true, true);

insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTS', '963', 'T', 2, true, true, true, true);

insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZZ', 'ZZZ', '999', 'Enabled country', 'Enabled country', '999', 'XTS', true);

insert into public.listing_types (code, name_en, name_ar) values ('product', 'Product', 'Product');

insert into auth.users (id, email) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'seller@example.test'),
  ('bbbbbbbb-2222-4222-8222-222222222222', 'buyer@example.test'),
  ('cccccccc-3333-4333-8333-333333333333', 'other@example.test');

insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status)
values ('aaaaaaaa-1111-4111-8111-111111111111', 'test-seller', 'Test Seller', 'ZZ', 'verified', now(), 'active'),
       ('cccccccc-3333-4333-8333-333333333333', 'other-seller', 'Other Seller', 'ZZ', 'verified', now(), 'active');

insert into public.categories (id, slug) values ('11111111-aaaa-4aaa-8aaa-111111111111', 'electronics');

insert into public.listings (id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language, currency_code, price_minor, country_code)
values ('99999999-aaaa-4aaa-8aaa-999999999999', 'aaaaaaaa-1111-4111-8111-111111111111', 'product',
        '11111111-aaaa-4aaa-8aaa-111111111111', 'blue-widget', 'Blue widget', 'A widget that is blue.',
        'zz', 'XTS', 15000, 'ZZ');

-- Lifecycle ------------------------------------------------------------------------------------------
select is((select status from public.listings where slug = 'blue-widget'), 'draft', 'a new listing starts as a draft');
select is(
  (select count(*) from public.listing_status_history where listing_id = '99999999-aaaa-4aaa-8aaa-999999999999'),
  1::bigint,
  'creating a listing records its first status entry'
);
select ok(not public.listing_is_visible('99999999-aaaa-4aaa-8aaa-999999999999'), 'a draft is not publicly visible');

select throws_ok(
  $$update public.listings set status = 'active' where slug = 'blue-widget'$$,
  '23514',
  null,
  'a listing cannot go live without an approval time'
);

update public.listings set status = 'active', approved_at = now(), published_at = now() where slug = 'blue-widget';

select ok(public.listing_is_visible('99999999-aaaa-4aaa-8aaa-999999999999'), 'an active listing is publicly visible');
select is(
  (select count(*) from public.outbox_events where event_type = 'listing.published' and aggregate_id = '99999999-aaaa-4aaa-8aaa-999999999999'),
  1::bigint,
  'going live publishes a revalidation event (C11)'
);

-- The visibility matrix --------------------------------------------------------------------------------
select ok(
  public.listing_status_is_public('sold') and public.listing_status_is_public('expired') and public.listing_status_is_public('archived'),
  'sold, expired and archived pages stay reachable with "No longer available" (D2, N7)'
);
select ok(
  not public.listing_status_is_purchasable('sold') and not public.listing_status_is_purchasable('expired'),
  'but none of them can be bought'
);
select ok(
  not public.listing_status_is_public('rejected') and not public.listing_status_is_public('suspended') and not public.listing_status_is_public('deleted'),
  'rejected, suspended and deleted listings return 404'
);
select ok(
  public.listing_status_is_indexable('active') and not public.listing_status_is_indexable('sold'),
  'only a live listing is indexable'
);

-- Slug history -----------------------------------------------------------------------------------------
update public.listings set slug = 'blue-widget-v2' where slug = 'blue-widget';
select is(
  (select count(*) from public.listing_slug_history where slug = 'blue-widget'),
  1::bigint,
  'the old slug is kept for the 301 redirect'
);

insert into public.listings (seller_user_id, listing_type_code, category_id, slug, title, description, content_language, currency_code, price_minor, country_code)
values ('cccccccc-3333-4333-8333-333333333333', 'product', '11111111-aaaa-4aaa-8aaa-111111111111',
        'green-widget', 'Green widget', 'A widget that is green.', 'zz', 'XTS', 12000, 'ZZ');

select throws_ok(
  $$update public.listings set slug = 'blue-widget' where slug = 'green-widget'$$,
  '23505',
  null,
  'a slug that is permanently redirected can never be taken by another listing'
);

-- Search vectors and geography --------------------------------------------------------------------------
select ok(
  (select search_vector_en @@ to_tsquery('english', 'widget') from public.listings where slug = 'blue-widget-v2'),
  'the English search vector is generated from the title and description'
);
select isnt((select search_vector_ar from public.listings where slug = 'blue-widget-v2'), null, 'and the Arabic vector exists too');

update public.listings
   set location = extensions.ST_SetSRID(extensions.ST_MakePoint(31.2357, 30.0444), 4326)::extensions.geography
 where slug = 'blue-widget-v2';
select isnt((select location from public.listings where slug = 'blue-widget-v2'), null, 'a listing can carry a PostGIS point');

-- Attribute values ---------------------------------------------------------------------------------------
insert into public.attribute_definitions (id, key, data_type, name_en, name_ar)
values ('44444444-aaaa-4aaa-8aaa-444444444444', 'brand', 'single_select', 'Brand', 'Brand'),
       ('55555555-aaaa-4aaa-8aaa-555555555555', 'screen_size', 'number', 'Screen size', 'Screen size');
insert into public.attribute_options (id, attribute_definition_id, value, label_en, label_ar)
values ('66666666-aaaa-4aaa-8aaa-666666666666', '44444444-aaaa-4aaa-8aaa-444444444444', 'acme', 'Acme', 'Acme');

select throws_ok(
  $$insert into public.listing_attribute_values (listing_id, attribute_definition_id, value_text)
    values ('99999999-aaaa-4aaa-8aaa-999999999999', '55555555-aaaa-4aaa-8aaa-555555555555', 'big')$$,
  '23514',
  null,
  'a number attribute refuses a text value'
);

select throws_ok(
  $$insert into public.listing_attribute_values (listing_id, attribute_definition_id, value_number, value_text)
    values ('99999999-aaaa-4aaa-8aaa-999999999999', '55555555-aaaa-4aaa-8aaa-555555555555', 6.1, 'big')$$,
  '23514',
  null,
  'exactly one value column may be populated'
);

select throws_ok(
  $$insert into public.listing_attribute_values (listing_id, attribute_definition_id, option_ids)
    values ('99999999-aaaa-4aaa-8aaa-999999999999', '44444444-aaaa-4aaa-8aaa-444444444444', array['11111111-aaaa-4aaa-8aaa-111111111111'::uuid])$$,
  '23514',
  null,
  'an option must belong to the attribute it answers'
);

insert into public.listing_attribute_values (listing_id, attribute_definition_id, option_ids)
values ('99999999-aaaa-4aaa-8aaa-999999999999', '44444444-aaaa-4aaa-8aaa-444444444444', array['66666666-aaaa-4aaa-8aaa-666666666666'::uuid]);
select is(
  (select count(*) from public.listing_attribute_values where listing_id = '99999999-aaaa-4aaa-8aaa-999999999999'),
  1::bigint,
  'a valid option value is accepted'
);

-- Tags ----------------------------------------------------------------------------------------------------
insert into public.tags (id, slug, name_en, name_ar) values ('77777777-aaaa-4aaa-8aaa-777777777777', 'vintage', 'Vintage', 'Vintage');
insert into public.listing_tags (listing_id, tag_id) values ('99999999-aaaa-4aaa-8aaa-999999999999', '77777777-aaaa-4aaa-8aaa-777777777777');
select is((select usage_count from public.tags where slug = 'vintage'), 1, 'tagging a listing counts towards the tag');
delete from public.listing_tags where listing_id = '99999999-aaaa-4aaa-8aaa-999999999999';
select is((select usage_count from public.tags where slug = 'vintage'), 0, 'and untagging takes it back');

-- Media ------------------------------------------------------------------------------------------------------
insert into public.listing_media (id, listing_id, kind, original_object_path, status)
values ('88888888-aaaa-4aaa-8aaa-888888888888', '99999999-aaaa-4aaa-8aaa-999999999999', 'image', 'private/listing/original.jpg', 'ready');

select throws_ok(
  $$insert into public.media_variants (listing_media_id, variant_key, format, object_path, width, height, byte_size)
    values ('88888888-aaaa-4aaa-8aaa-888888888888', 'large', 'webp', 'private/listing/original.jpg', 800, 600, 1000)$$,
  '23001',
  null,
  'a variant may never point at the private original'
);

insert into public.media_variants (id, listing_media_id, variant_key, format, object_path, width, height, byte_size, is_public, published_at)
values ('aaaa1111-aaaa-4aaa-8aaa-aaaa11111111', '88888888-aaaa-4aaa-8aaa-888888888888', 'large', 'webp', 'public/listing/large.webp', 800, 600, 1000, true, now());
select ok((select is_public from public.media_variants where variant_key = 'large'), 'a variant may be public while the listing is visible');

-- Withdrawal: suspending the listing takes the public variants down immediately.
update public.listings set status = 'suspended' where slug = 'blue-widget-v2';
select ok(not (select is_public from public.media_variants where variant_key = 'large'), 'suspending the listing withdraws its public variants');
select is(
  (select count(*) from public.outbox_events where event_type = 'listing.withdrawn' and aggregate_id = '99999999-aaaa-4aaa-8aaa-999999999999'),
  1::bigint,
  'and publishes a withdrawal event so the worker clears the public objects'
);

select * from finish();
rollback;
