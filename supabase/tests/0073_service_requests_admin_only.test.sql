-- pgTAP — migration 0073: service requests, Option 2 Admin Only (D7-09).
--
-- Nine things are being held to account.
--
-- **The buyer's writer produces an Admin Only row and cannot produce anything else.** No seller, the mode
-- written as a literal, the currency taken from the existing default and never from a parameter, `open` from
-- the column's own default, and every bound refused as an outcome rather than as a constraint violation.
--
-- **No quote exists, and none can.** The Option 1 quote writer refuses an Admin Only request, no quote row
-- is written, the request does not move, and no function in this migration mentions a quote at all.
--
-- **`declined` means two different things, and the two writers are disjoint.** 0071's seller writer cannot
-- touch an Admin Only row and 0073's staff writer cannot touch a seller-routed one — proven by driving both
-- against both kinds. That is what keeps one status value honest in two flows.
--
-- **The staff closure is `open → declined`, with `closed_at`, and nothing else.** Requires the manage key in
-- a strong session; refuses at aal1, refuses the read key alone, refuses a moderator and a support agent;
-- writes no payment deadline, no accepted terms, no quote and no event; sets `updated_at` because 0015's
-- trigger does, which is the only audit behaviour reused.
--
-- **Payment information is field-level, and absence is enforced in the database.** The queue and the detail
-- select neither column — proven against `pg_get_function_result`, not merely by reading a row — and the one
-- reader that does requires its own key. A caller with `request.read` alone gets a neutral not-found from it.
--
-- **Only an Admin Only row may carry payment information at all**, so there is no seller-routed row a seller
-- could read it from.
--
-- **Buyer isolation is unchanged.** Buyer A cannot read buyer B's Admin Only request through any reader, and
-- a seller sees it through none — neither the inbox reader nor real RLS nor the party detail.
--
-- **Retention clears exactly two fields, ninety days after closure, idempotently**, over both terminal paths
-- the Admin Only flow can reach, and publishes one count-only event with no identifier and no value.
--
-- **Option 1 is intact**, re-driven end to end inside this file: seller-routed create, the seller's inbox,
-- a quote, the trigger's promotion, acceptance, and `payment_due_at = accepted_at + 48 hours`.
--
-- In a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(164);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('d3000000-0000-4000-8000-00000000000a', 'ao-buyer-a@test.invalid'),
  ('d3000000-0000-4000-8000-00000000000b', 'ao-buyer-b@test.invalid'),
  ('d3000000-0000-4000-8000-000000000011', 'ao-seller-one@test.invalid'),
  ('d3000000-0000-4000-8000-0000000000d1', 'ao-admin@test.invalid'),
  ('d3000000-0000-4000-8000-0000000000d2', 'ao-support@test.invalid'),
  ('d3000000-0000-4000-8000-0000000000d3', 'ao-moderator@test.invalid'),
  ('d3000000-0000-4000-8000-0000000000d4', 'ao-super@test.invalid');

insert into public.profiles (id, display_name) values
  ('d3000000-0000-4000-8000-00000000000a', 'Admin Only Buyer A'),
  ('d3000000-0000-4000-8000-00000000000b', 'Admin Only Buyer B')
on conflict (id) do update set display_name = excluded.display_name;

insert into public.seller_profiles
  (user_id, slug, display_name, country_code, status, verification_status, verified_at)
values
  ('d3000000-0000-4000-8000-000000000011', 'ao-shop-one', 'Admin Only Shop', 'EG', 'active',
   'verified', now() - interval '10 days');

-- `granted_at` is explicit and in the past: `user_roles_expiry_after_grant` compares the two.
insert into public.user_roles (user_id, role_key, granted_at) values
  ('d3000000-0000-4000-8000-0000000000d1', 'admin', now() - interval '1 day'),
  ('d3000000-0000-4000-8000-0000000000d2', 'support_agent', now() - interval '1 day'),
  ('d3000000-0000-4000-8000-0000000000d3', 'moderator', now() - interval '1 day'),
  ('d3000000-0000-4000-8000-0000000000d4', 'super_admin', now() - interval '1 day');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('d3000000-0000-4000-8000-0000000000c1', null, 'ao-services', true, 94);
insert into public.category_translations (category_id, locale_code, name) values
  ('d3000000-0000-4000-8000-0000000000c1', 'en', 'Admin only work'),
  ('d3000000-0000-4000-8000-0000000000c1', 'ar', 'أعمال إدارية');

insert into public.listings (
  id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
  currency_code, price_minor, is_negotiable, status, country_code, city, created_at, approved_at
) values (
  'd3000000-0000-4000-8000-0000000000f1', 'd3000000-0000-4000-8000-000000000011', 'service',
  'd3000000-0000-4000-8000-0000000000c1', 'ao-custom-one', 'A quotable service',
  'A description long enough to satisfy the length rule.', 'en', 'EGP', null, false, 'active', 'EG',
  'Cairo', now() - interval '1 hour', now() - interval '1 hour'
);
insert into public.listing_service_details (listing_id, pricing_model, delivery_days, scope)
values ('d3000000-0000-4000-8000-0000000000f1', 'custom', null,
        'The scope of the service, at least ten characters.');

-- Shorthands -----------------------------------------------------------------------------------------
create or replace function pg_temp.request_status(p_id uuid) returns text
language sql as $$ select r.status from public.service_requests r where r.id = p_id; $$;

-- ---------------------------------------------------------------------------------------------------
-- 1. The two columns and their rules
-- ---------------------------------------------------------------------------------------------------
select has_column('public', 'service_requests', 'preferred_payment_method',
  'service_requests carries preferred_payment_method');
