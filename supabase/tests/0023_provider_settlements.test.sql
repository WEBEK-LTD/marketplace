-- pgTAP — migration 0023: statement import, immutability, matching, variance detection, the
-- fail-closed posting gate (B1-C) and the reconciliation journal.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(33);

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

insert into public.payment_providers (id, key, display_name, is_enabled)
values ('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'testgw', 'Test gateway', true);
insert into public.payment_provider_capabilities (payment_provider_id, currency_code, supports_charge, supports_webhooks, evidence_url)
values ('eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'XTS', true, true, 'https://provider.example/docs');
insert into public.payout_providers (id, key, display_name, is_enabled)
values ('eeee0002-aaaa-4aaa-8aaa-eeee00000002', 'testpay', 'Test payout rail', true);

-- One captured payment with a provider transaction we can match against.
insert into public.checkouts (id, currency_code, buyer_user_id, subtotal_minor, grand_total_minor,
                              commission_snapshot, cancellation_policy_snapshot, status)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222', 30000, 30000,
        '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb, 'paid');
insert into public.payments (id, currency_code, checkout_id, buyer_user_id, amount_minor)
values ('ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'XTS', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001',
        'bbbbbbbb-2222-4222-8222-222222222222', 30000);
insert into public.payment_attempts (id, currency_code, payment_id, payment_provider_id, attempt_number, amount_minor, idempotency_key)
values ('dddd0001-aaaa-4aaa-8aaa-dddd00000001', 'XTS', 'ffff0001-aaaa-4aaa-8aaa-ffff00000001',
        'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 1, 30000, 'attempt-key-1');
insert into public.payment_provider_transactions
  (currency_code, payment_provider_id, payment_attempt_id, payment_id, kind, provider_reference, amount_minor, normalized_status)
values ('XTS', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'dddd0001-aaaa-4aaa-8aaa-dddd00000001',
        'ffff0001-aaaa-4aaa-8aaa-ffff00000001', 'charge', 'ch_1', 30000, 'succeeded');

-- The clearing accounts exist only because the ledger put something there -------------------------------
do $$
begin
  perform app_private.post_ledger_journal('checkout_capture', 'XTS', jsonb_build_array(
    jsonb_build_object('account_type', 'provider_clearing', 'direction', 'debit', 'amount_minor', 30000),
    jsonb_build_object('account_type', 'seller_pending', 'seller_user_id', 'aaaaaaaa-1111-4111-8111-111111111111',
                       'direction', 'credit', 'amount_minor', 30000)
  ), 'checkout', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'capture:1', 'Capture');
end;
$$;

select is(public.clearing_account_balance('provider_clearing', 'XTS'), 30000::bigint,
  'a clearing account reads back the balance the ledger put there');
select is(public.clearing_account_balance('payout_clearing', 'XTS'), 0::bigint,
  'and an account nothing has touched reads zero rather than nothing');

-- A statement names exactly one provider of one kind -------------------------------------------------------
select throws_ok(
  $$insert into public.provider_settlements
      (settlement_kind, currency_code, payment_provider_id, payout_provider_id, statement_reference,
       period_start, period_end)
    values ('payment', 'XTS', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001', 'eeee0002-aaaa-4aaa-8aaa-eeee00000002',
            'st_bad', current_date, current_date)$$,
  '23514',
  null,
  'a statement cannot belong to a payment provider and a payout provider at once'
);
select throws_ok(
  $$insert into public.provider_settlements
      (settlement_kind, currency_code, statement_reference, period_start, period_end)
    values ('payout', 'XTS', 'st_bad2', current_date, current_date)$$,
  '23514',
  null,
  'nor to no provider at all'
);

-- Importing -----------------------------------------------------------------------------------------------
select lives_ok(
  $$select app_private.open_settlement('payment', 'XTS', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001',
      'st_2026_01', current_date - 30, current_date, 30000, 900, 29100, '\x01'::bytea)$$,
  'a statement is imported'
);
select is(
  app_private.open_settlement('payment', 'XTS', 'eeee0001-aaaa-4aaa-8aaa-eeee00000001',
    'st_2026_01', current_date - 30, current_date, 30000, 900, 29100),
  (select id from public.provider_settlements where statement_reference = 'st_2026_01'),
  'importing it again returns the one already there (C10)'
);

select throws_ok(
  $$update public.provider_settlements set reported_net_minor = 1 where statement_reference = 'st_2026_01'$$,
  '23001',
  null,
  'an imported statement can never be rewritten'
);

-- Its lines -------------------------------------------------------------------------------------------------
do $$
declare
  st uuid := (select id from public.provider_settlements where statement_reference = 'st_2026_01');
begin
  perform app_private.record_settlement_item(st, 'charge', 'inbound', 'ch_1', 30000);
  perform app_private.record_settlement_item(st, 'fee', 'outbound', 'fee_1', 900);
  perform app_private.record_settlement_item(st, 'charge', 'inbound', 'ch_unknown', 5000);
end;
$$;

select is((select count(*) from public.provider_settlement_items), 3::bigint,
  'every line of the statement is stored');
select is(
  app_private.record_settlement_item(
    (select id from public.provider_settlements where statement_reference = 'st_2026_01'),
    'charge', 'inbound', 'ch_1', 30000),
  null,
  'a line the statement already carries is not added twice'
);

select throws_ok(
  $$insert into public.provider_settlement_items
      (provider_settlement_id, settlement_kind, currency_code, item_kind, direction, provider_reference, amount_minor)
    values ((select id from public.provider_settlements where statement_reference = 'st_2026_01'),
            'payment', 'XTS', 'payout', 'outbound', 'po_1', 1000)$$,
  '23514',
  null,
  'a payout line can never appear on a payment statement'
);

select throws_ok(
  $$update public.provider_settlement_items set amount_minor = 1 where provider_reference = 'ch_1'$$,
  '23001',
  null,
  'what the provider reported on a line cannot be edited'
);
select throws_ok(
  $$delete from public.provider_settlement_items where provider_reference = 'ch_1'$$,
  '23001',
  null,
  'and a line can never be removed'
);

-- Matching ---------------------------------------------------------------------------------------------------
select is(
  app_private.match_settlement((select id from public.provider_settlements where statement_reference = 'st_2026_01')),
  1,
  'the line with a provider transaction behind it is matched'
);
select is(
  (select payment_id from public.provider_settlement_items where provider_reference = 'ch_1'),
  'ffff0001-aaaa-4aaa-8aaa-ffff00000001'::uuid,
  'and carries our payment'
);
select is(
  (select match_status from public.provider_settlement_items where provider_reference = 'fee_1'),
  'ignored',
  'a fee line is evidence, not a transaction of ours to find'
);
select is(
  (select match_status from public.provider_settlement_items where provider_reference = 'ch_unknown'),
  'unmatched',
  'a line we cannot attribute stays unmatched'
);
select is(
  (select computed_net_minor from public.provider_settlements where statement_reference = 'st_2026_01'),
  34100::bigint,
  'the statement''s own lines are summed, inbound less outbound'
);
select is(
  (select variance_minor from public.provider_settlements where statement_reference = 'st_2026_01'),
  -5000::bigint,
  'and compared with what its header claims'
);
select is(
  (select unmatched_amount_minor from public.provider_settlements where statement_reference = 'st_2026_01'),
  5000::bigint,
  'what stays unattributed is recorded too'
);
select is(
  (select status from public.provider_settlements where statement_reference = 'st_2026_01'),
  'matched',
  'the statement is now matched'
);

select throws_ok(
  $$select app_private.record_settlement_item(
      (select id from public.provider_settlements where statement_reference = 'st_2026_01'),
      'charge', 'inbound', 'ch_late', 100)$$,
  '23001',
  null,
  'a matched statement takes no more lines'
);

-- The posting gate fails closed while B1-C is open ----------------------------------------------------------------
select is(
  (public.site_setting('finance.settlement_posting_enabled'))::boolean,
  false,
  'settlement posting ships turned off (B1-C)'
);
select is(
  app_private.reconcile_settlement(
    (select id from public.provider_settlements where statement_reference = 'st_2026_01')),
  'posting_blocked',
  'so reconciling records the comparison and posts nothing'
);
select is(
  (select ledger_journal_id from public.provider_settlements where statement_reference = 'st_2026_01'),
  null,
  'no journal exists for it'
);
select isnt(
  (select posting_blocked_reason from public.provider_settlements where statement_reference = 'st_2026_01'),
  null,
  'and the settlement says why'
);
select is(
  (select status from public.provider_settlements where statement_reference = 'st_2026_01'),
  'matched',
  'the settlement waits at matched rather than claiming to be reconciled'
);

-- With the gate open, the journal is posted and it balances ---------------------------------------------------------
update public.site_settings set value = 'true'::jsonb where key = 'finance.settlement_posting_enabled';

select is(
  app_private.reconcile_settlement(
    (select id from public.provider_settlements where statement_reference = 'st_2026_01'),
    'dddddddd-4444-4444-8444-444444444444'),
  'variance',
  'reconciling now posts, and reports that the statement did not agree'
);
select is(
  (select sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end)::bigint
     from public.ledger_entries e
     join public.ledger_journals j on j.id = e.journal_id
    where j.journal_type = 'settlement'),
  0::bigint,
  'the settlement journal balances to the minor unit'
);
select is(
  (select e.amount_minor from public.ledger_entries e
     join public.ledger_journals j on j.id = e.journal_id
    where j.journal_type = 'settlement' and e.account_type = 'unallocated_receipts'),
  5000::bigint,
  'the line we could not attribute goes to unallocated receipts'
);
select is(
  (select e.amount_minor from public.ledger_entries e
     join public.ledger_journals j on j.id = e.journal_id
    where j.journal_type = 'settlement' and e.account_type = 'fee_variance'),
  5000::bigint,
  'and the statement''s disagreement with itself goes to fee variance'
);
select is(
  (select status from public.provider_settlements where statement_reference = 'st_2026_01'),
  'variance',
  'the settlement records that it did not come out clean'
);

-- Closing ------------------------------------------------------------------------------------------------------------
select ok(
  app_private.close_settlement((select id from public.provider_settlements where statement_reference = 'st_2026_01')),
  'a reconciled settlement can be closed'
);
select throws_ok(
  $$update public.provider_settlements set status = 'matched' where statement_reference = 'st_2026_01'$$,
  '23001',
  null,
  'and a closed settlement is final'
);

select * from finish();
rollback;
