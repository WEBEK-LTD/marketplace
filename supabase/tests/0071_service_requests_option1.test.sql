-- pgTAP — migration 0071: service requests and quotes, Option 1.
--
-- Nine things are being held to account.
--
-- **Both state machines are 0015's, and nothing else exists.** Every legal move is driven and every illegal
-- one attempted: a request that is cancelled, declined or accepted refuses every further move, and so does
-- a quote that is accepted, rejected, withdrawn or expired. No function assigns `expired` to either table,
-- asserted on the sources as well as by driving them.
--
-- **The trigger is 0015's and is not duplicated.** `tg_service_quotes_rule` is what moves a request from
-- `open` to `quoted`, and it is what refuses a quote from the wrong seller or on a closed request. Proven by
-- observing the promotion and by finding it in no function this migration defines.
--
-- **Ownership is the statement's.** A buyer cannot quote or withdraw a quote; a seller cannot create a
-- request, cancel one, or accept or reject a quote; neither can reach a third party's rows, and another
-- storefront's request is not refused but never matched.
--
-- **Only a purchasable, custom-priced service can receive a brief**, which is v5.2's own division. A fixed
-- service, a draft listing, the seller's own listing and a blocked pair are each refused with their own
-- outcome.
--
-- **Acceptance writes two rows in one transaction.** The quote takes all five obligation columns together,
-- the request is closed as `accepted` — the only path to that status anywhere — and both come from one
-- timestamp.
--
-- **`payment_due_at = accepted_at + finance.payment_due_hours`, exactly**, proven at 48, proven again after
-- the setting is changed, and proven not to be `offers.default_expiry_hours` nor the quote's own validity
-- window by making all three differ.
--
-- **A missing or unusable payment window writes nothing.** Absent, wrong type, zero and negative each
-- answer `payment_policy_missing` and leave both rows untouched. There is no `48` in the function's source.
--
-- **The validity window is the seller's and is bounded by 0015's own 1..365.** `expires_at` has no default
-- in the schema, so it is supplied; 0 and 366 are refused.
--
-- **Quote expiry stays 0032's.** A lapsed quote is not actionable by anybody, an accepted quote whose window
-- has passed is not re-expired, and the sweeper still only looks at `sent`.
--
-- Deterministic: fixed uuids, no wall-clock dependence beyond the intervals it sets itself. Everything runs
-- in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(203);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('d1000000-0000-4000-8000-00000000000a', 'sr-buyer-a@test.invalid'),
  ('d1000000-0000-4000-8000-00000000000b', 'sr-buyer-b@test.invalid'),
  ('d1000000-0000-4000-8000-00000000000c', 'sr-buyer-blocked@test.invalid'),
  ('d1000000-0000-4000-8000-000000000011', 'sr-seller-one@test.invalid'),
  ('d1000000-0000-4000-8000-000000000012', 'sr-seller-two@test.invalid');

insert into public.profiles (id, display_name) values
  ('d1000000-0000-4000-8000-00000000000a', 'Buyer A'),
  ('d1000000-0000-4000-8000-00000000000b', 'Buyer B'),
  ('d1000000-0000-4000-8000-00000000000c', 'Blocked Buyer')
on conflict (id) do update set display_name = excluded.display_name;

insert into public.seller_profiles
  (user_id, slug, display_name, country_code, status, verification_status, verified_at)
values
  ('d1000000-0000-4000-8000-000000000011', 'sr-shop-one', 'Service Shop One', 'EG', 'active',
   'verified', now() - interval '10 days'),
  ('d1000000-0000-4000-8000-000000000012', 'sr-shop-two', 'Service Shop Two', 'EG', 'active',
   'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('d1000000-0000-4000-8000-0000000000c1', null, 'sr-services', true, 92);
insert into public.category_translations (category_id, locale_code, name) values
  ('d1000000-0000-4000-8000-0000000000c1', 'en', 'Custom work'),
  ('d1000000-0000-4000-8000-0000000000c1', 'ar', 'أعمال مخصصة');

create or replace function pg_temp.service(
  p_id uuid, p_slug text, p_status text, p_seller uuid, p_pricing text
) returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at, approved_at
  ) values (
    p_id, p_seller, 'service', 'd1000000-0000-4000-8000-0000000000c1', p_slug,
    'A quotable service', 'A description long enough to satisfy the length rule.', 'en',
    'EGP', case when p_pricing = 'fixed' then 250000 else null end, false, p_status, 'EG', 'Cairo',
    now() - interval '1 hour',
    case when p_status in ('approved', 'active', 'sold', 'expired', 'archived')
      then now() - interval '1 hour' else null end
  );
  insert into public.listing_service_details (listing_id, pricing_model, delivery_days, scope)
  values (p_id, p_pricing, case when p_pricing = 'fixed' then 7 else null end,
          'The scope of the service, at least ten characters.');
end;
$$;

select pg_temp.service('d1000000-0000-4000-8000-0000000000f1', 'sr-custom-one', 'active',
  'd1000000-0000-4000-8000-000000000011', 'custom');
select pg_temp.service('d1000000-0000-4000-8000-0000000000f2', 'sr-custom-two', 'active',
  'd1000000-0000-4000-8000-000000000012', 'custom');
select pg_temp.service('d1000000-0000-4000-8000-0000000000f3', 'sr-fixed', 'active',
  'd1000000-0000-4000-8000-000000000011', 'fixed');
select pg_temp.service('d1000000-0000-4000-8000-0000000000f4', 'sr-draft', 'draft',
  'd1000000-0000-4000-8000-000000000011', 'custom');

insert into public.user_blocks (blocker_id, blocked_id) values
  ('d1000000-0000-4000-8000-000000000011', 'd1000000-0000-4000-8000-00000000000c');

-- Shorthands -----------------------------------------------------------------------------------------
create or replace function pg_temp.request_status(p_id uuid) returns text
language sql as $$ select r.status from public.service_requests r where r.id = p_id; $$;

create or replace function pg_temp.quote_status(p_id uuid) returns text
language sql as $$ select q.status from public.service_quotes q where q.id = p_id; $$;

