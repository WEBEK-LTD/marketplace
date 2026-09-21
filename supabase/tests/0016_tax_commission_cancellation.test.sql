-- pgTAP — migration 0016: tax rules, commission components (D27) and cancellation policies.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTS', '963', 'T', 2, true, false, true, true);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled)
values ('XTT', '964', 'U', 2, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZZ', 'ZZZ', '999', 'Enabled', 'Enabled', '999', 'XTS', true);
-- listing_types (`product`, `service`) are seeded reference data in 0033.
insert into public.categories (id, slug) values ('11111111-aaaa-4aaa-8aaa-111111111111', 'electronics');

-- Tax ------------------------------------------------------------------------------------------------
insert into public.tax_rules (name, country_code, rate_basis_points)
values ('Standard', 'ZZ', 1400);
insert into public.tax_rules (name, country_code, category_id, rate_basis_points, priority)
values ('Electronics', 'ZZ', '11111111-aaaa-4aaa-8aaa-111111111111', 500, 0);

select is(
  (public.resolve_tax_rule('ZZ', null, '11111111-aaaa-4aaa-8aaa-111111111111', 'product')).rate_basis_points,
  500,
  'the most specific tax rule wins'
);
select is(
  (public.resolve_tax_rule('ZZ')).rate_basis_points,
  1400,
  'the general rule applies when nothing more specific matches'
);
select throws_ok(
  $$insert into public.tax_rules (name, country_code, rate_basis_points) values ('Impossible', 'ZZ', 10001)$$,
  '23514',
  null,
  'a tax rate above 100% is refused'
);

-- Commission components --------------------------------------------------------------------------------
insert into public.commission_rules (id, name, scope, component_type, percentage_basis_points)
values ('22222222-aaaa-4aaa-8aaa-222222222222', 'Platform percentage', 'platform', 'percentage', 1000);
insert into public.commission_rules (id, name, scope, component_type)
values ('33333333-aaaa-4aaa-8aaa-333333333333', 'Fixed handling fee', 'platform', 'fixed');

select throws_ok(
  $$insert into public.commission_rules (name, scope, component_type) values ('Bad', 'platform', 'percentage')$$,
  '23514',
  null,
  'a percentage component must carry a rate'
);
select throws_ok(
  $$insert into public.commission_rules (name, scope, component_type, percentage_basis_points)
    values ('Bad', 'platform', 'fixed', 500)$$,
  '23514',
  null,
  'a fixed component must not carry a rate'
);
select throws_ok(
  $$insert into public.commission_rule_amounts (commission_rule_id, currency_code, amount_minor)
    values ('22222222-aaaa-4aaa-8aaa-222222222222', 'XTS', 500)$$,
  '23001',
  null,
  'only a fixed component carries per-currency amounts'
);

insert into public.commission_rule_amounts (commission_rule_id, currency_code, amount_minor)
values ('33333333-aaaa-4aaa-8aaa-333333333333', 'XTS', 500);

-- D27: the fixed component applies in XTS and is skipped in XTT, while the percentage still applies.
select is(
  (select count(*) from public.resolve_commission_components('XTS')),
  2::bigint,
  'both components resolve for a configured currency'
);
select is(
  (select count(*) from public.resolve_commission_components('XTS') where is_skipped),
  0::bigint,
  'and neither is skipped'
);
select is(
  (select amount_minor from public.resolve_commission_components('XTS') where component_type = 'fixed'),
  500::bigint,
  'the fixed amount comes from the currency row'
);
select ok(
  (select is_skipped from public.resolve_commission_components('XTT') where component_type = 'fixed'),
  'a fixed component with no amount for the checkout currency is skipped (D27)'
);
select ok(
  not (select is_skipped from public.resolve_commission_components('XTT') where component_type = 'percentage'),
  'while the other components still apply'
);

select isnt(
  public.record_commission_skip('33333333-aaaa-4aaa-8aaa-333333333333', 'XTT', '{"checkout_id":"test"}'::jsonb),
  null,
  'the skip is recorded as an audit entry, so it can be explained afterwards'
);

-- Cancellation policies -----------------------------------------------------------------------------------
insert into public.cancellation_policies (name, buyer_window_hours, refund_percentage_basis_points, is_default)
values ('Standard', 24, 10000, true);
insert into public.cancellation_policies (name, listing_type_code, buyer_window_hours, refund_percentage_basis_points)
values ('Products', 'product', 48, 5000);

select throws_ok(
  $$insert into public.cancellation_policies (name, buyer_window_hours, refund_percentage_basis_points, is_default)
    values ('Second default', 12, 10000, true)$$,
  '23505',
  null,
  'only one cancellation policy can be the default'
);

select is(
  (public.resolve_cancellation_policy('product')).buyer_window_hours,
  48,
  'the listing-type policy beats the default'
);

select * from finish();
rollback;
