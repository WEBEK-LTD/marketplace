-- pgTAP — migration 0064: the read-only seller surfaces.
--
-- Six things are being held to account.
--
-- **Nothing writes.** Every one of the six functions is declared `stable`, none contains an insert, update or
-- delete, and the proof is empirical as well as textual: every table these readers can reach is counted
-- before and after all six are called, along with the audit log and the outbox, and nothing moves.
--
-- **Ownership is the caller's storefront, and cross-seller access returns nothing at all.** Two sellers with
-- an order, a review, a balance, a promotion and analytics each: neither ever sees a row of the other's, and
-- the check is that the other seller's values appear nowhere in the output, not merely that the row count is
-- right.
--
-- **No staff material, no internal identifier, no ledger.** The fixtures deliberately carry a moderation
-- reason, a moderator, an auto-hidden reason, a commission snapshot, a cancellation policy snapshot, a
-- package snapshot and an idempotency key. Each is asserted absent from the reader's output. No function
-- mentions a ledger table, a payout, a payout destination or a withdrawal.
--
-- **The aggregates are reused, not recomputed.** The summary's numbers are compared against
-- `public.seller_ratings` itself, and the analytics against the sums of `public.promotion_analytics`, so a
-- future edit that started computing either here would fail rather than drift.
--
-- **Money travels safely**: minor units as text, the currency carried explicitly, and the decimal places read
-- from `public.currencies` — the fixture currency has three, so a hard-coded two would fail.
--
-- **A suspended or closed storefront still reads its own rows**, which is the established Phase 6 behaviour:
-- reading one's own data is not a mutation. No suspension reason or closure time is exposed by any of it.
--
-- Deterministic: fixed uuids, no wall-clock dependence except the analytics window, which is anchored to
-- `current_date`. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(159);

-- Fixtures ------------------------------------------------------------------------------------------
-- Three decimal places on purpose: a reader that assumed two would be caught.
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XRD', '963', 'R', 3, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZR', 'ZRA', '995', 'Readland', 'Readland', '995', 'XRD', true);

insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'jread-one@test.invalid'),
  ('a1000000-0000-4000-8000-000000000002', 'jread-two@test.invalid'),
  ('a1000000-0000-4000-8000-000000000003', 'jread-buyer@test.invalid'),
  ('a1000000-0000-4000-8000-000000000004', 'jread-nobody@test.invalid'),
  ('a1000000-0000-4000-8000-000000000005', 'jread-fresh@test.invalid'),
  ('a1000000-0000-4000-8000-000000000006', 'jread-susp@test.invalid'),
  ('a1000000-0000-4000-8000-000000000007', 'jread-closed@test.invalid'),
  ('a1000000-0000-4000-8000-000000000009', 'jread-moderator@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, country_code, status, suspended_at, suspension_reason, closed_at,
   verification_status, verified_at)
values
  ('a1000000-0000-4000-8000-000000000001', 'jread-one', 'Read One', 'ZR', 'active',
   null, null, null, 'verified', '2026-04-01T00:00:00Z'),
  ('a1000000-0000-4000-8000-000000000002', 'jread-two', 'Read Two', 'ZR', 'active',
   null, null, null, 'verified', '2026-04-01T00:00:00Z'),
  -- A brand-new storefront: every surface must be an honest empty, not a failure.
  ('a1000000-0000-4000-8000-000000000005', 'jread-fresh', 'Fresh Shop', 'ZR', 'pending',
   null, null, null, 'unverified', null),
  ('a1000000-0000-4000-8000-000000000006', 'jread-susp', 'Suspended Shop', 'ZR', 'suspended',
   '2026-03-01T00:00:00Z', 'Repeated policy breaches, internal note', null, 'unverified', null),
  ('a1000000-0000-4000-8000-000000000007', 'jread-closed', 'Closed Shop', 'ZR', 'closed',
   null, null, '2026-04-01T00:00:00Z', 'unverified', null);

insert into public.checkouts (id, currency_code, buyer_user_id) values
  ('b1000000-0000-4000-8000-000000000001', 'XRD', 'a1000000-0000-4000-8000-000000000003'),
  ('b1000000-0000-4000-8000-000000000002', 'XRD', 'a1000000-0000-4000-8000-000000000003'),
  ('b1000000-0000-4000-8000-000000000003', 'XRD', 'a1000000-0000-4000-8000-000000000003'),
  ('b1000000-0000-4000-8000-000000000004', 'XRD', 'a1000000-0000-4000-8000-000000000003');

-- The snapshots carry material a seller must never read back.
insert into public.orders (id, currency_code, checkout_id, seller_user_id, buyer_user_id, order_type, status,
  subtotal_minor, shipping_total_minor, tax_total_minor, discount_total_minor, commission_total_minor,
  grand_total_minor, seller_net_minor, commission_snapshot, cancellation_policy_snapshot,
  placed_at, paid_at, completed_at)
values
  ('c1000000-0000-4000-8000-000000000001', 'XRD', 'b1000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 'product', 'completed',
   100000, 5000, 2000, 1000, 8000, 106000, 98000,
   '{"note":"COMMISSION-SNAPSHOT-SECRET"}'::jsonb, '{"note":"POLICY-SNAPSHOT-SECRET"}'::jsonb,
   '2026-05-01T10:00:00Z', '2026-05-01T10:05:00Z', '2026-05-08T10:00:00Z'),
  ('c1000000-0000-4000-8000-000000000002', 'XRD', 'b1000000-0000-4000-8000-000000000002',
   'a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 'service', 'in_progress',
   7000, 0, 0, 0, 500, 7000, 6500, null, null,
   '2026-05-03T10:00:00Z', '2026-05-03T10:05:00Z', null),
  -- The other seller's, with values this seller must never see.
  ('c1000000-0000-4000-8000-000000000003', 'XRD', 'b1000000-0000-4000-8000-000000000003',
   'a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000003', 'service', 'completed',
   777777, 0, 0, 0, 7777, 777777, 770000, null, null,
   '2026-05-02T10:00:00Z', '2026-05-02T10:05:00Z', '2026-05-09T10:00:00Z'),
  -- A suspended storefront's own order.
  ('c1000000-0000-4000-8000-000000000004', 'XRD', 'b1000000-0000-4000-8000-000000000004',
   'a1000000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000003', 'product', 'paid',
   4000, 0, 0, 0, 100, 4000, 3900, null, null,
   '2026-05-04T10:00:00Z', '2026-05-04T10:05:00Z', null);

