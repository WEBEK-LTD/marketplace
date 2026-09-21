-- pgTAP — migration 0021: ledger journals and entries, seller balances, the wallet view, the
-- post-completion hold, wallet spending, withdrawals and commissions.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(37);

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
  ('bbbbbbbb-2222-4222-8222-222222222222', 'buyer@example.test'),
  ('dddddddd-4444-4444-8444-444444444444', 'admin@example.test');
insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status)
values ('aaaaaaaa-1111-4111-8111-111111111111', 'test-seller', 'Test Seller', 'ZZ', 'verified', now(), 'active');
insert into public.categories (id, slug) values ('11111111-aaaa-4aaa-8aaa-111111111111', 'electronics');
insert into public.listings (id, seller_user_id, listing_type_code, category_id, slug, title, description,
                             content_language, currency_code, price_minor, country_code, status, approved_at)
values ('99999999-aaaa-4aaa-8aaa-999999999999', 'aaaaaaaa-1111-4111-8111-111111111111', 'product',
        '11111111-aaaa-4aaa-8aaa-111111111111', 'blue-widget', 'Blue widget', 'A widget that is blue.',
        'zz', 'XTS', 15000, 'ZZ', 'active', now());
insert into public.listing_product_details (listing_id, condition, quantity)
values ('99999999-aaaa-4aaa-8aaa-999999999999', 'new', 5);

-- Posting rules ---------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.post_ledger_journal('adjustment', 'XTS', jsonb_build_array(
      jsonb_build_object('account_type', 'provider_clearing', 'direction', 'debit', 'amount_minor', 1000),
      jsonb_build_object('account_type', 'platform_loss', 'direction', 'debit', 'amount_minor', 1000)
    ))$$,
  '23514',
  null,
  'a journal whose debits and credits disagree is refused'
);

select throws_ok(
  $$select app_private.post_ledger_journal('adjustment', 'XTS', jsonb_build_array(
      jsonb_build_object('account_type', 'provider_clearing', 'direction', 'debit', 'amount_minor', 1000)
    ))$$,
  '23514',
  null,
  'a single-sided journal is refused'
);

select lives_ok(
  $$select app_private.post_ledger_journal('adjustment', 'XTS', jsonb_build_array(
      jsonb_build_object('account_type', 'provider_clearing', 'direction', 'debit', 'amount_minor', 1000),
      jsonb_build_object('account_type', 'unallocated_receipts', 'direction', 'credit', 'amount_minor', 1000)
    ), 'manual', 'fixture-1', 'fixture:1', 'An unallocated receipt')$$,
  'a balanced journal posts'
);

select is(
  (select count(*) from public.ledger_entries e
     join public.ledger_journals j on j.id = e.journal_id
    where j.idempotency_key = 'fixture:1'),
  2::bigint,
  'and carries both of its entries'
);

select is(
  app_private.post_ledger_journal('adjustment', 'XTS', jsonb_build_array(
    jsonb_build_object('account_type', 'provider_clearing', 'direction', 'debit', 'amount_minor', 1000),
    jsonb_build_object('account_type', 'unallocated_receipts', 'direction', 'credit', 'amount_minor', 1000)
  ), 'manual', 'fixture-1', 'fixture:1'),
  (select id from public.ledger_journals where idempotency_key = 'fixture:1'),
  'reposting the same idempotency key returns the journal already there (C10)'
);

select has_trigger('public', 'ledger_entries', 'ledger_entries_journal_balances',
  'the deferred balance check guards the entries table even against a direct write');

select throws_ok(
  $$update public.ledger_entries set amount_minor = 1 where amount_minor = 1000$$,
  '23001',
  null,
  'ledger entries are append-only'
);
select throws_ok(
  $$update public.ledger_journals set description = 'edited' where idempotency_key = 'fixture:1'$$,
  '23001',
  null,
  'ledger journals are append-only'
);

-- A correction is a reversal, never an edit -------------------------------------------------------------
select lives_ok(
  $$select app_private.reverse_ledger_journal(
      (select id from public.ledger_journals where idempotency_key = 'fixture:1'), 'posted in error')$$,
  'a posted journal is corrected by reversing it'
);
select is(
  (select e.direction from public.ledger_entries e
     join public.ledger_journals j on j.id = e.journal_id
    where j.journal_type = 'reversal' and e.account_type = 'provider_clearing'),
  'credit',
  'and the reversal mirrors every entry'
);

