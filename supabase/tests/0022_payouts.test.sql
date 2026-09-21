-- pgTAP — migration 0022: payout providers and eligibility, destinations, payout creation and
-- settlement, webhook replay protection and reversals.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(33);

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
  ('cccccccc-3333-4333-8333-333333333333', 'other-seller@example.test'),
  ('dddddddd-4444-4444-8444-444444444444', 'admin@example.test');
insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'test-seller', 'Test Seller', 'ZZ', 'verified', now(), 'active'),
  ('cccccccc-3333-4333-8333-333333333333', 'other-seller', 'Other Seller', 'ZZ', 'verified', now(), 'active');

-- The seller has money to withdraw. The ledger is the only way to put it there.
do $$
begin
  perform app_private.ensure_seller_balance('aaaaaaaa-1111-4111-8111-111111111111', 'XTS');
  perform app_private.post_ledger_journal('adjustment', 'XTS', jsonb_build_array(
    jsonb_build_object('account_type', 'provider_clearing', 'direction', 'debit', 'amount_minor', 50000),
    jsonb_build_object('account_type', 'seller_available', 'seller_user_id', 'aaaaaaaa-1111-4111-8111-111111111111',
                       'direction', 'credit', 'amount_minor', 50000)
  ), 'manual', 'opening', 'opening:1', 'Opening balance');
end;
$$;

insert into public.withdrawal_limits (currency_code, min_amount_minor, max_amount_minor)
values ('XTS', 1000, 100000);

-- Providers start empty and every capability fails closed -----------------------------------------------
select is((select count(*) from public.payout_providers), 0::bigint,
  'no payout provider is seeded: none is assumed before B1-B closes');