create or replace function pg_temp.brief(p_buyer uuid, p_listing uuid, p_title text) returns uuid
language sql as $$
  select request_id from app_private.service_request_create(
    p_buyer, p_listing, p_title, 'A brief that is comfortably longer than ten characters.', 500000, null);
$$;

-- ---------------------------------------------------------------------------------------------------
-- 1. The migration's shape
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('service_requests_for_buyer', 'service_requests_for_seller',
                        'service_request_detail', 'service_request_create', 'service_request_cancel',
                        'service_request_decline', 'service_quote_create', 'service_quote_withdraw',
                        'service_quote_reject', 'service_quote_accept')),
  10, '0071 defines exactly ten functions');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'service\_request%' or p.proname like 'service\_quote\_%')
      and p.proname <> 'tg_service_quotes_rule'
      and (not p.prosecdef
           or not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                           where cfg = 'search_path=pg_catalog, public'))),
  0, 'all of them are SECURITY DEFINER with the pinned search_path');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'service\_request%' or p.proname like 'service\_quote\_%')
      and p.proname <> 'tg_service_quotes_rule'
      and (has_function_privilege('public', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('app_worker', p.oid, 'execute'))),
  0, 'neither PUBLIC, authenticated nor app_worker may execute any of them');

-- Named one by one rather than counted over a prefix, so that a later migration adding a function of its
-- own under the same prefix — 0072's two staff predicates do — cannot make this assertion pass or fail for
-- a reason that has nothing to do with these ten.
-- All ten when 0071 closed. Since 0110 the ten are split by OD-A4: a buyer still reaches their own
-- requests, but nothing that needs a seller on the other side is reachable by the API. Both halves are
-- asserted by name, so neither can pass because the other changed.
select set_eq(
  $q$select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private'
        and p.proname in (
          'service_requests_for_buyer', 'service_requests_for_seller', 'service_request_detail',
          'service_request_create', 'service_request_cancel', 'service_request_decline',
          'service_quote_create', 'service_quote_withdraw', 'service_quote_reject', 'service_quote_accept')
        and has_function_privilege('app_system', p.oid, 'execute')$q$,
  $q$values ('service_requests_for_buyer'), ('service_request_detail'), ('service_request_cancel')$q$,
  'app_system reaches only the buyer''s own three: their list, one request, and withdrawing it');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in (
        'service_requests_for_seller', 'service_request_create', 'service_request_decline',
        'service_quote_create', 'service_quote_withdraw', 'service_quote_reject', 'service_quote_accept')
      and has_function_privilege('app_system', p.oid, 'execute')),
  0, 'and none of the seven that need a seller on the other side — the quote path is closed (OD-A4)');

-- 0015's model is untouched. Asserted by name rather than by count, because 0072 adds the two staff
-- policies D7-10's keys are enforced by — which is a foundation for Option 2, not a change to these three.
select is(
  (select string_agg(p.polname, ',' order by p.polname) from pg_policy p
    where p.polrelid = 'public.service_requests'::regclass
      and p.polname in ('service_requests_party_read', 'service_requests_buyer_insert',
                        'service_requests_party_update')),
  'service_requests_buyer_insert,service_requests_party_read,service_requests_party_update',
  'service_requests still carries 0015''s three policies, unaltered');
select is(
  (select count(*)::int from pg_policy p where p.polrelid = 'public.service_requests'::regclass),
  5, 'and exactly two more: 0072''s staff read and staff manage, and nothing else');
select is(
  (select count(*)::int from pg_policy p where p.polrelid = 'public.service_quotes'::regclass),
  3, 'service_quotes still carries exactly 0015''s three policies');
select is(
  (select count(*)::int from pg_trigger t
    where t.tgrelid = 'public.service_quotes'::regclass and not t.tgisinternal),
  2, 'service_quotes still carries exactly 0015''s two triggers');
select is(
  (select count(*)::int from pg_trigger t
    where t.tgrelid = 'public.service_requests'::regclass and not t.tgisinternal),
  1, 'and service_requests its one');
select has_index('public', 'service_quotes', 'service_quotes_one_accepted',
  '0015''s one-accepted-quote index is still there');
select has_index('public', 'service_quotes', 'service_quotes_expiring',
  'and its sent-only expiry index');

-- No function in this migration writes `expired`, and none hard-codes the payment window.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'service\_request%' or p.proname like 'service\_quote\_%')
      and p.prosrc like '%status = ''expired''%'),
  0, 'no function in 0071 assigns the expired status: 0032''s sweeper owns it');
select ok(
  (select p.prosrc not like '%48%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'service_quote_accept'),
  'the acceptance writer contains no hard-coded duration');
select ok(
  (select p.prosrc like '%finance.payment_due_hours%'
      and p.prosrc not like '%offers.default_expiry_hours%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'service_quote_accept'),
  'it reads finance.payment_due_hours and never the offers window');

-- Nothing in this migration reaches Phase 8 or invents an event.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'service\_request%' or p.proname like 'service\_quote\_%')
      and p.proname <> 'tg_service_quotes_rule'
      and (p.prosrc like '%public.orders%' or p.prosrc like '%public.checkouts%'
           or p.prosrc like '%service_deliveries%' or p.prosrc like '%ledger%'
           or p.prosrc like '%payout%' or p.prosrc like '%create_notification%'
           or p.prosrc like '%enqueue_outbox_event%')),
  0, 'no function reaches an order, checkout, delivery, ledger, payout, notification or event');

-- And nothing here reads or writes the routing column 0072 adds: every function in this migration leaves
-- it to its default, which is what makes every request Option 1 can create a `seller` request.
-- Named one by one rather than matched on a prefix, so that 7-J's Option 2 functions — whose subject is the
-- mode — cannot make this assertion fail for a reason that has nothing to do with these ten. Two of the ten
-- do *return* `routing_mode` since 7-J, so that a buyer's own surface can tell the truth about which flow a
-- brief is in; what none of them contains is the admin-only value, which is what "Option 1 does not decide
-- routing" actually means.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in (
        'service_requests_for_buyer', 'service_requests_for_seller', 'service_request_detail',
        'service_request_create', 'service_request_cancel', 'service_request_decline',
        'service_quote_create', 'service_quote_withdraw', 'service_quote_reject', 'service_quote_accept')
      and p.prosrc like '%admin_only%'),
  0, 'no Option 1 function mentions the admin-only mode, so none of them decides routing');