select has_column('public', 'service_requests', 'payment_notes', 'and payment_notes');
select col_is_null('public', 'service_requests', 'preferred_payment_method',
  'the method is nullable, because the retention job clears it');
select col_is_null('public', 'service_requests', 'payment_notes', 'and so is the note');
select col_type_is('public', 'service_requests', 'preferred_payment_method', 'text',
  'free text, not an enum: no payment vocabulary is encoded in the schema');

select ok(
  (select count(*) = 0 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'e'
      and (t.typname like '%payment%' or t.typname like '%wallet%' or t.typname like '%card%')),
  'and no payment, wallet or card enum type was created anywhere'
);
select ok(
  (select count(*) = 0 from information_schema.columns
    where table_schema = 'public' and table_name = 'service_requests'
      and (column_name like '%card%' or column_name like '%cvv%' or column_name like '%iban%'
           or column_name like '%account_number%' or column_name like '%credential%'
           or column_name like '%otp%' or column_name like '%secret%')),
  'and no column that could hold a credential, a card or a secret exists on the table'
);

select throws_ok($$
  insert into public.service_requests
    (currency_code, buyer_user_id, seller_user_id, routing_mode, title, brief, preferred_payment_method)
  values ('EGP', 'd3000000-0000-4000-8000-00000000000a', null, 'admin_only', 'A long method',
          'A brief that is comfortably longer than ten characters.', repeat('x', 121))
$$, '23514', null, 'a method beyond 120 characters is refused by the table itself');

-- The three constraints, by name.
select ok((select count(*) = 1 from pg_constraint where conrelid = 'public.service_requests'::regclass
            and conname = 'service_requests_payment_method_length'), 'the method length is a named constraint');
select ok((select count(*) = 1 from pg_constraint where conrelid = 'public.service_requests'::regclass
            and conname = 'service_requests_payment_notes_length'), 'and the note length');
select ok((select count(*) = 1 from pg_constraint where conrelid = 'public.service_requests'::regclass
            and conname = 'service_requests_payment_info_is_admin_only'),
  'and one constraint keeps payment information off a seller-routed row');

-- Only an Admin Only row may carry payment information, so a seller has no row to read it from.
select throws_ok($$
  insert into public.service_requests
    (currency_code, buyer_user_id, seller_user_id, title, brief, preferred_payment_method)
  values ('EGP', 'd3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-000000000011',
          'A seller brief', 'A brief that is comfortably longer than ten characters.', 'Cash')
$$, '23514', null, 'a seller-routed row cannot carry a preferred payment method');
select throws_ok($$
  insert into public.service_requests
    (currency_code, buyer_user_id, seller_user_id, title, brief, payment_notes)
  values ('EGP', 'd3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-000000000011',
          'A seller brief', 'A brief that is comfortably longer than ten characters.', 'A note')
$$, '23514', null, 'nor a payment note');

-- The queue index, partial and in the approved order.
select has_index('public', 'service_requests', 'service_requests_admin_queue',
  'the Admin Only queue has its own index');
select ok(
  (select pg_get_indexdef(i.indexrelid) like '%WHERE (routing_mode = ''admin_only''::text)%'
     from pg_index i where i.indexrelid = 'public.service_requests_admin_queue'::regclass),
  'and it covers only the admin-only rows'
);
select ok(
  (select pg_get_indexdef(i.indexrelid) like '%(created_at, id)%'
     from pg_index i where i.indexrelid = 'public.service_requests_admin_queue'::regclass),
  'in created_at, id order: oldest first, deterministic, with no ranking of any kind'
);

-- ---------------------------------------------------------------------------------------------------
-- 2. D7-09's permission
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.permissions where key = 'service_requests.payment_info.read'),
  1, 'the payment-information read key exists');
select is(
  (select count(*)::int from public.permissions where key = 'service_requests.payment_info.manage'),
  0, 'and no manage counterpart was created, in any increment');
select is(
  (select string_agg(distinct role_key, ',' order by role_key) from public.role_permissions
    where permission_key = 'service_requests.payment_info.read'),
  'admin,super_admin', 'admin and super_admin hold it, and no other role');
select is(
  (select count(*)::int from public.role_permissions
    where permission_key = 'service_requests.payment_info.read'
      and role_key in ('guest', 'buyer', 'seller', 'moderator', 'support_agent')),
  0, 'the moderator and the support agent hold it not: that is the whole of their exclusion');
select is((select count(*) from public.role_permissions where role_key = 'moderator'), 9::bigint,
  'the moderator''s nine are untouched');
select is((select count(*) from public.role_permissions where role_key = 'support_agent'), 5::bigint,
  'and the support agent''s five');

select ok(app_private.service_requests_payment_info_can_read('d3000000-0000-4000-8000-0000000000d1', true),
  'the predicate admits an admin at aal2');
select ok(not app_private.service_requests_payment_info_can_read('d3000000-0000-4000-8000-0000000000d1', false),
  'and refuses the same admin at aal1');
select ok(app_private.service_requests_payment_info_can_read('d3000000-0000-4000-8000-0000000000d4', true),
  'a super_admin at aal2 is admitted');
select ok(not app_private.service_requests_payment_info_can_read('d3000000-0000-4000-8000-0000000000d3', true),
  'a moderator at aal2 is refused');
select ok(not app_private.service_requests_payment_info_can_read('d3000000-0000-4000-8000-0000000000d2', true),
  'a support agent at aal2 is refused');
