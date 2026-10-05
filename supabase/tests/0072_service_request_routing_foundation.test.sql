-- pgTAP — migration 0072: service request routing mode and staff permissions (D7-08, D7-10).
--
-- Seven things are being held to account.
--
-- **D7-08 is on the existing table.** `seller_user_id` is nullable, `routing_mode` exists with the closed
-- vocabulary the repository's own convention uses, and one biconditional constraint enforces both approved
-- directions: a `seller` row must name a seller, an `admin_only` row must not. Both half-populated forms are
-- attempted and both are refused. No parallel table exists.
--
-- **Option 1 is unchanged by it.** The column defaults to `seller`, `service_request_create` never mentions
-- it, and a brief written through the Option 1 writer comes out as a `seller` row with its seller intact.
--
-- **An admin-only row is invisible to sellers, and that is not a line anybody wrote.** 0015's unchanged
-- `service_requests_party_read` matches `seller_user_id = public.current_user_id()`, which is NULL and not
-- true for a seller-less row. Driven through real RLS as a seller, as the buyer, and as a third party.
--
-- **Buyer ownership is unchanged.** The buyer of an admin-only brief still sees it — through RLS, through
-- the buyer list reader, and through the detail reader, where `is_seller` is false rather than unknown.
--
-- **D7-10's two keys exist and are assigned exactly as the seeded schema assigns every key**: admin and
-- super_admin, nobody else. Asserted against the seeded roles rather than against the migration text.
--
-- **AAL2 is enforced for staff access**, through the existing model and not a new one: `has_permission` is
-- false for an admin in an aal1 session and true at aal2, and the two `app_private` predicates behave the
-- same way with the assurance level passed as a parameter.
--
-- **Nothing Admin Only was added.** No function in `app_private` mentions `routing_mode` or `admin_only`, no
-- writer creates a seller-less request, and `service_quote_create` refuses one — which is the schema
-- refusing it, not a line added for it.
--
-- In a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(85);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('d2000000-0000-4000-8000-00000000000a', 'rf-buyer-a@test.invalid'),
  ('d2000000-0000-4000-8000-00000000000b', 'rf-buyer-b@test.invalid'),
  ('d2000000-0000-4000-8000-000000000011', 'rf-seller-one@test.invalid'),
  ('d2000000-0000-4000-8000-0000000000d1', 'rf-admin@test.invalid'),
  ('d2000000-0000-4000-8000-0000000000d2', 'rf-support@test.invalid');

insert into public.profiles (id, display_name) values
  ('d2000000-0000-4000-8000-00000000000a', 'Routing Buyer A'),
  ('d2000000-0000-4000-8000-00000000000b', 'Routing Buyer B')
on conflict (id) do update set display_name = excluded.display_name;

insert into public.seller_profiles
  (user_id, slug, display_name, country_code, status, verification_status, verified_at)
values
  ('d2000000-0000-4000-8000-000000000011', 'rf-shop-one', 'Routing Shop One', 'EG', 'active',
   'verified', now() - interval '10 days');

-- `granted_at` is explicit and in the past: `user_roles_expiry_after_grant` compares the two.
insert into public.user_roles (user_id, role_key, granted_at) values
  ('d2000000-0000-4000-8000-0000000000d1', 'admin', now() - interval '1 day'),
  ('d2000000-0000-4000-8000-0000000000d2', 'support_agent', now() - interval '1 day');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('d2000000-0000-4000-8000-0000000000c1', null, 'rf-services', true, 93);
insert into public.category_translations (category_id, locale_code, name) values
  ('d2000000-0000-4000-8000-0000000000c1', 'en', 'Routing work'),
  ('d2000000-0000-4000-8000-0000000000c1', 'ar', 'أعمال التوجيه');

insert into public.listings (
  id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
  currency_code, price_minor, is_negotiable, status, country_code, city, created_at, approved_at
) values (
  'd2000000-0000-4000-8000-0000000000f1', 'd2000000-0000-4000-8000-000000000011', 'service',
  'd2000000-0000-4000-8000-0000000000c1', 'rf-custom-one', 'A quotable service',
  'A description long enough to satisfy the length rule.', 'en', 'EGP', null, false, 'active', 'EG',
  'Cairo', now() - interval '1 hour', now() - interval '1 hour'
);
insert into public.listing_service_details (listing_id, pricing_model, delivery_days, scope)
values ('d2000000-0000-4000-8000-0000000000f1', 'custom', null,
        'The scope of the service, at least ten characters.');