insert into public.payout_providers (id, key, display_name, is_enabled)
values ('eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'testpay', 'Test payout rail', true);

select ok(
  not public.payout_provider_supports('eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTS', 'payout'),
  'a payout provider with no recorded capability supports nothing'
);
select ok(
  not public.payout_provider_is_eligible('eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTS'),
  'and is not eligible for payouts'
);

-- The eligibility rule is a constraint, not a convention -------------------------------------------------
select throws_ok(
  $$insert into public.payout_provider_capabilities
      (payout_provider_id, currency_code, supports_payout, destination_kinds, evidence_url)
    values ('eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTT', true, array['bank_account'], 'https://rail.example/docs')$$,
  '23514',
  null,
  'a provider that is neither idempotent nor queryable cannot claim payouts (C10)'
);
select throws_ok(
  $$insert into public.payout_provider_capabilities
      (payout_provider_id, currency_code, supports_payout, supports_status_lookup, evidence_url)
    values ('eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTT', true, true, 'https://rail.example/docs')$$,
  '23514',
  null,
  'and it must name at least one destination kind it accepts'
);

insert into public.payout_provider_capabilities
  (payout_provider_id, currency_code, supports_payout, supports_provider_idempotency, supports_reverse,
   supports_webhooks, destination_kinds, evidence_url)
values ('eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTS', true, true, true, true,
        array['bank_account'], 'https://rail.example/docs');

select ok(public.payout_provider_is_eligible('eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTS'),
  'a retry-safe, capable, enabled provider is eligible');
select ok(
  not public.payout_provider_is_eligible('eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTT'),
  'eligibility never leaks across currencies'
);
select ok(
  not public.payout_provider_supports('eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTS', 'cancel'),
  'an unrecorded capability is still refused'
);

-- Destinations hold no readable details ---------------------------------------------------------------------
select throws_ok(
  $$insert into public.payout_destinations
      (seller_user_id, payout_provider_id, currency_code, destination_kind, masked_value)
    values ('aaaaaaaa-1111-4111-8111-111111111111', 'eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTS',
            'bank_account', '•••• 4321')$$,
  '23514',
  null,
  'a destination with neither a Vault secret nor a provider token is refused'
);
select throws_ok(
  $$insert into public.payout_destinations
      (seller_user_id, payout_provider_id, currency_code, destination_kind, masked_value,
       vault_secret_id, provider_token)
    values ('aaaaaaaa-1111-4111-8111-111111111111', 'eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTS',
            'bank_account', '•••• 4321', '00000000-0000-4000-8000-000000000001', 'tok_1')$$,
  '23514',
  null,
  'and one holding both is refused too — the details live in exactly one place'
);

select hasnt_column('public', 'payout_destinations', 'account_number',
  'there is no column a bank number could be written to in the clear');

insert into public.payout_destinations
  (id, seller_user_id, payout_provider_id, currency_code, country_code, destination_kind, masked_value,
   vault_secret_id, verification_status, verified_at, is_default)
values ('d0000001-aaaa-4aaa-8aaa-d00000000001', 'aaaaaaaa-1111-4111-8111-111111111111',
        'eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTS', 'ZZ', 'bank_account', '•••• 4321',
        '00000000-0000-4000-8000-000000000001', 'verified', now(), true);

select throws_ok(
  $$insert into public.payout_destinations
      (seller_user_id, payout_provider_id, currency_code, destination_kind, masked_value, provider_token,
       verification_status, verified_at, is_default)
    values ('aaaaaaaa-1111-4111-8111-111111111111', 'eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTS',
            'wallet', '•••• 9999', 'tok_2', 'verified', now(), true)$$,
  '23505',
  null,
  'a seller has at most one default destination per currency'
);

select is(
  (select id from public.seller_payout_destination('aaaaaaaa-1111-4111-8111-111111111111', 'XTS')),
  'd0000001-aaaa-4aaa-8aaa-d00000000001'::uuid,
  'the resolver returns the verified default'
);
select is(
  (select id from public.seller_payout_destination('cccccccc-3333-4333-8333-333333333333', 'XTS')),
  null,
  'and nothing at all for a seller who has never set one up'
);

select ok(
  (select count(*) > 0 from public.outbox_events where event_type = 'payout_destination.added'),
  'adding a destination publishes the event that warns the seller'
);

-- No payout without an approved withdrawal ------------------------------------------------------------------
do $$
begin
  perform app_private.request_withdrawal('aaaaaaaa-1111-4111-8111-111111111111', 'XTS', 20000, 'wd-pay-1');
end;
$$;

select throws_ok(
  $$select app_private.create_payout(
      (select id from public.withdrawals where idempotency_key = 'wd-pay-1'),
      'eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'd0000001-aaaa-4aaa-8aaa-d00000000001', 'payout-key-1')$$,
  '23001',
  null,
  'a merely requested withdrawal cannot be paid out'
);

do $$
declare
  wd uuid := (select id from public.withdrawals where idempotency_key = 'wd-pay-1');
  admin_id constant uuid := 'dddddddd-4444-4444-8444-444444444444';
begin
  perform app_private.transition_withdrawal(wd, 'under_review', admin_id);
  perform app_private.transition_withdrawal(wd, 'approved', admin_id);
end;
$$;

-- A destination belonging to someone else is refused ----------------------------------------------------------
insert into public.payout_destinations
  (id, seller_user_id, payout_provider_id, currency_code, destination_kind, masked_value, provider_token,
   verification_status, verified_at)
values ('d0000002-aaaa-4aaa-8aaa-d00000000002', 'cccccccc-3333-4333-8333-333333333333',
        'eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'XTS', 'bank_account', '•••• 1111', 'tok_other',
        'verified', now());

select throws_ok(
  $$select app_private.create_payout(
      (select id from public.withdrawals where idempotency_key = 'wd-pay-1'),
      'eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'd0000002-aaaa-4aaa-8aaa-d00000000002', 'payout-key-1')$$,
  '23001',
  null,
  'a payout can never be sent to another seller''s destination'
);

select lives_ok(
  $$select app_private.create_payout(
      (select id from public.withdrawals where idempotency_key = 'wd-pay-1'),
      'eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'd0000001-aaaa-4aaa-8aaa-d00000000001', 'payout-key-1')$$,
  'an approved withdrawal creates its payout'
);
select is(
  (select status from public.withdrawals where idempotency_key = 'wd-pay-1'),
  'processing',
  'and the withdrawal moves to processing (payout created)'
);
select is(
  (select destination_masked_snapshot from public.payouts),
  '•••• 4321',
  'the payout snapshots the masked destination as it read at the time'
);
select is(
  (select format('%s/%s', available_minor, reserved_minor) from public.seller_balances
    where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  '30000/20000',
  'creating the payout moves no money: the reservation simply stays put');

select is(
  app_private.create_payout(
    (select id from public.withdrawals where idempotency_key = 'wd-pay-1'),
    'eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'd0000001-aaaa-4aaa-8aaa-d00000000001', 'payout-key-1'),
  (select id from public.payouts),
  'a retry finds the payout already there and creates no second one (C10)'
);

-- Webhook replay protection (C19) -------------------------------------------------------------------------------
select isnt(
  app_private.record_payout_event('eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'pevt_1', 'payout.paid',
                                  '\x00'::bytea, (select id from public.payouts)),
  null,
  'the first delivery of a payout webhook is stored'
);
select is(
  app_private.record_payout_event('eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'pevt_1', 'payout.paid', '\x00'::bytea),
  null,
  'a redelivery of the same event stores nothing'
);

-- Settlement -----------------------------------------------------------------------------------------------------
select is(
  app_private.settle_payout((select id from public.payouts), 'paid', 'po_ref_1'),
  'paid',
  'a paid payout settles'
);
select is(
  (select format('%s/%s', available_minor, reserved_minor) from public.seller_balances
    where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  '30000/0',
  'and only then is the reservation spent');
select is(
  (select status from public.withdrawals where idempotency_key = 'wd-pay-1'),
  'paid',
  'the withdrawal follows its payout'
);
select is(
  app_private.settle_payout((select id from public.payouts), 'paid', 'po_ref_1'),
  'already_paid',
  're-reporting the same outcome changes nothing (C10)'
);
select throws_ok(
  $$select app_private.settle_payout((select id from public.payouts), 'failed', 'po_ref_2')$$,
  '23001',
  null,
  'and a settled payout can never be settled differently'
);

-- Reversal --------------------------------------------------------------------------------------------------------
insert into public.payout_reversals (currency_code, payout_id, amount_minor, reason, idempotency_key)
values ('XTS', (select id from public.payouts), 20000, 'Recalled by the bank', 'reversal-key-1');

select is(
  app_private.settle_payout_reversal((select id from public.payout_reversals), 'succeeded', 'rev_ref_1'),
  'succeeded',
  'a reversal settles'
);
select is(
  (select status from public.payouts),
  'reversed',
  'and the payout is marked reversed rather than rewritten'
);
select is(
  (select available_minor from public.seller_balances where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  50000::bigint,
  'the money returns to the seller''s available balance'
);
select is(
  (select sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end)::bigint
     from public.ledger_entries e
    where e.account_type = 'payout_clearing'),
  0::bigint,
  'and payout clearing nets back to zero'
);

select * from finish();
rollback;
