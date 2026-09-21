-- pgTAP — migration 0027: reports and their triage, moderation actions and the listing trail, order
-- disputes, their thread and evidence, and the rule that nobody rules on their own case.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(39);

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
  ('eeeeeeee-5555-4555-8555-555555555555', 'stranger@example.test'),
  ('dddddddd-4444-4444-8444-444444444444', 'moderator@example.test');
insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status)
values ('aaaaaaaa-1111-4111-8111-111111111111', 'test-seller', 'Test Seller', 'ZZ', 'verified', now(), 'active');
insert into public.categories (id, slug) values ('11111111-aaaa-4aaa-8aaa-111111111111', 'electronics');
insert into public.listings (id, seller_user_id, listing_type_code, category_id, slug, title, description,
                             content_language, currency_code, price_minor, country_code, status, approved_at)
values ('99999999-aaaa-4aaa-8aaa-999999999999', 'aaaaaaaa-1111-4111-8111-111111111111', 'product',
        '11111111-aaaa-4aaa-8aaa-111111111111', 'blue-widget', 'Blue widget', 'A widget that is blue.',
        'zz', 'XTS', 20000, 'ZZ', 'active', now());

insert into public.checkouts (id, currency_code, buyer_user_id, subtotal_minor, grand_total_minor,
                              commission_snapshot, cancellation_policy_snapshot, status)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222', 20000, 20000,
        '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb, 'paid');
insert into public.orders (id, currency_code, checkout_id, seller_user_id, buyer_user_id, order_type, status,
                           subtotal_minor, grand_total_minor, paid_at, delivered_at)
values ('01110001-aaaa-4aaa-8aaa-011100000001', 'XTS', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001',
        'aaaaaaaa-1111-4111-8111-111111111111', 'bbbbbbbb-2222-4222-8222-222222222222', 'product', 'delivered',
        20000, 20000, now(), now());

-- Reports --------------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.file_report('bbbbbbbb-2222-4222-8222-222222222222', 'user',
      'bbbbbbbb-2222-4222-8222-222222222222', 'spam')$$,
  '23514',
  null,
  'a report cannot be about its own reporter'
);
select throws_ok(
  $$insert into public.reports (reporter_user_id, subject_type, subject_id, reason_code)
    values ('bbbbbbbb-2222-4222-8222-222222222222', 'planet', '99999999-aaaa-4aaa-8aaa-999999999999', 'spam')$$,
  '23514',
  null,
  'and only the listed subject kinds can be reported'
);

select lives_ok(
  $$select app_private.file_report('bbbbbbbb-2222-4222-8222-222222222222', 'listing',
      '99999999-aaaa-4aaa-8aaa-999999999999', 'counterfeit', 'This looks like a fake.')$$,
  'a user files a report'
);
select is(
  app_private.file_report('bbbbbbbb-2222-4222-8222-222222222222', 'listing',
    '99999999-aaaa-4aaa-8aaa-999999999999', 'counterfeit', 'Again'),
  (select id from public.reports),
  'filing the same report again lands on the one already open (C10)'
);
select is((select count(*) from public.reports), 1::bigint, 'so there is one report, not two');
select is((select status from public.reports), 'open', 'and it starts open');

select throws_ok(
  $$select app_private.resolve_report((select id from public.reports), 'dismissed',
      'bbbbbbbb-2222-4222-8222-222222222222', 'Never mind')$$,
  '42501',
  null,
  'nobody rules on their own report'
);
select throws_ok(
  $$select app_private.resolve_report((select id from public.reports), 'dismissed',
      'dddddddd-4444-4444-8444-444444444444', '  ')$$,
  '23514',
  null,
  'and a report is never closed without a reason'
);

select is(
  app_private.resolve_report((select id from public.reports), 'triaged',
    'dddddddd-4444-4444-8444-444444444444', null),
  'triaged',
  'triage moves a report on without closing it'
);
select is(
  (select resolved_at from public.reports),
  null,
  'so nothing is recorded as resolved yet'
);

-- Moderating the listing -------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.moderate_listing('99999999-aaaa-4aaa-8aaa-999999999999', 'suspend',
      'aaaaaaaa-1111-4111-8111-111111111111', 'I withdraw it')$$,
  '42501',
  null,
  'nobody moderates their own listing'
);
select throws_ok(
  $$select app_private.moderate_listing('99999999-aaaa-4aaa-8aaa-999999999999', 'suspend',
      'dddddddd-4444-4444-8444-444444444444', '')$$,
  '23514',
  null,
  'and a decision without a reason is refused'
);

select is(
  app_private.moderate_listing('99999999-aaaa-4aaa-8aaa-999999999999', 'suspend',
    'dddddddd-4444-4444-8444-444444444444', 'Counterfeit reported and confirmed',
    (select id from public.reports)),
  'suspended',
  'a moderator suspends the listing'
);
select is(
  (select status from public.listings where id = '99999999-aaaa-4aaa-8aaa-999999999999'),
  'suspended',
  'the listing moves'
);
select is(
  (select format('%s/%s/%s', action, from_status, to_status) from public.listing_moderation_actions),
  'suspend/active/suspended',
  'the listing trail records the move it made');