-- ---------------------------------------------------------------------------------------------------
-- 2. Sending a request
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-0000000000f1',
     'Build me a shelf', 'A brief that is comfortably longer than ten characters.', 400000,
     '2026-06-01')),
  'created', 'a buyer sends a brief to a custom service');

create or replace function pg_temp.request_a() returns uuid language sql as $$
  select r.id from public.service_requests r
   where r.buyer_user_id = 'd1000000-0000-4000-8000-00000000000a'
     and r.title = 'Build me a shelf';
$$;

select is(pg_temp.request_status(pg_temp.request_a()), 'open', 'it is open');
select is(
  (select r.seller_user_id from public.service_requests r where r.id = pg_temp.request_a()),
  'd1000000-0000-4000-8000-000000000011'::uuid,
  'the seller came from the listing, not from the caller');
select is(
  (select r.currency_code::text from public.service_requests r where r.id = pg_temp.request_a()),
  'EGP', 'and so did the currency');
select is(
  (select r.needed_by from public.service_requests r where r.id = pg_temp.request_a()),
  '2026-06-01'::date, 'the date the buyer stated is kept');
select is(
  (select r.closed_at from public.service_requests r where r.id = pg_temp.request_a()),
  null, 'an open request has no closing time, which 0015''s constraint requires');

select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-0000000000f3',
     'Fixed thing', 'A brief that is comfortably longer than ten characters.', null, null)),
  'not_custom', 'a fixed-price service cannot receive a brief: it is bought through the cart');
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-0000000000f4',
     'Draft thing', 'A brief that is comfortably longer than ten characters.', null, null)),
  'not_available', 'a draft listing cannot receive one either');
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-0000000000ff',
     'Nothing', 'A brief that is comfortably longer than ten characters.', null, null)),
  'not_found', 'nor can a listing that does not exist');
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-000000000011', 'd1000000-0000-4000-8000-0000000000f1',
     'My own', 'A brief that is comfortably longer than ten characters.', null, null)),
  'own_listing', 'a seller cannot brief their own service');
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000c', 'd1000000-0000-4000-8000-0000000000f1',
     'Blocked', 'A brief that is comfortably longer than ten characters.', null, null)),
  'blocked', 'a blocked pair cannot open one, exactly as 0015''s insert policy says');
select is(
  (select outcome from app_private.service_request_create(
     null, 'd1000000-0000-4000-8000-0000000000f1', 'No one',
     'A brief that is comfortably longer than ten characters.', null, null)),
  'not_found', 'and no account cannot');

select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000b', 'd1000000-0000-4000-8000-0000000000f1', 'ab',
     'A brief that is comfortably longer than ten characters.', null, null)),
  'invalid', 'a title shorter than 0015 allows is refused');
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000b', 'd1000000-0000-4000-8000-0000000000f1',
     repeat('x', 141), 'A brief that is comfortably longer than ten characters.', null, null)),
  'invalid', 'and one longer');
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000b', 'd1000000-0000-4000-8000-0000000000f1', 'Fine title',
     'too short', null, null)),
  'invalid', 'a brief shorter than 0015 allows is refused');
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000b', 'd1000000-0000-4000-8000-0000000000f1', 'Fine title',
     repeat('x', 10001), null, null)),
  'invalid', 'and one longer');
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000b', 'd1000000-0000-4000-8000-0000000000f1', 'Fine title',
     'A brief that is comfortably longer than ten characters.', 0, null)),
  'invalid', 'a zero budget is refused, as 0015''s own check would');
select is(
  (select count(*)::int from public.service_requests r
    where r.buyer_user_id = 'd1000000-0000-4000-8000-00000000000b'),
  0, 'none of those six wrote anything');

-- ---------------------------------------------------------------------------------------------------
-- 3. Ownership isolation on every write
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_request_cancel(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a())),
  'not_found', 'the seller cannot cancel the buyer''s request');
select is(
  (select outcome from app_private.service_request_decline(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a())),
  'not_found', 'the buyer cannot decline their own request through the seller''s path');
select is(
  (select outcome from app_private.service_request_cancel(
     'd1000000-0000-4000-8000-00000000000b', pg_temp.request_a())),
  'not_found', 'another buyer cannot cancel it');
select is(
  (select outcome from app_private.service_request_decline(
     'd1000000-0000-4000-8000-000000000012', pg_temp.request_a())),
  'not_found', 'another seller cannot decline it');
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000012', pg_temp.request_a(), 400000, 7::smallint, 1::smallint,
     'A scope long enough to pass the check.', 14::smallint)),
  'not_found', 'and another seller cannot quote on it — 0015''s own rule, reported not raised');
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a(), 400000, 7::smallint, 1::smallint,
     'A scope long enough to pass the check.', 14::smallint)),
  'not_found', 'nor can the buyer quote on their own brief');
select is(pg_temp.request_status(pg_temp.request_a()), 'open',
  'and after all six cross-party attempts the request is untouched');

-- ---------------------------------------------------------------------------------------------------
-- 4. The reads are scoped
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.service_requests_for_buyer(
     'd1000000-0000-4000-8000-00000000000a', 20, null, null)),
  1, 'the buyer sees their own request');
select is(
  (select count(*)::int from app_private.service_requests_for_buyer(
     'd1000000-0000-4000-8000-000000000011', 20, null, null)),
  0, 'the seller sees nothing on the buyer''s list');
select is(
  (select count(*)::int from app_private.service_requests_for_seller(
     'd1000000-0000-4000-8000-000000000011', 20, null, null)),
  1, 'and the seller sees it in their inbox');
select is(
  (select count(*)::int from app_private.service_requests_for_seller(
     'd1000000-0000-4000-8000-000000000012', 20, null, null)),
  0, 'another storefront''s inbox is empty');