insert into public.categories (id, slug, parent_id, listing_type_code, is_active, depth)
values ('d1000000-0000-4000-8000-000000000001', 'jread-cat', null, 'product', true, 0);

insert into public.listings (id, slug, seller_user_id, category_id, listing_type_code, title, description,
  status, currency_code, country_code, content_language, price_minor, approved_at, published_at)
values
  ('e1000000-0000-4000-8000-000000000001', 'jread-listing', 'a1000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', 'product', 'Read Listing', 'A listing for the read tests.',
   'active', 'XRD', 'ZR', 'en', 100000, '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z'),
  ('e1000000-0000-4000-8000-000000000002', 'jread-other-listing', 'a1000000-0000-4000-8000-000000000002',
   'd1000000-0000-4000-8000-000000000001', 'product', 'OTHER-SELLER-LISTING-TITLE', 'Another seller''s.',
   'active', 'XRD', 'ZR', 'en', 100000, '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z');

-- The title on the item is the snapshot, deliberately different from the listing's current title, so the
-- reader can be shown to read the snapshot rather than joining the live row.
insert into public.order_items (order_id, currency_code, listing_id, listing_type_code,
  listing_title_snapshot, listing_slug_snapshot, quantity, cancelled_quantity, unit_price_minor,
  line_subtotal_minor, discount_minor, tax_minor, line_total_minor, commission_minor)
values ('c1000000-0000-4000-8000-000000000001', 'XRD', 'e1000000-0000-4000-8000-000000000001', 'product',
        'Title As Purchased', 'jread-listing', 2, 0, 50000, 100000, 1000, 2000, 101000, 8000);

insert into public.reviews (id, order_id, seller_user_id, buyer_user_id, rating, title, body, status,
  moderation_reason, moderated_by, moderated_at, auto_hidden_reason, published_at)
values
  ('f1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 5,
   'Great', 'Very good seller.', 'published', null, null, null, null, '2026-05-10T10:00:00Z'),
  -- The other seller's, hidden, carrying every staff field at once.
  ('f1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003',
   'a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000003', 2,
   'OTHER-REVIEW-TITLE', 'OTHER-REVIEW-BODY', 'hidden', 'MODERATION-REASON-SECRET',
   'a1000000-0000-4000-8000-000000000009', '2026-05-11T10:00:00Z', 'AUTO-HIDDEN-SECRET',
   '2026-05-10T10:00:00Z');

insert into public.review_replies (review_id, seller_user_id, body, status, moderation_reason, moderated_by)
values ('f1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
        'Thank you very much.', 'published', 'REPLY-MODERATION-SECRET',
        'a1000000-0000-4000-8000-000000000009');

insert into public.seller_balances (seller_user_id, currency_code, pending_minor, available_minor, reserved_minor)
values ('a1000000-0000-4000-8000-000000000001', 'XRD', 12000, 98000, 3000),
       ('a1000000-0000-4000-8000-000000000002', 'XRD', 555555, 666666, 777777),
       ('a1000000-0000-4000-8000-000000000006', 'XRD', 10, 20, 30);

insert into public.promotion_packages (id, key, name_en, name_ar, duration_days, is_active)
values ('11000000-0000-4000-8000-000000000001', 'jread_pkg', 'Read Package', 'Read Package', 7, true);

insert into public.promotions (id, currency_code, seller_user_id, listing_id, promotion_package_id, status,
  payment_method, price_minor, priority, duration_days, package_snapshot, idempotency_key,
  starts_at, ends_at, paid_at, activated_at, created_at, expired_at, cancellation_reason)
values
  ('12000000-0000-4000-8000-000000000001', 'XRD', 'a1000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'active',
   'wallet', 25000, 10, 7, '{"note":"PACKAGE-SNAPSHOT-SECRET"}'::jsonb, 'IDEMPOTENCY-KEY-SECRET',
   '2026-05-01T00:00:00Z', '2026-05-08T00:00:00Z', '2026-04-30T00:00:00Z', '2026-05-01T00:00:00Z',
   '2026-04-30T00:00:00Z', null, null),
  ('12000000-0000-4000-8000-000000000002', 'XRD', 'a1000000-0000-4000-8000-000000000002',
   'e1000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000001', 'expired',
   'wallet', 999999, 1, 7, '{}'::jsonb, 'OTHER-IDEMPOTENCY-SECRET',
   '2026-04-01T00:00:00Z', '2026-04-08T00:00:00Z', '2026-03-31T00:00:00Z', null,
   '2026-03-31T00:00:00Z', '2026-04-08T00:00:00Z', 'OTHER-CANCELLATION-REASON');

insert into public.promotion_analytics (promotion_id, day, impressions, views, clicks, computed_at)
values ('12000000-0000-4000-8000-000000000001', current_date - 2, 1000, 200, 30, now()),
       ('12000000-0000-4000-8000-000000000001', current_date - 1, 1500, 250, 45, now()),
       ('12000000-0000-4000-8000-000000000002', current_date - 1, 999999, 888888, 777777, now());

-- Watermarks for the side-effect proof.
create temporary table before_counts as
select
  (select count(*) from public.orders) as orders,
  (select count(*) from public.order_items) as order_items,
  (select count(*) from public.reviews) as reviews,
  (select count(*) from public.review_replies) as review_replies,
  (select count(*) from public.seller_balances) as seller_balances,
  (select count(*) from public.promotions) as promotions,
  (select count(*) from public.promotion_analytics) as promotion_analytics,
  (select count(*) from public.listings) as listings,
  (select count(*) from public.seller_profiles) as seller_profiles,
  (select count(*) from public.outbox_events) as outbox_events,
  (select count(*) from public.notifications) as notifications,
  (select count(*) from audit.audit_logs) as audit_logs;