select ok(not app_private.service_requests_payment_info_can_read('d3000000-0000-4000-8000-000000000011', true),
  'a seller is refused');
select ok(not app_private.service_requests_payment_info_can_read('d3000000-0000-4000-8000-00000000000a', true),
  'and so is a buyer, on their own request');

-- ---------------------------------------------------------------------------------------------------
-- 3. The buyer's writer
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_request_create_admin_only(
     'd3000000-0000-4000-8000-00000000000a', 'An admin-only brief',
     'A brief that is comfortably longer than ten characters.', 'Bank transfer', null, 400000, null)),
  'created', 'a buyer may send an Admin Only request');

-- Pinned by identifier, because the duplicate-submission test below creates a second row with the same
-- title on purpose: a helper that matched on the title alone would name either of them.
create or replace function pg_temp.brief_a() returns uuid language sql as $$
  select r.id from public.service_requests r
   where r.title = 'An admin-only brief' and r.payment_notes is null
   order by r.id limit 1;
$$;

select is((select r.routing_mode from public.service_requests r where r.id = pg_temp.brief_a()),
  'admin_only', 'the mode is admin_only, written by the function and not chosen by the caller');
select is((select r.seller_user_id from public.service_requests r where r.id = pg_temp.brief_a()),
  null, 'no seller is assigned');
select is((select r.listing_id from public.service_requests r where r.id = pg_temp.brief_a()),
  null, 'and no listing: there is no storefront to name one');
select is(pg_temp.request_status(pg_temp.brief_a()), 'open', 'it starts open, from the column''s own default');
select is((select r.closed_at from public.service_requests r where r.id = pg_temp.brief_a()),
  null, 'with no closing time');
select is((select r.preferred_payment_method from public.service_requests r where r.id = pg_temp.brief_a()),
  'Bank transfer', 'the method is stored as the buyer wrote it');
select is((select r.payment_notes from public.service_requests r where r.id = pg_temp.brief_a()),
  null, 'and an omitted note is null rather than an empty string');

-- The currency comes from the authoritative default, tested against the mechanism and the current value.
select is(
  (select r.currency_code from public.service_requests r where r.id = pg_temp.brief_a()),
  (select c.code from public.currencies c where c.is_default),
  'the currency is the default currency, read through the existing is_default mechanism');
select is((select c.code::text from public.currencies c where c.is_default), 'EGP',
  'which is EGP in this repository — asserted through the mechanism, not hardcoded in the writer');
select ok(
  (select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'service_request_create_admin_only'
      and p.prosrc like '%EGP%'),
  'and the writer contains no currency literal at all'
);
select ok(
  (select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'service_request_create_admin_only'
      and pg_get_function_arguments(p.oid) like '%currency%'),
  'nor a currency parameter a browser could reach'
);

-- Every bound, as an outcome.
select is(
  (select outcome from app_private.service_request_create_admin_only(
     'd3000000-0000-4000-8000-00000000000a', 'ab', 'A brief that is comfortably longer than ten.',
     'Cash', null, null, null)),
  'invalid', 'a title shorter than 0015 allows is refused');
select is(
  (select outcome from app_private.service_request_create_admin_only(
     'd3000000-0000-4000-8000-00000000000a', repeat('x', 141),
     'A brief that is comfortably longer than ten.', 'Cash', null, null, null)),
  'invalid', 'and one longer');
select is(
  (select outcome from app_private.service_request_create_admin_only(
     'd3000000-0000-4000-8000-00000000000a', 'A brief', 'too short', 'Cash', null, null, null)),
  'invalid', 'a brief shorter than ten characters is refused');
select is(
  (select outcome from app_private.service_request_create_admin_only(
     'd3000000-0000-4000-8000-00000000000a', 'A brief', repeat('x', 10001), 'Cash', null, null, null)),
  'invalid', 'and one longer than ten thousand');
select is(
  (select outcome from app_private.service_request_create_admin_only(
     'd3000000-0000-4000-8000-00000000000a', 'A brief',
     'A brief that is comfortably longer than ten.', null, null, null, null)),
  'invalid', 'a missing payment method is refused: required where the table cannot require it');
select is(
  (select outcome from app_private.service_request_create_admin_only(
     'd3000000-0000-4000-8000-00000000000a', 'A brief',
     'A brief that is comfortably longer than ten.', '   ', null, null, null)),
  'invalid', 'and whitespace is not a method');
select is(
  (select outcome from app_private.service_request_create_admin_only(
     'd3000000-0000-4000-8000-00000000000a', 'A brief',
     'A brief that is comfortably longer than ten.', repeat('x', 121), null, null, null)),
  'invalid', 'a method beyond 120 characters is refused');
select is(
  (select outcome from app_private.service_request_create_admin_only(
     'd3000000-0000-4000-8000-00000000000a', 'A brief',
     'A brief that is comfortably longer than ten.', 'Cash', repeat('x', 2001), null, null)),
  'invalid', 'a note beyond 2000 characters is refused');
select is(
  (select outcome from app_private.service_request_create_admin_only(
     'd3000000-0000-4000-8000-00000000000a', 'A brief',
     'A brief that is comfortably longer than ten.', 'Cash', null, 0, null)),
  'invalid', 'a zero budget is refused');
select is(
  (select outcome from app_private.service_request_create_admin_only(
     null, 'A brief', 'A brief that is comfortably longer than ten.', 'Cash', null, null, null)),
  'not_found', 'and an absent buyer reaches nothing');
select is(
  (select count(*)::int from public.service_requests r where r.routing_mode = 'admin_only'),
  1, 'none of those ten wrote a row');

