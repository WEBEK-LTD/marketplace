-- pgTAP — migration 0080: review moderation, the admin side (Phase 7-P).
--
-- What these assertions hold to account:
--
--   * **two keys, and the separation between them.** The queue and the detail need
--     `reviews.review.read`; the decision needs `reviews.review.moderate`; the trail needs
--     `moderation.action.read`, which is 0027's own key and neither of the other two. A colleague holding
--     one and not another is driven against every function, and each answers with nothing or with
--     `not_found` — never a row, never an error that says why.
--   * **every role that holds a review key is `requires_mfa`, so read is gated at aal2 too.** Each function
--     is driven by the right person at `aal1`, by a revoked grant and by an expired one.
--   * **the decision is 0026's, not this migration's.** All four statuses are recorded for real; the
--     party refusal is provoked by having the buyer and then the seller try; the reason requirement is
--     provoked three ways; and the writer's own effects — `auto_hidden_reason` cleared, `published_at`
--     moved only on publishing, `moderated_by` recorded, the outbox event enqueued once — are asserted on
--     the row rather than on a returned value.
--   * **no transition matrix is imposed**, because 0026 has none: every one of the sixteen ordered pairs is
--     driven, including re-recording the status a review already holds.
--   * **a moderator's decision is final against automation.** `reassess_review_publication` is called on a
--     refunded order's review before and after a decision, and leaves the moderated one alone.
--   * **no account identifier crosses.** Asserted on the result types: not one of the six functions returns
--     `buyer_user_id`, `seller_user_id`, `moderated_by`, `moderator_user_id` or `order_id`.
--   * **the reply is returned and cannot be changed** — the reported gap, asserted as a fact: nothing in
--     `app_private` writes `public.review_replies` except 0026's own insert.
--   * **the rating view is untouched**, and a removed review leaves it, which is 0026's rule and not this
--     migration's.
--
-- Deterministic: fixed uuids, explicit ages, and `with ordinality` wherever order matters. Everything runs
-- in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(165);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zp', 'Test locale', 'Test locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default,
                               is_pricing_enabled, is_checkout_enabled)
values ('XTP', '961', 'P', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code,
                              default_currency_code, is_marketplace_enabled)
values ('ZP', 'ZPP', '961', 'Enabled', 'Enabled', '961', 'XTP', true);

insert into auth.users (id, email) values
  ('fa000000-0000-4000-8000-000000000001', 'q-moderator@test.invalid'),
  ('fa000000-0000-4000-8000-000000000002', 'q-admin@test.invalid'),
  ('fa000000-0000-4000-8000-000000000003', 'q-support-agent@test.invalid'),
  ('fa000000-0000-4000-8000-000000000004', 'q-buyer@test.invalid'),
  ('fa000000-0000-4000-8000-000000000005', 'q-revoked-moderator@test.invalid'),
  ('fa000000-0000-4000-8000-000000000006', 'q-expired-moderator@test.invalid'),
  -- The seller, and a second buyer whose review nobody is a party to.
  ('fa000000-0000-4000-8000-000000000007', 'q-seller@test.invalid'),
  ('fa000000-0000-4000-8000-000000000008', 'q-other-buyer@test.invalid'),
  -- A moderator who is also a buyer, and one who is also the seller: the only way 0026's party refusal is
  -- reachable at all.
  ('fa000000-0000-4000-8000-000000000009', 'q-moderator-who-bought@test.invalid'),
  ('fa000000-0000-4000-8000-00000000000a', 'q-moderator-who-sells@test.invalid');

insert into public.user_roles (user_id, role_key, granted_at) values
  ('fa000000-0000-4000-8000-000000000001', 'moderator', now() - interval '10 days'),
  ('fa000000-0000-4000-8000-000000000002', 'admin', now() - interval '10 days'),
  ('fa000000-0000-4000-8000-000000000003', 'support_agent', now() - interval '10 days'),
  ('fa000000-0000-4000-8000-000000000004', 'buyer', now() - interval '10 days'),
  ('fa000000-0000-4000-8000-000000000009', 'moderator', now() - interval '10 days'),
  ('fa000000-0000-4000-8000-00000000000a', 'moderator', now() - interval '10 days');

insert into public.user_roles (user_id, role_key, granted_at, revoked_at) values
  ('fa000000-0000-4000-8000-000000000005', 'moderator', now() - interval '20 days', now() - interval '1 hour');
insert into public.user_roles (user_id, role_key, granted_at, expires_at) values
  ('fa000000-0000-4000-8000-000000000006', 'moderator', now() - interval '20 days', now() - interval '1 hour');

insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status,
                                    verified_at, status) values
  ('fa000000-0000-4000-8000-000000000007', 'q-shop', 'Canary Shop', 'ZP', 'verified', now(), 'active'),
  ('fa000000-0000-4000-8000-00000000000a', 'q-mod-shop', 'Moderator Shop', 'ZP', 'verified', now(), 'active');

create or replace function pg_temp.order_for(
  p_checkout uuid, p_order uuid, p_buyer uuid, p_seller uuid, p_status text
) returns void language plpgsql as $$
begin
  insert into public.checkouts (id, currency_code, buyer_user_id, subtotal_minor, grand_total_minor,
                                commission_snapshot, cancellation_policy_snapshot, status)
  values (p_checkout, 'XTP', p_buyer, 30000, 30000, '{"components":[]}'::jsonb,
          '{"buyer_window_hours":24}'::jsonb, 'paid');
  insert into public.orders (id, currency_code, checkout_id, seller_user_id, buyer_user_id, order_type,
                             status, subtotal_minor, grand_total_minor, paid_at, completed_at)
  values (p_order, 'XTP', p_checkout, p_seller, p_buyer, 'product', p_status, 30000, 30000,
          now() - interval '20 days',
          case when p_status in ('completed', 'refunded') then now() - interval '15 days' end);