create temporary table before_stamps as
select
  (select max(updated_at) from public.orders) as orders_updated,
  (select max(updated_at) from public.reviews) as reviews_updated,
  (select max(updated_at) from public.seller_balances) as balances_updated,
  (select max(updated_at) from public.promotions) as promotions_updated;

-- ---------------------------------------------------------------------------------------------------
-- Security: the S8 contract, for all six readers
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_to_string(array_agg(p.proname || '/' || p.pronargs order by p.proname), ' ')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('seller_orders', 'seller_reviews', 'seller_reviews_summary', 'seller_earnings',
                        'seller_promotions', 'seller_promotion_analytics')),
  'seller_earnings/1 seller_orders/4 seller_promotion_analytics/2 seller_promotions/4 seller_reviews/4'
    || ' seller_reviews_summary/1',
  'this migration adds exactly six readers, each with the arity it declares, and no overloads');

create temporary view read_surface as
select p.proname,
       p.prosrc,
       regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') as code,
       p.provolatile,
       p.prosecdef,
       array_to_string(p.proconfig, ',') as config,
       p.proargnames[1:p.pronargs] as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('seller_orders', 'seller_reviews', 'seller_reviews_summary', 'seller_earnings',
                     'seller_promotions', 'seller_promotion_analytics');

select is((select count(*) from read_surface), 6::bigint, 'the scans below cover all six');
select is((select count(*) from read_surface r where not r.prosecdef), 0::bigint,
  'every one is SECURITY DEFINER');
select is((select count(*) from read_surface r where r.config <> 'search_path=pg_catalog, public'), 0::bigint,
  'and every one has its search_path pinned');
select is((select count(*) from read_surface r where r.provolatile <> 's'), 0::bigint,
  'and every one is declared stable, which is the database''s own statement that it does not write');

-- ACLs, one reader at a time.
select ok(not has_function_privilege('public', 'app_private.seller_orders(uuid, integer, timestamptz, text)', 'execute'),
  'PUBLIC cannot read a seller''s orders');
select ok(not has_function_privilege('anon', 'app_private.seller_orders(uuid, integer, timestamptz, text)', 'execute'),
  'anon cannot');
select ok(not has_function_privilege('authenticated', 'app_private.seller_orders(uuid, integer, timestamptz, text)', 'execute'),
  'authenticated cannot');
select ok(has_function_privilege('app_system', 'app_private.seller_orders(uuid, integer, timestamptz, text)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('app_worker', 'app_private.seller_orders(uuid, integer, timestamptz, text)', 'execute'),
  'app_worker cannot');
select ok(not has_function_privilege('authenticated', 'app_private.seller_reviews(uuid, integer, timestamptz, text)', 'execute'),
  'authenticated cannot read a seller''s reviews');
select ok(has_function_privilege('app_system', 'app_private.seller_reviews(uuid, integer, timestamptz, text)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('authenticated', 'app_private.seller_reviews_summary(uuid)', 'execute'),
  'authenticated cannot read the summary');
select ok(has_function_privilege('app_system', 'app_private.seller_reviews_summary(uuid)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('public', 'app_private.seller_earnings(uuid)', 'execute'),
  'PUBLIC cannot read a seller''s balances');
select ok(not has_function_privilege('authenticated', 'app_private.seller_earnings(uuid)', 'execute'),
  'and neither can authenticated: a balance is never one RLS mistake away from a browser');
select ok(has_function_privilege('app_system', 'app_private.seller_earnings(uuid)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('app_worker', 'app_private.seller_earnings(uuid)', 'execute'),
  'and the worker, which needs none of it, cannot');
select ok(not has_function_privilege('authenticated', 'app_private.seller_promotions(uuid, integer, timestamptz, uuid)', 'execute'),
  'authenticated cannot read a seller''s promotions');
select ok(has_function_privilege('app_system', 'app_private.seller_promotions(uuid, integer, timestamptz, uuid)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('authenticated', 'app_private.seller_promotion_analytics(uuid, integer)', 'execute'),
  'authenticated cannot read promotion analytics');
select ok(has_function_privilege('app_system', 'app_private.seller_promotion_analytics(uuid, integer)', 'execute'),
  'app_system can');

-- No reader takes a seller, an owner or a status from its caller.
select is(
  (select count(*) from read_surface r, unnest(r.args) as arg
    where arg like '%seller%' or arg like '%owner%' or arg like '%status%' or arg like '%buyer%'),
  0::bigint,
  'no reader takes a seller, an owner, a buyer or a status: the storefront comes from the caller''s id alone');

-- No writes anywhere in the code.
select is(
  (select count(*) from read_surface r
    where r.code ~* '\minsert\s+into\m' or r.code ~* '\mupdate\s+public\.' or r.code ~* '\mdelete\s+from\m'
       or r.code ~* '\mtruncate\m' or r.code ~* '\mmerge\m'),
  0::bigint,
  'not one reader contains an insert, update, delete, truncate or merge');
select is(
  (select count(*) from read_surface r
    where r.code like '%outbox%' or r.code like '%notification%' or r.code like '%audit%'),
  0::bigint,
  'none of them publishes an outbox event, creates a notification or writes an audit row');
select is(
  (select count(*) from read_surface r where r.code ~* '\mexecute\m'),
  0::bigint,
  'and none builds SQL at run time');

-- The ledger, the payouts and the withdrawals are untouched by every one of them.
select is(
  (select count(*) from read_surface r
    where r.code like '%ledger_entries%' or r.code like '%ledger_journals%' or r.code like '%ledger_accounts%'
       or r.code like '%wallet_transactions%' or r.code like '%payout%' or r.code like '%withdrawal%'),
  0::bigint,
  'no reader touches the ledger, a payout, a payout destination or a withdrawal');
select is(
  (select count(*) from read_surface r
    where r.code like '%moderation_reason%' or r.code like '%moderated_by%' or r.code like '%moderated_at%'
       or r.code like '%auto_hidden_reason%' or r.code like '%commission_snapshot%'
       or r.code like '%cancellation_policy_snapshot%' or r.code like '%package_snapshot%'
       or r.code like '%idempotency_key%' or r.code like '%suspension_reason%'),
  0::bigint,
  'and none names a moderation field, a snapshot, an idempotency key or a suspension reason');
select is(
  (select count(*) from read_surface r where r.code like '%buyer_user_id%'),
  0::bigint,
  'and none reads the buyer: an order on this surface is the seller''s side of it');

-- No currency literal, which is owner decision E3 applied to SQL as well.
select is(
  (select count(*) from read_surface r where r.code ~ '''[A-Z]{3}'''),
  0::bigint,
  'no reader writes a currency code in source: every one joins public.currencies for the minor unit');

select lives_ok($$ select app_private.assert_security_contract() $$,
  'the deploy-time security contract still holds');

select is(
  (select count(*) from information_schema.table_privileges
    where table_schema = 'public'
      and table_name in ('orders', 'order_items', 'reviews', 'review_replies', 'seller_balances',
                         'promotions', 'promotion_analytics')
      and grantee in ('app_system', 'app_worker')),
  0::bigint,
  'app_system still holds no privilege on any table these readers read');

-- The RLS the readers mirror is still in place, unweakened.
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'orders'),
  4::bigint, '0018''s four orders policies are untouched');
select is(
  (select array_to_string(array_agg(policyname order by policyname), ',')
     from pg_policies where schemaname = 'public' and tablename = 'reviews'),
  'reviews_author_read,reviews_public_read,reviews_seller_read,reviews_staff_moderate,reviews_staff_read',
  '0026''s five reviews policies are untouched, by name — including reviews_seller_read, which is the rule seller_reviews mirrors');
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'seller_balances'),
  2::bigint, '0021''s two seller_balances policies are untouched');
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'promotions'),
  2::bigint, '0025''s two promotions policies are untouched');
