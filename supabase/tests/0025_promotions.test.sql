-- pgTAP — migration 0025: packages, per-currency pricing, eligibility, the promotion lifecycle, the
-- wallet purchase, cancellation and refund, the event stream and its rollup.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(35);

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
  ('dddddddd-4444-4444-8444-444444444444', 'admin@example.test');
insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'seller-a', 'Seller A', 'ZZ', 'verified', now(), 'active'),
  ('cccccccc-3333-4333-8333-333333333333', 'seller-b', 'Seller B', 'ZZ', 'verified', now(), 'active');

insert into public.categories (id, slug) values ('11111111-aaaa-4aaa-8aaa-111111111111', 'electronics');
insert into public.categories (id, parent_id, slug)
values ('22222222-aaaa-4aaa-8aaa-222222222222', '11111111-aaaa-4aaa-8aaa-111111111111', 'phones');
insert into public.categories (id, slug) values ('33333333-aaaa-4aaa-8aaa-333333333333', 'garden');

insert into public.listings (id, seller_user_id, listing_type_code, category_id, slug, title, description,
                             content_language, currency_code, price_minor, country_code, status, approved_at) values
  ('99999999-aaaa-4aaa-8aaa-999999999999', 'aaaaaaaa-1111-4111-8111-111111111111', 'product',
   '22222222-aaaa-4aaa-8aaa-222222222222', 'blue-phone', 'Blue phone', 'A phone that is blue.',
   'zz', 'XTS', 20000, 'ZZ', 'active', now()),
  ('88888888-aaaa-4aaa-8aaa-888888888888', 'aaaaaaaa-1111-4111-8111-111111111111', 'product',
   '33333333-aaaa-4aaa-8aaa-333333333333', 'green-spade', 'Green spade', 'A spade that is green.',
   'zz', 'XTS', 5000, 'ZZ', 'draft', null);

-- The seller has wallet funds. The ledger is the only way to put them there.
do $$
begin
  perform app_private.ensure_seller_balance('aaaaaaaa-1111-4111-8111-111111111111', 'XTS');
  perform app_private.post_ledger_journal('adjustment', 'XTS', jsonb_build_array(
    jsonb_build_object('account_type', 'provider_clearing', 'direction', 'debit', 'amount_minor', 30000),
    jsonb_build_object('account_type', 'seller_available', 'seller_user_id', 'aaaaaaaa-1111-4111-8111-111111111111',
                       'direction', 'credit', 'amount_minor', 30000)
  ), 'manual', 'opening', 'opening:1', 'Opening balance');
end;
$$;

-- Packages ---------------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.promotion_packages (key, name_en, name_ar, billing_model, duration_days)
    values ('sale_based', 'Pay on sale', 'Pay on sale', 'pay_on_sale', 7)$$,
  '23514',
  null,
  'pay_on_sale is reserved and cannot be used in V1'
);
select throws_ok(
  $$insert into public.promotion_packages (key, name_en, name_ar, billing_model, duration_days)
    values ('per_click', 'Per click', 'Per click', 'per_click', 7)$$,
  '23514',
  null,
  'and there is no pay-per-click billing model at all'
);

insert into public.promotion_packages (id, key, name_en, name_ar, duration_days, priority, max_active_per_seller)
values ('a0000001-aaaa-4aaa-8aaa-a00000000001', 'featured_week', 'Featured for a week', 'مميز لمدة أسبوع', 7, 100, 1);
insert into public.promotion_package_placements (promotion_package_id, placement)
values ('a0000001-aaaa-4aaa-8aaa-a00000000001', 'search_results'),
       ('a0000001-aaaa-4aaa-8aaa-a00000000001', 'homepage');
insert into public.promotion_package_categories (promotion_package_id, category_id)
values ('a0000001-aaaa-4aaa-8aaa-a00000000001', '11111111-aaaa-4aaa-8aaa-111111111111');

select throws_ok(
  $$insert into public.promotion_package_placements (promotion_package_id, placement)
    values ('a0000001-aaaa-4aaa-8aaa-a00000000001', 'billboard')$$,
  '23514',
  null,
  'a placement has to be one the platform actually renders'
);

