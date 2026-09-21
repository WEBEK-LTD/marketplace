-- pgTAP — migration 0020: exception policies and cases, attempt settlement (D18, D19) and fee allocation (D20).
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(20);

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
  ('aaaaaaaa-1111-4111-8111-111111111111', 'seller@example.test'),
  ('bbbbbbbb-2222-4222-8222-222222222222', 'buyer@example.test');
insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status)
values ('aaaaaaaa-1111-4111-8111-111111111111', 'test-seller', 'Test Seller', 'ZZ', 'verified', now(), 'active');

insert into public.payment_providers (id, key, display_name, is_enabled)
values ('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'testgw', 'Test gateway', true);
insert into public.payment_provider_capabilities (payment_provider_id, currency_code, supports_charge, supports_refund, supports_webhooks, evidence_url)
values ('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'XTS', true, true, true, 'https://provider.example/docs');

-- Policies ------------------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.payment_exception_policies (case_type, resolution, requires_manual_approval)
    values ('duplicate_success', 'refund', false)$$,
  '23514',
  null,
  'a refunding policy can never be automatic (D19)'
);

insert into public.payment_exception_policies (case_type, resolution, requires_manual_approval, priority)
values ('duplicate_success', 'manual_review', true, 0),
       ('duplicate_success', 'reconcile', true, 10),
       ('late_success', 'manual_review', true, 0),
       ('amount_mismatch', 'manual_review', true, 0),
       ('currency_mismatch', 'manual_review', true, 0);

select is(
  (public.resolve_payment_exception_policy('duplicate_success')).resolution,
  'reconcile',
  'the highest-priority active policy wins'
);
-- 0033 seeds a fail-closed policy for every case type, so this test deactivates one to recreate the
-- unconfigured state the assertion is about.
update public.payment_exception_policies set is_active = false where case_type = 'unknown_reference';
select is(
  (public.resolve_payment_exception_policy('unknown_reference')).id,
  null,
  'an unconfigured case type resolves to nothing, so it waits for a human'
);

-- A checkout, its payment and two attempts -------------------------------------------------------------------
insert into public.checkouts (id, currency_code, buyer_user_id, subtotal_minor, grand_total_minor,
                              commission_snapshot, cancellation_policy_snapshot, status)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222', 30000, 30000,
        '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb, 'awaiting_payment');
insert into public.payments (id, currency_code, checkout_id, buyer_user_id, amount_minor)
values ('ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'XTS', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001',
        'bbbbbbbb-2222-4222-8222-222222222222', 30000);
insert into public.payment_attempts (id, currency_code, payment_id, payment_provider_id, attempt_number, amount_minor, idempotency_key) values
  ('aaaa0002-aaaa-4aaa-8aaa-aaaa00000002', 'XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 1, 30000, 'attempt-key-1'),
  ('aaaa0003-aaaa-4aaa-8aaa-aaaa00000003', 'XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 2, 30000, 'attempt-key-2'),
  ('aaaa0004-aaaa-4aaa-8aaa-aaaa00000004', 'XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 3, 30000, 'attempt-key-3');

-- Mismatches never become a success ------------------------------------------------------------------------------
select is(
  app_private.settle_payment_attempt('aaaa0002-aaaa-4aaa-8aaa-aaaa00000002', 'succeeded', 'pr_1', 30000, 'XTT'),
  'currency_mismatch',
  'a currency mismatch is refused'
);
select is((select status from public.payment_attempts where id = 'aaaa0002-aaaa-4aaa-8aaa-aaaa00000002'), 'pending',
  'and the attempt stays where it was');
select is(
  (select count(*) from public.payment_exception_cases where case_type = 'currency_mismatch'),
  1::bigint,
  'a currency-mismatch case is opened instead'
);

select is(
  app_private.settle_payment_attempt('aaaa0002-aaaa-4aaa-8aaa-aaaa00000002', 'succeeded', 'pr_1', 29000, 'XTS'),
  'amount_mismatch',
  'an amount mismatch is refused'
);
select is(
  (select expected_amount_minor from public.payment_exception_cases where case_type = 'amount_mismatch'),
  30000::bigint,
  'and the case records what was expected'
);

-- The happy path ----------------------------------------------------------------------------------------------------
select is(
  app_private.settle_payment_attempt('aaaa0002-aaaa-4aaa-8aaa-aaaa00000002', 'succeeded', 'pr_1', 30000, 'XTS'),
  'succeeded',
  'a matching success settles the attempt'
);
select is((select status from public.payments where id = 'ffff0001-aaaa-4aaa-8aaa-ffff00000001'), 'paid',
  'and marks the payment paid');
select is(
  app_private.settle_payment_attempt('aaaa0002-aaaa-4aaa-8aaa-aaaa00000002', 'succeeded', 'pr_1', 30000, 'XTS'),
  'already_succeeded',
  're-reporting the same success changes nothing (C10)'
);

-- A second success after fulfilment never fulfils again (D19) ------------------------------------------------------------
update public.checkouts
   set status = 'fulfilled', fulfilled_attempt_id = 'aaaa0002-aaaa-4aaa-8aaa-aaaa00000002', fulfilled_at = now()
 where id = 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001';

select is(
  app_private.settle_payment_attempt('aaaa0003-aaaa-4aaa-8aaa-aaaa00000003', 'succeeded', 'pr_2', 30000, 'XTS'),
  'duplicate_success',
  'a second payment success is recorded, never fulfilled again'
);
select is(
  (select resolution from public.payment_exception_cases where case_type = 'duplicate_success'),
  'reconcile',
  'the case carries the configured resolution'
);
select is(
  (select fulfilled_attempt_id from public.checkouts where id = 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001'),
  'aaaa0002-aaaa-4aaa-8aaa-aaaa00000002'::uuid,
  'and the fulfilling attempt is untouched'
);

-- A success after expiry never fulfils directly (D18) ----------------------------------------------------------------------
-- A fulfilled checkout can never be un-fulfilled, so the late success uses a checkout of its own.
insert into public.checkouts (id, currency_code, buyer_user_id, subtotal_minor, grand_total_minor,
                              commission_snapshot, cancellation_policy_snapshot, status)
values ('bbbb0002-aaaa-4aaa-8aaa-bbbb00000002', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222', 12000, 12000,
        '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb, 'awaiting_payment');
insert into public.payments (id, currency_code, checkout_id, buyer_user_id, amount_minor)
values ('ffff0002-aaaa-4aaa-8aaa-ffff00000002', 'XTS', 'bbbb0002-aaaa-4aaa-8aaa-bbbb00000002',
        'bbbbbbbb-2222-4222-8222-222222222222', 12000);
insert into public.payment_attempts (id, currency_code, payment_id, payment_provider_id, attempt_number, amount_minor, idempotency_key, status, failed_at)
values ('aaaa0005-aaaa-4aaa-8aaa-aaaa00000005', 'XTS', 'ffff0002-aaaa-4aaa-8aaa-ffff00000002',
        'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 1, 12000, 'attempt-key-5', 'expired', now());

select is(
  app_private.settle_payment_attempt('aaaa0005-aaaa-4aaa-8aaa-aaaa00000005', 'succeeded', 'pr_3', 12000, 'XTS'),
  'late_success',
  'a success that arrives after expiry becomes a late_success case'
);
select is(
  (select fulfilled_attempt_id from public.checkouts where id = 'bbbb0002-aaaa-4aaa-8aaa-bbbb00000002'),
  null,
  'and it never fulfils the checkout directly (D18)'
);

-- Every opened case leaves a trail, and that trail cannot be rewritten ----------------------------------------------------
select ok(
  (select count(*) >= 4 from public.payment_exception_actions where action_type = 'opened'),
  'every opened case records its opening action'
);
select throws_ok(
  $$update public.payment_exception_actions set outcome = 'edited' where action_type = 'opened'$$,
  '23001',
  null,
  'the exception trail is append-only'
);

-- Fee allocation (D20) ------------------------------------------------------------------------------------------------------
insert into public.payment_fee_allocations (currency_code, payment_id, fee_type, amount_minor)
values ('XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'provider', 750);
select is(
  (select allocated_to from public.payment_fee_allocations where fee_type = 'provider'),
  'platform',
  'by default the platform absorbs provider fees (D20)'
);

select throws_ok(
  $$insert into public.payment_fee_allocations (currency_code, payment_id, fee_type, allocated_to, amount_minor)
    values ('XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'provider', 'seller', 250)$$,
  '23514',
  null,
  'a fee allocated to a seller must name that seller'
);

select * from finish();
rollback;