-- ---------------------------------------------------------------------------------------------------
-- 1. D7-08 — the column, on the existing table
-- ---------------------------------------------------------------------------------------------------
select has_column('public', 'service_requests', 'routing_mode', 'service_requests carries routing_mode');
select col_type_is('public', 'service_requests', 'routing_mode', 'text',
  'as text, the convention this schema uses for a closed vocabulary rather than a PostgreSQL enum');
select col_not_null('public', 'service_requests', 'routing_mode', 'and it is not null');
select col_default_is('public', 'service_requests', 'routing_mode', 'seller',
  'defaulting to seller, so every request written without naming it is an Option 1 request');
select col_is_null('public', 'service_requests', 'seller_user_id',
  'seller_user_id is nullable now, as D7-08 requires');

select ok(
  (select count(*) = 0 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname <> 'service_requests' and c.relname like '%service_request%'),
  'and no parallel request table was created for the second mode'
);

select has_check('public', 'service_requests', 'service_requests has check constraints');
select ok(
  (select count(*) = 1 from pg_constraint
    where conrelid = 'public.service_requests'::regclass
      and conname = 'service_requests_routing_mode_allowed'),
  'the vocabulary is named in a constraint of its own'
);
select ok(
  (select count(*) = 1 from pg_constraint
    where conrelid = 'public.service_requests'::regclass
      and conname = 'service_requests_routing_has_seller'),
  'and one biconditional ties the mode to the seller'
);

-- The vocabulary is exactly two values.
select throws_ok($$
  insert into public.service_requests (currency_code, buyer_user_id, seller_user_id, title, brief, routing_mode)
  values ('EGP', 'd2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000011',
          'A third mode', 'A brief that is comfortably longer than ten characters.', 'staff_pool')
$$, '23514', null, 'a routing mode outside the approved two is refused');

-- Both approved directions, and both half-populated forms.
select lives_ok($$
  insert into public.service_requests (id, currency_code, buyer_user_id, seller_user_id, title, brief, routing_mode)
  values ('d2000000-0000-4000-8000-000000000101', 'EGP', 'd2000000-0000-4000-8000-00000000000a',
          'd2000000-0000-4000-8000-000000000011', 'A seller brief',
          'A brief that is comfortably longer than ten characters.', 'seller')
$$, 'seller routing with a seller is accepted');

select lives_ok($$
  insert into public.service_requests (id, currency_code, buyer_user_id, seller_user_id, title, brief, routing_mode)
  values ('d2000000-0000-4000-8000-000000000102', 'EGP', 'd2000000-0000-4000-8000-00000000000a',
          null, 'An admin brief',
          'A brief that is comfortably longer than ten characters.', 'admin_only')
$$, 'admin-only routing with no seller is accepted, which is what D7-08 asks for');

select throws_ok($$
  insert into public.service_requests (currency_code, buyer_user_id, seller_user_id, title, brief, routing_mode)
  values ('EGP', 'd2000000-0000-4000-8000-00000000000a', null, 'A seller brief with no seller',
          'A brief that is comfortably longer than ten characters.', 'seller')
$$, '23514', null, 'seller routing without a seller is refused: the first approved direction');

select throws_ok($$
  insert into public.service_requests (currency_code, buyer_user_id, seller_user_id, title, brief, routing_mode)
  values ('EGP', 'd2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000011',
          'An admin brief with a seller',
          'A brief that is comfortably longer than ten characters.', 'admin_only')
$$, '23514', null, 'admin-only routing with a seller is refused: the second approved direction');

select is(
  (select routing_mode from public.service_requests where id = 'd2000000-0000-4000-8000-000000000102'),
  'admin_only', 'the admin-only row exists and keeps its mode');
select is(
  (select seller_user_id from public.service_requests where id = 'd2000000-0000-4000-8000-000000000102'),
  null, 'with no seller on it');
