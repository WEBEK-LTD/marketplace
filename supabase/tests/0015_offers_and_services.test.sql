-- pgTAP — migration 0015: offers, custom-service requests and quotes.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(12);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zz', 'Test locale', 'Test locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTS', '963', 'T', 2, true, false, true, true);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled)
values ('XTT', '964', 'U', 2, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZZ', 'ZZZ', '999', 'Enabled', 'Enabled', '999', 'XTS', true);
-- listing_types (`product`, `service`) are seeded reference data in 0033.
-- `offers.default_expiry_hours` is seeded as 48 in 0033, which is the window this test measures.

insert into auth.users (id, email) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'seller@example.test'),
  ('bbbbbbbb-2222-4222-8222-222222222222', 'buyer@example.test'),
  ('cccccccc-3333-4333-8333-333333333333', 'other@example.test');
insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'test-seller', 'Test Seller', 'ZZ', 'verified', now(), 'active'),
  ('cccccccc-3333-4333-8333-333333333333', 'other-seller', 'Other Seller', 'ZZ', 'verified', now(), 'active');
insert into public.categories (id, slug) values ('11111111-aaaa-4aaa-8aaa-111111111111', 'electronics');

insert into public.listings (id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language, currency_code, price_minor, country_code)
values ('99999999-aaaa-4aaa-8aaa-999999999999', 'aaaaaaaa-1111-4111-8111-111111111111', 'product',
        '11111111-aaaa-4aaa-8aaa-111111111111', 'blue-widget', 'Blue widget', 'A widget that is blue.',
        'zz', 'XTS', 15000, 'ZZ');

-- Offers -------------------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.offers (listing_id, currency_code, buyer_user_id, seller_user_id, amount_minor)
    values ('99999999-aaaa-4aaa-8aaa-999999999999', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222',
            'aaaaaaaa-1111-4111-8111-111111111111', 12000)$$,
  '23001',
  null,
  'a draft listing cannot receive offers'
);

update public.listings set status = 'active', approved_at = now() where id = '99999999-aaaa-4aaa-8aaa-999999999999';

select throws_ok(
  $$insert into public.offers (listing_id, currency_code, buyer_user_id, seller_user_id, amount_minor)
    values ('99999999-aaaa-4aaa-8aaa-999999999999', 'XTT', 'bbbbbbbb-2222-4222-8222-222222222222',
            'aaaaaaaa-1111-4111-8111-111111111111', 12000)$$,
  '23503',
  null,
  'an offer cannot disagree with the listing currency'
);

select throws_ok(
  $$insert into public.offers (listing_id, currency_code, buyer_user_id, seller_user_id, amount_minor)
    values ('99999999-aaaa-4aaa-8aaa-999999999999', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222',
            'cccccccc-3333-4333-8333-333333333333', 12000)$$,
  '23001',
  null,
  'the offer must name the listing''s own seller'
);

insert into public.offers (id, listing_id, currency_code, buyer_user_id, seller_user_id, amount_minor)
values ('12121212-aaaa-4aaa-8aaa-121212121212', '99999999-aaaa-4aaa-8aaa-999999999999', 'XTS',
        'bbbbbbbb-2222-4222-8222-222222222222', 'aaaaaaaa-1111-4111-8111-111111111111', 12000);

select ok(
  (select expires_at between now() + interval '47 hours' and now() + interval '49 hours'
     from public.offers where id = '12121212-aaaa-4aaa-8aaa-121212121212'),
  'the configured default offer window is applied'
);

select throws_ok(
  $$insert into public.offers (listing_id, currency_code, buyer_user_id, seller_user_id, amount_minor)
    values ('99999999-aaaa-4aaa-8aaa-999999999999', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222',
            'aaaaaaaa-1111-4111-8111-111111111111', 13000)$$,
  '23505',
  null,
  'a buyer can only have one open offer per listing'
);