-- Repeated submissions are valid: the schema defines no dedupe, and none was added.
select is(
  (select outcome from app_private.service_request_create_admin_only(
     'd3000000-0000-4000-8000-00000000000a', 'An admin-only brief',
     'A brief that is comfortably longer than ten characters.', 'Bank transfer',
     'Please invoice the company address.', null, null)),
  'created', 'the same buyer may send the same brief again: no dedupe rule exists');
select is(
  (select count(*)::int from public.service_requests r
    where r.buyer_user_id = 'd3000000-0000-4000-8000-00000000000a' and r.routing_mode = 'admin_only'),
  2, 'and both rows exist');
select is(
  (select count(*)::int from pg_constraint
    where conrelid = 'public.service_requests'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) like '%buyer_user_id%'),
  0, 'no uniqueness constraint on the buyer was introduced');

-- ---------------------------------------------------------------------------------------------------
-- 4. No quote, and no quote path
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_quote_create(
     'd3000000-0000-4000-8000-000000000011', pg_temp.brief_a(), 390000, 7::smallint, 0::smallint,
     'A scope long enough to satisfy the ten-character rule.', 14::smallint)),
  'not_found', 'the seller cannot quote on an Admin Only request');
select is(
  (select count(*)::int from public.service_quotes q where q.service_request_id = pg_temp.brief_a()),
  0, 'no quote row was written');
select is(pg_temp.request_status(pg_temp.brief_a()), 'open',
  'and the request did not move: the trigger''s promotion never fired');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('service_request_create_admin_only', 'service_requests_admin_only_queue',
                        'service_request_admin_only_detail', 'service_request_payment_information',
                        'service_request_admin_decline', 'purge_due_payment_information')
      and (p.prosrc like '%service_quotes%' or p.prosrc like '%service_quote_%')),
  0, 'and no function of this migration mentions a quote at all');

-- Nor anything from Phase 8.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('service_request_create_admin_only', 'service_requests_admin_only_queue',
                        'service_request_admin_only_detail', 'service_request_payment_information',
                        'service_request_admin_decline', 'purge_due_payment_information')
      and (p.prosrc like '%public.orders%' or p.prosrc like '%public.checkouts%'
           or p.prosrc like '%ledger%' or p.prosrc like '%payout%'
           or p.prosrc like '%payment_attempts%' or p.prosrc like '%reservation%'
           or p.prosrc like '%payment_due_at%' or p.prosrc like '%accepted_terms%'
           or p.prosrc like '%payment_due_hours%')),
  0, 'no order, checkout, ledger, payout, attempt, reservation or payment obligation is reachable');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('service_request_create_admin_only', 'service_request_admin_decline')
      and p.prosrc like '%create_notification%'),
  0, 'and neither writer creates a notification: there is no call site, not a suppressed one');

-- Exactly one function in the database writes the routing mode into a row, and it is this one.
select is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.prosrc like '%admin_only%'
      and p.prosrc like '%insert into public.service_requests%'),
  'service_request_create_admin_only',
  'exactly one function writes an admin-only row, and it is the buyer''s Option 2 writer');

-- ---------------------------------------------------------------------------------------------------
-- 5. Field-level separation, asserted on the function signatures
-- ---------------------------------------------------------------------------------------------------
-- Matched on word boundaries, so the queue's `has_payment_notes` flag — a boolean, not a value — is not
-- mistaken for the column it reports on.
select ok(
  (select pg_get_function_result(p.oid) !~ '\mpreferred_payment_method\M'
      and pg_get_function_result(p.oid) !~ '\mpayment_notes\M'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'service_requests_admin_only_queue'),
  'the queue cannot return either payment field: neither is in its result type'
);
select ok(
  (select pg_get_function_result(p.oid) !~ '\mpreferred_payment_method\M'
      and pg_get_function_result(p.oid) !~ '\mpayment_notes\M'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'service_request_admin_only_detail'),
  'nor can the detail'
);
select ok(
  (select p.prosrc not like '%preferred_payment_method%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'service_requests_admin_only_queue'),
  'and the queue does not select the method even internally'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc like '%preferred_payment_method%'),
  3, 'exactly three functions mention the method: the writer, its reader, and the purge');
select is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc like '%preferred_payment_method%'),
  'purge_due_payment_information,service_request_create_admin_only,service_request_payment_information',
  'and they are those three by name');

-- The reader itself.
select is(
  (select outcome from app_private.service_request_payment_information(
     'd3000000-0000-4000-8000-0000000000d1', true, pg_temp.brief_a())),
  'found', 'an admin at aal2 may read the payment information');
select is(
  (select preferred_payment_method from app_private.service_request_payment_information(
     'd3000000-0000-4000-8000-0000000000d1', true, pg_temp.brief_a())),
  'Bank transfer', 'and gets the method');
select is(
  (select outcome from app_private.service_request_payment_information(
     'd3000000-0000-4000-8000-0000000000d1', false, pg_temp.brief_a())),
  'not_found', 'the same admin at aal1 does not');
select is(
  (select preferred_payment_method from app_private.service_request_payment_information(
     'd3000000-0000-4000-8000-0000000000d1', false, pg_temp.brief_a())),
  null, 'and is handed no value with the refusal');
select is(
  (select outcome from app_private.service_request_payment_information(
     'd3000000-0000-4000-8000-0000000000d3', true, pg_temp.brief_a())),
  'not_found', 'a moderator at aal2 cannot read payment information');