select is(
  (select count(*)::int from public.service_requests
    where id = 'd2000000-0000-4000-8000-000000000102' and buyer_user_id is not null),
  1, 'and its buyer intact: ownership does not depend on the mode');

-- ---------------------------------------------------------------------------------------------------
-- 2. Option 1 is unchanged
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.service_request_create(
     'd2000000-0000-4000-8000-00000000000b', 'd2000000-0000-4000-8000-0000000000f1', 'An Option 1 brief',
     'A brief that is comfortably longer than ten characters.', 400000, null)),
  'created', 'the Option 1 writer still creates a brief');
select is(
  (select r.routing_mode from public.service_requests r where r.title = 'An Option 1 brief'),
  'seller', 'and it is a seller row, from the default, without the writer naming the column');
select is(
  (select r.seller_user_id from public.service_requests r where r.title = 'An Option 1 brief'),
  'd2000000-0000-4000-8000-000000000011'::uuid,
  'with the seller taken from the listing exactly as before');

-- 0015's not-self rule still holds where it can be evaluated, and does not fire where it cannot.
select throws_ok($$
  insert into public.service_requests (currency_code, buyer_user_id, seller_user_id, title, brief)
  values ('EGP', 'd2000000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000000011',
          'Own brief', 'A brief that is comfortably longer than ten characters.')
$$, '23514', null, 'a self-addressed brief is still refused');

-- ---------------------------------------------------------------------------------------------------
-- 3. Who can read an admin-only row — driven through real RLS
-- ---------------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d2000000-0000-4000-8000-000000000011","role":"authenticated","aal":"aal1"}', true);
create temp table probe_seller as
select (select count(*) from public.service_requests
         where id = 'd2000000-0000-4000-8000-000000000102') as admin_rows,
       (select count(*) from public.service_requests
         where id = 'd2000000-0000-4000-8000-000000000101') as own_rows,
       (select count(*) from public.service_requests where routing_mode = 'admin_only') as any_admin_rows,
       public.has_permission('service_requests.request.read') as can_read,
       public.has_permission('service_requests.request.manage') as can_manage;
reset role;

select is((select admin_rows from probe_seller), 0::bigint,
  'the seller cannot see the admin-only row: null seller_user_id never matches their own id');
select is((select any_admin_rows from probe_seller), 0::bigint,
  'nor any other admin-only row, through any predicate available to them');
select is((select own_rows from probe_seller), 1::bigint,
  'and their own seller-routed row is still visible: Option 1 reading is untouched');
select ok((select not can_read from probe_seller), 'a seller holds neither of the new permissions');
select ok((select not can_manage from probe_seller), 'not the manage one either');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d2000000-0000-4000-8000-00000000000a","role":"authenticated","aal":"aal1"}', true);
create temp table probe_buyer as
select (select count(*) from public.service_requests
         where id = 'd2000000-0000-4000-8000-000000000102') as admin_rows,
       (select count(*) from public.service_requests
         where id = 'd2000000-0000-4000-8000-000000000101') as seller_rows,
       (select count(*) from public.service_requests
         where buyer_user_id <> 'd2000000-0000-4000-8000-00000000000a') as other_buyers_rows,
       public.has_permission('service_requests.request.read') as can_read;
reset role;

select is((select admin_rows from probe_buyer), 1::bigint,
  'the buyer of an admin-only brief still sees it: buyer ownership is unchanged');
select is((select seller_rows from probe_buyer), 1::bigint, 'along with their seller-routed brief');
select is((select other_buyers_rows from probe_buyer), 0::bigint,
  'and nothing of anybody else''s, in either mode');
select ok((select not can_read from probe_buyer), 'a buyer holds no staff permission');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d2000000-0000-4000-8000-00000000000b","role":"authenticated","aal":"aal1"}', true);
create temp table probe_third as
select (select count(*) from public.service_requests
         where id = 'd2000000-0000-4000-8000-000000000102') as admin_rows,
       (select count(*) from public.service_requests
         where id = 'd2000000-0000-4000-8000-000000000101') as seller_rows;
reset role;

select is((select admin_rows from probe_third), 0::bigint,
  'a third party sees neither the admin-only brief');
select is((select seller_rows from probe_third), 0::bigint, 'nor the seller-routed one');