end;
$$;

-- Five completed orders on the canary shop, one refunded, and two on moderator-owned parties.
select pg_temp.order_for('cf000001-0000-4000-8000-000000000001', '0f000001-0000-4000-8000-000000000001',
  'fa000000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-000000000007', 'completed');
select pg_temp.order_for('cf000002-0000-4000-8000-000000000002', '0f000002-0000-4000-8000-000000000002',
  'fa000000-0000-4000-8000-000000000008', 'fa000000-0000-4000-8000-000000000007', 'completed');
select pg_temp.order_for('cf000003-0000-4000-8000-000000000003', '0f000003-0000-4000-8000-000000000003',
  'fa000000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-000000000007', 'completed');
select pg_temp.order_for('cf000004-0000-4000-8000-000000000004', '0f000004-0000-4000-8000-000000000004',
  'fa000000-0000-4000-8000-000000000008', 'fa000000-0000-4000-8000-000000000007', 'completed');
-- Completed for now; refunded below, after its review exists. That order matters: 0026's eligibility
-- trigger requires a completed order to review, and a refund is something that happens afterwards — which
-- is exactly the situation the publication block exists for.
select pg_temp.order_for('cf000005-0000-4000-8000-000000000005', '0f000005-0000-4000-8000-000000000005',
  'fa000000-0000-4000-8000-000000000008', 'fa000000-0000-4000-8000-000000000007', 'completed');
-- The moderator bought this one.
select pg_temp.order_for('cf000006-0000-4000-8000-000000000006', '0f000006-0000-4000-8000-000000000006',
  'fa000000-0000-4000-8000-000000000009', 'fa000000-0000-4000-8000-000000000007', 'completed');
-- And this one is on the moderator's own storefront.
select pg_temp.order_for('cf000007-0000-4000-8000-000000000007', '0f000007-0000-4000-8000-000000000007',
  'fa000000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-00000000000a', 'completed');

/*
 * Reviews. `created_at` is set explicitly on each so "newest first" is a fact rather than a coin flip:
 * `now()` is transaction-stable, so rows written together would otherwise tie.
 */
create or replace function pg_temp.review(
  p_id uuid, p_order uuid, p_buyer uuid, p_seller uuid, p_rating integer, p_title text, p_body text,
  p_status text, p_age interval
) returns void language plpgsql as $$
begin
  insert into public.reviews (id, order_id, seller_user_id, buyer_user_id, rating, title, body, status,
                              published_at, created_at)
  values (p_id, p_order, p_seller, p_buyer, p_rating::smallint, p_title, p_body, p_status,
          now() - p_age, now() - p_age);
end;
$$;

select pg_temp.review('7e000001-0000-4000-8000-000000000001', '0f000001-0000-4000-8000-000000000001',
  'fa000000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-000000000007', 5,
  'Excellent', 'The canary arrived singing.', 'published', interval '5 days');
select pg_temp.review('7e000002-0000-4000-8000-000000000002', '0f000002-0000-4000-8000-000000000002',
  'fa000000-0000-4000-8000-000000000008', 'fa000000-0000-4000-8000-000000000007', 1,
  'Terrible', 'A body that a moderator will need to read in full.', 'published', interval '4 days');
-- No body at all: the queue reports whether there is prose without carrying it.
select pg_temp.review('7e000003-0000-4000-8000-000000000003', '0f000003-0000-4000-8000-000000000003',
  'fa000000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-000000000007', 3,
  null, null, 'published', interval '3 days');
select pg_temp.review('7e000004-0000-4000-8000-000000000004', '0f000004-0000-4000-8000-000000000004',
  'fa000000-0000-4000-8000-000000000008', 'fa000000-0000-4000-8000-000000000007', 2,
  'Hidden already', 'Something a moderator already looked at.', 'hidden', interval '2 days');
-- On the refunded order, so `review_publication_block` answers.
select pg_temp.review('7e000005-0000-4000-8000-000000000005', '0f000005-0000-4000-8000-000000000005',
  'fa000000-0000-4000-8000-000000000008', 'fa000000-0000-4000-8000-000000000007', 4,
  'Refunded order', 'The order behind this was refunded.', 'published', interval '1 day');
-- The moderator is the buyer on this one.
select pg_temp.review('7e000006-0000-4000-8000-000000000006', '0f000006-0000-4000-8000-000000000006',
  'fa000000-0000-4000-8000-000000000009', 'fa000000-0000-4000-8000-000000000007', 5,
  'Bought it myself', 'Written by somebody who also moderates.', 'published', interval '6 days');
-- And the seller on this one.
select pg_temp.review('7e000007-0000-4000-8000-000000000007', '0f000007-0000-4000-8000-000000000007',
  'fa000000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-00000000000a', 4,
  'On the moderator shop', 'Left on a storefront a moderator owns.', 'published', interval '7 days');

-- Now the refund, after the review it will affect. Nothing else in this file touches an order.
update public.orders set status = 'refunded' where id = '0f000005-0000-4000-8000-000000000005';

-- One seller reply, on the one-star review.
insert into public.review_replies (id, review_id, seller_user_id, body, created_at) values
  ('7d000001-0000-4000-8000-000000000001', '7e000002-0000-4000-8000-000000000002',
   'fa000000-0000-4000-8000-000000000007', 'The seller answer that a moderator can read.',
   now() - interval '3 days');