select is(
  (select count(*)::int from app_private.service_requests_for_seller(
     'd1000000-0000-4000-8000-00000000000a', 20, null, null)),
  0, 'a buyer sees nothing on the seller''s list');
select is(
  (select count(*)::int from app_private.service_requests_for_buyer(null, 20, null, null)),
  0, 'and no account sees nothing');

select is(
  (select counterparty_name from app_private.service_requests_for_buyer(
     'd1000000-0000-4000-8000-00000000000a', 20, null, null)),
  'Service Shop One', 'the buyer''s row names the storefront');
select is(
  (select counterparty_name from app_private.service_requests_for_seller(
     'd1000000-0000-4000-8000-000000000011', 20, null, null)),
  'Buyer A', 'the seller''s row names the buyer by display name');
select is(
  (select currency_minor_unit from app_private.service_requests_for_buyer(
     'd1000000-0000-4000-8000-00000000000a', 20, null, null)),
  2::smallint, 'money travels with its authoritative decimal places');
select is(
  (select quote_count from app_private.service_requests_for_buyer(
     'd1000000-0000-4000-8000-00000000000a', 20, null, null)),
  0, 'with no quotes yet');
select is(
  (select listing_slug from app_private.service_requests_for_buyer(
     'd1000000-0000-4000-8000-00000000000a', 20, null, null)),
  'sr-custom-one', 'and the service it is about');

select is(
  (select count(*)::int from unnest(
     (select p.proargnames from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app_private' and p.proname = 'service_requests_for_seller')) name
    where name in ('buyer_user_id', 'seller_user_id', 'user_id')),
  0, 'the seller''s list returns no account identifier');
select is(
  (select count(*)::int from unnest(
     (select p.proargnames from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app_private' and p.proname = 'service_request_detail')) name
    where name in ('buyer_user_id', 'seller_user_id')),
  0, 'and neither does the detail');

select is(
  (select count(*)::int from app_private.service_requests_for_buyer(
     'd1000000-0000-4000-8000-00000000000a', 0, null, null)),
  1, 'a zero limit is clamped up to one');
select is(
  (select count(*)::int from app_private.service_requests_for_buyer(
     'd1000000-0000-4000-8000-00000000000a', 500, null, null)),
  1, 'and an oversized one is clamped down');
select is(
  (select count(*)::int from app_private.service_requests_for_buyer(
     'd1000000-0000-4000-8000-00000000000a', 20,
     (select r.created_at from public.service_requests r where r.id = pg_temp.request_a()),
     pg_temp.request_a())),
  0, 'the page after the last row is empty');

-- ---------------------------------------------------------------------------------------------------
-- 5. The detail, from both sides and from neither
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a())),
  'found', 'the buyer reads their own request');
select is(
  (select is_buyer from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a())),
  true, 'and is told they are the buyer');
select is(
  (select is_seller from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a())),
  false, 'and not the seller');
select is(
  (select is_seller from app_private.service_request_detail(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a())),
  true, 'the seller reads the same request and is told they are the seller');
select is(
  (select is_buyer from app_private.service_request_detail(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a())),
  false, 'and not the buyer: 0015''s not-self constraint makes both impossible');
select is(
  (select brief from app_private.service_request_detail(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a())),
  'A brief that is comfortably longer than ten characters.',
  'the seller can read the brief they were sent');
select is(
  (select jsonb_array_length(quotes) from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a())),
  0, 'with no quotes on it yet');
select is(
  (select outcome from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000b', pg_temp.request_a())),
  'not_found', 'a third party reads nothing');
select is(
  (select outcome from app_private.service_request_detail(
     'd1000000-0000-4000-8000-000000000012', pg_temp.request_a())),
  'not_found', 'and so does another seller — identical to a request that is not there');
select is(
  (select outcome from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-0000000000ff')),
  'not_found', 'as does a request that does not exist');
select is(
  (select outcome from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000a', null)),
  'not_found', 'and no request at all');

-- ---------------------------------------------------------------------------------------------------
-- 6. Quoting, and 0015's trigger doing the promotion
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a(), 380000, 10::smallint, 2::smallint,
     'A scope long enough to satisfy the ten-character rule.', 14::smallint)),
  'created', 'the seller the brief was sent to quotes on it');

create or replace function pg_temp.quote_one() returns uuid language sql as $$
  select q.id from public.service_quotes q
   where q.service_request_id = pg_temp.request_a() and q.amount_minor = 380000;
$$;

select is(pg_temp.quote_status(pg_temp.quote_one()), 'sent', 'the quote is sent');
select is(pg_temp.request_status(pg_temp.request_a()), 'quoted',
  '0015''s own tg_service_quotes_rule moved the request from open to quoted');
select is(
  (select q.currency_code::text from public.service_quotes q where q.id = pg_temp.quote_one()),
  'EGP', 'the currency was copied from the request, so 0015''s composite key cannot be violated');
select is(
  (select q.delivery_days from public.service_quotes q where q.id = pg_temp.quote_one()),
  10::smallint, 'the delivery time is the one quoted');
select is(
  (select q.revisions_included from public.service_quotes q where q.id = pg_temp.quote_one()),
  2::smallint, 'and the revisions');
select ok(
  (select q.expires_at > now() + interval '13 days' and q.expires_at <= now() + interval '14 days'
     from public.service_quotes q where q.id = pg_temp.quote_one()),
  'the validity window is the seller''s fourteen days, which the schema leaves to the writer');
select is(
  (select q.accepted_at from public.service_quotes q where q.id = pg_temp.quote_one()),
  null, 'a sent quote has no acceptance time');
select is(
  (select q.payment_due_at from public.service_quotes q where q.id = pg_temp.quote_one()),
  null, 'and no payment deadline: that is acceptance''s to set');