-- ---------------------------------------------------------------------------------------------------
-- 4. D7-10 — the keys, and their assignment
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.permissions
    where key in ('service_requests.request.read', 'service_requests.request.manage')),
  2, 'both approved permission keys exist');
-- The module's keys, as they stand once D7-09's field-level read key has landed too. What must never
-- exist is the *manage* counterpart: nothing anywhere edits either payment field, so a key for it would be
-- a promise the schema does not keep.
select is(
  (select string_agg(key, ',' order by key) from public.permissions
    where module = 'service_requests'),
  'service_requests.payment_info.read,service_requests.request.manage,service_requests.request.read',
  'the module holds the two request keys and D7-09''s read key, and nothing else');
select is(
  (select count(*)::int from public.permissions where key = 'service_requests.payment_info.manage'),
  0, 'and no payment-information manage key exists, in any increment');
select is(
  (select count(*)::int from public.permissions
    where key like 'service_requests.%' and module <> 'service_requests'),
  0, 'each row''s module agrees with its own key, as 0033 requires of every row');
select is(
  (select count(*)::int from public.permissions
    where key in ('service_requests.request.read', 'service_requests.request.manage')
      and (btrim(description_ar) = '' or description_ar = description_en)),
  0, 'each is described in both languages');

select is(
  (select string_agg(distinct role_key, ',' order by role_key) from public.role_permissions
    where permission_key = 'service_requests.request.read'),
  'admin,super_admin', 'the read key is held by admin and super_admin, and no other role');
select is(
  (select string_agg(distinct role_key, ',' order by role_key) from public.role_permissions
    where permission_key = 'service_requests.request.manage'),
  'admin,super_admin', 'and so is the manage key');
select is(
  (select count(*)::int from public.role_permissions
    where permission_key like 'service_requests.%'
      and role_key in ('guest', 'buyer', 'seller', 'moderator', 'support_agent')),
  0, 'no unprivileged role and neither narrow console role was granted anything');
select is(
  (select count(*) from public.role_permissions where role_key = 'admin'),
  (select count(*) from public.permissions),
  'admin still holds every permission, which is the seeded invariant the assignment follows');
select is(
  (select count(*) from public.role_permissions where role_key = 'super_admin'),
  (select count(*) from public.permissions),
  'and so does super_admin');
select is((select count(*) from public.role_permissions where role_key = 'moderator'), 9::bigint,
  'the moderator''s nine are untouched');
select is((select count(*) from public.role_permissions where role_key = 'support_agent'), 5::bigint,
  'and the support agent''s five');

-- The repository's own invariant: every key is enforced by a live policy, and every enforced key is seeded.
select is(
  (select count(distinct e.k)::int from (
     select (regexp_matches(pg_get_expr(p.polqual, p.polrelid) || ' ' ||
                            coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                            'has_permission\(''([a-z_.]+)''::text\)', 'g'))[1] as k
       from pg_policy p) e
    where e.k in ('service_requests.request.read', 'service_requests.request.manage')),
  2, 'both new keys are enforced by a live policy, as 0033''s invariant requires');

-- ---------------------------------------------------------------------------------------------------
-- 5. AAL2, through the existing model
-- ---------------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d2000000-0000-4000-8000-0000000000d1","role":"authenticated","aal":"aal1"}', true);
create temp table probe_admin_aal1 as
select public.has_permission('service_requests.request.read') as can_read,
       public.has_permission('service_requests.request.manage') as can_manage,
       (select count(*) from public.service_requests) as visible;
reset role;

select ok((select not can_read from probe_admin_aal1),
  'an admin in an aal1 session holds neither key: 0003''s requires_mfa rule, not a new one');
select ok((select not can_manage from probe_admin_aal1), 'nor the manage key');
select is((select visible from probe_admin_aal1), 0::bigint,
  'and sees no request at all at aal1, including their own none');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d2000000-0000-4000-8000-0000000000d1","role":"authenticated","aal":"aal2"}', true);
create temp table probe_admin_aal2 as
select public.has_permission('service_requests.request.read') as can_read,
       public.has_permission('service_requests.request.manage') as can_manage,
       (select count(*) from public.service_requests
         where id = 'd2000000-0000-4000-8000-000000000102') as admin_rows,
       (select count(*) from public.service_requests
         where id = 'd2000000-0000-4000-8000-000000000101') as seller_rows;