select throws_ok(
  $$update public.offers set status = 'accepted', accepted_at = now(), responded_at = now()
     where id = '12121212-aaaa-4aaa-8aaa-121212121212'$$,
  '23514',
  null,
  'an accepted offer must snapshot its terms and carry a payment deadline (D25)'
);

update public.offers
   set status = 'accepted', responded_at = now(), accepted_at = now(),
       accepted_terms = jsonb_build_object('amount_minor', 12000, 'currency_code', 'XTS', 'quantity', 1),
       payment_due_at = now() + interval '24 hours'
 where id = '12121212-aaaa-4aaa-8aaa-121212121212';
select is((select status from public.offers where id = '12121212-aaaa-4aaa-8aaa-121212121212'), 'accepted',
  'a fully snapshotted acceptance is allowed');

select ok(
  (select count(*) > 0 from public.currency_blockers('XTS') where dependency_key = 'offers.currency_code'),
  'an accepted offer blocks disabling its currency (D16)'
);

-- Custom services: request → quote ----------------------------------------------------------------------------
insert into public.service_requests (id, currency_code, buyer_user_id, seller_user_id, title, brief)
values ('13131313-aaaa-4aaa-8aaa-131313131313', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222',
        'aaaaaaaa-1111-4111-8111-111111111111', 'Build a widget', 'Please build me a custom widget of some kind.');

select throws_ok(
  $$insert into public.service_quotes (service_request_id, currency_code, seller_user_id, amount_minor, delivery_days, scope, expires_at)
    values ('13131313-aaaa-4aaa-8aaa-131313131313', 'XTT', 'aaaaaaaa-1111-4111-8111-111111111111', 20000, 7,
            'A complete custom widget, built to the brief.', now() + interval '7 days')$$,
  '23503',
  null,
  'a quote cannot disagree with the request currency'
);

select throws_ok(
  $$insert into public.service_quotes (service_request_id, currency_code, seller_user_id, amount_minor, delivery_days, scope, expires_at)
    values ('13131313-aaaa-4aaa-8aaa-131313131313', 'XTS', 'cccccccc-3333-4333-8333-333333333333', 20000, 7,
            'A complete custom widget, built to the brief.', now() + interval '7 days')$$,
  '23001',
  null,
  'only the seller the request was sent to may quote'
);

insert into public.service_quotes (id, service_request_id, currency_code, seller_user_id, amount_minor, delivery_days, scope, expires_at)
values ('14141414-aaaa-4aaa-8aaa-141414141414', '13131313-aaaa-4aaa-8aaa-131313131313', 'XTS',
        'aaaaaaaa-1111-4111-8111-111111111111', 20000, 7, 'A complete custom widget, built to the brief.', now() + interval '7 days');

select is((select status from public.service_requests where id = '13131313-aaaa-4aaa-8aaa-131313131313'), 'quoted',
  'quoting moves the request forward');

insert into public.service_quotes (id, service_request_id, currency_code, seller_user_id, amount_minor, delivery_days, scope, expires_at)
values ('15151515-aaaa-4aaa-8aaa-151515151515', '13131313-aaaa-4aaa-8aaa-131313131313', 'XTS',
        'aaaaaaaa-1111-4111-8111-111111111111', 25000, 14, 'A more elaborate custom widget, built to the brief.', now() + interval '7 days');

update public.service_quotes
   set status = 'accepted', accepted_at = now(),
       accepted_terms = jsonb_build_object('amount_minor', 20000, 'currency_code', 'XTS', 'delivery_days', 7),
       payment_due_at = now() + interval '24 hours'
 where id = '14141414-aaaa-4aaa-8aaa-141414141414';

select throws_ok(
  $$update public.service_quotes
       set status = 'accepted', accepted_at = now(),
           accepted_terms = jsonb_build_object('amount_minor', 25000),
           payment_due_at = now() + interval '24 hours'
     where id = '15151515-aaaa-4aaa-8aaa-151515151515'$$,
  '23505',
  null,
  'only one quote per request can ever be accepted, so only one checkout can open'
);

select * from finish();
rollback;
