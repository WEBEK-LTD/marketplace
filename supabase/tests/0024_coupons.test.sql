-- pgTAP — migration 0024: coupon definitions, per-currency amounts, scope and funding rules (D11),
-- rounding (D14), usage limits, applying to a checkout and releasing a redemption.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(31);

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

insert into auth.users (id, email) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'seller-a@example.test'),
  ('cccccccc-3333-4333-8333-333333333333', 'seller-b@example.test'),
  ('bbbbbbbb-2222-4222-8222-222222222222', 'buyer@example.test');
insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'seller-a', 'Seller A', 'ZZ', 'verified', now(), 'active'),
  ('cccccccc-3333-4333-8333-333333333333', 'seller-b', 'Seller B', 'ZZ', 'verified', now(), 'active');

insert into public.categories (id, slug) values ('11111111-aaaa-4aaa-8aaa-111111111111', 'electronics');
insert into public.categories (id, parent_id, slug)
values ('22222222-aaaa-4aaa-8aaa-222222222222', '11111111-aaaa-4aaa-8aaa-111111111111', 'phones');

insert into public.listings (id, seller_user_id, listing_type_code, category_id, slug, title, description,
                             content_language, currency_code, price_minor, country_code, status, approved_at) values
  ('99999999-aaaa-4aaa-8aaa-999999999999', 'aaaaaaaa-1111-4111-8111-111111111111', 'product',
   '22222222-aaaa-4aaa-8aaa-222222222222', 'blue-phone', 'Blue phone', 'A phone that is blue.',
   'zz', 'XTS', 20000, 'ZZ', 'active', now()),
  ('88888888-aaaa-4aaa-8aaa-888888888888', 'cccccccc-3333-4333-8333-333333333333', 'product',
   '11111111-aaaa-4aaa-8aaa-111111111111', 'green-lamp', 'Green lamp', 'A lamp that is green.',
   'zz', 'XTS', 10000, 'ZZ', 'active', now());

-- A three-level tree answers about its own branch ------------------------------------------------------
select ok(public.category_is_within('22222222-aaaa-4aaa-8aaa-222222222222', '11111111-aaaa-4aaa-8aaa-111111111111'),
  'a child category sits within its parent (D8)');
select ok(
  not public.category_is_within('11111111-aaaa-4aaa-8aaa-111111111111', '22222222-aaaa-4aaa-8aaa-222222222222'),
  'and containment does not run the other way'
);

-- Definition rules -------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.coupons (code, name, discount_type, percentage_basis_points, funding_source)
    values ('AB', 'Too short', 'percentage', 1000, 'platform')$$,
  '23514',
  null,
  'a coupon code has a shape'
);
select throws_ok(
  $$insert into public.coupons (code, name, discount_type, funding_source)
    values ('NOPCT', 'No rate', 'percentage', 'platform')$$,
  '23514',
  null,
  'a percentage coupon must carry its rate'
);
select throws_ok(
  $$insert into public.coupons (code, name, discount_type, amount_check, funding_source)
    values ('BAD', 'Bad', 'fixed', 1, 'platform')$$,
  '42703',
  null,
  'there is no per-coupon amount column: amounts are per currency'
);
select throws_ok(
  $$insert into public.coupons (code, name, discount_type, funding_source, funded_by_seller_user_id)
    values ('PLATSELL', 'Mixed', 'fixed', 'platform', 'aaaaaaaa-1111-4111-8111-111111111111')$$,
  '23514',
  null,
  'a platform-funded coupon never names a funding seller (D11)'
);
select throws_ok(
  $$insert into public.coupons (code, name, discount_type, funding_source)
    values ('SELLERNOONE', 'Unfunded', 'fixed', 'seller')$$,
  '23514',
  null,
  'and a seller-funded one always does'
);
select throws_ok(
  $$insert into public.coupons (code, name, discount_type, percentage_basis_points, funding_source, scope)
    values ('SCOPELESS', 'Scoped at nothing', 'percentage', 1000, 'platform', 'category')$$,
  '23514',
  null,
  'a scoped coupon must name its target'
);