select is(
  (select count(*) from public.moderation_actions where subject_type = 'listing'),
  1::bigint,
  'and the generic trail records the decision too'
);
select is(
  (select report_id from public.listing_moderation_actions),
  (select id from public.reports),
  'both pointing back at the report that prompted it'
);
select ok(
  (select count(*) > 0 from public.listing_status_history where to_status = 'suspended'),
  '0011''s own status trail still records the move'
);

select throws_ok(
  $$update public.moderation_actions set reason = 'edited'$$,
  '23001',
  null,
  'moderation decisions are append-only'
);
select throws_ok(
  $$insert into public.moderation_actions (subject_type, subject_id, action, reason, moderator_user_id, expires_at)
    values ('listing', '99999999-aaaa-4aaa-8aaa-999999999999', 'remove', 'Gone', 'dddddddd-4444-4444-8444-444444444444',
            now() + interval '7 days')$$,
  '23514',
  null,
  'only a temporary measure carries an expiry'
);

select is(
  app_private.moderate_listing('99999999-aaaa-4aaa-8aaa-999999999999', 'reinstate',
    'dddddddd-4444-4444-8444-444444444444', 'Seller provided proof of authenticity'),
  'active',
  'and a reinstatement puts the listing back'
);

-- Closing the report ---------------------------------------------------------------------------------------
select is(
  app_private.resolve_report((select id from public.reports), 'actioned',
    'dddddddd-4444-4444-8444-444444444444', 'Listing suspended then reinstated after proof'),
  'actioned',
  'the report closes with its outcome'
);
select throws_ok(
  $$select app_private.resolve_report((select id from public.reports), 'dismissed',
      'dddddddd-4444-4444-8444-444444444444', 'Changed my mind')$$,
  '23001',
  null,
  'and a closed report cannot be reopened this way'
);

-- Disputes -------------------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.open_dispute('01110001-aaaa-4aaa-8aaa-011100000001',
      'eeeeeeee-5555-4555-8555-555555555555', 'not_received')$$,
  '42501',
  null,
  'only the buyer or the seller of an order may dispute it'
);
select throws_ok(
  $$select app_private.open_dispute('01110001-aaaa-4aaa-8aaa-011100000001',
      'bbbbbbbb-2222-4222-8222-222222222222', 'not_received', 'Nothing arrived', 99000)$$,
  '23514',
  null,
  'and a claim can never exceed the order'
);

select lives_ok(
  $$select app_private.open_dispute('01110001-aaaa-4aaa-8aaa-011100000001',
      'bbbbbbbb-2222-4222-8222-222222222222', 'not_received', 'Nothing arrived.', 20000)$$,
  'the buyer opens a dispute'
);
select is(
  (select status from public.orders where id = '01110001-aaaa-4aaa-8aaa-011100000001'),
  'disputed',
  'the order says it is in dispute, which is what keeps its earnings pending'
);
select is(
  (select order_status_before from public.disputes),
  'delivered',
  'and the dispute snapshots where the order came from'
);
select ok(public.order_has_open_dispute('01110001-aaaa-4aaa-8aaa-011100000001'),
  'the order reads back as disputed');
select is(
  app_private.open_dispute('01110001-aaaa-4aaa-8aaa-011100000001',
    'aaaaaaaa-1111-4111-8111-111111111111', 'other'),
  (select id from public.disputes),
  'a second attempt lands on the dispute already open (C10)'
);
select is(
  (select count(*) from public.dispute_messages),
  1::bigint,
  'the opening statement became the first message of the thread'
);

select throws_ok(
  $$select app_private.post_dispute_message((select id from public.disputes),
      'bbbbbbbb-2222-4222-8222-222222222222', 'A private note', true)$$,
  '42501',
  null,
  'only staff keep internal notes'
);
select lives_ok(
  $$select app_private.post_dispute_message((select id from public.disputes),
      'dddddddd-4444-4444-8444-444444444444', 'Chasing the courier.', true)$$,
  'staff may'
);
select is(
  (select author_role from public.dispute_messages where is_internal),
  'staff',
  'and the author''s role is worked out from the dispute, not trusted from an argument'
);

select throws_ok(
  $$insert into public.dispute_evidence (dispute_id, uploaded_by, object_path)
    values ((select id from public.disputes), 'bbbbbbbb-2222-4222-8222-222222222222', 'public/photo.jpg')$$,
  '23514',
  null,
  'evidence never lands outside the private bucket'
);

-- Resolving ------------------------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.resolve_dispute((select id from public.disputes), 'refund_buyer',
      'bbbbbbbb-2222-4222-8222-222222222222', 'I win', 20000)$$,
  '42501',
  null,
  'nobody resolves a dispute they are a party to'
);
select is(
  app_private.resolve_dispute((select id from public.disputes), 'partial_refund',
    'dddddddd-4444-4444-8444-444444444444', 'Item arrived late and damaged', 8000),
  'partial_refund',
  'staff resolve it with a reason'
);
select is(
  (select status from public.orders where id = '01110001-aaaa-4aaa-8aaa-011100000001'),
  'delivered',
  'and the order goes back where it was rather than being guessed at'
);
select ok(
  not public.order_has_open_dispute('01110001-aaaa-4aaa-8aaa-011100000001'),
  'the order is no longer in dispute'
);

select * from finish();
rollback;
