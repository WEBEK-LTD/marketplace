-- pgTAP — migration 0002: currency and locale rules (D14, D16).
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(17);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zz', 'Test locale', 'Test locale', 'ltr', true, false);

insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTS', '963', 'T', 2, true, false, true, true);

insert into public.currencies (code, numeric_code, symbol, decimal_places)
values ('XXX', '999', 'U', 2);

-- Shape ---------------------------------------------------------------------------------------------
select has_table('public', 'currencies', 'currencies exists');
select has_table('public', 'locales', 'locales exists');
select has_table('public', 'countries', 'countries exists');
select has_table('public', 'currency_translations', 'currency_translations exists');
select has_table('public', 'listing_types', 'listing_types exists');

-- Enabling stamps first_enabled_at ------------------------------------------------------------------
select isnt((select first_enabled_at from public.currencies where code = 'XTS'), null,
  'enabling a currency records first_enabled_at');
select is((select first_enabled_at from public.currencies where code = 'XXX'), null,
  'a currency that was never enabled has no first_enabled_at');

-- Decimal places lock once used ---------------------------------------------------------------------
select throws_ok(
  $$update public.currencies set decimal_places = 3 where code = 'XTS'$$,
  '23001',
  null,
  'decimal places are locked once the currency has been enabled'
);
select lives_ok(
  $$update public.currencies set decimal_places = 3 where code = 'XXX'$$,
  'decimal places can still change while the currency has never been enabled'
);

-- Immutable identity --------------------------------------------------------------------------------
select throws_ok(
  $$update public.currencies set numeric_code = '111' where code = 'XXX'$$,
  '23001',
  null,
  'the numeric code is immutable'
);

-- Retire, never delete ------------------------------------------------------------------------------
select throws_ok(
  $$delete from public.currencies where code = 'XTS'$$,
  '23001',
  null,
  'a currency that has been in use cannot be deleted'
);
select lives_ok(
  $$delete from public.currencies where code = 'XXX'$$,
  'a currency that was never enabled can be deleted'
);

-- Default protection --------------------------------------------------------------------------------
-- The default currency is the seeded EGP (0033), so the rule is exercised against it rather than
-- against a second default the schema would never allow to exist.
select throws_ok(
  $$update public.currencies set is_default = false where code = 'EGP'$$,
  '23001',
  null,
  'the default currency cannot simply be unset'
);

-- D16 blockers --------------------------------------------------------------------------------------
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZZ', 'ZZZ', '999', 'Test country', 'Test country', '999', 'XTS', true);

select is((select count(*) from public.currency_blockers('XTS')), 1::bigint,
  'a country using the currency blocks disabling it');

select throws_ok(
  $$update public.currencies set is_enabled = false where code = 'XTS'$$,
  '23001',
  null,
  'a currency with dependants cannot be disabled'
);

-- One default per table -----------------------------------------------------------------------------
select throws_ok(
  $$insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
    values ('yy', 'Second', 'Second', 'ltr', true, true)$$,
  '23505',
  null,
  'only one locale can be the default'
);

select ok(
  (select count(*) = 1 from app_private.currency_dependencies where dependency_key = 'countries.default_currency_code'),
  'the countries dependency is registered'
);

select * from finish();
rollback;