-- A moderation action against one review, so the trail has something to read. It is 0027's own table.
insert into public.moderation_actions (id, subject_type, subject_id, action, reason, notes,
                                       moderator_user_id, created_at) values
  ('7c000001-0000-4000-8000-000000000001', 'review', '7e000004-0000-4000-8000-000000000004',
   'hide', 'Contained a phone number.', 'A note only staff read.',
   'fa000000-0000-4000-8000-000000000002', now() - interval '2 days');

create or replace function pg_temp.mod() returns uuid language sql immutable as $$
  select 'fa000000-0000-4000-8000-000000000001'::uuid;
$$;

create or replace function pg_temp.decide(
  p_actor uuid, p_review uuid, p_status text, p_reason text default 'A reason.'
) returns text language sql as $$
  select outcome from app_private.review_moderate_for_staff(p_actor, true, p_review, p_status, p_reason);
$$;

create or replace function pg_temp.status_of(p_review uuid) returns text language sql as $$
  select status from public.reviews where id = p_review;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 1. The two predicates
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.review_can_read(pg_temp.mod(), true),
  'a moderator holds reviews.review.read at aal2');
select ok(app_private.review_can_moderate(pg_temp.mod(), true),
  'and reviews.review.moderate');
select ok(app_private.review_can_read('fa000000-0000-4000-8000-000000000002', true),
  'an admin holds the read key');
select ok(app_private.review_can_moderate('fa000000-0000-4000-8000-000000000002', true),
  'and the moderate key');
select ok(not app_private.review_can_read('fa000000-0000-4000-8000-000000000003', true),
  'a support agent holds neither — 0033 gives it no review key at all');
select ok(not app_private.review_can_moderate('fa000000-0000-4000-8000-000000000003', true),
  'confirmed on the moderate key');
select ok(not app_private.review_can_read('fa000000-0000-4000-8000-000000000004', true),
  'a buyer holds neither');
select ok(not app_private.review_can_moderate('fa000000-0000-4000-8000-000000000004', true),
  'confirmed on the moderate key');
select ok(not app_private.review_can_read(pg_temp.mod(), false),
  'a moderator at aal1 holds no read — the role requires MFA');
select ok(not app_private.review_can_moderate(pg_temp.mod(), false),
  'nor moderate');
select ok(not app_private.review_can_read('fa000000-0000-4000-8000-000000000005', true),
  'a revoked moderator holds nothing');
select ok(not app_private.review_can_read('fa000000-0000-4000-8000-000000000006', true),
  'nor an expired one');
select ok(not app_private.review_can_moderate('fa000000-0000-4000-8000-000000000005', true),
  'confirmed for revoked on the moderate key');
select ok(not app_private.review_can_read(null, true), 'nor nobody');
select ok(not app_private.review_can_moderate(null, true), 'confirmed for nobody');

-- ---------------------------------------------------------------------------------------------------
-- 2. The queue
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(pg_temp.mod(), true, 51)),
  7, 'a moderator reads all seven reviews');

select is(
  (select array_agg(id::text order by ord) from (
     select id, ord from app_private.review_queue_for_staff(pg_temp.mod(), true, 51) with ordinality as t(
       id, rating, title, status, has_body, auto_hidden_reason, is_moderated, moderated_by_me, is_party,
       seller_slug, seller_display_name, has_reply, reply_status, created_at, ord)) s),
  array['7e000005-0000-4000-8000-000000000005', '7e000004-0000-4000-8000-000000000004',
        '7e000003-0000-4000-8000-000000000003', '7e000002-0000-4000-8000-000000000002',
        '7e000001-0000-4000-8000-000000000001', '7e000006-0000-4000-8000-000000000006',
        '7e000007-0000-4000-8000-000000000007'],
  'the queue is newest first');

select is(
  (select rating from app_private.review_queue_for_staff(pg_temp.mod(), true, 51)
    where id = '7e000002-0000-4000-8000-000000000002'),
  1::smallint, 'a row carries the rating');
select is(
  (select title from app_private.review_queue_for_staff(pg_temp.mod(), true, 51)
    where id = '7e000002-0000-4000-8000-000000000002'),
  'Terrible', 'and the title');
select ok(
  (select has_body from app_private.review_queue_for_staff(pg_temp.mod(), true, 51)
    where id = '7e000002-0000-4000-8000-000000000002'),
  'and says there is prose to read');
select ok(
  (select not has_body from app_private.review_queue_for_staff(pg_temp.mod(), true, 51)
    where id = '7e000003-0000-4000-8000-000000000003'),
  'and says when there is none');
select is(
  (select seller_slug from app_private.review_queue_for_staff(pg_temp.mod(), true, 51)
    where id = '7e000002-0000-4000-8000-000000000002'),
  'q-shop', 'the storefront is named by its slug');
select is(
  (select seller_display_name from app_private.review_queue_for_staff(pg_temp.mod(), true, 51)
    where id = '7e000002-0000-4000-8000-000000000002'),
  'Canary Shop', 'and its display name');
select ok(
  (select has_reply from app_private.review_queue_for_staff(pg_temp.mod(), true, 51)
    where id = '7e000002-0000-4000-8000-000000000002'),
  'a review with a reply says so');
select is(
  (select reply_status from app_private.review_queue_for_staff(pg_temp.mod(), true, 51)
    where id = '7e000002-0000-4000-8000-000000000002'),
  'published', 'with the reply''s own state');
select ok(
  (select not has_reply from app_private.review_queue_for_staff(pg_temp.mod(), true, 51)
    where id = '7e000001-0000-4000-8000-000000000001'),
  'and one without says so');
select is(
  (select reply_status from app_private.review_queue_for_staff(pg_temp.mod(), true, 51)
    where id = '7e000001-0000-4000-8000-000000000001'),
  null, 'with no reply state at all');