select is(public.promotion_package_price('a0000001-aaaa-4aaa-8aaa-a00000000001', 'XTS'), null,
  'a package with no price in a currency is not for sale there (D16)');

insert into public.promotion_package_prices (promotion_package_id, currency_code, price_minor)
values ('a0000001-aaaa-4aaa-8aaa-a00000000001', 'XTS', 10000);

select is(public.promotion_package_price('a0000001-aaaa-4aaa-8aaa-a00000000001', 'XTS'), 10000::bigint,
  'and is for sale once a price exists');

select ok(
  public.promotion_package_allows_category('a0000001-aaaa-4aaa-8aaa-a00000000001', '22222222-aaaa-4aaa-8aaa-222222222222'),
  'category eligibility reaches the whole branch beneath it (D8)'
);
select ok(
  not public.promotion_package_allows_category('a0000001-aaaa-4aaa-8aaa-a00000000001', '33333333-aaaa-4aaa-8aaa-333333333333'),
  'and stops at the branch it was given'
);

-- Eligibility --------------------------------------------------------------------------------------------
select ok(public.listing_is_promotable('99999999-aaaa-4aaa-8aaa-999999999999', 'aaaaaaaa-1111-4111-8111-111111111111'),
  'an active listing belonging to the seller is eligible');
select ok(
  not public.listing_is_promotable('88888888-aaaa-4aaa-8aaa-888888888888', 'aaaaaaaa-1111-4111-8111-111111111111'),
  'a draft listing is not'
);
select ok(
  not public.listing_is_promotable('99999999-aaaa-4aaa-8aaa-999999999999', 'cccccccc-3333-4333-8333-333333333333'),
  'and nobody promotes somebody else''s listing'
);

select throws_ok(
  $$select app_private.create_promotion('cccccccc-3333-4333-8333-333333333333',
      '99999999-aaaa-4aaa-8aaa-999999999999', 'a0000001-aaaa-4aaa-8aaa-a00000000001', 'XTS')$$,
  '23001',
  null,
  'creating a promotion for a listing that is not yours is refused'
);
select throws_ok(
  $$select app_private.create_promotion('aaaaaaaa-1111-4111-8111-111111111111',
      '99999999-aaaa-4aaa-8aaa-999999999999', 'a0000001-aaaa-4aaa-8aaa-a00000000001', 'XTT')$$,
  '23001',
  null,
  'and so is buying in a currency the package has no price in (D16)'
);

-- Buying ----------------------------------------------------------------------------------------------------
select lives_ok(
  $$select app_private.create_promotion('aaaaaaaa-1111-4111-8111-111111111111',
      '99999999-aaaa-4aaa-8aaa-999999999999', 'a0000001-aaaa-4aaa-8aaa-a00000000001', 'XTS', 'promo-1')$$,
  'an eligible listing and a priced package make a promotion'
);
select is(
  (select format('%s/%s/%s', status, price_minor, duration_days) from public.promotions),
  'draft/10000/7',
  'which starts as a draft carrying the snapshotted price and duration');
select is(
  (select package_snapshot -> 'placements' from public.promotions),
  '["homepage", "search_results"]'::jsonb,
  'and the placements it was sold with'
);
select is(
  app_private.create_promotion('aaaaaaaa-1111-4111-8111-111111111111',
    '99999999-aaaa-4aaa-8aaa-999999999999', 'a0000001-aaaa-4aaa-8aaa-a00000000001', 'XTS', 'promo-1'),
  (select id from public.promotions),
  'creating it again with the same key returns the same promotion (C10)'
);

select throws_ok(
  $$update public.promotions set status = 'active'$$,
  '23514',
  null,
  'a draft promotion cannot jump straight to active'
);

