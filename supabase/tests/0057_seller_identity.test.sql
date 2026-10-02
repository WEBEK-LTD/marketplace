-- pgTAP — migration 0057: the authenticated seller's own identity.
--
-- Two things are being held to account.
--
-- **The projection.** Exactly six columns, named and typed, and every field 0009 holds that this reader
-- must never disclose is asserted absent from the return type itself rather than merely unselected — a
-- column that cannot exist in the result cannot be added to the select later by accident.
--
-- **The scope.** The function reads the row belonging to the id it is given and no other. One seller
-- cannot ask about another, and an account with no storefront gets no row rather than an empty one.
--
-- All four statuses are covered, because this reader deliberately *does* report state: it is the owner
-- asking about their own storefront, not a guest asking about somebody else's, and 0050 remains the
-- reader that refuses to tell those apart.
--
-- Deterministic: fixed uuids, no wall-clock dependence. Everything runs in a transaction that is rolled
-- back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(58);

-- Fixtures ------------------------------------------------------------------------------------------
-- The country and the locale the profiles reference. `tg_seller_country_rule` requires a marketplace
-- country, so the fixture country is enabled.
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zy', 'Test locale', 'Test locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTT', '961', 'T', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZY', 'ZYZ', '997', 'Testland', 'Testland', '997', 'XTT', true);

insert into auth.users (id, email) values
  ('80000000-0000-4000-8000-000000000001', 'pending-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000002', 'active-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000003', 'suspended-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000004', 'closed-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000005', 'not-a-seller@test.invalid');

-- One profile per status the schema allows. `active` needs a verified verification status by 0009's own
-- constraint, and the two time-stamped statuses need their timestamps, so each row is built as the
-- schema requires rather than forced.
insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, bio, content_language, logo_object_path, banner_object_path,
   country_code, governorate, city, contact_email, contact_phone_e164,
   status, suspended_at, suspension_reason, closed_at, verification_status, verified_at)
values
  ('80000000-0000-4000-8000-000000000001', 'pending-shop', 'Pending Shop', 'Pending Shop LLC',
   'We are waiting for review.', 'zy', 'logos/pending.webp', 'banners/pending.webp',
   'ZY', 'Test Governorate', 'Testville', 'pending@private.invalid', '+201555000001',
   'pending', null, null, null, 'unverified', null),
  ('80000000-0000-4000-8000-000000000002', 'active-shop', 'Active Shop', 'Active Shop LLC',
   'We restore mid-century furniture.', 'zy', 'logos/active.webp', 'banners/active.webp',
   'ZY', 'Test Governorate', 'Cairo', 'active@private.invalid', '+201555000002',
   'active', null, null, null, 'verified', now()),
  ('80000000-0000-4000-8000-000000000003', 'suspended-shop', 'Suspended Shop', 'Suspended Shop LLC',
   'Temporarily off.', 'zy', 'logos/suspended.webp', 'banners/suspended.webp',
   'ZY', 'Test Governorate', 'Alexandria', 'suspended@private.invalid', '+201555000003',
   'suspended', now(), 'Repeated policy breaches, internal note', null, 'verified', now()),
  ('80000000-0000-4000-8000-000000000004', 'closed-shop', 'Closed Shop', 'Closed Shop LLC',
   'We have closed.', 'zy', 'logos/closed.webp', 'banners/closed.webp',
   'ZY', 'Test Governorate', 'Giza', 'closed@private.invalid', '+201555000004',
   'closed', null, null, now(), 'verified', now());

-- ---------------------------------------------------------------------------------------------------
-- The projection: exactly six columns, and exactly these
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'seller_identity', array['uuid'],
  'the reader exists, taking one caller id');

select is(
  (select count(*)::int from pg_get_function_result('app_private.seller_identity(uuid)'::regprocedure::oid)),
  1,
  'it returns a table rather than a scalar'
);

select set_eq(
  $$select (t).name::text
      from unnest((select proargnames from pg_proc where oid = 'app_private.seller_identity(uuid)'::regprocedure)) with ordinality as x(name, ord)
     cross join lateral (select x.name) as t
     where ord > 1$$,
  $$values ('slug'), ('display_name'), ('status'), ('verification_status'), ('city'), ('country_code')$$,
  'and its output columns are exactly the six approved fields'
);

