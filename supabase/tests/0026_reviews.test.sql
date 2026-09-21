-- pgTAP — migration 0026: review eligibility and uniqueness (D13), seller replies, moderation, the
-- effect of refunds and disputes on publication, and the derived seller rating.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

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
  ('eeeeeeee-5555-4555-8555-555555555555', 'other-buyer@example.test'),
  ('cccccccc-3333-4333-8333-333333333333', 'other-seller@example.test'),
  ('dddddddd-4444-4444-8444-444444444444', 'moderator@example.test');
insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'test-seller', 'Test Seller', 'ZZ', 'verified', now(), 'active'),
  ('cccccccc-3333-4333-8333-333333333333', 'other-seller', 'Other Seller', 'ZZ', 'verified', now(), 'active');

insert into public.checkouts (id, currency_code, buyer_user_id, subtotal_minor, grand_total_minor,
                              commission_snapshot, cancellation_policy_snapshot, status) values
  ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222', 30000, 30000,
   '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb, 'paid'),
  ('bbbb0002-aaaa-4aaa-8aaa-bbbb00000002', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222', 10000, 10000,
   '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb, 'paid'),
  ('bbbb0003-aaaa-4aaa-8aaa-bbbb00000003', 'XTS', 'eeeeeeee-5555-4555-8555-555555555555', 20000, 20000,
   '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb, 'paid');

insert into public.orders (id, currency_code, checkout_id, seller_user_id, buyer_user_id, order_type, status,
                           subtotal_minor, grand_total_minor, paid_at, completed_at) values
  ('01110001-aaaa-4aaa-8aaa-011100000001', 'XTS', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001',
   'aaaaaaaa-1111-4111-8111-111111111111', 'bbbbbbbb-2222-4222-8222-222222222222', 'product', 'completed',
   30000, 30000, now(), now()),
  ('01110002-aaaa-4aaa-8aaa-011100000002', 'XTS', 'bbbb0002-aaaa-4aaa-8aaa-bbbb00000002',
   'aaaaaaaa-1111-4111-8111-111111111111', 'bbbbbbbb-2222-4222-8222-222222222222', 'product', 'paid',
   10000, 10000, now(), null),
  ('01110003-aaaa-4aaa-8aaa-011100000003', 'XTS', 'bbbb0003-aaaa-4aaa-8aaa-bbbb00000003',
   'aaaaaaaa-1111-4111-8111-111111111111', 'eeeeeeee-5555-4555-8555-555555555555', 'product', 'completed',
   20000, 20000, now(), now());

-- Eligibility ------------------------------------------------------------------------------------------
select ok(public.can_review_order('01110001-aaaa-4aaa-8aaa-011100000001', 'bbbbbbbb-2222-4222-8222-222222222222'),
  'a completed order the buyer owns can be reviewed');
select ok(
  not public.can_review_order('01110002-aaaa-4aaa-8aaa-011100000002', 'bbbbbbbb-2222-4222-8222-222222222222'),
  'an order that is only paid cannot'
);
select ok(
  not public.can_review_order('01110001-aaaa-4aaa-8aaa-011100000001', 'eeeeeeee-5555-4555-8555-555555555555'),
  'and somebody else''s order cannot be reviewed at all'
);

select throws_ok(
  $$select app_private.create_review('01110002-aaaa-4aaa-8aaa-011100000002',
      'bbbbbbbb-2222-4222-8222-222222222222', 5::smallint, 'Too soon', 'Not completed yet.')$$,
  '23001',
  null,
  'an order that has not completed earns no review'
);
select throws_ok(
  $$select app_private.create_review('01110001-aaaa-4aaa-8aaa-011100000001',
      'eeeeeeee-5555-4555-8555-555555555555', 5::smallint, 'Not mine', 'I did not buy this.')$$,
  '42501',
  null,
  'and only the buyer of an order may review it'
);

-- Writing a review -----------------------------------------------------------------------------------------
select lives_ok(
  $$select app_private.create_review('01110001-aaaa-4aaa-8aaa-011100000001',
      'bbbbbbbb-2222-4222-8222-222222222222', 5::smallint, 'Excellent', 'Arrived quickly and as described.')$$,
  'a completed order earns its review'
);
select is(
  (select format('%s/%s/%s', rating, status, seller_user_id) from public.reviews),
  '5/published/aaaaaaaa-1111-4111-8111-111111111111',
  'which is published and tied to the order''s seller');

select is(
  app_private.create_review('01110001-aaaa-4aaa-8aaa-011100000001',
    'bbbbbbbb-2222-4222-8222-222222222222', 3::smallint, 'Changed my mind', 'Second attempt.'),
  (select id from public.reviews where order_id = '01110001-aaaa-4aaa-8aaa-011100000001'),
  'writing it again returns the one already written (C10)'
);
select throws_ok(
  $$insert into public.reviews (order_id, seller_user_id, buyer_user_id, rating)
    values ('01110001-aaaa-4aaa-8aaa-011100000001', 'aaaaaaaa-1111-4111-8111-111111111111',
            'bbbbbbbb-2222-4222-8222-222222222222', 4)$$,
  '23505',
  null,
  'a duplicate is impossible at database level (D13)'
);

-- The composite keys are what tie a review to its order -------------------------------------------------------
select throws_ok(
  $$insert into public.reviews (order_id, seller_user_id, buyer_user_id, rating)
    values ('01110003-aaaa-4aaa-8aaa-011100000003', 'aaaaaaaa-1111-4111-8111-111111111111',
            'bbbbbbbb-2222-4222-8222-222222222222', 4)$$,
  '23503',
  null,
  'a review can never name a buyer who did not place the order'
);
select throws_ok(
  $$insert into public.reviews (order_id, seller_user_id, buyer_user_id, rating)
    values ('01110003-aaaa-4aaa-8aaa-011100000003', 'cccccccc-3333-4333-8333-333333333333',
            'eeeeeeee-5555-4555-8555-555555555555', 4)$$,
  '23503',
  null,
  'nor a seller who did not sell it'
);
select throws_ok(
  $$insert into public.reviews (order_id, seller_user_id, buyer_user_id, rating)
    values ('01110003-aaaa-4aaa-8aaa-011100000003', 'aaaaaaaa-1111-4111-8111-111111111111',
            'eeeeeeee-5555-4555-8555-555555555555', 9)$$,
  '23514',
  null,
  'and a rating outside one to five is refused'
);

-- Replies --------------------------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.reply_to_review(
      (select id from public.reviews), 'bbbbbbbb-2222-4222-8222-222222222222', 'Thanks!')$$,
  '42501',
  null,
  'only the seller a review is about may reply to it'
);
select lives_ok(
  $$select app_private.reply_to_review(
      (select id from public.reviews), 'aaaaaaaa-1111-4111-8111-111111111111', 'Thank you for the kind words.')$$,
  'the seller replies once'
);
select is(
  app_private.reply_to_review((select id from public.reviews), 'aaaaaaaa-1111-4111-8111-111111111111', 'Again'),
  (select id from public.review_replies),
  'and replying again returns the reply already there (C10)'
);
select is((select count(*) from public.review_replies), 1::bigint, 'so there is exactly one reply');

-- The derived rating --------------------------------------------------------------------------------------------
select is(
  (select format('%s/%s', review_count, average_rating_basis_points) from public.seller_ratings),
  '1/50000',
  'the seller rating is derived from published reviews, half-up in basis points');

insert into public.reviews (order_id, seller_user_id, buyer_user_id, rating, body)
values ('01110003-aaaa-4aaa-8aaa-011100000003', 'aaaaaaaa-1111-4111-8111-111111111111',
        'eeeeeeee-5555-4555-8555-555555555555', 4, 'Good, not perfect.');

select is(
  (select format('%s/%s', review_count, average_rating_basis_points) from public.seller_ratings),
  '2/45000',
  'and follows every published review');

-- A refund hides a review without destroying it ---------------------------------------------------------------------
update public.orders set status = 'refunded' where id = '01110003-aaaa-4aaa-8aaa-011100000003';

select is(
  public.review_publication_block('01110003-aaaa-4aaa-8aaa-011100000003'),
  'order_refunded',
  'a refunded order is a reason not to show its review'
);
select is(
  app_private.reassess_review_publication('01110003-aaaa-4aaa-8aaa-011100000003'),
  1,
  'reassessment acts on it'
);
select is(
  (select format('%s/%s', status, auto_hidden_reason) from public.reviews
    where order_id = '01110003-aaaa-4aaa-8aaa-011100000003'),
  'hidden/order_refunded',
  'the review is hidden and says why');
select is(
  (select review_count from public.seller_ratings),
  1::bigint,
  'the rating drops it while it is hidden'
);
select is((select count(*) from public.reviews), 2::bigint, 'but what the buyer said is still on the record');

update public.orders set status = 'completed' where id = '01110003-aaaa-4aaa-8aaa-011100000003';
select is(
  app_private.reassess_review_publication('01110003-aaaa-4aaa-8aaa-011100000003'),
  1,
  'and when the reason goes away the review comes back'
);
select is(
  (select status from public.reviews where order_id = '01110003-aaaa-4aaa-8aaa-011100000003'),
  'published',
  'published once more'
);

-- Moderation is the last word ------------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.moderate_review((select id from public.reviews where rating = 4), 'removed',
      'aaaaaaaa-1111-4111-8111-111111111111', 'I did not like it')$$,
  '42501',
  null,
  'nobody moderates a review they are a party to'
);
select throws_ok(
  $$select app_private.moderate_review((select id from public.reviews where rating = 4), 'removed',
      'dddddddd-4444-4444-8444-444444444444', '   ')$$,
  '23514',
  null,
  'and a decision without a reason is refused'
);

select is(
  app_private.moderate_review((select id from public.reviews where rating = 4), 'removed',
    'dddddddd-4444-4444-8444-444444444444', 'Abusive language'),
  'removed',
  'a moderator can remove a review, with the reason recorded'
);
update public.orders set status = 'refunded' where id = '01110003-aaaa-4aaa-8aaa-011100000003';
select is(
  app_private.reassess_review_publication('01110003-aaaa-4aaa-8aaa-011100000003'),
  0,
  'after which the automatic reassessment leaves it alone'
);
select is(
  (select status from public.reviews where rating = 4),
  'removed',
  'the moderator''s decision stands'
);

select * from finish();
rollback;
