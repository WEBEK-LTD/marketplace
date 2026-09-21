-- pgTAP — migration 0018: references (D12), fulfilment, order lifecycle and service auto-completion (D23).
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(19);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zz', 'Test locale', 'Test locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTS', '963', 'T', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZZ', 'ZZZ', '999', 'Enabled', 'Enabled', '999', 'XTS', true);
-- listing_types (`product`, `service`) are seeded reference data in 0033.
-- `orders.service_buyer_response_hours` is seeded as 72 in 0033, which is the window this test measures.

insert into auth.users (id, email) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'seller-a@example.test'),
  ('cccccccc-3333-4333-8333-333333333333', 'seller-b@example.test'),
  ('bbbbbbbb-2222-4222-8222-222222222222', 'buyer@example.test');
insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'seller-a', 'Seller A', 'ZZ', 'verified', now(), 'active'),
  ('cccccccc-3333-4333-8333-333333333333', 'seller-b', 'Seller B', 'ZZ', 'verified', now(), 'active');
insert into public.categories (id, slug) values ('11111111-aaaa-4aaa-8aaa-111111111111', 'electronics');

insert into public.listings (id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language, currency_code, price_minor, country_code, status, approved_at) values
  ('99999999-aaaa-4aaa-8aaa-999999999999', 'aaaaaaaa-1111-4111-8111-111111111111', 'product',
   '11111111-aaaa-4aaa-8aaa-111111111111', 'blue-widget', 'Blue widget', 'A widget that is blue.', 'zz', 'XTS', 15000, 'ZZ', 'active', now()),
  ('77777777-aaaa-4aaa-8aaa-777777777777', 'cccccccc-3333-4333-8333-333333333333', 'service',
   '11111111-aaaa-4aaa-8aaa-111111111111', 'widget-setup', 'Widget setup', 'We set the widget up for you.', 'zz', 'XTS', 8000, 'ZZ', 'active', now());
insert into public.listing_product_details (listing_id, condition, quantity)
values ('99999999-aaaa-4aaa-8aaa-999999999999', 'new', 5);

-- References (D12) ---------------------------------------------------------------------------------------
insert into public.checkouts (id, currency_code, buyer_user_id, subtotal_minor, shipping_total_minor, tax_total_minor, grand_total_minor,
                              commission_snapshot, cancellation_policy_snapshot, status)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222', 38000, 5000, 0, 43000,
        '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb, 'paid');

select matches(
  (select reference from public.checkouts where id = 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001'),
  '^CO-[0-9]{2}-000001$',
  'the first checkout reference of the year is CO-YY-000001 (D12)'
);

insert into public.checkout_items (checkout_id, currency_code, listing_id, seller_user_id, listing_type_code,
                                   listing_title_snapshot, listing_slug_snapshot, quantity, unit_price_minor,
                                   line_subtotal_minor, line_total_minor) values
  ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', '99999999-aaaa-4aaa-8aaa-999999999999',
   'aaaaaaaa-1111-4111-8111-111111111111', 'product', 'Blue widget', 'blue-widget', 2, 15000, 30000, 30000),
  ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', '77777777-aaaa-4aaa-8aaa-777777777777',
   'cccccccc-3333-4333-8333-333333333333', 'service', 'Widget setup', 'widget-setup', 1, 8000, 8000, 8000);

insert into public.checkout_charges (checkout_id, currency_code, charge_type, seller_user_id, label, amount_minor)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'shipping', 'aaaaaaaa-1111-4111-8111-111111111111', 'Standard', 5000);

select is(app_private.reserve_checkout_stock('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001'), 1,
  'only the stocked line is reserved');