select is(
  pg_get_function_result('app_private.seller_identity(uuid)'::regprocedure),
  'TABLE(slug text, display_name text, status text, verification_status text, city text, country_code character)',
  'named and typed exactly, in the approved order'
);

-- Every field 0009 holds that must not be disclosed, asserted against the return type itself.
select ok(
  (select position(field in pg_get_function_result('app_private.seller_identity(uuid)'::regprocedure)) = 0),
  format('the projection has no place for %s', field)
) from unnest(array[
  'user_id', 'legal_name', 'bio', 'contact_email', 'contact_phone_e164', 'suspension_reason',
  'suspended_at', 'closed_at', 'verified_at', 'created_at', 'updated_at', 'logo_object_path',
  'banner_object_path', 'content_language', 'governorate'
]) as field;

-- ---------------------------------------------------------------------------------------------------
-- Every status reports itself
-- ---------------------------------------------------------------------------------------------------
select results_eq(
  $$select slug, display_name, status, verification_status, city, country_code::text
      from app_private.seller_identity('80000000-0000-4000-8000-000000000001'::uuid)$$,
  $$values ('pending-shop', 'Pending Shop', 'pending', 'unverified', 'Testville', 'ZY')$$,
  'a pending seller sees that their application is pending and unverified'
);

select results_eq(
  $$select slug, display_name, status, verification_status, city, country_code::text
      from app_private.seller_identity('80000000-0000-4000-8000-000000000002'::uuid)$$,
  $$values ('active-shop', 'Active Shop', 'active', 'verified', 'Cairo', 'ZY')$$,
  'an active seller sees that they are trading'
);

select results_eq(
  $$select slug, display_name, status, verification_status, city, country_code::text
      from app_private.seller_identity('80000000-0000-4000-8000-000000000003'::uuid)$$,
  $$values ('suspended-shop', 'Suspended Shop', 'suspended', 'verified', 'Alexandria', 'ZY')$$,
  'a suspended seller sees that they are suspended — their own account state is not hidden from them'
);

select results_eq(
  $$select slug, display_name, status, verification_status, city, country_code::text
      from app_private.seller_identity('80000000-0000-4000-8000-000000000004'::uuid)$$,
  $$values ('closed-shop', 'Closed Shop', 'closed', 'verified', 'Giza', 'ZY')$$,
  'and a closed seller sees that it is closed'
);

select is(
  (select count(*)::int from app_private.seller_identity('80000000-0000-4000-8000-000000000003'::uuid)),
  1,
  'a suspended seller still gets exactly one row: this reader has no status filter'
);

-- ---------------------------------------------------------------------------------------------------
-- Not a seller is not an empty seller
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.seller_identity('80000000-0000-4000-8000-000000000005'::uuid)),
  0,
  'an account that has never applied has no seller identity at all'
);

select is(
  (select count(*)::int from app_private.seller_identity('80000000-0000-4000-8000-0000000000ff'::uuid)),
  0,
  'and neither does an id that names no account'
);

select is(
  (select count(*)::int from app_private.seller_identity(null)),
  0,
  'a null caller reads nothing rather than everything'
);

-- ---------------------------------------------------------------------------------------------------
-- One caller, one row
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.seller_identity('80000000-0000-4000-8000-000000000002'::uuid)),
  1,
  'the reader answers with one row, never a list'
);

select is(
  (select slug from app_private.seller_identity('80000000-0000-4000-8000-000000000002'::uuid)),
  'active-shop',
  'and it is the caller''s own row'
);

select isnt(
  (select slug from app_private.seller_identity('80000000-0000-4000-8000-000000000002'::uuid)),
  (select slug from app_private.seller_identity('80000000-0000-4000-8000-000000000003'::uuid)),
  'two callers get two different storefronts: nothing is shared or cached between them'
);

select is(
  (select count(*)::int from app_private.seller_identity('80000000-0000-4000-8000-000000000005'::uuid)),
  0,
  'a caller with no storefront cannot see somebody else''s by asking'
);