-- The party flags, which 0026's refusal makes necessary.
select ok(
  (select is_party from app_private.review_queue_for_staff(
     'fa000000-0000-4000-8000-000000000009', true, 51)
    where id = '7e000006-0000-4000-8000-000000000006'),
  'a moderator who bought the order is flagged as a party to that review');
select ok(
  (select not is_party from app_private.review_queue_for_staff(pg_temp.mod(), true, 51)
    where id = '7e000006-0000-4000-8000-000000000006'),
  'and a colleague who is not, is not');
select ok(
  (select is_party from app_private.review_queue_for_staff(
     'fa000000-0000-4000-8000-00000000000a', true, 51)
    where id = '7e000007-0000-4000-8000-000000000007'),
  'a moderator who owns the storefront is flagged too');

-- Filters, paging and clamping.
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(pg_temp.mod(), true, 51, 'hidden')),
  1, 'the status filter narrows to the hidden review');
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(pg_temp.mod(), true, 51, 'published')),
  6, 'and to the published ones');
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(pg_temp.mod(), true, 51, 'not_a_status')),
  0, 'an unknown status matches nothing rather than being interpolated');
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(pg_temp.mod(), true, 2)),
  2, 'the limit is honoured');
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(pg_temp.mod(), true, 0)),
  1, 'a limit of zero is clamped up to one');
select ok(
  (select count(*) from app_private.review_queue_for_staff(pg_temp.mod(), true, 9999)) <= 51,
  'and a huge one is clamped down');
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(
     pg_temp.mod(), true, 51, null,
     (select created_at from public.reviews where id = '7e000005-0000-4000-8000-000000000005'),
     '7e000005-0000-4000-8000-000000000005')),
  6, 'the cursor continues after the newest review, without repeating it');
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(
     pg_temp.mod(), true, 51, null,
     (select created_at from public.reviews where id = '7e000007-0000-4000-8000-000000000007'),
     '7e000007-0000-4000-8000-000000000007')),
  0, 'and past the oldest returns nothing');

-- Who may read it.
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(
     'fa000000-0000-4000-8000-000000000002', true, 51)),
  7, 'an admin reads the queue');
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(
     'fa000000-0000-4000-8000-000000000003', true, 51)),
  0, 'a support agent reads no review');
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(
     'fa000000-0000-4000-8000-000000000004', true, 51)),
  0, 'nor a buyer');
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(
     'fa000000-0000-4000-8000-000000000007', true, 51)),
  0, 'nor the seller whose storefront they are on');
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(pg_temp.mod(), false, 51)),
  0, 'nor a moderator at aal1');
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(
     'fa000000-0000-4000-8000-000000000005', true, 51)),
  0, 'nor a revoked moderator');
select is(
  (select count(*)::integer from app_private.review_queue_for_staff(null, true, 51)),
  0, 'nor nobody');

-- ---------------------------------------------------------------------------------------------------
-- 3. One review
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.review_for_staff(
     pg_temp.mod(), true, '7e000002-0000-4000-8000-000000000002')),
  'found', 'a moderator reads one review');
select is(
  (select body from app_private.review_for_staff(
     pg_temp.mod(), true, '7e000002-0000-4000-8000-000000000002')),
  'A body that a moderator will need to read in full.', 'with the whole body');
select is(
  (select reply_body from app_private.review_for_staff(
     pg_temp.mod(), true, '7e000002-0000-4000-8000-000000000002')),
  'The seller answer that a moderator can read.', 'and the seller''s reply beside it');
select is(
  (select reply_status from app_private.review_for_staff(
     pg_temp.mod(), true, '7e000002-0000-4000-8000-000000000002')),
  'published', 'with the reply''s state');
select is(
  (select reply_body from app_private.review_for_staff(
     pg_temp.mod(), true, '7e000001-0000-4000-8000-000000000001')),
  null, 'a review with no reply carries none');
select ok(
  (select can_moderate from app_private.review_for_staff(
     pg_temp.mod(), true, '7e000002-0000-4000-8000-000000000002')),
  'the detail reports whether this caller may record a decision');
select is(
  (select seller_status from app_private.review_for_staff(
     pg_temp.mod(), true, '7e000002-0000-4000-8000-000000000002')),
  'active', 'and the storefront''s own standing');

-- 0026's publication block, reported so a moderator sees what they would override.
select is(
  (select publication_block from app_private.review_for_staff(
     pg_temp.mod(), true, '7e000005-0000-4000-8000-000000000005')),
  'order_refunded', 'a review on a refunded order reports why automation would hide it');
select is(
  (select publication_block from app_private.review_for_staff(
     pg_temp.mod(), true, '7e000001-0000-4000-8000-000000000001')),
  null, 'and one with nothing against it reports nothing');

select ok(
  (select is_party from app_private.review_for_staff(
     'fa000000-0000-4000-8000-000000000009', true, '7e000006-0000-4000-8000-000000000006')),
  'the detail flags a caller who is a party');
select ok(
  (select not is_party from app_private.review_for_staff(
     pg_temp.mod(), true, '7e000006-0000-4000-8000-000000000006')),
  'and one who is not');

-- Absence, the wrong key and aal1 are one answer.
select is(
  (select outcome from app_private.review_for_staff(
     pg_temp.mod(), true, '7e000000-0000-4000-8000-0000000000ff')),
  'not_found', 'a review that never existed is not_found');
select is(
  (select outcome from app_private.review_for_staff(
     'fa000000-0000-4000-8000-000000000003', true, '7e000002-0000-4000-8000-000000000002')),
  'not_found', 'a support agent gets the same answer for one that does');
select is(
  (select outcome from app_private.review_for_staff(
     'fa000000-0000-4000-8000-000000000004', true, '7e000002-0000-4000-8000-000000000002')),
  'not_found', 'and so does a buyer');
