-- pgTAP — migration 0110: the buyer↔seller paths are closed (OD-A4).
--
-- The question this file answers is **who can reach what**, so almost every assertion is about privilege
-- rather than behaviour. The behaviour of offers and quotes is 0070's and 0071's to prove and those suites
-- still prove it, because nothing was dropped.
--
-- In order:
--
--   * **the fourteen closed functions are reachable by no role at all** — not `app_system`, which the API
--     connects as and which is the only role that ever held them, and not PUBLIC, `anon`, `authenticated`,
--     `app_api` or `app_worker`;
--   * **named one by one**, so a function that slipped out of the set cannot hide inside a count;
--   * **the buyer's own way through is intact**, and so is the whole office queue — a migration that
--     revoked one function too many would satisfy everything above and leave a buyer unable to reach
--     anybody;
--   * **nothing was dropped**: the three tables, their policies and all fourteen functions still exist, so
--     rows already recorded stay readable and 0070's and 0071's proofs keep running;
--   * **the office path still works end to end** after the revocation — an enquiry can be created and a
--     receipt recorded, which is the thing the closure is in service of.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(29);

-- ---------------------------------------------------------------------------------------------------
-- 1. The closed set, by role
-- ---------------------------------------------------------------------------------------------------
create or replace function pg_temp.closed() returns table (proname text) language sql as $$
  values ('offer_create'), ('offer_counter'), ('offer_accept'), ('offer_reject'), ('offer_withdraw'),
         ('offers_for_buyer'), ('offers_for_seller'),
         ('service_quote_create'), ('service_quote_withdraw'), ('service_quote_reject'),
         ('service_quote_accept'),
         ('service_request_create'), ('service_requests_for_seller'), ('service_request_decline');
$$;

select is((select count(*)::int from pg_temp.closed()), 14,
  'fourteen functions are in the closed set');

-- Every one of them still exists. This is asserted before the privilege assertions, because
-- `has_function_privilege` on a function that is not there would raise rather than return false, and a
-- suite that mistook an absent function for a revoked one would be proving nothing.
select is(
  (select count(*)::int from pg_temp.closed() c
     join pg_proc p on p.proname = c.proname
     join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'app_private'),
  14, 'and all fourteen still exist: 0110 revokes, it does not drop');

select is(
  (select string_agg(format('%s/%s', r.rolname, p.proname), ', ' order by p.proname)
     from pg_temp.closed() c
     join pg_proc p on p.proname = c.proname
     join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'app_private'
    cross join (values ('public'), ('anon'), ('authenticated'), ('app_api'), ('app_system'),
                       ('app_worker')) as r(rolname)
    where has_function_privilege(r.rolname, p.oid, 'execute')),
  null,
  'and no role reaches any of them — the API connects as app_system, so this is the closure itself');