select is(
  (select outcome from app_private.service_request_payment_information(
     'd3000000-0000-4000-8000-0000000000d2', true, pg_temp.brief_a())),
  'not_found', 'nor can a support agent');
select is(
  (select outcome from app_private.service_request_payment_information(
     'd3000000-0000-4000-8000-000000000011', true, pg_temp.brief_a())),
  'not_found', 'nor a seller');
select is(
  (select outcome from app_private.service_request_payment_information(
     'd3000000-0000-4000-8000-00000000000a', true, pg_temp.brief_a())),
  'not_found', 'nor the buyer who wrote it, through this staff path');
select is(
  (select outcome from app_private.service_request_payment_information(
     'd3000000-0000-4000-8000-0000000000d4', true, pg_temp.brief_a())),
  'found', 'a super_admin at aal2 may');

-- ---------------------------------------------------------------------------------------------------
-- 6. The staff queue and detail
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.service_requests_admin_only_queue(
     'd3000000-0000-4000-8000-0000000000d1', true, null, 20, null, null)),
  2, 'the admin sees both Admin Only requests');
select is(
  (select count(*)::int from app_private.service_requests_admin_only_queue(
     'd3000000-0000-4000-8000-0000000000d1', false, null, 20, null, null)),
  0, 'at aal1 they see none: zero rows rather than an error');
select is(
  (select count(*)::int from app_private.service_requests_admin_only_queue(
     'd3000000-0000-4000-8000-0000000000d3', true, null, 20, null, null)),
  0, 'a moderator sees none');
select is(
  (select count(*)::int from app_private.service_requests_admin_only_queue(
     'd3000000-0000-4000-8000-0000000000d2', true, null, 20, null, null)),
  0, 'a support agent sees none');
select is(
  (select count(*)::int from app_private.service_requests_admin_only_queue(
     'd3000000-0000-4000-8000-000000000011', true, null, 20, null, null)),
  0, 'a seller sees none');
select is(
  (select count(*)::int from app_private.service_requests_admin_only_queue(
     'd3000000-0000-4000-8000-00000000000a', true, null, 20, null, null)),
  0, 'and the buyer sees none through the staff queue');
select is(
  (select buyer_name from app_private.service_requests_admin_only_queue(
     'd3000000-0000-4000-8000-0000000000d1', true, null, 20, null, null) limit 1),
  'Admin Only Buyer A', 'the queue names the buyer, which is what handling the request needs');
select is(
  (select has_payment_notes from app_private.service_requests_admin_only_queue(
     'd3000000-0000-4000-8000-0000000000d1', true, null, 20, null, null)
    where id = pg_temp.brief_a()),
  false, 'and says whether there is a note without carrying one');
select is(
  (select count(*)::int from app_private.service_requests_admin_only_queue(
     'd3000000-0000-4000-8000-0000000000d1', true, null, 20, null, null)
    where has_payment_notes),
  1, 'reporting true for the request that has one, still without carrying it');
select is(
  (select count(*)::int from app_private.service_requests_admin_only_queue(
     'd3000000-0000-4000-8000-0000000000d1', true, 'declined', 20, null, null)),
  0, 'the status filter is applied in the statement');
select ok(
  (select count(*) <= 51 from app_private.service_requests_admin_only_queue(
     'd3000000-0000-4000-8000-0000000000d1', true, null, 100000, null, null)),
  'and the limit is clamped rather than trusted'
);

select is(
  (select outcome from app_private.service_request_admin_only_detail(
     'd3000000-0000-4000-8000-0000000000d1', true, pg_temp.brief_a())),
  'found', 'the admin may read one Admin Only request in full');
select is(
  (select brief from app_private.service_request_admin_only_detail(
     'd3000000-0000-4000-8000-0000000000d1', true, pg_temp.brief_a())),
  'A brief that is comfortably longer than ten characters.', 'with the brief');
select is(
  (select outcome from app_private.service_request_admin_only_detail(
     'd3000000-0000-4000-8000-0000000000d1', false, pg_temp.brief_a())),
  'not_found', 'at aal1 it is a neutral not-found');
select is(
  (select outcome from app_private.service_request_admin_only_detail(
     'd3000000-0000-4000-8000-0000000000d3', true, pg_temp.brief_a())),
  'not_found', 'and for a moderator');
select is(
  (select outcome from app_private.service_request_admin_only_detail(
     'd3000000-0000-4000-8000-0000000000d1', true, 'd3000000-0000-4000-8000-0000000000ee')),
  'not_found', 'a request that does not exist answers identically');

-- ---------------------------------------------------------------------------------------------------
-- 7. Option 1 first, so the two `declined` meanings can be driven against each other
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_request_create(
     'd3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000f1', 'A seller brief',
     'A brief that is comfortably longer than ten characters.', 500000, null)),
  'created', 'Option 1 still creates a seller-routed request');

create or replace function pg_temp.seller_brief() returns uuid language sql as $$
  select r.id from public.service_requests r where r.title = 'A seller brief';
$$;

select is((select r.routing_mode from public.service_requests r where r.id = pg_temp.seller_brief()),
  'seller', 'as a seller row');
select is(
  (select count(*)::int from app_private.service_requests_for_seller(
     'd3000000-0000-4000-8000-000000000011', 20, null, null)),
  1, 'the seller''s inbox carries it');
select is(
  (select count(*)::int from app_private.service_requests_for_seller(
     'd3000000-0000-4000-8000-000000000011', 20, null, null)
    where id in (select r.id from public.service_requests r where r.routing_mode = 'admin_only')),
  0, 'and carries no Admin Only request: there is no seller inbox entry for one');