select is(
  (select outcome from app_private.review_for_staff(
     pg_temp.mod(), false, '7e000002-0000-4000-8000-000000000002')),
  'not_found', 'and so does a moderator at aal1');
select is(
  (select body from app_private.review_for_staff(
     'fa000000-0000-4000-8000-000000000003', true, '7e000002-0000-4000-8000-000000000002')),
  null, 'a refused read carries no body');
select is(
  (select reply_body from app_private.review_for_staff(
     'fa000000-0000-4000-8000-000000000003', true, '7e000002-0000-4000-8000-000000000002')),
  null, 'and no reply');
select is(
  (select outcome from app_private.review_for_staff(pg_temp.mod(), true, null)),
  'not_found', 'no review id is not_found');

-- ---------------------------------------------------------------------------------------------------
-- 4. The moderation trail, behind 0027's own key
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_private.review_moderation_actions(
     pg_temp.mod(), true, '7e000004-0000-4000-8000-000000000004', 51)),
  1, 'a moderator reads the action recorded against that review');
select is(
  (select action from app_private.review_moderation_actions(
     pg_temp.mod(), true, '7e000004-0000-4000-8000-000000000004', 51)),
  'hide', 'with the action taken');
select is(
  (select reason from app_private.review_moderation_actions(
     pg_temp.mod(), true, '7e000004-0000-4000-8000-000000000004', 51)),
  'Contained a phone number.', 'and the reason');
select ok(
  (select not is_own_action from app_private.review_moderation_actions(
     pg_temp.mod(), true, '7e000004-0000-4000-8000-000000000004', 51)),
  'and says whether it was the reader''s own, without naming the colleague');
select ok(
  (select is_own_action from app_private.review_moderation_actions(
     'fa000000-0000-4000-8000-000000000002', true, '7e000004-0000-4000-8000-000000000004', 51)),
  'which for the colleague who took it, it was');
select is(
  (select count(*)::integer from app_private.review_moderation_actions(
     pg_temp.mod(), true, '7e000001-0000-4000-8000-000000000001', 51)),
  0, 'a review with no action has an empty trail');
select is(
  (select count(*)::integer from app_private.review_moderation_actions(
     'fa000000-0000-4000-8000-000000000003', true, '7e000004-0000-4000-8000-000000000004', 51)),
  0, 'a support agent reads no trail');
select is(
  (select count(*)::integer from app_private.review_moderation_actions(
     pg_temp.mod(), false, '7e000004-0000-4000-8000-000000000004', 51)),
  0, 'nor a moderator at aal1');
select is(
  (select count(*)::integer from app_private.review_moderation_actions(
     pg_temp.mod(), true, '7e000004-0000-4000-8000-000000000004', 0)),
  1, 'a limit of zero is clamped up to one');

-- ---------------------------------------------------------------------------------------------------
-- 5. Authorization on the decision
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.decide('fa000000-0000-4000-8000-000000000003', '7e000001-0000-4000-8000-000000000001', 'hidden'),
  'not_found', 'a support agent cannot moderate a review');
select is(pg_temp.decide('fa000000-0000-4000-8000-000000000004', '7e000001-0000-4000-8000-000000000001', 'hidden'),
  'not_found', 'nor can a buyer');
select is(pg_temp.decide('fa000000-0000-4000-8000-000000000007', '7e000001-0000-4000-8000-000000000001', 'hidden'),
  'not_found', 'nor the seller');
select is(pg_temp.decide('fa000000-0000-4000-8000-000000000005', '7e000001-0000-4000-8000-000000000001', 'hidden'),
  'not_found', 'nor a revoked moderator');
select is(pg_temp.decide('fa000000-0000-4000-8000-000000000006', '7e000001-0000-4000-8000-000000000001', 'hidden'),
  'not_found', 'nor an expired one');
select is(
  (select outcome from app_private.review_moderate_for_staff(
     pg_temp.mod(), false, '7e000001-0000-4000-8000-000000000001', 'hidden', 'A reason.')),
  'not_found', 'nor a moderator at aal1');
select is(pg_temp.decide(null, '7e000001-0000-4000-8000-000000000001', 'hidden'),
  'not_found', 'nor nobody');
select is(pg_temp.status_of('7e000001-0000-4000-8000-000000000001'), 'published',
  'and none of those seven refusals moved the review');

select is(pg_temp.decide(pg_temp.mod(), '7e000000-0000-4000-8000-0000000000ff', 'hidden'),
  'not_found', 'a review that never existed is not_found');
select is(
  (select outcome from app_private.review_moderate_for_staff(
     'fa000000-0000-4000-8000-000000000003', true, '7e000001-0000-4000-8000-000000000001', 'hidden', 'A reason.')),
  (select outcome from app_private.review_moderate_for_staff(
     pg_temp.mod(), true, '7e000000-0000-4000-8000-0000000000ff', 'hidden', 'A reason.')),
  'and a caller without the key gets the identical outcome for one that exists');

-- 0026's party refusal, provoked from both sides.
select is(pg_temp.decide('fa000000-0000-4000-8000-000000000009', '7e000006-0000-4000-8000-000000000006', 'hidden'),
  'is_party', 'a moderator who bought the order cannot moderate that review');
select is(pg_temp.decide('fa000000-0000-4000-8000-00000000000a', '7e000007-0000-4000-8000-000000000007', 'hidden'),
  'is_party', 'and neither can one who owns the storefront');
select is(pg_temp.status_of('7e000006-0000-4000-8000-000000000006'), 'published',
  'and neither review moved');