select ok(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'seller_balances'
      and policyname = 'seller_balances_owner_read' and qual like '%current_user_id()%') = 1,
  'and the balance owner policy still scopes to the current user, which is the rule seller_earnings mirrors');

-- ---------------------------------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 20, null, null)),
  2::bigint, 'the seller reads their own two orders');
select is(
  (select array_to_string(array_agg(o.order_number), ',')
     from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 20, null, null) o),
  (select array_to_string(array_agg(x.order_number order by x.placed_at desc), ',')
     from public.orders x where x.seller_user_id = 'a1000000-0000-4000-8000-000000000001'),
  'newest placed first, which is the order orders_seller already indexes');
select is(
  (select o.outcome from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 20, null, null) o
    limit 1),
  'found', 'and the outcome says so');

select is(
  (select o.status from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 20, null, null) o
    where o.order_number = (select x.order_number from public.orders x
                             where x.id = 'c1000000-0000-4000-8000-000000000001')),
  'completed', 'each order carries its own status');
select is(
  (select o.currency_decimal_places from app_private.seller_orders(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) o limit 1),
  3, 'the currency''s own decimal places come from public.currencies, and this currency has three');
select is(
  (select o.grand_total_minor from app_private.seller_orders(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) o
    where o.order_number = (select x.order_number from public.orders x
                             where x.id = 'c1000000-0000-4000-8000-000000000001')),
  '106000', 'the amounts are minor units as text, not a JavaScript number waiting to happen');
select is(
  (select o.seller_net_minor from app_private.seller_orders(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) o
    where o.order_number = (select x.order_number from public.orders x
                             where x.id = 'c1000000-0000-4000-8000-000000000001')),
  '98000', 'including the seller''s own net');
select is(
  (select o.commission_total_minor from app_private.seller_orders(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) o
    where o.order_number = (select x.order_number from public.orders x
                             where x.id = 'c1000000-0000-4000-8000-000000000001')),
  '8000',
  'and the commission charged on it, which is the seller''s own fee and the difference between the two above');

select is(
  (select o.item_count from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 20, null, null) o
    where o.order_number = (select x.order_number from public.orders x
                             where x.id = 'c1000000-0000-4000-8000-000000000001')),
  1, 'the item count is the order''s own');
select is(
  (select item->>'title' from app_private.seller_orders(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) o,
     jsonb_array_elements(o.items) as item
    where o.order_number = (select x.order_number from public.orders x
                             where x.id = 'c1000000-0000-4000-8000-000000000001')),
  'Title As Purchased',
  'the item shows the title as it was at purchase, from order_items'' snapshot, not the listing''s current one');
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 20, null, null) o
    where o.items::text like '%Read Listing%'),
  0::bigint,
  'so the listing''s current title appears nowhere: nothing here joins the live listing');
select is(
  (select array_to_string(array_agg(k order by k), ',')
     from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 20, null, null) o,
     jsonb_array_elements(o.items) as item, jsonb_object_keys(item) as k
    where o.item_count = 1),
  'cancelledQuantity,lineTotalMinor,listingTypeCode,quantity,slug,title,unitPriceMinor',
  'an item carries exactly seven fields, and no listing id, order id or commission among them');
select is(
  (select item->>'unitPriceMinor' from app_private.seller_orders(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) o,
     jsonb_array_elements(o.items) as item where o.item_count = 1),
  '50000', 'and its money is text too');
select is(
  (select o.items from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 20, null, null) o
    where o.item_count = 0),
  '[]'::jsonb, 'an order with no item rows carries an empty list, not a null');

-- Nothing private, nothing of anybody else's.
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 20, null, null) o
    where o::text like '%COMMISSION-SNAPSHOT-SECRET%' or o::text like '%POLICY-SNAPSHOT-SECRET%'),
  0::bigint, 'the commission and cancellation-policy snapshots are nowhere in the answer');
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 20, null, null) o
    where o::text like '%a1000000-0000-4000-8000-000000000003%'
       or o::text like '%a1000000-0000-4000-8000-000000000001%'
       or o::text like '%c1000000-0000-4000-8000%'
       or o::text like '%b1000000-0000-4000-8000%'),
  0::bigint, 'and no buyer id, seller id, order id or checkout id appears anywhere in it');