-- The validity window's bound is 0015's own.
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a(), 390000, 7::smallint, 0::smallint,
     'A scope long enough to satisfy the ten-character rule.', 0::smallint)),
  'invalid', 'a validity window of zero days is refused');
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a(), 390000, 7::smallint, 0::smallint,
     'A scope long enough to satisfy the ten-character rule.', 366::smallint)),
  'invalid', 'and one beyond 0015''s own 1..365');
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a(), 0, 7::smallint, 0::smallint,
     'A scope long enough to satisfy the ten-character rule.', 14::smallint)),
  'invalid', 'a zero amount is refused');
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a(), 390000, 0::smallint, 0::smallint,
     'A scope long enough to satisfy the ten-character rule.', 14::smallint)),
  'invalid', 'a delivery time of zero days is refused');
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a(), 390000, 366::smallint, 0::smallint,
     'A scope long enough to satisfy the ten-character rule.', 14::smallint)),
  'invalid', 'and one beyond 0015''s range');
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a(), 390000, 7::smallint, -1::smallint,
     'A scope long enough to satisfy the ten-character rule.', 14::smallint)),
  'invalid', 'a negative revision count is refused');
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a(), 390000, 7::smallint, 0::smallint,
     'short', 14::smallint)),
  'invalid', 'a scope shorter than 0015 allows is refused');
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a(), 390000, 7::smallint, 0::smallint,
     repeat('x', 10001), 14::smallint)),
  'invalid', 'and one longer');
select is(
  (select count(*)::int from public.service_quotes q where q.service_request_id = pg_temp.request_a()),
  1, 'none of those eight wrote a quote');

-- A second quote on the same request is allowed while it is still quoted.
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a(), 420000, 5::smallint, 3::smallint,
     'A second scope, also longer than ten characters.', 7::smallint)),
  'created', 'the seller may send a second quote while the request is still open to them');
select is(
  (select count(*)::int from public.service_quotes q where q.service_request_id = pg_temp.request_a()),
  2, 'and both exist');
select is(
  (select live_quote_count from app_private.service_requests_for_buyer(
     'd1000000-0000-4000-8000-00000000000a', 20, null, null)),
  2, 'the buyer''s row counts both as live');
select is(
  (select jsonb_array_length(quotes) from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a())),
  2, 'and the detail carries both');
-- Both quotes were written inside one transaction, so `created_at` is identical for them and the order
-- between them is settled by the identifier tie-break. That tie-break is total and stable, but it is not
-- something a test can predict, so the two properties that matter are asserted separately: that every amount
-- crosses as a string, and that the order really is newest-first once the two rows differ in time — which is
-- the only case a reader can observe.
select is(
  (select count(*)::int from jsonb_array_elements(
     (select quotes from app_private.service_request_detail(
        'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a()))) e
    where jsonb_typeof(e.value -> 'amountMinor') = 'string'),
  2, 'both amounts cross as strings rather than JSON numbers');
select is(
  (select quotes from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a())),
  (select quotes from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a())),
  'and the order is deterministic: two reads of the same rows agree');

update public.service_quotes set created_at = now() - interval '1 hour'
 where service_request_id = pg_temp.request_a() and amount_minor = 380000;
select is(
  (select quotes -> 0 ->> 'amountMinor' from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a())),
  '420000', 'the newer quote is first');
update public.service_quotes set created_at = now() - interval '2 hours'
 where service_request_id = pg_temp.request_a() and amount_minor = 420000;
select is(
  (select quotes -> 0 ->> 'amountMinor' from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a())),
  '380000', 'and the other way round once the older one becomes the newer');
select is(
  (select count(*)::int from jsonb_array_elements(
     (select quotes from app_private.service_request_detail(
        'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a()))) q
    where q.value ? 'sellerUserId' or q.value ? 'seller_user_id'),
  0, 'and no account identifier on any quote');

create or replace function pg_temp.quote_two() returns uuid language sql as $$
  select q.id from public.service_quotes q
   where q.service_request_id = pg_temp.request_a() and q.amount_minor = 420000;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 7. Withdrawing and rejecting a quote
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_quote_withdraw(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_two())),
  'not_found', 'the buyer cannot withdraw the seller''s quote');
select is(
  (select outcome from app_private.service_quote_withdraw(
     'd1000000-0000-4000-8000-000000000012', pg_temp.quote_two())),
  'not_found', 'nor can another seller');
select is(
  (select outcome from app_private.service_quote_reject(
     'd1000000-0000-4000-8000-000000000011', pg_temp.quote_two())),
  'not_found', 'the seller cannot reject their own quote through the buyer''s path');
select is(
  (select outcome from app_private.service_quote_reject(
     'd1000000-0000-4000-8000-00000000000b', pg_temp.quote_two())),
  'not_found', 'and another buyer cannot reject it');
select is(pg_temp.quote_status(pg_temp.quote_two()), 'sent', 'the quote is untouched by all four');

select is(
  (select outcome from app_private.service_quote_withdraw(
     'd1000000-0000-4000-8000-000000000011', pg_temp.quote_two())),
  'withdrawn', 'the seller takes their own second quote back');
-- Each quote writer reports the request the quote belongs to, so the API can refuse a quote id spent
-- against a different request without asking a second question.
select is(
  (select request_id from app_private.service_quote_withdraw(
     'd1000000-0000-4000-8000-000000000011', pg_temp.quote_two())),
  pg_temp.request_a(), 'and reports which request the quote belonged to');
select is(pg_temp.quote_status(pg_temp.quote_two()), 'withdrawn', 'the row says so');
select ok(
  (select q.responded_at is not null from public.service_quotes q where q.id = pg_temp.quote_two()),
  'and records when');
select is(
  (select outcome from app_private.service_quote_withdraw(
     'd1000000-0000-4000-8000-000000000011', pg_temp.quote_two())),
  'conflict', 'withdrawing it again is a conflict');
select is(
  (select outcome from app_private.service_quote_accept(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_two())),
  'conflict', 'and a withdrawn quote cannot be accepted');
select is(
  (select outcome from app_private.service_quote_reject(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_two())),
  'conflict', 'nor rejected');
select is(pg_temp.request_status(pg_temp.request_a()), 'quoted',
  'and withdrawing a quote does not close the request');

-- Rejecting leaves the request open to another quote.
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a(), 450000, 3::smallint, 0::smallint,
     'A third scope, also longer than ten characters.', 7::smallint)),
  'created', 'a third quote is sent');

create or replace function pg_temp.quote_three() returns uuid language sql as $$
  select q.id from public.service_quotes q
   where q.service_request_id = pg_temp.request_a() and q.amount_minor = 450000;