-- Fulfilment posts the capture journal -------------------------------------------------------------------
insert into public.checkouts (id, currency_code, buyer_user_id, subtotal_minor, shipping_total_minor,
                              tax_total_minor, grand_total_minor, commission_snapshot,
                              cancellation_policy_snapshot, status)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222',
        30000, 5000, 0, 35000, '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb, 'paid');
insert into public.checkout_items (checkout_id, currency_code, listing_id, seller_user_id, listing_type_code,
                                   listing_title_snapshot, listing_slug_snapshot, quantity, unit_price_minor,
                                   line_subtotal_minor, line_total_minor, commission_minor,
                                   commission_base_minor, commission_snapshot)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', '99999999-aaaa-4aaa-8aaa-999999999999',
        'aaaaaaaa-1111-4111-8111-111111111111', 'product', 'Blue widget', 'blue-widget', 2, 15000,
        30000, 30000, 3000, 30000, '{"components":[{"scope":"platform","basis_points":1000}]}'::jsonb);
insert into public.checkout_charges (checkout_id, currency_code, charge_type, seller_user_id, label, amount_minor)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'shipping', 'aaaaaaaa-1111-4111-8111-111111111111', 'Standard', 5000);

insert into public.payment_providers (id, key, display_name, is_enabled)
values ('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'testgw', 'Test gateway', true);
insert into public.payments (id, currency_code, checkout_id, buyer_user_id, amount_minor)
values ('ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'XTS', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001',
        'bbbbbbbb-2222-4222-8222-222222222222', 35000);
insert into public.payment_attempts (id, currency_code, payment_id, payment_provider_id, attempt_number, amount_minor, idempotency_key)
values ('dddd0001-aaaa-4aaa-8aaa-dddd00000001', 'XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001',
        'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 1, 35000, 'attempt-key-1');

select is(
  app_private.fulfil_checkout('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'dddd0001-aaaa-4aaa-8aaa-dddd00000001'),
  1,
  'fulfilment still creates one order per seller'
);

select is(
  (select sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end)::bigint
     from public.ledger_entries e
     join public.ledger_journals j on j.id = e.journal_id
    where j.journal_type = 'checkout_capture'),
  0::bigint,
  'the capture journal balances to the minor unit'
);
select is(
  (select amount_minor from public.ledger_entries e
     join public.ledger_journals j on j.id = e.journal_id
    where j.journal_type = 'checkout_capture' and e.account_type = 'provider_clearing'),
  35000::bigint,
  'the full capture is debited to provider clearing'
);
select is(
  (select amount_minor from public.ledger_entries e
     join public.ledger_journals j on j.id = e.journal_id
    where j.journal_type = 'checkout_capture' and e.account_type = 'commission_revenue'),
  3000::bigint,
  'and the commission is credited to commission revenue'
);

select is(
  (select commission_total_minor from public.orders),
  3000::bigint,
  'the order carries the commission the checkout resolved'
);
select is(
  (select seller_net_minor from public.orders),
  32000::bigint,
  'and the seller net is the order total less tax and commission'
);
select is(
  (select amount_minor from public.commissions),
  3000::bigint,
  'the commission is snapshotted per order item (D11)'
);
select is(
  (select pending_minor from public.seller_balances where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  32000::bigint,
  'the seller''s earnings land in pending, not available'
);

-- The post-completion hold ---------------------------------------------------------------------------------
update public.orders set status = 'completed', completed_at = now() - interval '10 days';

select is(app_private.release_seller_holds(), 1, 'a completed order past its hold is released');
select is(
  (select format('%s/%s', pending_minor, available_minor) from public.seller_balances
    where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  '0/32000',
  'and the money moves from pending to available');
select is(app_private.release_seller_holds(), 0, 'a second run releases the same order again — it does not');

-- Withdrawals -------------------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.request_withdrawal('aaaaaaaa-1111-4111-8111-111111111111', 'XTS', 20000)$$,
  '23001',
  null,
  'a currency with no withdrawal limits fails closed'
);

insert into public.withdrawal_limits (currency_code, min_amount_minor, max_amount_minor, max_open_requests)
values ('XTS', 1000, 100000, 2);

select throws_ok(
  $$select app_private.request_withdrawal('aaaaaaaa-1111-4111-8111-111111111111', 'XTS', 50000)$$,
  '23514',
  null,
  'a seller cannot withdraw more than is available'
);

select lives_ok(
  $$select app_private.request_withdrawal('aaaaaaaa-1111-4111-8111-111111111111', 'XTS', 20000, 'wd-1')$$,
  'a withdrawal within the limits is accepted'
);
select is(
  (select format('%s/%s', available_minor, reserved_minor) from public.seller_balances
    where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  '12000/20000',
  'and its funds are reserved straight away');

select throws_ok(
  $$select app_private.transition_withdrawal(
      (select id from public.withdrawals where idempotency_key = 'wd-1'), 'paid',
      'dddddddd-4444-4444-8444-444444444444')$$,
  '23514',
  null,
  'no payout without an approved withdrawal: requested can never jump to paid'
);

select lives_ok(
  $$select app_private.transition_withdrawal(
      (select id from public.withdrawals where idempotency_key = 'wd-1'), 'under_review',
      'dddddddd-4444-4444-8444-444444444444'),
    app_private.transition_withdrawal(
      (select id from public.withdrawals where idempotency_key = 'wd-1'), 'rejected',
      'dddddddd-4444-4444-8444-444444444444', 'Payout details do not match')$$,
  'a reviewed withdrawal can be rejected'
);
select is(
  (select format('%s/%s', available_minor, reserved_minor) from public.seller_balances
    where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  '32000/0',
  'and a rejection releases the funds');

do $$
declare
  wd uuid;
  admin_id constant uuid := 'dddddddd-4444-4444-8444-444444444444';
begin
  wd := app_private.request_withdrawal('aaaaaaaa-1111-4111-8111-111111111111', 'XTS', 20000, 'wd-2');
  perform app_private.transition_withdrawal(wd, 'under_review', admin_id);
  perform app_private.transition_withdrawal(wd, 'approved', admin_id);
  perform app_private.transition_withdrawal(wd, 'processing', admin_id);
  perform app_private.transition_withdrawal(wd, 'paid', admin_id);
end;
$$;

select is(
  (select format('%s/%s', available_minor, reserved_minor) from public.seller_balances
    where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  '12000/0',
  'a paid withdrawal spends the reservation once and only once');
select is(
  (select sum(e.amount_minor)::bigint from public.ledger_entries e
    where e.account_type = 'payout_clearing' and e.direction = 'credit'),
  20000::bigint,
  'and the obligation sits in payout clearing until the payout settles');

-- The wallet statement -----------------------------------------------------------------------------------------
select is(
  (select sum(signed_minor)::bigint from public.wallet_transactions
    where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  12000::bigint,
  'the wallet statement adds up to what the seller still holds'
);

-- Spending available funds ----------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.spend_wallet_on_promotion('aaaaaaaa-1111-4111-8111-111111111111', 'XTS', 99000,
      'promotion', 'promo-1', 'promo:1')$$,
  '23514',
  null,
  'the wallet pays a promotion only when available funds cover it in full'
);
select lives_ok(
  $$select app_private.spend_wallet_on_promotion('aaaaaaaa-1111-4111-8111-111111111111', 'XTS', 5000,
      'promotion', 'promo-2', 'promo:2')$$,
  'a promotion within the available balance is paid from the wallet'
);
select is(
  (select available_minor from public.seller_balances where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  7000::bigint,
  'and the wallet is debited by exactly the price'
);

-- A seller can never be overdrawn ------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.post_ledger_journal('adjustment', 'XTS', jsonb_build_array(
      jsonb_build_object('account_type', 'seller_available', 'seller_user_id', 'aaaaaaaa-1111-4111-8111-111111111111',
                         'direction', 'debit', 'amount_minor', 99000),
      jsonb_build_object('account_type', 'platform_loss', 'direction', 'credit', 'amount_minor', 99000)
    ))$$,
  '23514',
  null,
  'no journal can take a seller balance below zero'
);

-- Disputed funds are frozen (D26) ---------------------------------------------------------------------------------------
insert into public.payment_disputes (currency_code, payment_id, amount_minor, payment_provider_id, provider_reference)
values ('XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 35000, 'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'dp_1');

select ok(public.seller_funds_are_frozen('aaaaaaaa-1111-4111-8111-111111111111'),
  'an open dispute freezes the seller''s funds');
select throws_ok(
  $$select app_private.request_withdrawal('aaaaaaaa-1111-4111-8111-111111111111', 'XTS', 2000, 'wd-3')$$,
  '23001',
  null,
  'and no withdrawal can be raised while they are frozen (D26)'
);

select * from finish();
rollback;