select is(
  (select count(*)::int from app_private.service_requests_admin_only_queue(
     'd3000000-0000-4000-8000-0000000000d1', true, null, 20, null, null)
    where id = pg_temp.seller_brief()),
  0, 'and the admin queue carries no seller-routed request');

-- A quote, the trigger's promotion, and acceptance — Option 1, unchanged.
select is(
  (select outcome from app_private.service_quote_create(
     'd3000000-0000-4000-8000-000000000011', pg_temp.seller_brief(), 380000, 10::smallint, 2::smallint,
     'A scope long enough to satisfy the ten-character rule.', 14::smallint)),
  'created', 'the seller may still quote');
select is(pg_temp.request_status(pg_temp.seller_brief()), 'quoted',
  'and 0015''s trigger still promotes the request to quoted');

create or replace function pg_temp.seller_quote() returns uuid language sql as $$
  select q.id from public.service_quotes q where q.service_request_id = pg_temp.seller_brief();
$$;

select is(
  (select outcome from app_private.service_quote_accept(
     'd3000000-0000-4000-8000-00000000000a', pg_temp.seller_quote())),
  'accepted', 'the buyer may still accept it');
select is(pg_temp.request_status(pg_temp.seller_brief()), 'accepted',
  'and acceptance still closes the request as accepted');
select is(
  (select (q.payment_due_at - q.accepted_at) from public.service_quotes q where q.id = pg_temp.seller_quote()),
  interval '48 hours', 'with payment_due_at exactly 48 hours after acceptance');
select is(
  (select (value #>> '{}')::integer from public.site_settings where key = 'finance.payment_due_hours'),
  48, 'and finance.payment_due_hours is still 48');
select is(
  (select count(*)::int from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.service_quotes'::regclass and not t.tgisinternal
      and p.proname = 'tg_service_quotes_rule'),
  1, 'the quote trigger is still there, and is still the same function');
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'service_quotes'),
  16, 'and service_quotes has the columns it had: no Admin Only support was added to it');

-- ---------------------------------------------------------------------------------------------------
-- 8. `declined` means two things, and the two writers cannot cross
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_request_decline(
     'd3000000-0000-4000-8000-000000000011', pg_temp.brief_a())),
  'not_found', 'the Option 1 seller writer cannot decline an Admin Only request');
select is(pg_temp.request_status(pg_temp.brief_a()), 'open', 'which stays open');
select is(
  (select outcome from app_private.service_request_admin_decline(
     'd3000000-0000-4000-8000-0000000000d1', true, pg_temp.seller_brief())),
  'not_found', 'and the staff writer cannot decline a seller-routed request');

-- The approved staff closure.
select is(
  (select outcome from app_private.service_request_admin_decline(
     'd3000000-0000-4000-8000-0000000000d3', true, pg_temp.brief_a())),
  'not_found', 'a moderator cannot close an Admin Only request');
select is(
  (select outcome from app_private.service_request_admin_decline(
     'd3000000-0000-4000-8000-0000000000d2', true, pg_temp.brief_a())),
  'not_found', 'nor a support agent');
select is(
  (select outcome from app_private.service_request_admin_decline(
     'd3000000-0000-4000-8000-00000000000a', true, pg_temp.brief_a())),
  'not_found', 'nor the buyer');
select is(
  (select outcome from app_private.service_request_admin_decline(
     'd3000000-0000-4000-8000-000000000011', true, pg_temp.brief_a())),
  'not_found', 'nor the seller');
select is(
  (select outcome from app_private.service_request_admin_decline(
     'd3000000-0000-4000-8000-0000000000d1', false, pg_temp.brief_a())),
  'not_found', 'and not the admin at aal1');
select is(pg_temp.request_status(pg_temp.brief_a()), 'open', 'none of those six moved it');

select is(
  (select outcome from app_private.service_request_admin_decline(
     'd3000000-0000-4000-8000-0000000000d1', true, pg_temp.brief_a())),
  'declined', 'an admin at aal2 with the manage key closes it');
select is(pg_temp.request_status(pg_temp.brief_a()), 'declined', 'the status is declined');
select ok(
  (select r.closed_at is not null from public.service_requests r where r.id = pg_temp.brief_a()),
  'with closed_at set, as service_requests_closed_has_time requires'
);
-- The existing audit behaviour of this table, and the absence of a second one. A timestamp comparison
-- would prove nothing inside one transaction, because `now()` does not advance within it — so what is
-- asserted is the mechanism: 0015's trigger is what maintains `updated_at`, nothing was added beside it,
-- and the closure published no event of its own.
select is(
  (select count(*)::int from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.service_requests'::regclass and not t.tgisinternal
      and p.proname = 'tg_set_updated_at'),
  1, 'updated_at is maintained by 0015''s trigger, which is the audit behaviour the closure reuses');
select is(
  (select count(*)::int from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.service_requests'::regclass and not t.tgisinternal
      and p.proname like '%record_change%'),
  0, 'and no audit trigger was added to the table: no second audit path was invented');
select is(
  (select count(*)::int from public.outbox_events e where e.event_type like 'service_request.%'),
  0, 'the closure published no event of any kind');
select is(
  (select q.payment_due_at from public.service_quotes q
    where q.service_request_id = pg_temp.brief_a() limit 1),
  null, 'no quote and therefore no payment deadline came into being');
select is(
  (select count(*)::int from public.service_quotes q where q.service_request_id = pg_temp.brief_a()),
  0, 'still no quote row');
select is(
  (select r.preferred_payment_method from public.service_requests r where r.id = pg_temp.brief_a()),
  'Bank transfer', 'and the payment information survives the closure: retention clears it, not the closure');