$$;

select is(
  (select outcome from app_private.service_quote_reject(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_three())),
  'rejected', 'the buyer rejects it');
select is(
  (select request_id from app_private.service_quote_reject(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_three())),
  pg_temp.request_a(), 'reporting the request it belonged to');
select is(pg_temp.quote_status(pg_temp.quote_three()), 'rejected', 'the row says so');
select is(pg_temp.request_status(pg_temp.request_a()), 'quoted',
  'and the request stays open, because 0015''s trigger still admits further quotes');
select is(
  (select q.accepted_at from public.service_quotes q where q.id = pg_temp.quote_three()),
  null, 'a rejection records no acceptance time');
select is(
  (select q.payment_due_at from public.service_quotes q where q.id = pg_temp.quote_three()),
  null, 'and no payment deadline');
select is(
  (select outcome from app_private.service_quote_reject(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_three())),
  'conflict', 'rejecting it again is a conflict');

-- ---------------------------------------------------------------------------------------------------
-- 8. Acceptance, and the payment window
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_quote_accept(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_one())),
  'accepted', 'the buyer accepts the first quote');

select is(pg_temp.quote_status(pg_temp.quote_one()), 'accepted', 'the quote is accepted');
select is(
  (select request_id from app_private.service_quote_accept(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_one())),
  pg_temp.request_a(), 'and acceptance reports the request too, even on the repeat that conflicts');
select ok(
  (select q.accepted_at is not null from public.service_quotes q where q.id = pg_temp.quote_one()),
  'the acceptance time is recorded, which 0015''s constraint requires');
select is(
  (select q.responded_at from public.service_quotes q where q.id = pg_temp.quote_one()),
  (select q.accepted_at from public.service_quotes q where q.id = pg_temp.quote_one()),
  'the response time is the same value, so the two cannot disagree');
select ok(
  (select jsonb_typeof(q.accepted_terms) = 'object' from public.service_quotes q
    where q.id = pg_temp.quote_one()),
  'the terms are snapshotted as an object, which 0015''s constraint requires');
select ok(
  (select q.payment_due_at is not null from public.service_quotes q where q.id = pg_temp.quote_one()),
  'and the payment deadline is set');

-- The second row: the request is closed as accepted, which is the only way it reaches that status.
select is(pg_temp.request_status(pg_temp.request_a()), 'accepted', 'the request is closed as accepted');
select ok(
  (select r.closed_at is not null from public.service_requests r where r.id = pg_temp.request_a()),
  'with the closing time 0015''s constraint requires');
select is(
  (select r.closed_at from public.service_requests r where r.id = pg_temp.request_a()),
  (select q.accepted_at from public.service_quotes q where q.id = pg_temp.quote_one()),
  'from the same timestamp as the acceptance, so the two rows cannot diverge');

-- **The calculation.**
select is(
  (select q.payment_due_at - q.accepted_at from public.service_quotes q where q.id = pg_temp.quote_one()),
  interval '48 hours',
  'payment_due_at is exactly accepted_at plus finance.payment_due_hours');
select is(
  (select q.accepted_terms ->> 'payment_due_hours' from public.service_quotes q
    where q.id = pg_temp.quote_one()),
  '48', 'and the window that was applied is in the snapshot');
select is(
  (select q.accepted_terms ->> 'amount_minor' from public.service_quotes q where q.id = pg_temp.quote_one()),
  '380000', 'the snapshot carries the agreed amount, as a string');
select is(
  (select q.accepted_terms ->> 'currency_code' from public.service_quotes q where q.id = pg_temp.quote_one()),
  'EGP', 'its currency');
select is(
  (select (q.accepted_terms ->> 'delivery_days')::int from public.service_quotes q
    where q.id = pg_temp.quote_one()),
  10, 'the delivery time that was agreed');
select is(
  (select (q.accepted_terms ->> 'revisions_included')::int from public.service_quotes q
    where q.id = pg_temp.quote_one()),
  2, 'the revisions');
select is(
  (select q.accepted_terms ->> 'service_request_id' from public.service_quotes q
    where q.id = pg_temp.quote_one()),
  pg_temp.request_a()::text, 'and the brief it answers');
select is(
  (select count(*)::int from jsonb_object_keys(
     (select q.accepted_terms from public.service_quotes q where q.id = pg_temp.quote_one())) k),
  6, 'the snapshot has exactly those six keys and invents no term');

-- Nothing beyond the obligation happened.
select is((select count(*)::int from public.service_deliveries), 0,
  'no delivery row was created: that belongs to the order, not to the quote');
select is(
  (select count(*)::int from public.notifications n
    where n.subject_type = 'service_request' or n.category = 'orders'),
  0, 'and no notification: none is defined for this domain in the repository');
select is(
  (select count(*)::int from public.outbox_events e
    where e.aggregate_type in ('service_request', 'service_quote')
      and e.event_type <> 'service_quote.expired'),
  0, 'nor any event other than 0032''s own service_quote.expired');

-- Repetition, and the closed request.
select is(
  (select outcome from app_private.service_quote_accept(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_one())),
  'conflict', 'accepting the same quote again is a conflict');
select is(
  (select outcome from app_private.service_quote_reject(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_one())),
  'conflict', 'an accepted quote cannot then be rejected');
select is(
  (select outcome from app_private.service_quote_withdraw(
     'd1000000-0000-4000-8000-000000000011', pg_temp.quote_one())),
  'conflict', 'nor withdrawn by the seller');
select is(
  (select outcome from app_private.service_request_cancel(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_a())),
  'conflict', 'and a closed request cannot be cancelled');
select is(
  (select outcome from app_private.service_request_decline(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a())),
  'conflict', 'nor declined');
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_a(), 460000, 3::smallint, 0::smallint,
     'A fourth scope, also longer than ten characters.', 7::smallint)),
  'conflict', 'nor quoted on again');
select is(pg_temp.quote_status(pg_temp.quote_one()), 'accepted', 'and the accepted quote is unchanged');
select is(
  (select q.payment_due_at - q.accepted_at from public.service_quotes q where q.id = pg_temp.quote_one()),
  interval '48 hours', 'with the deadline the first acceptance set');