select is(
  app_private.pay_promotion_from_wallet((select id from public.promotions), 'promo-pay-1'),
  'paid',
  'paying from the wallet succeeds when available funds cover the price'
);
select is(
  (select available_minor from public.seller_balances where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  20000::bigint,
  'and the wallet is debited by exactly the price'
);
select is(
  (select sum(e.amount_minor)::bigint from public.ledger_entries e where e.account_type = 'promotion_revenue'),
  10000::bigint,
  'with the money landing in promotion revenue'
);
select is(
  (select status from public.promotions),
  'scheduled',
  'and the promotion is scheduled straight away'
);
select is(
  app_private.pay_promotion_from_wallet((select id from public.promotions), 'promo-pay-1'),
  'already_paid',
  'paying again changes nothing (C10)'
);
select is(
  (select count(*) from public.promotion_status_history),
  3::bigint,
  'every state it passed through is on the record'
);

-- The package limit holds ---------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.create_promotion('aaaaaaaa-1111-4111-8111-111111111111',
      '99999999-aaaa-4aaa-8aaa-999999999999', 'a0000001-aaaa-4aaa-8aaa-a00000000001', 'XTS', 'promo-2')$$,
  '23001',
  null,
  'a seller cannot exceed the package''s per-seller limit'
);

-- Starting and expiring ------------------------------------------------------------------------------------------
select is(app_private.start_due_promotions(), 1, 'a scheduled promotion whose time has come starts');
select isnt(
  (select id from public.active_promotion_for_listing('99999999-aaaa-4aaa-8aaa-999999999999')),
  null,
  'and search can then see what to label as sponsored'
);

-- Events and rollups -------------------------------------------------------------------------------------------------
select is(
  app_private.record_promotion_events(jsonb_build_array(
    jsonb_build_object('event_id', '00000000-0000-4000-8000-000000000001',
                       'promotion_id', (select id from public.promotions),
                       'listing_id', '99999999-aaaa-4aaa-8aaa-999999999999',
                       'seller_user_id', 'aaaaaaaa-1111-4111-8111-111111111111',
                       'event_type', 'impression', 'placement', 'search_results'),
    jsonb_build_object('event_id', '00000000-0000-4000-8000-000000000002',
                       'promotion_id', (select id from public.promotions),
                       'listing_id', '99999999-aaaa-4aaa-8aaa-999999999999',
                       'seller_user_id', 'aaaaaaaa-1111-4111-8111-111111111111',
                       'event_type', 'click', 'placement', 'search_results'),
    jsonb_build_object('event_id', '00000000-0000-4000-8000-000000000001',
                       'promotion_id', (select id from public.promotions),
                       'listing_id', '99999999-aaaa-4aaa-8aaa-999999999999',
                       'event_type', 'impression')
  )),
  2,
  'the event stream drops the repeat by event id'
);
select throws_ok(
  $$update public.promotion_events set event_type = 'click'$$,
  '23001',
  null,
  'the event stream is append-only'
);
select is(
  app_private.rollup_promotion_analytics(current_date),
  1,
  'the daily rollup summarises the stream'
);
select is(
  (select format('%s/%s', impressions, clicks) from public.promotion_analytics),
  '1/1',
  'and counts each kind of event');

-- Cancelling with a refund policy -------------------------------------------------------------------------------------
select is(
  (select id from public.resolve_promotion_refund_policy('listing_unavailable')),
  null,
  'with nothing configured, nothing is refunded'
);

insert into public.promotion_refund_policies (name, applies_to, refund_percentage_basis_points)
values ('Full refund when a listing goes away', 'listing_unavailable', 10000);

select is(
  app_private.cancel_promotion((select id from public.promotions), 'listing_unavailable', 'listing was archived'),
  10000::bigint,
  'the configured policy decides what comes back'
);
select is(
  (select format('%s/%s', status, refunded_amount_minor) from public.promotions),
  'refunded/10000',
  'and the promotion records that it was refunded, not rewritten');
select is(
  (select available_minor from public.seller_balances where seller_user_id = 'aaaaaaaa-1111-4111-8111-111111111111'),
  30000::bigint,
  'the money is back in the seller''s wallet'
);
select is(
  (select sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end)::bigint
     from public.ledger_entries e where e.account_type = 'promotion_revenue'),
  0::bigint,
  'and promotion revenue nets back to zero'
);

select * from finish();
rollback;