select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000002', 20, null, null) o),
  1::bigint, 'the other seller reads exactly their own one order');
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000002', 20, null, null) o
    where o.grand_total_minor = '106000' or o.seller_net_minor = '98000'),
  0::bigint, 'and none of the first seller''s money reaches them');
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 20, null, null) o
    where o.grand_total_minor = '777777' or o.seller_net_minor = '770000'),
  0::bigint, 'nor the reverse: cross-seller isolation in both directions');

-- Empty and absent.
select is(
  (select o.outcome from app_private.seller_orders('a1000000-0000-4000-8000-000000000005', 20, null, null) o),
  null::text,
  'a storefront with no orders returns no rows at all, which the layer above renders as an honest empty');
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000005', 20, null, null)),
  0::bigint, 'zero rows, not a row of nulls');
select is(
  (select o.outcome from app_private.seller_orders('a1000000-0000-4000-8000-000000000004', 20, null, null) o),
  'not_found', 'an account with no storefront is not_found, which is a different answer');
select is(
  (select o.outcome from app_private.seller_orders(null, 20, null, null) o),
  'not_found', 'and so is no caller at all');

-- Suspended and closed storefronts read their own rows, which is the established Phase 6 behaviour.
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000006', 20, null, null)),
  1::bigint, 'a suspended storefront still reads its own order: reading one''s own data is not a mutation');
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000006', 20, null, null) o
    where o::text like '%internal note%'),
  0::bigint, 'and its suspension reason is not in the answer, because no reader selects one');
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000007', 20, null, null)),
  0::bigint, 'a closed storefront with no orders reads none, and is refused nothing');

-- The limit and the cursor.
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 1, null, null)),
  1::bigint, 'the limit is honoured');
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 9999, null, null)),
  2::bigint, 'an absurd limit is clamped rather than obeyed');
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 0, null, null)),
  1::bigint, 'and a limit of zero becomes one rather than an empty page');
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', null, null, null)),
  2::bigint, 'an unstated limit takes the default');
select is(
  (select o.order_number from app_private.seller_orders(
     'a1000000-0000-4000-8000-000000000001', 20,
     (select x.placed_at from public.orders x where x.id = 'c1000000-0000-4000-8000-000000000002'),
     (select x.order_number from public.orders x where x.id = 'c1000000-0000-4000-8000-000000000002')) o),
  (select x.order_number from public.orders x where x.id = 'c1000000-0000-4000-8000-000000000001'),
  'a cursor at the newer order returns the older one, and only it');
select is(
  (select count(*) from app_private.seller_orders(
     'a1000000-0000-4000-8000-000000000001', 20,
     (select x.placed_at from public.orders x where x.id = 'c1000000-0000-4000-8000-000000000001'),
     (select x.order_number from public.orders x where x.id = 'c1000000-0000-4000-8000-000000000001'))),
  0::bigint, 'a cursor at the oldest returns nothing, so the page sequence terminates');
select is(
  (select count(*) from app_private.seller_orders('a1000000-0000-4000-8000-000000000001', 20,
     '2026-05-03T10:00:00Z', null)),
  2::bigint, 'half a cursor is no cursor: both halves are required, so a partial one cannot skip a row');

-- ---------------------------------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.seller_reviews('a1000000-0000-4000-8000-000000000001', 20, null, null)),
  1::bigint, 'the seller reads the one review on their storefront');
select is(
  (select r.rating from app_private.seller_reviews('a1000000-0000-4000-8000-000000000001', 20, null, null) r),
  5, 'with its rating');
select is(
  (select r.body from app_private.seller_reviews('a1000000-0000-4000-8000-000000000001', 20, null, null) r),
  'Very good seller.', 'its body');
select is(
  (select r.status from app_private.seller_reviews('a1000000-0000-4000-8000-000000000001', 20, null, null) r),
  'published', 'its status');
select is(
  (select r.order_number from app_private.seller_reviews(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) r),
  (select x.order_number from public.orders x where x.id = 'c1000000-0000-4000-8000-000000000001'),
  'and the order it belongs to, which is what names it, since reviews are unique per order');
select is(
  (select r.reply_body from app_private.seller_reviews(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) r),
  'Thank you very much.', 'the seller''s own reply comes with it');
select is(
  (select r.reply_status from app_private.seller_reviews(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) r),
  'published', 'and the reply''s own status');

select is(
  (select count(*) from app_private.seller_reviews('a1000000-0000-4000-8000-000000000001', 20, null, null) r
    where r::text like '%REPLY-MODERATION-SECRET%'),
  0::bigint, 'the reply''s moderation reason is not in the answer');
select is(
  (select count(*) from app_private.seller_reviews('a1000000-0000-4000-8000-000000000001', 20, null, null) r
    where r::text like '%a1000000-0000-4000-8000-000000000009%'
       or r::text like '%a1000000-0000-4000-8000-000000000003%'
       or r::text like '%f1000000-0000-4000-8000%'),
  0::bigint, 'and no moderator, no buyer and no review id appear anywhere in it');

-- A hidden review, and every staff field attached to it.
select is(
  (select count(*) from app_private.seller_reviews('a1000000-0000-4000-8000-000000000002', 20, null, null)),
  1::bigint,
  'the other seller reads their hidden review: reviews_seller_read puts no status condition on the owner');
select is(
  (select r.status from app_private.seller_reviews('a1000000-0000-4000-8000-000000000002', 20, null, null) r),
  'hidden', 'and is told it is hidden, which is a fact about their own storefront');
select is(
  (select count(*) from app_private.seller_reviews('a1000000-0000-4000-8000-000000000002', 20, null, null) r
    where r::text like '%MODERATION-REASON-SECRET%' or r::text like '%AUTO-HIDDEN-SECRET%'),
  0::bigint,
  'but never why: neither the moderation reason nor the auto-hidden reason is projected');