select is(
  (select count(*)::int from pg_proc p
    where p.oid = 'app_private.seller_identity(uuid)'::regprocedure
      and p.pronargs = 1),
  1,
  'there is exactly one parameter, so no caller can name a seller other than themselves'
);

select is(
  (select pg_get_function_identity_arguments('app_private.seller_identity(uuid)'::regprocedure)),
  'p_user_id uuid',
  'and that parameter is the caller id the API establishes from the session'
);

-- ---------------------------------------------------------------------------------------------------
-- It reads, and only reads
-- ---------------------------------------------------------------------------------------------------
create temporary table before_reading as
select
  (select count(*)::int from public.seller_profiles) as profiles,
  (select count(*)::int from public.outbox_events) as events,
  (select count(*)::int from audit.audit_logs) as audits,
  (select status from public.seller_profiles where user_id = '80000000-0000-4000-8000-000000000001') as pending_status,
  (select updated_at from public.seller_profiles where user_id = '80000000-0000-4000-8000-000000000002') as active_updated;

select ok(
  (select p.provolatile = 's'
     from pg_proc p where p.oid = 'app_private.seller_identity(uuid)'::regprocedure),
  'the function is declared stable, so it cannot write'
);

-- Reading every profile, then proving nothing moved.
select is(
  (select count(*)::int from (
     select app_private.seller_identity('80000000-0000-4000-8000-000000000001'::uuid)
     union all select app_private.seller_identity('80000000-0000-4000-8000-000000000002'::uuid)
     union all select app_private.seller_identity('80000000-0000-4000-8000-000000000003'::uuid)
     union all select app_private.seller_identity('80000000-0000-4000-8000-000000000004'::uuid)
   ) as everything),
  4,
  'all four storefronts read back'
);

select is(
  (select count(*)::int from public.seller_profiles),
  (select profiles from before_reading),
  'and no profile was created or removed by reading'
);

select is(
  (select status from public.seller_profiles where user_id = '80000000-0000-4000-8000-000000000001'),
  (select pending_status from before_reading),
  'no status changed'
);

select is(
  (select updated_at from public.seller_profiles where user_id = '80000000-0000-4000-8000-000000000002'),
  (select active_updated from before_reading),
  'no row was touched: `updated_at` did not move'
);

select is(
  (select count(*)::int from public.outbox_events),
  (select events from before_reading),
  'no outbox event was written'
);

select is(
  (select count(*)::int from audit.audit_logs),
  (select audits from before_reading),
  'and nothing was audited, because nothing was decided'
);

-- ---------------------------------------------------------------------------------------------------
-- 0050's public reader is untouched, and still refuses what it always refused
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.public_seller_by_slug('pending-shop')),
  'not_found',
  'the public reader still hides a pending seller'
);

select is(
  (select outcome from app_private.public_seller_by_slug('closed-shop')),
  'not_found',
  'and a closed one'
);

select is(
  (select availability from app_private.public_seller_by_slug('suspended-shop')),
  'unavailable',
  'while a suspended seller still has a page that says so'
);

select is(
  (select availability from app_private.public_seller_by_slug('active-shop')),
  'available',
  'and an active one is available'
);

select is(
  (select pg_get_function_result('app_private.public_seller_by_slug(text)'::regprocedure)),
  'TABLE(outcome text, availability text, slug text, display_name text, bio text, content_language text, city text)',
  '0050''s projection is unchanged: 0057 added a reader rather than altering one'
);

-- ---------------------------------------------------------------------------------------------------
-- The privilege model
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.security_contract_problems()),
  0,
  '0057 leaves the security contract with nothing to report'
);

select ok(
  (select p.prosecdef from pg_proc p where p.oid = 'app_private.seller_identity(uuid)'::regprocedure),
  'the reader is SECURITY DEFINER'
);

select ok(
  (select p.proconfig @> array['search_path=pg_catalog, public']
     from pg_proc p where p.oid = 'app_private.seller_identity(uuid)'::regprocedure),
  'with a pinned search_path'
);

select ok(
  not has_function_privilege('public', 'app_private.seller_identity(uuid)', 'execute'),
  'PUBLIC may not execute it'
);