insert into public.coupons (id, code, name, discount_type, percentage_basis_points, funding_source, scope, category_id)
values ('c0000001-aaaa-4aaa-8aaa-c00000000001', 'phones10', 'Ten percent off phones', 'percentage', 1000,
        'platform', 'category', '11111111-aaaa-4aaa-8aaa-111111111111');

select throws_ok(
  $$insert into public.coupons (code, name, discount_type, percentage_basis_points, funding_source)
    values ('PHONES10', 'Same code again', 'percentage', 500, 'platform')$$,
  '23505',
  null,
  'codes are unique regardless of case'
);

select throws_ok(
  $$insert into public.coupon_amounts (coupon_id, currency_code, amount_minor)
    values ('c0000001-aaaa-4aaa-8aaa-c00000000001', 'XTS', 5000)$$,
  '23514',
  null,
  'a percentage coupon carries no per-currency amount'
);

insert into public.coupon_amounts (coupon_id, currency_code, min_order_amount_minor, max_discount_amount_minor)
values ('c0000001-aaaa-4aaa-8aaa-c00000000001', 'XTS', 10000, 4000);

-- A checkout with one line from each seller --------------------------------------------------------------
insert into public.checkouts (id, currency_code, buyer_user_id, subtotal_minor, grand_total_minor,
                              commission_snapshot, cancellation_policy_snapshot, status)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222', 50000, 50000,
        '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb, 'open');
insert into public.checkout_items (checkout_id, currency_code, listing_id, seller_user_id, listing_type_code,
                                   listing_title_snapshot, listing_slug_snapshot, quantity, unit_price_minor,
                                   line_subtotal_minor, line_total_minor) values
  ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', '99999999-aaaa-4aaa-8aaa-999999999999',
   'aaaaaaaa-1111-4111-8111-111111111111', 'product', 'Blue phone', 'blue-phone', 2, 20000, 40000, 40000),
  ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', '88888888-aaaa-4aaa-8aaa-888888888888',
   'cccccccc-3333-4333-8333-333333333333', 'product', 'Green lamp', 'green-lamp', 1, 10000, 10000, 10000);