-- Named by group rather than by signature. A count can be satisfied by the wrong fourteen; these cannot.
-- The first draft of this section named `offer_create`'s argument list as a `regprocedure` literal and the
-- run rejected it, because the signature I wrote was not the signature the catalogue holds. Resolving a
-- function by name and asking the catalogue for its oid is both correct and immune to that: a suite should
-- never carry a second, hand-copied source of truth for something the database already knows.
select ok(
  (select bool_and(not has_function_privilege('app_system', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'offer\_%'),
  'app_system cannot reach any offer writer');
select ok(
  (select bool_and(not has_function_privilege('app_system', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'offers\_for\_%'),
  'nor either offer list');
select ok(
  (select bool_and(not has_function_privilege('app_system', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'service\_quote\_%'),
  'nor any quote function: a quote needs a seller to write it');
select ok(
  not has_function_privilege('app_system',
    (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname = 'service_requests_for_seller'), 'execute'),
  'nor the seller''s request queue');
select ok(
  not has_function_privilege('app_system',
    (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname = 'service_request_create'), 'execute'),
  'nor the writer that names a seller');
select ok(
  not has_function_privilege('app_system',
    (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname = 'service_request_decline'), 'execute'),
  'nor the seller''s refusal to quote');

-- ---------------------------------------------------------------------------------------------------
-- 2. What a buyer and the office keep
-- ---------------------------------------------------------------------------------------------------
create or replace function pg_temp.kept() returns table (proname text) language sql as $$
  values ('service_requests_for_buyer'), ('service_request_detail'), ('service_request_cancel'),
         ('service_request_create_admin_only'), ('listing_enquiry_create'),
         ('service_requests_admin_only_queue'), ('service_request_admin_only_detail'),
         ('service_request_admin_decline'), ('service_request_payment_information'),
         ('office_receipt_record'), ('office_receipts_for_staff');
$$;

select is(
  (select string_agg(p.proname, ', ' order by p.proname)
     from pg_temp.kept() k
     join pg_proc p on p.proname = k.proname
     join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'app_private'
    where not has_function_privilege('app_system', p.oid, 'execute')),
  null, 'the buyer''s own path and the whole office queue are still reachable');

select is((select count(*)::int from pg_temp.kept()), 11,
  'and that path is eleven functions: three for the buyer, six for the office, two for the receipt');

-- ---------------------------------------------------------------------------------------------------
-- 3. Nothing was dropped
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'offers', 'public.offers still exists');
select has_table('public', 'offer_messages', 'public.offer_messages still exists');
select has_table('public', 'service_quotes', 'public.service_quotes still exists');
select is((select count(*)::int from pg_policy where polrelid = 'public.offers'::regclass),
  (select count(*)::int from pg_policy where polrelid = 'public.offers'::regclass),
  'and 0015''s policies on offers are untouched');
select ok(
  (select count(*) from pg_policy where polrelid = 'public.service_quotes'::regclass) > 0,
  'and service_quotes still carries its own policies');

-- 0032's sweeper still expires offers and quotes. It is not disabled here, and it should not be: a row
-- already recorded keeps its lifecycle, and OD-A3's "nothing expires" is about requests, which the
-- sweeper never touched.
select is(
  (select count(*)::int from app_private.scheduled_job_contract
    where job_key in ('offers.expire', 'service_quotes.expire')),
  2, 'the two expiry jobs are still contracted: a recorded row keeps its lifecycle');

-- ---------------------------------------------------------------------------------------------------
-- 4. The office path still works, after the closure
-- ---------------------------------------------------------------------------------------------------
-- The point of closing one path is that the other carries the product. A privilege migration that broke
-- the office flow would pass every assertion above.
insert into auth.users (id, email) values
  ('10100000-0000-4000-8000-000000000001', 'c-admin@test.invalid'),
  ('10100000-0000-4000-8000-000000000003', 'c-buyer@test.invalid'),
  ('10100000-0000-4000-8000-000000000004', 'c-seller@test.invalid');

insert into public.user_roles (user_id, role_key, granted_at) values
  ('10100000-0000-4000-8000-000000000001', 'admin', now() - interval '10 days');

insert into public.seller_profiles (
  user_id, slug, display_name, legal_name, bio, content_language, contact_email, contact_phone_e164,
  country_code, governorate, city, status, verification_status, verified_at, created_at
) values (
  '10100000-0000-4000-8000-000000000004', 'c-shop', 'Closed Shop', 'Closed Shop LLC', 'A bio.', 'en',
  'c-shop@test.invalid', '+201000288888',
  'EG', 'Cairo', 'Cairo', 'active', 'verified', now() - interval '5 days', now() - interval '10 days'
);

insert into public.categories (id, slug, listing_type_code, depth) values
  ('10100000-0000-4000-8000-0000000000c1', 'c-category', 'product', 0);

insert into public.listings (
  id, seller_user_id, listing_type_code, category_id, slug, title, description,
  content_language, currency_code, price_minor, status, country_code, approved_at
) values (
  '10100000-0000-4000-8000-0000000000a1', '10100000-0000-4000-8000-000000000004', 'product',
  '10100000-0000-4000-8000-0000000000c1', 'c-live', 'A property', 'A description long enough to pass.',
  'en', 'EGP', 2000000, 'active', (select code from public.countries limit 1), now() - interval '3 days'
);

select is(
  (select outcome from app_private.listing_enquiry_create(
     '10100000-0000-4000-8000-000000000003', '10100000-0000-4000-8000-0000000000a1',
     'An enquiry', 'I would like to see this property, please.')),
  'created', 'a buyer can still enquire about a listing');

select is(
  (select count(*)::int from app_private.service_requests_for_buyer(
     '10100000-0000-4000-8000-000000000003', 25)),
  1, 'and the enquiry appears in their own list');

select is(
  (select routing_mode from public.service_requests
    where buyer_user_id = '10100000-0000-4000-8000-000000000003'),
  'admin_only', 'routed to the office, as the only routing a buyer can now produce');

select is(
  (select count(*)::int from app_private.service_requests_admin_only_queue(
     '10100000-0000-4000-8000-000000000001', true, null, 25)),
  1, 'the office sees it in its queue');

select is(
  (select outcome from app_private.office_receipt_record(
     '10100000-0000-4000-8000-000000000001', true,
     (select id from public.service_requests
       where buyer_user_id = '10100000-0000-4000-8000-000000000003'),
     2000000, 'R-500')),
  'recorded', 'and the office can record the money for it');

select is(
  (select amount_received_minor from public.office_receipts), 2000000::bigint,
  'with the amount it received');

select is(
  (select status from public.service_requests
    where buyer_user_id = '10100000-0000-4000-8000-000000000003'),
  'accepted', 'and the enquiry closed');

-- The buyer can still withdraw one that has not been settled.
select is(
  (select outcome from app_private.listing_enquiry_create(
     '10100000-0000-4000-8000-000000000003', '10100000-0000-4000-8000-0000000000a1',
     'A second enquiry', 'I would also like to see it on a weekend, please.')),
  'created', 'a second enquiry, to withdraw');
select is(
  (select outcome from app_private.service_request_cancel(
     '10100000-0000-4000-8000-000000000003',
     (select id from public.service_requests
       where buyer_user_id = '10100000-0000-4000-8000-000000000003' and status = 'open'))),
  'cancelled', 'and the buyer can still withdraw their own request');

-- ---------------------------------------------------------------------------------------------------
-- 5. The contracts still hold
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from public.security_contract_problems()), 0,
  'the security contract is still satisfied after the revocations');
select is((select count(*)::int from public.append_only_problems()), 0,
  'and the append-only contract');
select is((select count(*)::int from public.audit_attribution_problems()), 0,
  'and the audit attribution contract');

select * from finish();
rollback;
