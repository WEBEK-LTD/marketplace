-- pgTAP — migration 0017: carts, checkout pricing records and inventory reservations.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

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
-- `carts.guest_expiry_days` is seeded as 30 in 0033, which is the window this test measures.

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
insert into public.listing_product_details (listing_id, condition, quantity)
values ('99999999-aaaa-4aaa-8aaa-999999999999', 'new', 5);

insert into public.listings (id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language, currency_code, price_minor, country_code)
values ('88888888-aaaa-4aaa-8aaa-888888888888', 'aaaaaaaa-1111-4111-8111-111111111111', 'product',
        '11111111-aaaa-4aaa-8aaa-111111111111', 'draft-widget', 'Draft widget', 'Not published yet at all.',
        'zz', 'XTS', 9000, 'ZZ');

-- Carts ------------------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.carts (currency_code, user_id, guest_token_hash)
    values ('XTS', 'bbbbbbbb-2222-4222-8222-222222222222', '\x01'::bytea)$$,
  '23514',
  null,
  'a cart belongs either to an account or to a guest token, never both'
);

insert into public.carts (id, currency_code, user_id)
values ('aaaa0001-aaaa-4aaa-8aaa-aaaa00000001', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222');

select ok(
  (select expires_at between now() + interval '29 days' and now() + interval '31 days'
     from public.carts where id = 'aaaa0001-aaaa-4aaa-8aaa-aaaa00000001'),
  'the configured cart expiry window is applied (D22)'
);

select throws_ok(
  $$insert into public.carts (currency_code, user_id)
    values ('XTS', 'bbbbbbbb-2222-4222-8222-222222222222')$$,
  '23505',
  null,
  'a user has at most one active cart'
);

select throws_ok(
  $$insert into public.cart_items (cart_id, currency_code, listing_id, seller_user_id, quantity, unit_price_minor)
    values ('aaaa0001-aaaa-4aaa-8aaa-aaaa00000001', 'XTS', '88888888-aaaa-4aaa-8aaa-888888888888',
            'aaaaaaaa-1111-4111-8111-111111111111', 1, 9000)$$,
  '23001',
  null,
  'a listing that is not live cannot be added to a cart'
);

select throws_ok(
  $$insert into public.cart_items (cart_id, currency_code, listing_id, seller_user_id, quantity, unit_price_minor)
    values ('aaaa0001-aaaa-4aaa-8aaa-aaaa00000001', 'XTT', '99999999-aaaa-4aaa-8aaa-999999999999',
            'aaaaaaaa-1111-4111-8111-111111111111', 1, 15000)$$,
  '23503',
  null,
  'a cart item cannot disagree with the cart currency'
);

insert into public.cart_items (cart_id, currency_code, listing_id, seller_user_id, quantity, unit_price_minor)
values ('aaaa0001-aaaa-4aaa-8aaa-aaaa00000001', 'XTS', '99999999-aaaa-4aaa-8aaa-999999999999',
        'aaaaaaaa-1111-4111-8111-111111111111', 2, 15000);
select is((select count(*) from public.cart_items), 1::bigint, 'a live listing can be added');

-- Checkouts --------------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.checkouts (reference, currency_code, buyer_user_id, subtotal_minor, grand_total_minor)
    values ('CO-26-000001', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222', 30000, 29000)$$,
  '23514',
  null,
  'the checkout total must add up from its parts'
);

select throws_ok(
  $$insert into public.checkouts (reference, currency_code, buyer_user_id)
    values ('CHECKOUT-1', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222')$$,
  '23514',
  null,
  'the checkout reference follows the D12 format'
);

insert into public.checkouts (id, reference, currency_code, buyer_user_id, cart_id, subtotal_minor, shipping_total_minor, tax_total_minor, grand_total_minor,
                              commission_snapshot, cancellation_policy_snapshot)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'CO-26-000001', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222',
        'aaaa0001-aaaa-4aaa-8aaa-aaaa00000001', 30000, 5000, 4200, 39200,
        '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb);

insert into public.checkout_items (checkout_id, currency_code, listing_id, seller_user_id, listing_type_code,
                                   listing_title_snapshot, listing_slug_snapshot, quantity, unit_price_minor,
                                   line_subtotal_minor, tax_minor, line_total_minor)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', '99999999-aaaa-4aaa-8aaa-999999999999',
        'aaaaaaaa-1111-4111-8111-111111111111', 'product', 'Blue widget', 'blue-widget', 2, 15000, 30000, 4200, 34200);

select throws_ok(
  $$insert into public.checkout_items (checkout_id, currency_code, listing_id, seller_user_id, listing_type_code,
                                       listing_title_snapshot, listing_slug_snapshot, quantity, unit_price_minor,
                                       line_subtotal_minor, line_total_minor)
    values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', '88888888-aaaa-4aaa-8aaa-888888888888',
            'aaaaaaaa-1111-4111-8111-111111111111', 'product', 'Draft widget', 'draft-widget', 1, 9000, 9000, 8000)$$,
  '23514',
  null,
  'a checkout line must add up from its own parts'
);

select throws_ok(
  $$insert into public.checkout_charges (checkout_id, currency_code, charge_type, label, amount_minor, funding_source)
    values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'discount', 'Welcome', 500, 'platform')$$,
  '23514',
  null,
  'a discount is recorded as a negative amount'
);

insert into public.checkout_charges (checkout_id, currency_code, charge_type, seller_user_id, label, amount_minor)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'shipping', 'aaaaaaaa-1111-4111-8111-111111111111', 'Standard', 5000);

select throws_ok(
  $$insert into public.checkout_charges (checkout_id, currency_code, charge_type, label, amount_minor)
    values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'shipping', 'Standard', 5000)$$,
  '23514',
  null,
  'shipping is always attributed to a seller'
);

-- Reservations ---------------------------------------------------------------------------------------------
select is(public.available_quantity('99999999-aaaa-4aaa-8aaa-999999999999'), 5,
  'all stock is available before anything is reserved');

select is(app_private.reserve_checkout_stock('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001'), 1,
  'the checkout reserves its stocked line');
select is(public.available_quantity('99999999-aaaa-4aaa-8aaa-999999999999'), 3,
  'the reservation removes that quantity from availability');

select * from finish();
rollback;
