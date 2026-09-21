-- pgTAP — migration 0013: favorites, saved searches and the analytics event stream.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(10);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zz', 'Test locale', 'Test locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTS', '963', 'T', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZZ', 'ZZZ', '999', 'Enabled', 'Enabled', '999', 'XTS', true);
-- listing_types (`product`, `service`) are seeded reference data in 0033.
insert into auth.users (id, email) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'seller@example.test'),
  ('bbbbbbbb-2222-4222-8222-222222222222', 'buyer@example.test');
insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status)
values ('aaaaaaaa-1111-4111-8111-111111111111', 'test-seller', 'Test Seller', 'ZZ', 'verified', now(), 'active');
insert into public.categories (id, slug) values ('11111111-aaaa-4aaa-8aaa-111111111111', 'electronics');
insert into public.listings (id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language, currency_code, price_minor, country_code, status, approved_at)
values ('99999999-aaaa-4aaa-8aaa-999999999999', 'aaaaaaaa-1111-4111-8111-111111111111', 'product',
        '11111111-aaaa-4aaa-8aaa-111111111111', 'blue-widget', 'Blue widget', 'A widget that is blue.',
        'zz', 'XTS', 15000, 'ZZ', 'active', now());

-- Favorites and saved searches --------------------------------------------------------------------------
insert into public.favorites (user_id, listing_id)
values ('bbbbbbbb-2222-4222-8222-222222222222', '99999999-aaaa-4aaa-8aaa-999999999999');
select throws_ok(
  $$insert into public.favorites (user_id, listing_id)
    values ('bbbbbbbb-2222-4222-8222-222222222222', '99999999-aaaa-4aaa-8aaa-999999999999')$$,
  '23505',
  null,
  'a listing can only be favourited once per user'
);

insert into public.saved_searches (user_id, name, query)
values ('bbbbbbbb-2222-4222-8222-222222222222', 'Widgets', '{"q":"widget"}'::jsonb);
select throws_ok(
  $$insert into public.saved_searches (user_id, name, query)
    values ('bbbbbbbb-2222-4222-8222-222222222222', 'Widgets', '{"q":"other"}'::jsonb)$$,
  '23505',
  null,
  'saved search names are unique per user'
);
select throws_ok(
  $$insert into public.saved_searches (user_id, name, query)
    values ('bbbbbbbb-2222-4222-8222-222222222222', 'Bad', '[]'::jsonb)$$,
  '23514',
  null,
  'a saved search query must be an object'
);

-- Analytics events -----------------------------------------------------------------------------------------
select ok(
  (select count(*) >= 5 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'listing\_events\_%'),
  'the monthly partitions around today exist'
);

select is(
  app_private.record_listing_events(jsonb_build_array(
    jsonb_build_object('event_id', '11111111-2222-4222-8222-111111111111', 'listing_id', '99999999-aaaa-4aaa-8aaa-999999999999',
                       'seller_user_id', 'aaaaaaaa-1111-4111-8111-111111111111', 'event_type', 'view', 'source', 'search'),
    jsonb_build_object('event_id', '22222222-2222-4222-8222-222222222222', 'listing_id', '99999999-aaaa-4aaa-8aaa-999999999999',
                       'seller_user_id', 'aaaaaaaa-1111-4111-8111-111111111111', 'event_type', 'impression')
  )),
  2,
  'a batch of events is inserted'
);

select is(
  app_private.record_listing_events(jsonb_build_array(
    jsonb_build_object('event_id', '11111111-2222-4222-8222-111111111111', 'listing_id', '99999999-aaaa-4aaa-8aaa-999999999999',
                       'event_type', 'view')
  )),
  0,
  'an at-least-once redelivery is dropped by event id'
);

select throws_ok(
  $$insert into public.listing_events (event_id, listing_id, event_type)
    values (gen_random_uuid(), '99999999-aaaa-4aaa-8aaa-999999999999', 'purchase')$$,
  '23514',
  null,
  'an unknown event type is refused'
);

select throws_ok(
  $$update public.listing_events set event_type = 'click' where event_id = '22222222-2222-4222-8222-222222222222'$$,
  '23001',
  null,
  'the analytics stream is append-only'
);

select is(app_private.ensure_month_partitions('public', 'listing_events', 3), 0,
  'creating the partitions again does nothing');

select is(
  (select count(*) from public.listing_events where listing_id = '99999999-aaaa-4aaa-8aaa-999999999999'),
  2::bigint,
  'the two distinct events are stored once each'
);

select * from finish();
rollback;