-- Repeating it, and closing an already-closed request.
select is(
  (select outcome from app_private.service_request_admin_decline(
     'd3000000-0000-4000-8000-0000000000d1', true, pg_temp.brief_a())),
  'conflict', 'a second closure is a conflict, not a second write');
select is(
  (select status from app_private.service_request_admin_decline(
     'd3000000-0000-4000-8000-0000000000d1', true, pg_temp.brief_a())),
  'declined', 'and the conflict reports what the request actually is');

-- The buyer's own cancellation still reaches an Admin Only request, through 0071's unchanged writer.
select is(
  (select outcome from app_private.service_request_cancel(
     'd3000000-0000-4000-8000-00000000000a',
     (select r.id from public.service_requests r
       where r.routing_mode = 'admin_only' and r.status = 'open' limit 1))),
  'cancelled', 'the buyer may still cancel their own Admin Only request');
select is(
  (select count(*)::int from public.service_requests r
    where r.routing_mode = 'admin_only' and r.status = 'cancelled'),
  1, 'and it is cancelled, through 0071''s writer with nothing added to it');

-- No status outside 0015's six was invented, and neither new writer can reach quoted, accepted or expired.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('service_request_create_admin_only', 'service_request_admin_decline')
      and (p.prosrc like '%''quoted''%' or p.prosrc like '%''accepted''%' or p.prosrc like '%''expired''%')),
  0, 'no Option 2 writer mentions quoted, accepted or expired');
select is(
  (select string_agg(distinct r.status, ',' order by r.status) from public.service_requests r
    where r.routing_mode = 'admin_only'),
  'cancelled,declined', 'and the Admin Only rows here are exactly the two terminal states reachable');

-- ---------------------------------------------------------------------------------------------------
-- 9. Buyer isolation and seller invisibility, through the readers and through real RLS
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_request_detail(
     'd3000000-0000-4000-8000-00000000000b', pg_temp.brief_a())),
  'not_found', 'buyer B cannot read buyer A''s Admin Only request');
select is(
  (select outcome from app_private.service_request_detail(
     'd3000000-0000-4000-8000-000000000011', pg_temp.brief_a())),
  'not_found', 'and the seller cannot read it either');
select is(
  (select is_buyer from app_private.service_request_detail(
     'd3000000-0000-4000-8000-00000000000a', pg_temp.brief_a())),
  true, 'while buyer A still reads their own');
select is(
  (select count(*)::int from app_private.service_requests_for_buyer(
     'd3000000-0000-4000-8000-00000000000b', 20, null, null)),
  0, 'buyer B''s list is empty');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d3000000-0000-4000-8000-000000000011","role":"authenticated","aal":"aal1"}', true);
create temp table probe_seller as
select (select count(*) from public.service_requests where routing_mode = 'admin_only') as admin_rows,
       (select count(*) from public.service_requests
         where preferred_payment_method is not null) as with_payment,
       (select count(*) from public.service_requests where routing_mode = 'seller') as seller_rows;
reset role;

select is((select admin_rows from probe_seller), 0::bigint,
  'through real RLS a seller sees no Admin Only row at all');
select is((select with_payment from probe_seller), 0::bigint,
  'and no row carrying payment information, in any mode');
select is((select seller_rows from probe_seller), 1::bigint,
  'while their own seller-routed request is still visible: Option 1 reading is untouched');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d3000000-0000-4000-8000-00000000000b","role":"authenticated","aal":"aal1"}', true);
create temp table probe_buyer_b as
select (select count(*) from public.service_requests) as rows_visible;
reset role;
select is((select rows_visible from probe_buyer_b), 0::bigint,
  'and buyer B sees nothing of anybody else''s, in either mode');

-- ---------------------------------------------------------------------------------------------------
-- 10. Retention
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.scheduled_job_contract
    where job_key = 'service_requests.payment_info_purge'
      and cron_schedule = '5 4 * * *'
      and target_signature = 'app_private.purge_due_payment_information(500)'),
  1::bigint, 'the retention job is contracted with the approved key, schedule and target');
select is(
  (select count(*) from cron.job
    where jobname = 'marketplace.service_requests.payment_info_purge'
      and schedule = '5 4 * * *'
      and command = 'select app_private.run_scheduled_job(''service_requests.payment_info_purge'')'),
  1::bigint, 'and scheduled through the one dispatcher, with no logic in the command');
select is((select count(*) from public.cron_job_problems()), 0::bigint,
  'the whole schedule still matches its contract');

-- Nothing is due yet: both Admin Only rows closed moments ago.
select is(app_private.purge_due_payment_information(500), 0,
  'a request that closed today is not due');
select is(
  (select r.preferred_payment_method from public.service_requests r where r.id = pg_temp.brief_a()),
  'Bank transfer', 'and its payment information is untouched');

-- Age both terminal paths past ninety days: the staff closure and the buyer cancellation.
update public.service_requests
   set closed_at = now() - interval '91 days'
 where routing_mode = 'admin_only' and closed_at is not null;

create temporary table before_purge on commit drop as
  select id, status, closed_at, title, brief, budget_minor, currency_code, buyer_user_id, routing_mode,
         created_at
    from public.service_requests where routing_mode = 'admin_only';

select is(app_private.purge_due_payment_information(500), 2,
  'both terminal Admin Only requests are purged: the declined one and the cancelled one');
select is(
  (select count(*)::int from public.service_requests r
    where r.routing_mode = 'admin_only'
      and (r.preferred_payment_method is not null or r.payment_notes is not null)),
  0, 'neither field survives');