select is(pg_temp.status_of('7e000007-0000-4000-8000-000000000007'), 'published', 'confirmed on the second');
-- A colleague who is not a party may moderate the very same reviews.
select is(pg_temp.decide(pg_temp.mod(), '7e000006-0000-4000-8000-000000000006', 'hidden', 'By a colleague.'),
  'moderated', 'a colleague who is not a party may moderate it');

-- ---------------------------------------------------------------------------------------------------
-- 6. The status value and the reason
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.decide(pg_temp.mod(), '7e000001-0000-4000-8000-000000000001', 'deleted'),
  'invalid', 'a status outside 0026''s four is refused');
select is(pg_temp.decide(pg_temp.mod(), '7e000001-0000-4000-8000-000000000001', 'PUBLISHED'),
  'invalid', 'and so is one that differs only in case');
select is(pg_temp.decide(pg_temp.mod(), '7e000001-0000-4000-8000-000000000001', ''),
  'invalid', 'and so is an empty one');
select is(pg_temp.decide(pg_temp.mod(), '7e000001-0000-4000-8000-000000000001', null),
  'invalid', 'and so is none');

select is(pg_temp.decide(pg_temp.mod(), '7e000001-0000-4000-8000-000000000001', 'hidden', null),
  'reason_required', 'a decision with no reason is refused');
select is(pg_temp.decide(pg_temp.mod(), '7e000001-0000-4000-8000-000000000001', 'hidden', '   '),
  'reason_required', 'and so is one with only whitespace');
select is(pg_temp.decide(pg_temp.mod(), '7e000001-0000-4000-8000-000000000001', 'hidden', ''),
  'reason_required', 'and so is an empty one');
select is(pg_temp.status_of('7e000001-0000-4000-8000-000000000001'), 'published',
  'and none of those seven moved the review');
select is(
  (select moderation_reason from public.reviews where id = '7e000001-0000-4000-8000-000000000001'),
  null, 'nor recorded a reason on it');

-- ---------------------------------------------------------------------------------------------------
-- 7. All four statuses, recorded for real
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.decide(pg_temp.mod(), '7e000001-0000-4000-8000-000000000001', 'hidden', '  Contained a phone number.  '),
  'moderated', 'a review is hidden');
select is(pg_temp.status_of('7e000001-0000-4000-8000-000000000001'), 'hidden', 'the review is hidden');
select is(
  (select moderation_reason from public.reviews where id = '7e000001-0000-4000-8000-000000000001'),
  'Contained a phone number.', 'the reason is recorded, trimmed');
select ok(
  (select moderated_at is not null from public.reviews where id = '7e000001-0000-4000-8000-000000000001'),
  'and the time it was recorded');
select is(
  (select moderated_by from public.reviews where id = '7e000001-0000-4000-8000-000000000001'),
  pg_temp.mod(), 'and who recorded it');

select is(pg_temp.decide(pg_temp.mod(), '7e000001-0000-4000-8000-000000000001', 'removed', 'Worse on a second look.'),
  'moderated', 'and then removed');
select is(pg_temp.status_of('7e000001-0000-4000-8000-000000000001'), 'removed', 'the review is removed');
select is(pg_temp.decide(pg_temp.mod(), '7e000001-0000-4000-8000-000000000001', 'pending_moderation', 'Needs a second opinion.'),
  'moderated', 'and put back for a second opinion');
select is(pg_temp.status_of('7e000001-0000-4000-8000-000000000001'), 'pending_moderation',
  'the review is pending moderation');
select is(pg_temp.decide(pg_temp.mod(), '7e000001-0000-4000-8000-000000000001', 'published', 'Cleared on review.'),
  'moderated', 'and published again');
select is(pg_temp.status_of('7e000001-0000-4000-8000-000000000001'), 'published', 'the review is published');

-- 0026's own effects, asserted on the row.
select ok(
  (select published_at > created_at from public.reviews where id = '7e000001-0000-4000-8000-000000000001'),
  'publishing moved published_at, which is 0026''s rule and not this migration''s');
select is(
  (select auto_hidden_reason from public.reviews where id = '7e000001-0000-4000-8000-000000000001'),
  null, 'and every decision cleared the automatic hiding reason');

-- Re-recording the same status is accepted: 0026 has no transition matrix, so none is imposed.
select is(pg_temp.decide(pg_temp.mod(), '7e000001-0000-4000-8000-000000000001', 'published', 'Re-affirmed.'),
  'moderated', 'the status a review already holds may be re-recorded, with a fresh reason');
select is(
  (select moderation_reason from public.reviews where id = '7e000001-0000-4000-8000-000000000001'),
  'Re-affirmed.', 'and the new reason stands');

-- Every one of the sixteen ordered pairs is reachable, which is what "no matrix" means.
select is(
  (select count(*)::integer from (
     select pg_temp.decide(pg_temp.mod(), '7e000003-0000-4000-8000-000000000003', s.target,
                           'Walking every pair.') as outcome
       from unnest(array['published', 'pending_moderation', 'hidden', 'removed',
                         'published', 'hidden', 'pending_moderation', 'removed',
                         'published', 'removed', 'hidden', 'published',
                         'pending_moderation', 'published', 'removed', 'pending_moderation']) as s(target)
   ) r where r.outcome <> 'moderated'),
  0, 'all sixteen ordered status pairs are accepted, because 0026 imposes no matrix');

-- ---------------------------------------------------------------------------------------------------
-- 8. A decision is final against automation
-- ---------------------------------------------------------------------------------------------------
select is(
  (select auto_hidden_reason from public.reviews where id = '7e000005-0000-4000-8000-000000000005'),
  null, 'the review on the refunded order starts with no automatic reason');