reset role;

select ok((select can_read from probe_admin_aal2), 'at aal2 the read key applies');
select ok((select can_manage from probe_admin_aal2), 'and the manage key');
select is((select admin_rows from probe_admin_aal2), 1::bigint,
  'and the staff read policy shows the admin-only row');
select is((select seller_rows from probe_admin_aal2), 1::bigint, 'and the seller-routed one');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d2000000-0000-4000-8000-0000000000d2","role":"authenticated","aal":"aal2"}', true);
create temp table probe_support as
select public.has_permission('service_requests.request.read') as can_read,
       (select count(*) from public.service_requests) as visible;
reset role;

select ok((select not can_read from probe_support),
  'a support agent at aal2 still holds neither key: the grant is admin and super_admin only');
select is((select visible from probe_support), 0::bigint, 'and sees no request through it');

-- The app_system counterparts: the same rule with the assurance level as a parameter.
select ok(app_private.service_requests_staff_can_read('d2000000-0000-4000-8000-0000000000d1', true),
  'the read predicate is true for an admin at aal2');
select ok(not app_private.service_requests_staff_can_read('d2000000-0000-4000-8000-0000000000d1', false),
  'and false for the same admin at aal1');
select ok(not app_private.service_requests_staff_can_read('d2000000-0000-4000-8000-0000000000d1', null),
  'and false when the assurance level is unknown rather than stated');
select ok(app_private.service_requests_staff_can_manage('d2000000-0000-4000-8000-0000000000d1', true),
  'the manage predicate is true for an admin at aal2');
select ok(not app_private.service_requests_staff_can_manage('d2000000-0000-4000-8000-0000000000d1', false),
  'and false at aal1');
select ok(not app_private.service_requests_staff_can_read('d2000000-0000-4000-8000-0000000000d2', true),
  'neither predicate admits a support agent');
select ok(not app_private.service_requests_staff_can_read('d2000000-0000-4000-8000-000000000011', true),
  'nor a seller');
select ok(not app_private.service_requests_staff_can_read(null, true),
  'nor an absent account');

-- A revoked or expired grant is not a grant, which is 0003's rule and not a second copy of it.
update public.user_roles set revoked_at = now() - interval '1 hour'
 where user_id = 'd2000000-0000-4000-8000-0000000000d1';
select ok(not app_private.service_requests_staff_can_read('d2000000-0000-4000-8000-0000000000d1', true),
  'a revoked role grants neither key');
update public.user_roles set revoked_at = null, expires_at = now() - interval '1 minute'
 where user_id = 'd2000000-0000-4000-8000-0000000000d1';
select ok(not app_private.service_requests_staff_can_read('d2000000-0000-4000-8000-0000000000d1', true),
  'and an expired one does not either');
update public.user_roles set expires_at = null
 where user_id = 'd2000000-0000-4000-8000-0000000000d1';

-- Least privilege on the two predicates.
select ok(
  (select count(*) = 0 from information_schema.role_routine_grants
    where routine_schema = 'app_private' and grantee in ('public', 'PUBLIC', 'authenticated', 'anon')
      and routine_name in ('service_requests_staff_can_read', 'service_requests_staff_can_manage')),
  'neither predicate is executable by public, anon or authenticated'
);
select ok(
  (select count(*) = 2 from information_schema.role_routine_grants
    where routine_schema = 'app_private' and grantee = 'app_system'
      and routine_name in ('service_requests_staff_can_read', 'service_requests_staff_can_manage')),
  'and both are executable by app_system'
);
select ok(
  (select bool_and(p.proconfig @> array['search_path=pg_catalog, public'])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('service_requests_staff_can_read', 'service_requests_staff_can_manage')),
  'both pin their search_path'
);
select ok(
  (select bool_and(pg_get_function_arguments(p.oid) = 'p_user_id uuid, p_is_aal2 boolean')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('service_requests_staff_can_read', 'service_requests_staff_can_manage')),
  'and neither takes a permission key as an argument: an account and an assurance level, nothing else'
);
select ok(
  (select p.prosrc like '%''service_requests.request.read''%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'service_requests_staff_can_read'),
  'the read predicate pins its own key as a literal'
);
select ok(
  (select p.prosrc like '%''service_requests.request.manage''%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'service_requests_staff_can_manage'),
  'and the manage predicate pins its own'
);

-- ---------------------------------------------------------------------------------------------------
-- 6. The two readers, made null-safe without changing Option 1
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.service_requests_for_buyer(
     'd2000000-0000-4000-8000-00000000000a', 20, null, null)),
  2, 'the buyer''s list carries both of their briefs, the seller-routed and the admin-only one');