-- The fulfilling attempt is a real payment attempt (the foreign key is added in 0019).
insert into public.payment_providers (id, key, display_name, is_enabled)
values ('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'testgw', 'Test gateway', true);
insert into public.payments (id, currency_code, checkout_id, buyer_user_id, amount_minor)
values ('ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'XTS', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001',
        'bbbbbbbb-2222-4222-8222-222222222222', 43000);
insert into public.payment_attempts (id, currency_code, payment_id, payment_provider_id, attempt_number, amount_minor, idempotency_key) values
  ('dddd0001-aaaa-4aaa-8aaa-dddd00000001', 'XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 1, 43000, 'attempt-key-1'),
  ('dddd0002-aaaa-4aaa-8aaa-dddd00000002', 'XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 2, 43000, 'attempt-key-2');

-- Fulfilment ------------------------------------------------------------------------------------------------
select is(
  app_private.fulfil_checkout('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'dddd0001-aaaa-4aaa-8aaa-dddd00000001'),
  2,
  'one order is created per seller'
);

select matches(
  (select order_number from public.orders where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  '^MP-[0-9]{2}-001001$',
  'seller order numbers start at MP-YY-001001 (D12)'
);

select is(
  (select grand_total_minor from public.orders where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  35000::bigint,
  'the product order carries its own subtotal and its own shipping'
);
select is(
  (select grand_total_minor from public.orders where seller_user_id = 'cccccccc-3333-4333-8333-333333333333'),
  8000::bigint,
  'and the service order carries no shipping'
);
select is(
  (select order_type from public.orders where seller_user_id = 'cccccccc-3333-4333-8333-333333333333'),
  'service',
  'an order of only service lines is a service order'
);

select is((select count(*) from public.order_items), 2::bigint, 'every checkout line became an order line');
select is((select quantity from public.listing_product_details where listing_id = '99999999-aaaa-4aaa-8aaa-999999999999'), 3,
  'stock is decremented by the fulfilled quantity');
select is(
  (select count(*) from public.inventory_reservations where checkout_id = 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001' and consumed_at is not null),
  1::bigint,
  'the reservation is consumed, not left hanging'
);
select is((select status from public.checkouts where id = 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001'), 'fulfilled',
  'the checkout is marked fulfilled');

-- Only one attempt can ever fulfil -------------------------------------------------------------------------------
select is(
  app_private.fulfil_checkout('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'dddd0001-aaaa-4aaa-8aaa-dddd00000001'),
  0,
  'the same attempt retrying is idempotent and creates nothing'
);
select throws_ok(
  $$select app_private.fulfil_checkout('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'dddd0002-aaaa-4aaa-8aaa-dddd00000002')$$,
  '23505',
  null,
  'a second payment success never creates a second set of orders'
);
select throws_ok(
  $$update public.checkouts set fulfilled_attempt_id = 'dddd0003-aaaa-4aaa-8aaa-dddd00000003'
     where id = 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001'$$,
  '23001',
  null,
  'the fulfilling attempt cannot be changed afterwards'
);

-- Lifecycle --------------------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.order_status_history),
  2::bigint,
  'every order records its opening status'
);
select ok(
  (select count(*) > 0 from public.outbox_events where event_type = 'checkout.fulfilled'),
  'fulfilment publishes its outbox event'
);

select throws_ok(
  $$update public.orders set status = 'shipped'
     where seller_user_id = 'cccccccc-3333-4333-8333-333333333333'$$,
  '23514',
  null,
  'a service order cannot take a product status'
);

-- D23 ---------------------------------------------------------------------------------------------------------------
update public.orders set status = 'delivered', delivered_at = now()
 where seller_user_id = 'cccccccc-3333-4333-8333-333333333333';
select ok(
  (select auto_complete_at between now() + interval '71 hours' and now() + interval '73 hours'
     from public.orders where seller_user_id = 'cccccccc-3333-4333-8333-333333333333'),
  'a delivered service order gets its configured auto-completion deadline (D23)'
);

update public.orders set auto_complete_at = now() - interval '1 hour'
 where seller_user_id = 'cccccccc-3333-4333-8333-333333333333';
select is(app_private.complete_due_service_orders(), 1,
  'the due service order completes by itself');

select * from finish();
rollback;