select is(
  (select count(*)::int from public.service_quotes q
    where q.service_request_id = pg_temp.request_a() and q.status = 'accepted'),
  1, 'exactly one accepted quote per request, which 0015''s unique index requires');

-- ---------------------------------------------------------------------------------------------------
-- 9. The deadline is the payment window and nothing else
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000b', 'd1000000-0000-4000-8000-0000000000f1',
     'Second brief', 'A brief that is comfortably longer than ten characters.', null, null)),
  'created', 'a second buyer sends a brief, to accept under a different payment window');

create or replace function pg_temp.request_b() returns uuid language sql as $$
  select r.id from public.service_requests r
   where r.buyer_user_id = 'd1000000-0000-4000-8000-00000000000b' and r.title = 'Second brief';
$$;

select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_b(), 500000, 30::smallint, 0::smallint,
     'A scope for the second brief, longer than ten characters.', 90::smallint)),
  'created', 'the seller quotes with a ninety-day validity window');

create or replace function pg_temp.quote_b() returns uuid language sql as $$
  select q.id from public.service_quotes q where q.service_request_id = pg_temp.request_b();
$$;

update public.site_settings set value = '6'::jsonb where key = 'finance.payment_due_hours';
update public.site_settings set value = '99'::jsonb where key = 'offers.default_expiry_hours';

select is(
  (select outcome from app_private.service_quote_accept(
     'd1000000-0000-4000-8000-00000000000b', pg_temp.quote_b())),
  'accepted', 'the buyer accepts it');
select is(
  (select q.payment_due_at - q.accepted_at from public.service_quotes q where q.id = pg_temp.quote_b()),
  interval '6 hours', 'the deadline followed finance.payment_due_hours to its new value');
select isnt(
  (select q.payment_due_at - q.accepted_at from public.service_quotes q where q.id = pg_temp.quote_b()),
  interval '99 hours', 'and not offers.default_expiry_hours, which was moved at the same time');
select isnt(
  (select q.payment_due_at - q.accepted_at from public.service_quotes q where q.id = pg_temp.quote_b()),
  interval '90 days', 'and not the quote''s own ninety-day validity window either');
select is(
  (select q.accepted_terms ->> 'payment_due_hours' from public.service_quotes q where q.id = pg_temp.quote_b()),
  '6', 'the snapshot records the window that was actually applied');

update public.site_settings set value = '48'::jsonb where key = 'finance.payment_due_hours';
update public.site_settings set value = '48'::jsonb where key = 'offers.default_expiry_hours';

-- ---------------------------------------------------------------------------------------------------
-- 10. A missing or unusable payment window writes nothing
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-0000000000f2',
     'Third brief', 'A brief that is comfortably longer than ten characters.', null, null)),
  'created', 'a third brief, to the other storefront');

create or replace function pg_temp.request_c() returns uuid language sql as $$
  select r.id from public.service_requests r where r.title = 'Third brief';
$$;

select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000012', pg_temp.request_c(), 200000, 7::smallint, 0::smallint,
     'A scope for the third brief, longer than ten characters.', 14::smallint)),
  'created', 'the other seller quotes on it');

create or replace function pg_temp.quote_c() returns uuid language sql as $$
  select q.id from public.service_quotes q where q.service_request_id = pg_temp.request_c();
$$;

delete from public.site_settings where key = 'finance.payment_due_hours';
select is(
  (select outcome from app_private.service_quote_accept(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_c())),
  'payment_policy_missing', 'an absent setting is an integrity failure, never a fallback to 48');
select is(pg_temp.quote_status(pg_temp.quote_c()), 'sent', 'the quote is still sent');
select is(pg_temp.request_status(pg_temp.request_c()), 'quoted', 'and the request is still quoted');
select is(
  (select q.accepted_at from public.service_quotes q where q.id = pg_temp.quote_c()),
  null, 'with no acceptance time');
select is(
  (select r.closed_at from public.service_requests r where r.id = pg_temp.request_c()),
  null, 'and no closing time: neither row was written');

insert into public.site_settings (key, category, value, value_type, is_public, description_en, description_ar)
values ('finance.payment_due_hours', 'marketplace', '"48"'::jsonb, 'string', false, 'wrong type', 'نوع خاطئ');
select is(
  (select outcome from app_private.service_quote_accept(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_c())),
  'payment_policy_missing', 'a setting of the wrong JSON type is refused, not coerced');
update public.site_settings set value = '0'::jsonb, value_type = 'number'
 where key = 'finance.payment_due_hours';
select is(
  (select outcome from app_private.service_quote_accept(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_c())),
  'payment_policy_missing', 'a window of zero hours is refused');
update public.site_settings set value = '-5'::jsonb where key = 'finance.payment_due_hours';
select is(
  (select outcome from app_private.service_quote_accept(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_c())),
  'payment_policy_missing', 'and a negative one, which would put the deadline in the past');
select is(pg_temp.quote_status(pg_temp.quote_c()), 'sent', 'none of the three wrote anything');

update public.site_settings set value = '48'::jsonb where key = 'finance.payment_due_hours';
select is(
  (select outcome from app_private.service_quote_accept(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_c())),
  'accepted', 'and with the setting restored the same acceptance succeeds');
select is(pg_temp.request_status(pg_temp.request_c()), 'accepted', 'closing its request with it');

-- ---------------------------------------------------------------------------------------------------
-- 11. Cancelling and declining
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000b', 'd1000000-0000-4000-8000-0000000000f2',
     'Cancel me', 'A brief that is comfortably longer than ten characters.', null, null)),
  'created', 'a brief to cancel');

create or replace function pg_temp.request_x() returns uuid language sql as $$
  select r.id from public.service_requests r where r.title = 'Cancel me';
$$;

select is(
  (select outcome from app_private.service_request_cancel(
     'd1000000-0000-4000-8000-00000000000b', pg_temp.request_x())),
  'cancelled', 'the buyer cancels it while it is open');