select is(
  (select r.reply_body from app_private.seller_reviews(
     'a1000000-0000-4000-8000-000000000002', 20, null, null) r),
  null::text, 'a review with no reply of the caller''s carries no reply');

select is(
  (select count(*) from app_private.seller_reviews('a1000000-0000-4000-8000-000000000001', 20, null, null) r
    where r.title = 'OTHER-REVIEW-TITLE' or r.body = 'OTHER-REVIEW-BODY'),
  0::bigint, 'neither seller reads the other''s review');
select is(
  (select count(*) from app_private.seller_reviews('a1000000-0000-4000-8000-000000000002', 20, null, null) r
    where r.body = 'Very good seller.'),
  0::bigint, 'in either direction');

select is(
  (select count(*) from app_private.seller_reviews('a1000000-0000-4000-8000-000000000005', 20, null, null)),
  0::bigint, 'a storefront with no reviews reads none');
select is(
  (select r.outcome from app_private.seller_reviews('a1000000-0000-4000-8000-000000000004', 20, null, null) r),
  'not_found', 'an account with no storefront is not_found');
select is(
  (select r.outcome from app_private.seller_reviews(null, 20, null, null) r),
  'not_found', 'and so is no caller');
select is(
  (select count(*) from app_private.seller_reviews('a1000000-0000-4000-8000-000000000001', 9999, null, null)),
  1::bigint, 'the limit is clamped here too');
select is(
  (select count(*) from app_private.seller_reviews('a1000000-0000-4000-8000-000000000001', 20,
     (select x.created_at from public.reviews x where x.id = 'f1000000-0000-4000-8000-000000000001'),
     (select o.order_number from public.orders o where o.id = 'c1000000-0000-4000-8000-000000000001'))),
  0::bigint, 'and the cursor terminates the sequence');

-- ---------------------------------------------------------------------------------------------------
-- The rating summary — the view's numbers, not this migration's
-- ---------------------------------------------------------------------------------------------------
select is(
  (select s.outcome from app_private.seller_reviews_summary('a1000000-0000-4000-8000-000000000001') s),
  'found', 'a storefront with a published review has a summary');
select is(
  (select s.review_count from app_private.seller_reviews_summary('a1000000-0000-4000-8000-000000000001') s),
  (select v.review_count::integer from public.seller_ratings v
    where v.seller_user_id = 'a1000000-0000-4000-8000-000000000001'),
  'the count is the view''s own');
select is(
  (select s.average_rating_basis_points from app_private.seller_reviews_summary(
     'a1000000-0000-4000-8000-000000000001') s),
  (select v.average_rating_basis_points from public.seller_ratings v
    where v.seller_user_id = 'a1000000-0000-4000-8000-000000000001'),
  'and so is the average, to the basis point: nothing here recomputes or re-rounds it');
select is(
  (select s.average_rating_basis_points from app_private.seller_reviews_summary(
     'a1000000-0000-4000-8000-000000000001') s),
  50000, 'which for one five-star review is 50000 basis points, the view''s scale and not a 0-5 float');
select is(
  (select s.five_star_count from app_private.seller_reviews_summary(
     'a1000000-0000-4000-8000-000000000001') s),
  1, 'the star distribution is the view''s');
select is(
  (select s.one_star_count from app_private.seller_reviews_summary(
     'a1000000-0000-4000-8000-000000000001') s),
  0, 'including the empty buckets');
select is(
  (select s.latest_review_at from app_private.seller_reviews_summary(
     'a1000000-0000-4000-8000-000000000001') s),
  '2026-05-10T10:00:00Z'::timestamptz, 'and the latest published time');

select is(
  (select s.outcome from app_private.seller_reviews_summary('a1000000-0000-4000-8000-000000000002') s),
  'none',
  'a storefront whose only review is hidden has no summary: the view counts published reviews only');
select is(
  (select s.review_count from app_private.seller_reviews_summary('a1000000-0000-4000-8000-000000000002') s),
  null::integer,
  'and it is null rather than zero, because "no reviews yet" and "an average of zero" are different claims');
select is(
  (select s.outcome from app_private.seller_reviews_summary('a1000000-0000-4000-8000-000000000005') s),
  'none', 'a brand-new storefront is none as well');
select is(
  (select s.outcome from app_private.seller_reviews_summary('a1000000-0000-4000-8000-000000000004') s),
  'not_found', 'and an account with no storefront is not_found');
select is(
  (select s.outcome from app_private.seller_reviews_summary(null) s),
  'not_found', 'as is no caller');
select is(
  (select count(*) from app_private.seller_reviews_summary('a1000000-0000-4000-8000-000000000001') s
    where s::text like '%666666%' or s::text like '%OTHER%'),
  0::bigint, 'and the summary carries nothing of the other seller''s');

-- ---------------------------------------------------------------------------------------------------
-- Earnings
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.seller_earnings('a1000000-0000-4000-8000-000000000001')),
  1::bigint, 'the seller reads one balance row per currency');
select is(
  (select e.outcome from app_private.seller_earnings('a1000000-0000-4000-8000-000000000001') e),
  'found', 'with an outcome that says so');
select is(
  (select e.currency_code from app_private.seller_earnings('a1000000-0000-4000-8000-000000000001') e),
  'XRD', 'the currency is carried explicitly, trimmed of char(3) padding');
select is(
  (select e.currency_decimal_places from app_private.seller_earnings(
     'a1000000-0000-4000-8000-000000000001') e),
  3, 'with that currency''s own decimal places, which are three here and not an assumed two');
select is(
  (select e.pending_minor from app_private.seller_earnings('a1000000-0000-4000-8000-000000000001') e),
  '12000', 'pending as minor units in text');
select is(
  (select e.available_minor from app_private.seller_earnings('a1000000-0000-4000-8000-000000000001') e),
  '98000', 'available likewise');
select is(
  (select e.reserved_minor from app_private.seller_earnings('a1000000-0000-4000-8000-000000000001') e),
  '3000', 'and reserved: the three the ledger keeps, and no total computed from them');