select is(app_private.reassess_review_publication('0f000005-0000-4000-8000-000000000005'), 1,
  'the automatic reassessment hides it, because its order was refunded');
select is(pg_temp.status_of('7e000005-0000-4000-8000-000000000005'), 'hidden', 'so it is hidden');
select is(
  (select auto_hidden_reason from public.reviews where id = '7e000005-0000-4000-8000-000000000005'),
  'order_refunded', 'with the reason automation recorded');

select is(pg_temp.decide(pg_temp.mod(), '7e000005-0000-4000-8000-000000000005', 'published', 'Judged on its content.'),
  'moderated', 'a moderator publishes it anyway');
select is(
  (select auto_hidden_reason from public.reviews where id = '7e000005-0000-4000-8000-000000000005'),
  null, 'which clears the automatic reason');
select is(app_private.reassess_review_publication('0f000005-0000-4000-8000-000000000005'), 0,
  'and the reassessment now leaves it alone, because a human has ruled');
select is(pg_temp.status_of('7e000005-0000-4000-8000-000000000005'), 'published',
  'so the moderator''s decision stands');

-- ---------------------------------------------------------------------------------------------------
-- 9. The outbox event, and no second one
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.outbox_events
    where aggregate_type = 'review' and aggregate_id = '7e000002-0000-4000-8000-000000000002'
      and event_type = 'review.moderated'),
  0, 'no event exists for a review nobody has ruled on');
select is(pg_temp.decide(pg_temp.mod(), '7e000002-0000-4000-8000-000000000002', 'hidden', 'For the event count.'),
  'moderated', 'one decision');
select is(
  (select count(*)::integer from public.outbox_events
    where aggregate_type = 'review' and aggregate_id = '7e000002-0000-4000-8000-000000000002'
      and event_type = 'review.moderated'),
  1, 'enqueues exactly one review.moderated event — 0026''s writer, and no second from this migration');
select is(
  (select count(*)::integer from public.outbox_events
    where aggregate_type = 'review' and event_type <> 'review.moderated'),
  0, 'and no event type this increment invented');
select is(
  (select count(*)::integer from public.security_events where event_type like 'review%'),
  0, 'no security event was written, and no vocabulary extended');

-- The audit trail is 0026's trigger's.
select ok(
  (select count(*) from audit.audit_logs
    where table_schema = 'public' and table_name = 'reviews'
      and record_id = '7e000002-0000-4000-8000-000000000002') > 0,
  'the change is recorded in the audit trail by 0026''s own trigger');
select ok(
  (select bool_or('status' = any (changed_columns)) from audit.audit_logs
    where table_schema = 'public' and table_name = 'reviews'
      and record_id = '7e000002-0000-4000-8000-000000000002'),
  'naming the status column as one that changed');

-- ---------------------------------------------------------------------------------------------------
-- 10. The rating view, untouched
-- ---------------------------------------------------------------------------------------------------
-- 0026's own rule: the aggregate counts published reviews only, and it is a view so it cannot drift.
-- Nothing in this migration recomputes it, and hiding a review changes it only through that definition.
select ok(
  (select review_count from public.seller_ratings
    where seller_user_id = 'fa000000-0000-4000-8000-000000000007') > 0,
  'the canary shop has a rating derived from its published reviews');
select is(
  (select review_count::integer from public.seller_ratings
    where seller_user_id = 'fa000000-0000-4000-8000-000000000007'),
  (select count(*)::integer from public.reviews
    where seller_user_id = 'fa000000-0000-4000-8000-000000000007' and status = 'published'),
  'and it counts exactly the published ones, by the view''s own definition');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('review_queue_for_staff', 'review_for_staff', 'review_moderate_for_staff',
                        'review_moderation_actions')
      and (p.prosrc like '%seller_ratings%' or p.prosrc like '%avg(%' or p.prosrc like '%sum(r.rating%')),
  0, 'and no function in this migration recomputes a rating');

-- ---------------------------------------------------------------------------------------------------
-- 11. What the six result types do not carry
-- ---------------------------------------------------------------------------------------------------
create or replace function pg_temp.result_columns(p_name text) returns text
language sql stable as $$
  select coalesce(string_agg(lower(a.attname), ',' order by a.attname), '')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join lateral unnest(coalesce(p.proallargtypes, array[]::oid[]))
      with ordinality as t(typ, ord) on true
    join lateral unnest(coalesce(p.proargnames, array[]::text[]))
      with ordinality as a(attname, ord2) on a.ord2 = t.ord
    join lateral unnest(coalesce(p.proargmodes, array[]::"char"[]))
      with ordinality as m(mode, ord3) on m.ord3 = t.ord
   where n.nspname = 'app_private' and p.proname = p_name and m.mode in ('o', 't');
$$;

select is(
  (select count(*)::integer from unnest(array[
     'review_queue_for_staff', 'review_for_staff', 'review_moderate_for_staff',
     'review_moderation_actions']) as f(name)
    where pg_temp.result_columns(f.name) = ''),
  0, 'all four result types are readable, so the absences below are absences');

select ok(pg_temp.result_columns('review_queue_for_staff') not like '%buyer%',
  'the queue names no buyer');
select ok(pg_temp.result_columns('review_queue_for_staff') not like '%seller_user_id%',
  'and no seller account — the storefront is a slug');
select ok(pg_temp.result_columns('review_queue_for_staff') not like '%moderated_by,%',
  'and no colleague who ruled');
select ok(pg_temp.result_columns('review_queue_for_staff') not like '%order%',
  'and no order');
-- Exact rather than a substring: `has_body` itself contains the word, and it is the flag this is about.
select ok(',' || pg_temp.result_columns('review_queue_for_staff') || ',' not like '%,body,%',
  'and not the body itself, only whether there is one');