select is(pg_temp.request_status(pg_temp.request_x()), 'cancelled', 'the row says so');
select ok(
  (select r.closed_at is not null from public.service_requests r where r.id = pg_temp.request_x()),
  'with the closing time 0015''s constraint requires');
select is(
  (select outcome from app_private.service_request_cancel(
     'd1000000-0000-4000-8000-00000000000b', pg_temp.request_x())),
  'conflict', 'cancelling it again is a conflict');
select is(
  (select outcome from app_private.service_request_decline(
     'd1000000-0000-4000-8000-000000000012', pg_temp.request_x())),
  'conflict', 'and a cancelled request cannot then be declined');
select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000012', pg_temp.request_x(), 100000, 7::smallint, 0::smallint,
     'A scope for a cancelled brief, longer than ten characters.', 14::smallint)),
  'conflict', 'nor quoted on');

select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000b', 'd1000000-0000-4000-8000-0000000000f1',
     'Decline me', 'A brief that is comfortably longer than ten characters.', null, null)),
  'created', 'a brief to decline');

create or replace function pg_temp.request_y() returns uuid language sql as $$
  select r.id from public.service_requests r where r.title = 'Decline me';
$$;

select is(
  (select outcome from app_private.service_request_decline(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_y())),
  'declined', 'the seller declines to quote');
select is(pg_temp.request_status(pg_temp.request_y()), 'declined', 'the row says so');
select ok(
  (select r.closed_at is not null from public.service_requests r where r.id = pg_temp.request_y()),
  'with its closing time');
select is(
  (select outcome from app_private.service_request_decline(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_y())),
  'conflict', 'declining it again is a conflict');
select is(
  (select outcome from app_private.service_request_cancel(
     'd1000000-0000-4000-8000-00000000000b', pg_temp.request_y())),
  'conflict', 'and a declined request cannot be cancelled');

-- A request can also be declined after it has been quoted.
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000b', 'd1000000-0000-4000-8000-0000000000f1',
     'Quoted then declined', 'A brief that is comfortably longer than ten characters.', null, null)),
  'created', 'a brief that will be quoted and then declined');

create or replace function pg_temp.request_z() returns uuid language sql as $$
  select r.id from public.service_requests r where r.title = 'Quoted then declined';
$$;

select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_z(), 300000, 7::smallint, 0::smallint,
     'A scope for the quoted-then-declined brief, over ten characters.', 14::smallint)),
  'created', 'the seller quotes');
select is(pg_temp.request_status(pg_temp.request_z()), 'quoted', 'the request is quoted');
select is(
  (select outcome from app_private.service_request_decline(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_z())),
  'declined', 'and it can still be declined from `quoted`, which is a live status');
select is(pg_temp.request_status(pg_temp.request_z()), 'declined', 'the row says so');

-- ---------------------------------------------------------------------------------------------------
-- 12. Quote expiry stays 0032's
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_request_create(
     'd1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-0000000000f1',
     'Lapse me', 'A brief that is comfortably longer than ten characters.', null, null)),
  'created', 'a brief whose quote will lapse');

create or replace function pg_temp.request_l() returns uuid language sql as $$
  select r.id from public.service_requests r where r.title = 'Lapse me';
$$;

select is(
  (select outcome from app_private.service_quote_create(
     'd1000000-0000-4000-8000-000000000011', pg_temp.request_l(), 150000, 7::smallint, 0::smallint,
     'A scope for the lapsing quote, longer than ten characters.', 14::smallint)),
  'created', 'the seller quotes on it');

create or replace function pg_temp.quote_l() returns uuid language sql as $$
  select q.id from public.service_quotes q where q.service_request_id = pg_temp.request_l();
$$;

update public.service_quotes set expires_at = now() - interval '1 minute' where id = pg_temp.quote_l();

select is(
  (select (quotes -> 0 ->> 'isLapsed')::boolean from app_private.service_request_detail(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.request_l())),
  true, 'a sent quote past its window reads as lapsed');
select is(pg_temp.quote_status(pg_temp.quote_l()), 'sent',
  'while its status is still sent, because 0032''s sweeper has not run');
select is(
  (select live_quote_count from app_private.service_requests_for_buyer(
     'd1000000-0000-4000-8000-00000000000a', 20, null, null)
    where id = pg_temp.request_l()),
  0, 'and it is not counted as live');

select is(
  (select outcome from app_private.service_quote_accept(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_l())),
  'expired', 'a lapsed quote cannot be accepted');
select is(
  (select outcome from app_private.service_quote_reject(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_l())),
  'expired', 'nor rejected');
select is(
  (select outcome from app_private.service_quote_withdraw(
     'd1000000-0000-4000-8000-000000000011', pg_temp.quote_l())),
  'expired', 'nor withdrawn');
select is(pg_temp.quote_status(pg_temp.quote_l()), 'sent',
  'and none of the three wrote the status the sweeper owns');
select is(pg_temp.request_status(pg_temp.request_l()), 'quoted',
  'nor closed the request');

select ok(app_private.expire_due_service_quotes(500) >= 1, '0032''s sweeper closes it');
select is(pg_temp.quote_status(pg_temp.quote_l()), 'expired', 'now it is expired');
select ok(
  (select q.responded_at is not null from public.service_quotes q where q.id = pg_temp.quote_l()),
  'with the response time the sweeper records');
select is(
  (select outcome from app_private.service_quote_accept(
     'd1000000-0000-4000-8000-00000000000a', pg_temp.quote_l())),
  'conflict', 'an expired quote cannot be accepted');

-- An accepted quote is never re-expired.
update public.service_quotes set expires_at = now() - interval '1 day' where id = pg_temp.quote_one();
select is(app_private.expire_due_service_quotes(500), 0,
  'a second sweep finds nothing: the sweeper only ever looked at sent');
select is(pg_temp.quote_status(pg_temp.quote_one()), 'accepted',
  'an accepted quote whose window has passed is not re-expired');
select ok(
  (select q.payment_due_at is not null from public.service_quotes q where q.id = pg_temp.quote_one()),
  'and it keeps its payment deadline');
select is(pg_temp.request_status(pg_temp.request_a()), 'accepted',
  'and its request stays accepted');

select * from finish();
rollback;