select is(
  (select counterparty_name from app_private.service_requests_for_buyer(
     'd2000000-0000-4000-8000-00000000000a', 20, null, null) where id = 'd2000000-0000-4000-8000-000000000101'),
  'Routing Shop One', 'with the storefront named on the seller-routed one, exactly as before');
select is(
  (select counterparty_name from app_private.service_requests_for_buyer(
     'd2000000-0000-4000-8000-00000000000a', 20, null, null) where id = 'd2000000-0000-4000-8000-000000000102'),
  null, 'and null on the admin-only one rather than the row disappearing');

select is(
  (select count(*)::int from app_private.service_requests_for_seller(
     'd2000000-0000-4000-8000-000000000011', 20, null, null)
    where id = 'd2000000-0000-4000-8000-000000000102'),
  0, 'the seller''s inbox never carries an admin-only brief');

select is(
  (select is_seller from app_private.service_request_detail(
     'd2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000102')),
  false, 'the detail says is_seller false, not unknown, on a seller-less brief');
select is(
  (select is_buyer from app_private.service_request_detail(
     'd2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000102')),
  true, 'and is_buyer true for its buyer');
select is(
  (select seller_name from app_private.service_request_detail(
     'd2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000102')),
  null, 'with no storefront named');
select is(
  (select outcome from app_private.service_request_detail(
     'd2000000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000000102')),
  'not_found', 'and the seller is told nothing at all about it');
select is(
  (select is_seller from app_private.service_request_detail(
     'd2000000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000000101')),
  true, 'while the seller-routed brief still reports its seller as the seller');

-- ---------------------------------------------------------------------------------------------------
-- 7. Nothing Admin Only was added
-- ---------------------------------------------------------------------------------------------------
-- The four functions this migration defines or replaces, named one by one. 7-J's Option 2 functions do
-- mention the mode — that is their subject — so the claim these assertions make is about the foundation
-- itself: it carries the column and the keys without consuming either.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in (
        'service_requests_staff_can_read', 'service_requests_staff_can_manage',
        'service_requests_for_buyer', 'service_request_detail')
      and p.prosrc like '%admin_only%'),
  0, 'no function of the foundation writes or reads the admin-only mode');
-- Two of the four *return* the column since 7-J, so a buyer's own surface can name the flow. What none of
-- them does is write it or branch on the admin-only value, which is the claim that matters: the foundation
-- carries the column without deciding anything with it.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in (
        'service_requests_staff_can_read', 'service_requests_staff_can_manage',
        'service_requests_for_buyer', 'service_request_detail')
      and (p.prosrc like '%insert into public.service_requests%'
           or p.prosrc like '%set routing_mode%')),
  0, 'and none of them writes the column');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in (
        'service_requests_staff_can_read', 'service_requests_staff_can_manage',
        'service_requests_for_buyer', 'service_request_detail')
      and p.prosrc like '%payment_info%'),
  0, 'and none of them reads payment information: that is D7-09''s own reader');

-- A quote cannot be sent against a seller-less brief, because no seller matches — the schema refusing it.
select is(
  (select outcome from app_private.service_quote_create(
     'd2000000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000000102', 390000,
     7::smallint, 0::smallint, 'A scope long enough to satisfy the ten-character rule.', 14::smallint)),
  'not_found', 'a seller cannot quote on an admin-only brief');
select is(
  (select count(*)::int from public.service_quotes q
    where q.service_request_id = 'd2000000-0000-4000-8000-000000000102'),
  0, 'and no quote was written for one');
select is(
  (select r.status from public.service_requests r where r.id = 'd2000000-0000-4000-8000-000000000102'),
  'open', 'the admin-only brief did not move: no quote support was added for it');

select * from finish();
rollback;
