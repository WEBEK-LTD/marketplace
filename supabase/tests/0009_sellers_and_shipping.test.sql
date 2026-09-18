-- pgTAP — migration 0009: seller profiles, manual verification and the shipping foundations.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(19);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTS', '963', 'T', 2, true, true, true, true);

insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZZ', 'ZZZ', '999', 'Enabled country', 'Enabled country', '999', 'XTS', true),
       ('YY', 'YYY', '998', 'Disabled country', 'Disabled country', '998', null, false);

insert into auth.users (id, email) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'seller@example.test'),
  ('bbbbbbbb-2222-4222-8222-222222222222', 'buyer@example.test');

-- D17: sellers must sit in a marketplace-enabled country ------------------------------------------------
select throws_ok(
  $$insert into public.seller_profiles (user_id, slug, display_name, country_code)
    values ('aaaaaaaa-1111-4111-8111-111111111111', 'blocked-seller', 'Blocked', 'YY')$$,
  '23001',
  null,
  'a seller cannot be registered in a country that is not enabled (D17)'
);

insert into public.seller_profiles (user_id, slug, display_name, country_code)
values ('aaaaaaaa-1111-4111-8111-111111111111', 'test-seller', 'Test Seller', 'ZZ');

select is((select status from public.seller_profiles where slug = 'test-seller'), 'pending', 'a new storefront starts pending');
select is((select verification_status from public.seller_profiles where slug = 'test-seller'), 'unverified', 'and unverified');

select throws_ok(
  $$update public.seller_profiles set status = 'active' where slug = 'test-seller'$$,
  '23514',
  null,
  'a seller cannot go active before verification'
);

-- Verification ------------------------------------------------------------------------------------------
insert into public.seller_verifications (seller_user_id, status, submitted_at)
values ('aaaaaaaa-1111-4111-8111-111111111111', 'submitted', now());

select is(
  (select verification_status from public.seller_profiles where slug = 'test-seller'),
  'pending',
  'submitting a verification moves the storefront to pending'
);

select throws_ok(
  $$insert into public.seller_verifications (seller_user_id, status, submitted_at)
    values ('aaaaaaaa-1111-4111-8111-111111111111', 'submitted', now())$$,
  '23505',
  null,
  'a seller can only have one open verification at a time'
);

select throws_ok(
  $$update public.seller_verifications
       set status = 'approved', reviewed_at = now(), reviewed_by = 'bbbbbbbb-2222-4222-8222-222222222222'
     where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'$$,
  '23514',
  null,
  'approval requires both contacts verified (sellers verify email and phone)'
);

select throws_ok(
  $$update public.seller_verifications
       set status = 'rejected', reviewed_at = now(), reviewed_by = 'bbbbbbbb-2222-4222-8222-222222222222'
     where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'$$,
  '23514',
  null,
  'a rejection must carry a reason'
);

update public.seller_verifications
   set email_verified_at = now(), phone_verified_at = now(), status = 'approved',
       reviewed_at = now(), reviewed_by = 'bbbbbbbb-2222-4222-8222-222222222222'
 where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111';

select is(
  (select verification_status from public.seller_profiles where slug = 'test-seller'),
  'verified',
  'approving the review verifies the storefront'
);
select isnt((select verified_at from public.seller_profiles where slug = 'test-seller'), null, 'and records when');

update public.seller_profiles set status = 'active' where slug = 'test-seller';
select ok(public.is_seller_publicly_visible('aaaaaaaa-1111-4111-8111-111111111111'), 'an active seller is publicly visible');

-- is_verified_seller now consults seller_verifications (it was a deny-all stub in 0003) -------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-1111-4111-8111-111111111111","role":"authenticated","aal":"aal1"}', true);
create temp table seller_probe as select public.is_verified_seller() as verified;
reset role;
select ok((select verified from seller_probe), 'is_verified_seller is true for an active, verified seller');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-2222-4222-8222-222222222222","role":"authenticated","aal":"aal1"}', true);
create temp table buyer_probe as
select public.is_verified_seller() as verified,
       (select count(*) from public.seller_profiles) as visible_sellers;
reset role;
select ok(not (select verified from buyer_probe), 'and false for someone who is not a seller');
select is((select visible_sellers from buyer_probe), 1::bigint, 'a buyer sees the active storefront');

update public.seller_profiles set status = 'suspended', suspended_at = now() where slug = 'test-seller';
select ok(not public.is_seller_publicly_visible('aaaaaaaa-1111-4111-8111-111111111111'), 'a suspended seller is not publicly visible');
update public.seller_profiles set status = 'active', suspended_at = null where slug = 'test-seller';

-- Shipping: composite currency keys -----------------------------------------------------------------------
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled)
values ('XTT', '964', 'U', 2, true);

insert into public.shipping_profiles (id, seller_user_id, name, currency_code)
values ('cccccccc-3333-4333-8333-333333333333', 'aaaaaaaa-1111-4111-8111-111111111111', 'Default', 'XTS');

select throws_ok(
  $$insert into public.shipping_zones (id, shipping_profile_id, currency_code, name, country_code)
    values ('dddddddd-4444-4444-8444-444444444444', 'cccccccc-3333-4333-8333-333333333333', 'XTT', 'Cairo', 'ZZ')$$,
  '23503',
  null,
  'a shipping zone cannot disagree with its profile currency'
);

insert into public.shipping_zones (id, shipping_profile_id, currency_code, name, country_code)
values ('dddddddd-4444-4444-8444-444444444444', 'cccccccc-3333-4333-8333-333333333333', 'XTS', 'Cairo', 'ZZ');

select throws_ok(
  $$insert into public.shipping_rates (shipping_zone_id, currency_code, method, name, base_amount_minor)
    values ('dddddddd-4444-4444-8444-444444444444', 'XTT', 'standard', 'Standard', 5000)$$,
  '23503',
  null,
  'a shipping rate cannot disagree with its zone currency'
);

select throws_ok(
  $$insert into public.shipping_rates (shipping_zone_id, currency_code, method, name, base_amount_minor)
    values ('dddddddd-4444-4444-8444-444444444444', 'XTS', 'standard', 'Standard', -1)$$,
  '23514',
  null,
  'shipping amounts are never negative'
);

insert into public.shipping_rates (shipping_zone_id, currency_code, method, name, base_amount_minor)
values ('dddddddd-4444-4444-8444-444444444444', 'XTS', 'standard', 'Standard', 5000);

select ok(
  (select count(*) > 0 from public.currency_blockers('XTS') where dependency_key = 'shipping_rates.currency_code'),
  'shipping rates register as a blocker against disabling their currency (D16)'
);

select * from finish();
rollback;