select ok(
  not has_function_privilege('authenticated', 'app_private.seller_identity(uuid)', 'execute'),
  'authenticated may not execute it'
);

select ok(
  not has_function_privilege('anon', 'app_private.seller_identity(uuid)', 'execute'),
  'anon may not execute it'
);

select ok(
  has_function_privilege('app_system', 'app_private.seller_identity(uuid)', 'execute'),
  'and app_system may, which is the only application path in'
);

select ok(
  not has_table_privilege('app_system', 'public.seller_profiles', 'select')
  and not has_table_privilege('app_system', 'public.seller_profiles', 'update')
  and not has_table_privilege('app_system', 'public.seller_profiles', 'insert'),
  'app_system still holds no table privilege on seller_profiles: it reads only through this function'
);

select ok(
  not has_table_privilege('anon', 'public.seller_profiles', 'select'),
  'and anon reaches the table not at all'
);

-- 0009's own owner-write policies stay as they are: defence in depth for a path the application does not
-- use. 0057 neither relies on them nor removes them.
select ok(
  (select count(*)::int from pg_policy p
    where p.polrelid = 'public.seller_profiles'::regclass
      and p.polname in ('seller_profiles_self_read', 'seller_profiles_self_insert',
                        'seller_profiles_self_update', 'seller_profiles_public_read',
                        'seller_profiles_admin_read', 'seller_profiles_admin_update')) = 6,
  '0009''s six seller-profile policies are all still in place'
);

select ok(
  has_table_privilege('authenticated', 'public.seller_profiles', 'select')
  and has_table_privilege('authenticated', 'public.seller_profiles', 'insert')
  and has_table_privilege('authenticated', 'public.seller_profiles', 'update'),
  'and its grants were not revoked: 6-A added a reader and changed no posture'
);

-- Narrowed in 6-C (`seller_create_profile`, 0058), 6-D (`seller_update_profile`, 0059) and 6-E (the two
-- media functions, 0060). The point of this pair has not changed — the seller surface grows only by
-- approved increments — so instead of counting it names the whole inventory, which still fails the moment
-- an unapproved seller function appears.
select is(
  (select array_to_string(array_agg(p.proname order by p.proname), ',') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname like 'seller_%'),
  'seller_create_profile,seller_earnings,seller_identity,seller_listing_archive,'
    || 'seller_listing_attribute_options,seller_listing_attributes,seller_listing_attributes_save,'
    || 'seller_listing_create_draft,'
    || 'seller_listing_submit,seller_listing_tag_choices,seller_listing_tags_save,'
    || 'seller_listing_update_draft,seller_listing_vocabulary_context,seller_listings,'
    || 'seller_media_attach,'
    || 'seller_media_upload_target,seller_orders,seller_promotion_analytics,seller_promotions,'
    || 'seller_reviews,seller_reviews_summary,'
    || 'seller_service_create_draft,seller_service_details_problem,'
    || 'seller_service_update_draft,seller_services,seller_update_profile,'
    || 'seller_verification,seller_verification_document_attach,'
    || 'seller_verification_document_remove,seller_verification_document_target,'
    || 'seller_verification_start,seller_verification_submit',
  'app_private holds exactly thirty-two seller_% functions: this reader, 6-C''s writer, 6-D''s editor, 6-E''s two media functions, 6-F''s five approved listing functions, 6-G''s four approved service functions, 6-I''s six approved verification functions 6-J''s six approved read-only surfaces and 8-C''s six listing attribute and tag functions'
);

-- Narrowed again in 6-D, which added the approved editor. What still holds in full is the half that keeps
-- the later increments out: nothing deletes, suspends, closes, verifies or activates a storefront — those
-- are moderation and 6-I decisions, and no seller-facing path may make them.
select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'seller_delete%'
           or p.proname like 'seller_suspend%' or p.proname like 'seller_close%'
           or p.proname like 'seller_verify%' or p.proname like 'seller_activate%')),
  0,
  'no seller-profile deleter, suspender, closer, verifier or activator exists: 6-D edits only'
);

select finish();
rollback;