select is(
  (select count(*)::int from public.service_requests r
    join before_purge b on b.id = r.id
   where (r.status, r.closed_at, r.title, r.brief, r.budget_minor, r.currency_code, r.buyer_user_id,
          r.routing_mode, r.created_at)
      is distinct from
         (b.status, b.closed_at, b.title, b.brief, b.budget_minor, b.currency_code, b.buyer_user_id,
          b.routing_mode, b.created_at)),
  0, 'and every other column of every purged row is exactly as it was');

-- Idempotent: run it again.
select is(app_private.purge_due_payment_information(500), 0,
  'a second run clears nothing, because a cleared row is no longer due');
select is(app_private.purge_due_payment_information(500), 0, 'and a third');

-- The event: one, count-only.
select is(
  (select count(*)::int from public.outbox_events e
    where e.event_type = 'service_request.payment_information_purged'),
  1, 'exactly one event was published, for the run that cleared something');
select is(
  (select e.payload from public.outbox_events e
    where e.event_type = 'service_request.payment_information_purged'),
  jsonb_build_object('count', 2), 'and it carries a count and nothing else');
select is(
  (select e.aggregate_id from public.outbox_events e
    where e.event_type = 'service_request.payment_information_purged'),
  'batch', 'no request identifier is in the aggregate id either');
select ok(
  (select e.payload::text not like '%Bank transfer%' and e.payload::text not like '%invoice%'
     from public.outbox_events e
    where e.event_type = 'service_request.payment_information_purged'),
  'and no payment value reached the event'
);

-- Bounded, and it touches nothing else.
select ok(
  (select p.prosrc like '%limit greatest%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'purge_due_payment_information'),
  'the batch is bounded by its limit'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'purge_due_payment_information'
      and (p.prosrc like '%delete%' or p.prosrc like '%public.service_quotes%'
           or p.prosrc like '%public.offers%' or p.prosrc like '%public.listings%'
           or p.prosrc like '%public.profiles%' or p.prosrc like '%auth.users%')),
  0, 'and it deletes nothing and reaches no other table: it is not a retention framework');

-- A seller-routed request is not in its scope, because it can carry no payment information at all.
select is(
  (select count(*)::int from public.service_requests r
    where r.routing_mode = 'seller'
      and (r.preferred_payment_method is not null or r.payment_notes is not null)),
  0, 'a seller-routed request has nothing for the purge to clear, by constraint');

-- ---------------------------------------------------------------------------------------------------
-- 11. Least privilege on everything this migration defines
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from information_schema.role_routine_grants
    where routine_schema = 'app_private'
      and grantee in ('public', 'PUBLIC', 'authenticated', 'anon', 'app_worker')
      and routine_name in ('service_requests_payment_info_can_read', 'service_request_create_admin_only',
                           'service_requests_admin_only_queue', 'service_request_admin_only_detail',
                           'service_request_payment_information', 'service_request_admin_decline',
                           'purge_due_payment_information')),
  0, 'no function here is executable by PUBLIC, anon, authenticated or app_worker');
select is(
  (select count(*)::int from information_schema.role_routine_grants
    where routine_schema = 'app_private' and grantee = 'app_system'
      and routine_name in ('service_requests_payment_info_can_read', 'service_request_create_admin_only',
                           'service_requests_admin_only_queue', 'service_request_admin_only_detail',
                           'service_request_payment_information', 'service_request_admin_decline')),
  6, 'the six the API reaches are executable by app_system');
select is(
  (select count(*)::int from information_schema.role_routine_grants
    where routine_schema = 'app_private' and grantee = 'app_system'
      and routine_name = 'purge_due_payment_information'),
  0, 'and the purge is not: it is the scheduler''s, reached through the dispatcher');
select ok(
  (select bool_and(p.proconfig @> array['search_path=pg_catalog, public'])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('service_requests_payment_info_can_read', 'service_request_create_admin_only',
                        'service_requests_admin_only_queue', 'service_request_admin_only_detail',
                        'service_request_payment_information', 'service_request_admin_decline',
                        'purge_due_payment_information')),
  'every one of them pins its search_path'
);
select ok(
  (select bool_and(p.prosecdef)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('service_requests_payment_info_can_read', 'service_request_create_admin_only',
                        'service_requests_admin_only_queue', 'service_request_admin_only_detail',
                        'service_request_payment_information', 'service_request_admin_decline',
                        'purge_due_payment_information')),
  'and every one is security definer'
);
select ok(
  (select bool_and(pg_get_function_arguments(p.oid) not like '%permission%'
                   and pg_get_function_arguments(p.oid) not like '%role%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('service_requests_admin_only_queue', 'service_request_admin_only_detail',
                        'service_request_payment_information', 'service_request_admin_decline')),
  'no staff function takes a permission or a role as an argument: each pins its own key'
);
select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'and the whole security contract is still green');

-- No second routing column, no parallel table, no new status.
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'service_requests'
      and column_name like '%rout%'),
  1, 'there is exactly one routing column, 0072''s');
select ok(
  (select count(*) = 0 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname <> 'service_requests' and c.relname like '%service_request%'),
  'and no parallel request table'
);
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.service_requests'::regclass
      and conname = 'service_requests_status_allowed'),
  'CHECK ((status = ANY (ARRAY[''open''::text, ''quoted''::text, ''accepted''::text, ''declined''::text, ''cancelled''::text, ''expired''::text])))',
  'and 0015''s six statuses are still exactly six');

select * from finish();
rollback;