select is(
  (select count(*) from app_private.seller_earnings('a1000000-0000-4000-8000-000000000001') e
    where e::text like '%555555%' or e::text like '%666666%' or e::text like '%777777%'),
  0::bigint, 'none of the other seller''s money is in the answer');
select is(
  (select count(*) from app_private.seller_earnings('a1000000-0000-4000-8000-000000000001') e
    where e::text like '%a1000000-0000-4000-8000%'),
  0::bigint, 'and no seller id either');
select is(
  (select count(*) from app_private.seller_earnings('a1000000-0000-4000-8000-000000000005')),
  0::bigint,
  'a storefront that has earned nothing has no balance row, and that is an empty rather than a zero');
select is(
  (select e.outcome from app_private.seller_earnings('a1000000-0000-4000-8000-000000000004') e),
  'not_found', 'an account with no storefront is not_found');
select is(
  (select e.outcome from app_private.seller_earnings(null) e),
  'not_found', 'and so is no caller');
select is(
  (select count(*) from app_private.seller_earnings('a1000000-0000-4000-8000-000000000006')),
  1::bigint,
  'a suspended storefront still reads its own balance, which it needs in order to know what it is owed');

-- ---------------------------------------------------------------------------------------------------
-- Promotions
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.seller_promotions('a1000000-0000-4000-8000-000000000001', 20, null, null)),
  1::bigint, 'the seller reads their own promotion');
select is(
  (select p.listing_slug from app_private.seller_promotions(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) p),
  'jread-listing', 'named by the slug of the listing it promotes');
select is(
  (select p.listing_title from app_private.seller_promotions(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) p),
  'Read Listing', 'and that listing''s title');
select is(
  (select p.status from app_private.seller_promotions(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) p),
  'active', 'with its own status');
select is(
  (select p.price_minor from app_private.seller_promotions(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) p),
  '25000', 'its price as minor units in text');
select is(
  (select p.currency_decimal_places from app_private.seller_promotions(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) p),
  3, 'beside the currency''s own decimal places');
select is(
  (select p.refunded_amount_minor from app_private.seller_promotions(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) p),
  '0', 'and whatever has been refunded, which is zero here and still text');
select is(
  (select p.priority from app_private.seller_promotions(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) p),
  10, 'the priority it bought');
select is(
  (select p.duration_days from app_private.seller_promotions(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) p),
  7, 'and its duration');

select is(
  (select count(*) from app_private.seller_promotions('a1000000-0000-4000-8000-000000000001', 20, null, null) p
    where p::text like '%PACKAGE-SNAPSHOT-SECRET%' or p::text like '%IDEMPOTENCY-KEY-SECRET%'),
  0::bigint, 'the package snapshot and the idempotency key are nowhere in the answer');
select is(
  (select count(*) from app_private.seller_promotions('a1000000-0000-4000-8000-000000000002', 20, null, null) p
    where p::text like '%OTHER-CANCELLATION-REASON%'),
  0::bigint, 'and no cancellation reason is projected either');
select is(
  (select count(*) from app_private.seller_promotions('a1000000-0000-4000-8000-000000000001', 20, null, null) p
    where p::text like '%11000000-0000-4000-8000%' or p::text like '%a1000000-0000-4000-8000%'
       or p::text like '%e1000000-0000-4000-8000%'),
  0::bigint, 'no package id, seller id or listing id appears in it');
select is(
  (select count(*) from app_private.seller_promotions('a1000000-0000-4000-8000-000000000001', 20, null, null) p
    where p.price_minor = '999999'),
  0::bigint, 'and none of the other seller''s promotion reaches this one');
select is(
  (select p.listing_slug from app_private.seller_promotions(
     'a1000000-0000-4000-8000-000000000002', 20, null, null) p),
  'jread-other-listing', 'the other seller reads their own, and only theirs');
select is(
  (select count(*) from app_private.seller_promotions('a1000000-0000-4000-8000-000000000005', 20, null, null)),
  0::bigint, 'a storefront that has promoted nothing reads none');
select is(
  (select p.outcome from app_private.seller_promotions(
     'a1000000-0000-4000-8000-000000000004', 20, null, null) p),
  'not_found', 'an account with no storefront is not_found');
select is(
  (select p.outcome from app_private.seller_promotions(null, 20, null, null) p),
  'not_found', 'and so is no caller');
select is(
  (select count(*) from app_private.seller_promotions('a1000000-0000-4000-8000-000000000001', 9999, null, null)),
  1::bigint, 'the limit is clamped');
select is(
  (select count(*) from app_private.seller_promotions('a1000000-0000-4000-8000-000000000001', 20,
     '2026-04-30T00:00:00Z', '12000000-0000-4000-8000-000000000001')),
  0::bigint, 'and the cursor terminates the sequence');
select ok(
  (select p.cursor_id from app_private.seller_promotions(
     'a1000000-0000-4000-8000-000000000001', 20, null, null) p) = '12000000-0000-4000-8000-000000000001',
  'the cursor tie-breaker comes back for the layer above to encode, and is the promotion''s own id');

-- ---------------------------------------------------------------------------------------------------
-- Promotion analytics — the rollup's numbers, not this migration's
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.seller_promotion_analytics('a1000000-0000-4000-8000-000000000001', 30)),
  1::bigint, 'one row per promotion with analytics in the window');
select is(
  (select a.impressions from app_private.seller_promotion_analytics(
     'a1000000-0000-4000-8000-000000000001', 30) a),
  (select sum(x.impressions)::text from public.promotion_analytics x
    where x.promotion_id = '12000000-0000-4000-8000-000000000001'),
  'the impressions are the rollup''s own rows, summed and nothing else');
select is(
  (select a.views from app_private.seller_promotion_analytics(
     'a1000000-0000-4000-8000-000000000001', 30) a),
  (select sum(x.views)::text from public.promotion_analytics x
    where x.promotion_id = '12000000-0000-4000-8000-000000000001'),
  'and so are the views');