-- Scope reaches the whole branch, and the cap holds ----------------------------------------------------------
select is(
  public.coupon_eligible_subtotal('c0000001-aaaa-4aaa-8aaa-c00000000001', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001'),
  50000::bigint,
  'a coupon scoped to a parent category reaches both lines beneath it'
);
select is(
  (select discount_minor from public.coupon_check('phones10', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001')),
  4000::bigint,
  'ten percent of 50000 is capped at the configured maximum'
);
select is(
  (select is_applicable from public.coupon_check('PhOnEs10', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001')),
  true,
  'and the code is matched without regard to case'
);
select is(
  (select reason from public.coupon_check('nosuchcode', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001')),
  'unknown_code',
  'an unknown code says so rather than failing silently'
);

-- Applying -------------------------------------------------------------------------------------------------
select is(
  app_private.apply_coupon('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'phones10'),
  4000::bigint,
  'applying the coupon discounts the checkout'
);
select is(
  (select format('%s/%s', discount_total_minor, grand_total_minor) from public.checkouts
    where id = 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001'),
  '4000/46000',
  'and the checkout totals follow');
select is(
  (select format('%s/%s/%s', amount_minor, funding_source, source_type) from public.checkout_charges
    where charge_type = 'discount'),
  '-4000/platform/coupon',
  'the discount is a negative charge that records who funded it and where it came from (D11)');
select is(
  (select redemption_count from public.coupons where id = 'c0000001-aaaa-4aaa-8aaa-c00000000001'),
  1,
  'the redemption is counted'
);
select is(
  app_private.apply_coupon('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'phones10'),
  4000::bigint,
  'applying it again returns the discount already given, not a second one (C10)'
);
select is(
  (select count(*) from public.checkout_charges where charge_type = 'discount'),
  1::bigint,
  'and no second discount charge appears'
);

select throws_ok(
  $$update public.coupon_usage set discount_minor = 1$$,
  '23001',
  null,
  'redemption records are append-only'
);

-- Releasing ------------------------------------------------------------------------------------------------
select is(
  app_private.release_coupon_usage('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'checkout expired'),
  1,
  'an abandoned checkout gives its redemption back'
);
select is(
  (select redemption_count from public.coupons where id = 'c0000001-aaaa-4aaa-8aaa-c00000000001'),
  0,
  'and the counter follows the reversing row rather than an edit'
);
select is(
  (select count(*) from public.coupon_usage),
  2::bigint,
  'both the redemption and its release are on the record'
);

-- Limits ---------------------------------------------------------------------------------------------------
insert into public.coupons (id, code, name, discount_type, percentage_basis_points, funding_source,
                            max_redemptions, max_redemptions_per_user)
values ('c0000002-aaaa-4aaa-8aaa-c00000000002', 'once5', 'Five percent, once', 'percentage', 500,
        'platform', 1, 1);
update public.coupons set redemption_count = 1 where id = 'c0000002-aaaa-4aaa-8aaa-c00000000002';

select is(
  (select reason from public.coupon_check('once5', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001')),
  'redemption_limit_reached',
  'a spent coupon refuses with its reason'
);

insert into public.coupons (id, code, name, discount_type, funding_source, starts_at, ends_at)
values ('c0000003-aaaa-4aaa-8aaa-c00000000003', 'expired1', 'Yesterday only', 'fixed', 'platform',
        now() - interval '2 days', now() - interval '1 day');
insert into public.coupon_amounts (coupon_id, currency_code, amount_minor)
values ('c0000003-aaaa-4aaa-8aaa-c00000000003', 'XTS', 1000);
select is(
  (select reason from public.coupon_check('expired1', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001')),
  'outside_window',
  'a coupon outside its window refuses with its reason'
);

-- A fixed coupon is never converted into a currency it was not configured for (D16) ---------------------------
insert into public.coupons (id, code, name, discount_type, funding_source)
values ('c0000004-aaaa-4aaa-8aaa-c00000000004', 'fixed500', 'Five hundred off', 'fixed', 'platform');
insert into public.coupon_amounts (coupon_id, currency_code, amount_minor)
values ('c0000004-aaaa-4aaa-8aaa-c00000000004', 'XTT', 500);

select is(
  (select reason from public.coupon_check('fixed500', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001')),
  'currency_not_configured',
  'a fixed coupon with no amount in the checkout currency simply does not apply'
);

-- A seller-funded coupon never reaches another seller's lines (D11) --------------------------------------------
insert into public.coupons (id, code, name, discount_type, percentage_basis_points, funding_source,
                            funded_by_seller_user_id)
values ('c0000005-aaaa-4aaa-8aaa-c00000000005', 'sellera20', 'Seller A, twenty percent', 'percentage', 2000,
        'seller', 'aaaaaaaa-1111-4111-8111-111111111111');

select is(
  public.coupon_eligible_subtotal('c0000005-aaaa-4aaa-8aaa-c00000000005', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001'),
  40000::bigint,
  'a seller-funded coupon only reaches its funder''s lines'
);
select is(
  (select discount_minor from public.coupon_check('sellera20', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001')),
  8000::bigint,
  'and is worth twenty percent of only those lines'
);

-- Half-up rounding (D14) -------------------------------------------------------------------------------------------
insert into public.coupons (id, code, name, discount_type, percentage_basis_points, funding_source, scope, listing_id)
values ('c0000006-aaaa-4aaa-8aaa-c00000000006', 'odd333', 'A third, near enough', 'percentage', 3333,
        'platform', 'listing', '88888888-aaaa-4aaa-8aaa-888888888888');

select is(
  (select discount_minor from public.coupon_check('odd333', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001')),
  3333::bigint,
  'a fractional discount rounds half-up in minor units (D14)'
);

-- Applying to a checkout that is no longer open ------------------------------------------------------------------
update public.checkouts set status = 'awaiting_payment' where id = 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001';
select throws_ok(
  $$select app_private.apply_coupon('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'sellera20')$$,
  '23001',
  null,
  'a checkout past pricing can no longer be repriced'
);

select * from finish();
rollback;