select ok(pg_temp.result_columns('review_queue_for_staff') like '%has_body%',
  'which it reports as a flag');

select ok(pg_temp.result_columns('review_for_staff') not like '%buyer%',
  'the detail names no buyer');
select ok(pg_temp.result_columns('review_for_staff') not like '%seller_user_id%',
  'and no seller account');
select ok(pg_temp.result_columns('review_for_staff') not like '%order%',
  'and no order — only the publication block it produced');
select ok(pg_temp.result_columns('review_for_staff') like '%publication_block%',
  'which it does report');
select ok(pg_temp.result_columns('review_for_staff') not like '%moderated_by,%',
  'and no colleague who ruled, only whether it was the reader');
select ok(pg_temp.result_columns('review_for_staff') like '%moderated_by_me%',
  'confirmed');

select ok(pg_temp.result_columns('review_moderation_actions') not like '%moderator%',
  'the trail names no moderator');
select ok(pg_temp.result_columns('review_moderation_actions') like '%is_own_action%',
  'only whether an action was the reader''s own');

-- ---------------------------------------------------------------------------------------------------
-- 12. The reported gap: no writer for a review reply
-- ---------------------------------------------------------------------------------------------------
-- If somebody later adds one without an owner decision on the rules, this is what fails.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.prosrc ~* 'update\s+public\.review_replies'
        or p.prosrc ~* 'delete\s+from\s+public\.review_replies')),
  0, 'no app_private function updates or deletes public.review_replies — moderating a reply has no writer');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.prosrc ~* 'insert\s+into\s+public\.review_replies'),
  1, 'exactly one function inserts one, and it is 0026''s seller-side reply_to_review');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like '%review_reply%'),
  0, 'and there is no function named for moderating a reply at all');

-- The computed rule that makes the gap narrower than it looks: a reply is publicly readable only while its
-- parent review is published, so hiding a review already hides the reply with no reply row written.
select ok(
  (select pg_get_expr(p.polqual, p.polrelid) like '%r.status = ''published''%'
     from pg_policy p
    where p.polrelid = 'public.review_replies'::regclass
      and p.polname = 'review_replies_public_read'),
  'a reply is publicly readable only while its parent review is published');
select is(
  (select status from public.review_replies where id = '7d000001-0000-4000-8000-000000000001'),
  'published',
  'so the reply on the review hidden above is still `published` in its own row, and invisible anyway');

-- ---------------------------------------------------------------------------------------------------
-- 13. The boundary
-- ---------------------------------------------------------------------------------------------------
create or replace function pg_temp.names() returns setof text language sql stable as $$
  values ('review_can_read'), ('review_can_moderate'), ('review_queue_for_staff'), ('review_for_staff'),
         ('review_moderation_actions'), ('review_moderate_for_staff');
$$;

select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())),
  6, 'all six functions exist');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and not p.prosecdef),
  0, 'every one is SECURITY DEFINER');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and not coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog, public']),
  0, 'every one pins its search_path');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and (has_function_privilege('public', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('app_worker', p.oid, 'execute'))),
  0, 'none is executable by public, authenticated or app_worker');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and not has_function_privilege('app_system', p.oid, 'execute')),
  0, 'and every one is executable by app_system');

select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and (p.prosrc like '%''super_admin''%' or p.prosrc like '%''support_agent''%'
        or p.prosrc like '%''moderator''%' or p.prosrc like '%''admin''%')),
  0, 'not one of them names a role');

-- The readers read, and the one writer writes through 0026 rather than to the table.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('review_queue_for_staff', 'review_for_staff', 'review_moderation_actions')
      and (p.prosrc ~* '\minsert\s+into\m' or p.prosrc ~* '\mupdate\s+public\.'
        or p.prosrc ~* '\mdelete\s+from\m')),
  0, 'not one of the three readers writes anything');
-- Statement forms, not words: `prosrc` carries the function's own comments, and one of them names
-- `audit.audit_logs` precisely to say that the trigger writes it rather than this function.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'review_moderate_for_staff'
      and (p.prosrc ~* 'update\s+public\.reviews\s+set'
        or p.prosrc ~* 'insert\s+into\s+audit\.'
        or p.prosrc ~* 'insert\s+into\s+public\.'
        or p.prosrc ~* 'perform\s+public\.enqueue_outbox_event')),
  0, 'and the writer updates no table, enqueues no event and writes no audit row: it delegates to 0026');
select ok(
  (select p.prosrc like '%app_private.moderate_review(%' from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'review_moderate_for_staff'),
  'which it does by calling moderate_review');

-- ---------------------------------------------------------------------------------------------------
-- 14. 0026's own behaviour is preserved
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from pg_policy p where p.polrelid = 'public.reviews'::regclass),
  5, 'all five of 0026''s review policies are still there');
select is(
  (select count(*)::integer from pg_policy p where p.polrelid = 'public.review_replies'::regclass),
  5, 'and all five of its reply policies');
select is(
  (select count(*)::integer from pg_trigger t
    where t.tgrelid = 'public.reviews'::regclass and not t.tgisinternal),
  3, 'all three of its review triggers');
select ok(
  (select count(*) from pg_trigger t
    where t.tgrelid = 'public.reviews'::regclass and t.tgname = 'reviews_audit') = 1,
  'including the audit trigger this increment relies on and did not replace');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid = 'public.reviews'::regclass and contype = 'c'),
  7, 'and no CHECK constraint on reviews was added or removed');
select ok(
  (select count(*) from pg_constraint
    where conrelid = 'public.reviews'::regclass and conname = 'reviews_status_allowed') = 1,
  'the status vocabulary is still 0026''s');

select * from finish();
rollback;