select is(
  (select a.clicks from app_private.seller_promotion_analytics(
     'a1000000-0000-4000-8000-000000000001', 30) a),
  (select sum(x.clicks)::text from public.promotion_analytics x
    where x.promotion_id = '12000000-0000-4000-8000-000000000001'),
  'and the clicks: no rate, ratio or click-through is computed anywhere');
select is(
  (select a.impressions from app_private.seller_promotion_analytics(
     'a1000000-0000-4000-8000-000000000001', 30) a),
  '2500', 'which for this fixture is 2500 impressions across two days');
select is(
  (select a.listing_slug from app_private.seller_promotion_analytics(
     'a1000000-0000-4000-8000-000000000001', 30) a),
  'jread-listing', 'named by the promoted listing''s slug');
select is(
  (select a.first_day from app_private.seller_promotion_analytics(
     'a1000000-0000-4000-8000-000000000001', 30) a),
  (current_date - 2), 'with the first day the rollup covered');
select is(
  (select a.last_day from app_private.seller_promotion_analytics(
     'a1000000-0000-4000-8000-000000000001', 30) a),
  (current_date - 1), 'and the last');
select is(
  (select count(*) from app_private.seller_promotion_analytics('a1000000-0000-4000-8000-000000000001', 1) a
    where a.first_day = (current_date - 2)),
  0::bigint, 'a narrower window excludes the older day rather than quietly including it');
select is(
  (select a.impressions from app_private.seller_promotion_analytics(
     'a1000000-0000-4000-8000-000000000001', 1) a),
  '1500', 'and the sum then covers only the days inside it');
select is(
  (select count(*) from app_private.seller_promotion_analytics('a1000000-0000-4000-8000-000000000001', 30) a
    where a.impressions = '999999' or a.views = '888888' or a.clicks = '777777'),
  0::bigint, 'none of the other seller''s analytics reaches this one');
select is(
  (select count(*) from app_private.seller_promotion_analytics('a1000000-0000-4000-8000-000000000001', 30) a
    where a::text like '%12000000-0000-4000-8000%'),
  0::bigint, 'and no promotion id appears in the answer');
select is(
  (select a.listing_slug from app_private.seller_promotion_analytics(
     'a1000000-0000-4000-8000-000000000002', 30) a),
  'jread-other-listing', 'the other seller reads their own');
select is(
  (select count(*) from app_private.seller_promotion_analytics('a1000000-0000-4000-8000-000000000005', 30)),
  0::bigint, 'a storefront with no promotions has no analytics, honestly empty');
select is(
  (select a.outcome from app_private.seller_promotion_analytics('a1000000-0000-4000-8000-000000000004', 30) a),
  'not_found', 'an account with no storefront is not_found');
select is(
  (select a.outcome from app_private.seller_promotion_analytics(null, 30) a),
  'not_found', 'and so is no caller');
select is(
  (select count(*) from app_private.seller_promotion_analytics('a1000000-0000-4000-8000-000000000001', 9999)),
  1::bigint, 'an absurd window is clamped rather than obeyed');
select is(
  (select count(*) from app_private.seller_promotion_analytics('a1000000-0000-4000-8000-000000000001', null)),
  1::bigint, 'and an unstated window takes the default');

-- Narrowed by 0102, which added the listing rollup this assertion said did not exist and a reader for it.
-- The half that belongs to 6-J still holds exactly as written: this migration's own promotion reader is not
-- duplicated or overloaded, and **no seller reader anywhere reads the raw event stream** — 0102's reads the
-- rollup, which is the distinction the original assertion was protecting.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller%promotion%analytic%'),
  1::bigint, 'exactly one promotion analytics reader exists, and it is 6-J''s');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller%analytic%'
      and p.prosrc ~ 'listing_events'),
  0::bigint, 'and no seller analytics reader touches listing_events: the rollup is what gets read');
select is(
  (select count(*) from read_surface r where r.code like '%listing_events%'),
  0::bigint,
  'and no reader counts raw listing events into a metric, which would be inventing a KPI definition');

-- ---------------------------------------------------------------------------------------------------
-- Nothing wrote. Proven by counting, not by reading the source again.
-- ---------------------------------------------------------------------------------------------------
select is(
  (select row(o.orders, o.order_items, o.reviews, o.review_replies, o.seller_balances, o.promotions,
              o.promotion_analytics, o.listings, o.seller_profiles, o.outbox_events, o.notifications,
              o.audit_logs)::text
     from (select
       (select count(*) from public.orders) as orders,
       (select count(*) from public.order_items) as order_items,
       (select count(*) from public.reviews) as reviews,
       (select count(*) from public.review_replies) as review_replies,
       (select count(*) from public.seller_balances) as seller_balances,
       (select count(*) from public.promotions) as promotions,
       (select count(*) from public.promotion_analytics) as promotion_analytics,
       (select count(*) from public.listings) as listings,
       (select count(*) from public.seller_profiles) as seller_profiles,
       (select count(*) from public.outbox_events) as outbox_events,
       (select count(*) from public.notifications) as notifications,
       (select count(*) from audit.audit_logs) as audit_logs) o),
  (select row(b.orders, b.order_items, b.reviews, b.review_replies, b.seller_balances, b.promotions,
              b.promotion_analytics, b.listings, b.seller_profiles, b.outbox_events, b.notifications,
              b.audit_logs)::text from before_counts b),
  'after every reader has been called many times over, not one row was inserted or deleted anywhere they reach — orders, items, reviews, replies, balances, promotions, analytics, listings, profiles, the outbox, notifications or the audit log');
select is(
  (select row(
     (select max(updated_at) from public.orders),
     (select max(updated_at) from public.reviews),
     (select max(updated_at) from public.seller_balances),
     (select max(updated_at) from public.promotions))::text),
  (select row(s.orders_updated, s.reviews_updated, s.balances_updated, s.promotions_updated)::text
     from before_stamps s),
  'and no updated_at moved, so nothing was touched in place either');

select * from finish();
rollback;
