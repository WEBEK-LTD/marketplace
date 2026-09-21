-- pgTAP — migration 0019: providers, capabilities, payments, attempts, webhook replay, refunds, disputes.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(17);

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
  ('bbbbbbbb-2222-4222-8222-222222222222', 'buyer@example.test');

insert into public.checkouts (id, currency_code, buyer_user_id, subtotal_minor, grand_total_minor,
                              commission_snapshot, cancellation_policy_snapshot, status)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222', 30000, 30000,
        '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb, 'awaiting_payment');

-- Providers start empty and capabilities fail closed ---------------------------------------------------
select is((select count(*) from public.payment_providers), 0::bigint,
  'no payment provider is seeded: none is assumed before B1-A closes');

insert into public.payment_providers (id, key, display_name, is_enabled)
values ('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'testgw', 'Test gateway', true);

select ok(
  not public.payment_provider_supports('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'XTS', 'charge'),
  'a provider with no recorded capability supports nothing'
);

insert into public.payment_provider_capabilities (payment_provider_id, currency_code, supports_charge, supports_refund, supports_webhooks, evidence_url)
values ('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'XTS', true, true, true, 'https://provider.example/docs');

select ok(public.payment_provider_supports('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'XTS', 'charge'),
  'a recorded capability is honoured');
select ok(
  not public.payment_provider_supports('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'XTS', 'partial_refund'),
  'and an unrecorded one is still refused'
);
select ok(
  not public.payment_provider_supports('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'XTT', 'charge'),
  'capabilities never leak across currencies'
);

select throws_ok(
  $$insert into public.payment_provider_capabilities (payment_provider_id, currency_code, supports_partial_refund, evidence_url)
    values ('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'XTT', true, 'https://provider.example/docs')$$,
  '23514',
  null,
  'partial refunds cannot be claimed without refunds'
);

-- Payments and attempts ------------------------------------------------------------------------------------
insert into public.payments (id, currency_code, checkout_id, buyer_user_id, amount_minor)
values ('ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'XTS', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001',
        'bbbbbbbb-2222-4222-8222-222222222222', 30000);

select throws_ok(
  $$insert into public.payments (currency_code, checkout_id, buyer_user_id, amount_minor)
    values ('XTS', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'bbbbbbbb-2222-4222-8222-222222222222', 30000)$$,
  '23505',
  null,
  'a checkout has exactly one payment'
);

insert into public.payment_attempts (id, currency_code, payment_id, payment_provider_id, attempt_number, amount_minor, idempotency_key)
values ('aaaa0002-aaaa-4aaa-8aaa-aaaa00000002', 'XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001',
        'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 1, 30000, 'attempt-key-1');

select throws_ok(
  $$insert into public.payment_attempts (currency_code, payment_id, payment_provider_id, attempt_number, amount_minor, idempotency_key)
    values ('XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 2, 30000, 'attempt-key-1')$$,
  '23505',
  null,
  'an idempotency key is used once per provider (C10)'
);

update public.payment_attempts set status = 'succeeded', succeeded_at = now()
 where id = 'aaaa0002-aaaa-4aaa-8aaa-aaaa00000002';
select throws_ok(
  $$update public.payment_attempts set status = 'failed', failed_at = now()
     where id = 'aaaa0002-aaaa-4aaa-8aaa-aaaa00000002'$$,
  '23001',
  null,
  'a succeeded attempt is final'
);

select throws_ok(
  $$update public.checkouts set fulfilled_attempt_id = 'dddd9999-aaaa-4aaa-8aaa-dddd99999999', status = 'fulfilled', fulfilled_at = now()
     where id = 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001'$$,
  '23503',
  null,
  'the fulfilling attempt must be a real payment attempt'
);

-- Webhook replay protection (C19) ------------------------------------------------------------------------------
select isnt(
  app_private.record_payment_event('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'evt_1', 'payment.succeeded', '\x00'::bytea,
                                   'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'aaaa0002-aaaa-4aaa-8aaa-aaaa00000002'),
  null,
  'the first delivery of a webhook is stored'
);
select is(
  app_private.record_payment_event('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'evt_1', 'payment.succeeded', '\x00'::bytea),
  null,
  'a redelivery of the same event stores nothing'
);

-- Refunds ------------------------------------------------------------------------------------------------------
update public.payments set status = 'paid', paid_at = now() where id = 'ffff0001-aaaa-4aaa-8aaa-ffff00000001';

select throws_ok(
  $$insert into public.refunds (currency_code, payment_id, amount_minor, reason, idempotency_key, payment_provider_id)
    values ('XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 40000, 'Too much', 'refund-key-0', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001')$$,
  '23001',
  null,
  'a refund can never exceed the payment'
);

select throws_ok(
  $$insert into public.refunds (currency_code, payment_id, amount_minor, reason, idempotency_key, payment_provider_id)
    values ('XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 10000, 'Partial', 'refund-key-1', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001')$$,
  '23001',
  null,
  'a partial refund needs the provider to support partial refunds'
);

insert into public.refunds (id, currency_code, payment_id, amount_minor, reason, idempotency_key, payment_provider_id, status, processed_at)
values ('cccc0002-aaaa-4aaa-8aaa-cccc00000002', 'XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 30000,
        'Full refund', 'refund-key-2', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'succeeded', now());

select is((select status from public.payments where id = 'ffff0001-aaaa-4aaa-8aaa-ffff00000001'), 'refunded',
  'a succeeded full refund moves the payment to refunded');
select is((select refunded_amount_minor from public.payments where id = 'ffff0001-aaaa-4aaa-8aaa-ffff00000001'), 30000::bigint,
  'and records the refunded total');

-- Disputes ----------------------------------------------------------------------------------------------------------
insert into public.payment_disputes (currency_code, payment_id, amount_minor, payment_provider_id, provider_reference)
values ('XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 30000, 'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'dp_1');
select ok(public.payment_has_open_dispute('ffff0001-aaaa-4aaa-8aaa-ffff00000001'),
  'an open dispute freezes the payment''s funds (D26)');

select * from finish();
rollback;
