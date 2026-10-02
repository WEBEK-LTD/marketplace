-- pgTAP — migration 0058: creating one's own storefront.
--
-- Three things are being held to account, and the first is the reason the function exists at all.
--
-- **The caller cannot choose their state.** `status` and `verification_status` are not parameters, so the
-- test cannot even attempt to pass one — which is the strongest form of the assertion, and it is checked
-- by asserting the *parameter list itself*, name by name. What the test can do is prove that every
-- successful creation lands on `pending` / `unverified`, that none of the four state-bearing timestamp
-- columns is set, and that no path produces an `active`, `verified`, `suspended` or `closed` storefront.
--
-- **One storefront per user, one holder per slug.** Both are 0009's own keys. The function checks them
-- before writing so the ordinary repeat answers cleanly, and catches the violation so two simultaneous
-- attempts cannot both land; both branches are covered, and `exists` and `slug_taken` are asserted to be
-- different answers rather than one vague refusal.
--
-- **Every limit is 0009's.** Each boundary is tested on both sides — 2 and 1 characters, 80 and 81, 2000
-- and 2001, a 50-character slug and a 51-character one — so a limit that drifted in either direction
-- fails here. An uppercase slug is asserted *refused*, not normalised: a slug becomes a permanent public
-- address, and silently changing what somebody typed is not a kindness.
--
-- The security block is the S8 contract restated for this function: SECURITY DEFINER, pinned search_path,
-- PUBLIC revoked, `authenticated` and `anon` refused, `app_system` alone granted, no table privilege
-- anywhere, and 0009's own `authenticated` grants and policies still exactly as they were.
--
-- Deterministic: fixed uuids, no wall-clock dependence. Everything runs in a transaction that is rolled
-- back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(121);

-- Fixtures ------------------------------------------------------------------------------------------
-- A marketplace-enabled country and a disabled one, so D17 can be tested from both sides, plus a locale
-- `content_language` can point at.
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zy', 'Test locale', 'Test locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTT', '961', 'T', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZY', 'ZYZ', '997', 'Testland', 'Testland', '997', 'XTT', true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZX', 'ZXZ', '996', 'Offland', 'Offland', '996', 'XTT', false);

insert into auth.users (id, email) values
  ('80000000-0000-4000-8000-000000000001', 'first-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000002', 'second-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000003', 'boundary-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000004', 'refused-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000005', 'never-a-seller@test.invalid');

-- ---------------------------------------------------------------------------------------------------
-- Security: the S8 contract, restated for this function
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'seller_create_profile',
  array['uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
  'the writer exists, taking the caller id and the ten onboarding fields');

select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_create_profile'),
  true,
  'it is SECURITY DEFINER, because app_system holds no table privileges');

select is(
  (select array_to_string(p.proconfig, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_create_profile'),
  'search_path=pg_catalog, public',
  'its search_path is pinned, so a definer function cannot be redirected');

select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_create_profile'),
  'v'::"char",
  'it is volatile: it writes');

-- The parameter list is the security property. There is exactly one identity parameter, it is the first,
-- and there is no `status`, `verification_status`, `role`, `suspended`, `closed` or `verified` parameter
-- anywhere — so a caller has nothing to pass that could choose their own state or somebody else's row.
select is(
  (select array_to_string(p.proargnames[1:11], ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_create_profile'),
  'p_user_id,p_slug,p_display_name,p_legal_name,p_bio,p_content_language,p_country_code,p_governorate,p_city,p_contact_email,p_contact_phone_e164',
  'the ten onboarding fields and one caller id, and nothing else, are its parameters');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames[1:11]) as arg
    where n.nspname = 'app_private' and p.proname = 'seller_create_profile'
      and (arg like '%status%' or arg like '%role%' or arg like '%suspend%'
        or arg like '%closed%' or arg like '%verif%' or arg like '%owner%')),
  0::bigint,
  'no parameter names a status, a role, a suspension, a closure, a verification or another owner');

select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_create_profile'),
  'TABLE(outcome text, slug text, display_name text, status text, verification_status text, city text, country_code character)',
  'it returns the outcome and the 6-A projection, and nothing private');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames[12:18]) as col
    where n.nspname = 'app_private' and p.proname = 'seller_create_profile'
      and col in ('user_id', 'legal_name', 'bio', 'contact_email', 'contact_phone_e164',
                  'suspension_reason', 'suspended_at', 'closed_at', 'verified_at',
                  'logo_object_path', 'banner_object_path', 'governorate', 'created_at', 'updated_at')),
  0::bigint,
  'none of the fourteen private columns can appear in its result');

select ok(
  not has_function_privilege('public', 'app_private.seller_create_profile(uuid, text, text, text, text, text, text, text, text, text, text)', 'execute'),
  'PUBLIC cannot execute it');
select ok(
  not has_function_privilege('authenticated', 'app_private.seller_create_profile(uuid, text, text, text, text, text, text, text, text, text, text)', 'execute'),
  'authenticated cannot execute it: a browser session is not an onboarding path');
select ok(
  not has_function_privilege('anon', 'app_private.seller_create_profile(uuid, text, text, text, text, text, text, text, text, text, text)', 'execute'),
  'anon cannot execute it');
select ok(
  has_function_privilege('app_system', 'app_private.seller_create_profile(uuid, text, text, text, text, text, text, text, text, text, text)', 'execute'),
  'app_system can execute it');
select ok(
  not has_function_privilege('app_worker', 'app_private.seller_create_profile(uuid, text, text, text, text, text, text, text, text, text, text)', 'execute'),
  'app_worker cannot: onboarding is not background work');

-- No table privilege was granted anywhere by this migration.
select is(
  (select count(*) from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'seller_profiles' and grantee = 'app_system'),
  0::bigint,
  'app_system still holds no privilege on public.seller_profiles');
select is(
  (select count(*) from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'seller_profiles' and grantee = 'anon'),
  0::bigint,
  'anon still holds no privilege on public.seller_profiles');
select is(
  (select array_to_string(array_agg(distinct privilege_type order by privilege_type), ',')
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'seller_profiles' and grantee = 'authenticated'),
  'INSERT,SELECT,UPDATE',
  '0009''s authenticated grants are unchanged: no DELETE, and nothing widened');
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'seller_profiles'),
  6::bigint,
  '0009''s six policies are still in place as defence in depth');
select ok(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'seller_profiles' and policyname = 'seller_profiles_self_insert') = 1,
  'the owner-write insert policy in particular was not revoked');

-- The seller functions in app_private: 0057's reader, this writer, and — since 6-D — 0059's editor. Named
-- rather than counted, so an unapproved fourth still fails here.
select is(
  (select array_to_string(array_agg(p.proname order by p.proname), ',') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_%'),
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
  'exactly thirty-two seller_ functions exist in app_private: the 6-A reader, this writer, 6-D''s editor, 6-E''s two media functions, 6-F''s five approved listing functions, 6-G''s four approved service functions, 6-I''s six approved verification functions 6-J''s six approved read-only surfaces and 8-C''s six listing attribute and tag functions');

select lives_ok(
  $$ select app_private.assert_security_contract() $$,
  'the deploy-time security contract still holds');

-- ---------------------------------------------------------------------------------------------------
-- Creation
-- ---------------------------------------------------------------------------------------------------
create temporary table created as
select * from app_private.seller_create_profile(
  '80000000-0000-4000-8000-000000000001',
  'good-shop',
  '  Good Shop  ',
  '  Good Shop Trading LLC  ',
  '  We restore mid-century furniture.  ',
  'zy',
  'ZY',
  '  Cairo Governorate  ',
  '  Cairo  ',
  '  owner@example.invalid  ',
  '+201555000001'
);

select is((select outcome from created), 'created', 'an authenticated caller creates their storefront');
select is((select status from created), 'pending', 'the returned status is pending');
select is((select verification_status from created), 'unverified', 'the returned verification status is unverified');
select is((select slug from created), 'good-shop', 'the returned slug is the one asked for');
select is((select display_name from created), 'Good Shop', 'the returned display name is trimmed');
select is((select city from created), 'Cairo', 'the returned city is trimmed');
select is((select country_code from created), 'ZY'::char(2), 'the returned country is the one asked for');

select is(
  (select count(*) from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  1::bigint,
  'exactly one row was written');

select is(
  (select s.user_id from public.seller_profiles s where s.slug = 'good-shop'),
  '80000000-0000-4000-8000-000000000001'::uuid,
  'the row belongs to the account whose id was supplied, and no other');

-- Every allowed field, as stored.
select is((select s.slug from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'good-shop', 'the slug is stored as given');
select is((select s.display_name from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'Good Shop', 'the display name is stored trimmed');
select is((select s.legal_name from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'Good Shop Trading LLC', 'the legal name is stored trimmed');
select is((select s.bio from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'We restore mid-century furniture.', 'the bio is stored trimmed');
select is((select s.content_language from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'zy', 'the content language is stored');
select is((select s.country_code from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'ZY'::char(2), 'the country is stored');
select is((select s.governorate from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'Cairo Governorate', 'the governorate is stored trimmed');
select is((select s.city from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'Cairo', 'the city is stored trimmed');
select is((select s.contact_email::text from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'owner@example.invalid', 'the contact email is stored trimmed');
select is((select s.contact_phone_e164 from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  '+201555000001', 'the contact phone is stored');

-- The state, in the table rather than in the return value.
select is((select s.status from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'pending', 'the stored status is pending');
select is((select s.verification_status from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'unverified', 'the stored verification status is unverified');
select is((select s.suspended_at from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  null::timestamptz, 'suspended_at is not set');
select is((select s.suspension_reason from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  null::text, 'suspension_reason is not set');
select is((select s.closed_at from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  null::timestamptz, 'closed_at is not set');
select is((select s.verified_at from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  null::timestamptz, 'verified_at is not set');
select is((select s.logo_object_path from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  null::text, 'no logo object path was invented: media is a later increment');
select is((select s.banner_object_path from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  null::text, 'no banner object path was invented');
select isnt((select s.created_at from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  null::timestamptz, 'the timestamps are the table''s own defaults, not the caller''s');

-- Nothing else was created alongside it.
select is(
  (select count(*) from public.user_roles r
    where r.user_id = '80000000-0000-4000-8000-000000000001'),
  0::bigint,
  'no role was assigned: Phase 6 authorization is seller_profiles.status');
select is(
  (select count(*) from public.seller_verifications v
    where v.seller_user_id = '80000000-0000-4000-8000-000000000001'),
  0::bigint,
  'no verification record was created: submission is a later increment');
select is(
  (select count(*) from public.notifications n where n.user_id = '80000000-0000-4000-8000-000000000001'),
  0::bigint,
  'nobody was notified');

-- ---------------------------------------------------------------------------------------------------
-- Optional fields left blank become absent, not empty
-- ---------------------------------------------------------------------------------------------------
create temporary table minimal as
select * from app_private.seller_create_profile(
  '80000000-0000-4000-8000-000000000002', 'plain-shop', 'Plain Shop',
  '', '', null, 'ZY', '', '', '', ''
);

select is((select outcome from minimal), 'created', 'a seller may create a storefront with only the required fields');
select is((select s.legal_name from public.seller_profiles s where s.slug = 'plain-shop'),
  null::text, 'an empty legal name is stored as absent, not as an empty string');
select is((select s.bio from public.seller_profiles s where s.slug = 'plain-shop'),
  null::text, 'an empty bio is absent');
select is((select s.governorate from public.seller_profiles s where s.slug = 'plain-shop'),
  null::text, 'an empty governorate is absent');
select is((select s.city from public.seller_profiles s where s.slug = 'plain-shop'),
  null::text, 'an empty city is absent');
select is((select s.contact_email from public.seller_profiles s where s.slug = 'plain-shop'),
  null::extensions.citext, 'an empty contact email is absent');
select is((select s.contact_phone_e164 from public.seller_profiles s where s.slug = 'plain-shop'),
  null::text, 'an empty contact phone is absent');
select is((select s.content_language from public.seller_profiles s where s.slug = 'plain-shop'),
  null::text, 'no content language is absent');
select is((select city from minimal), null::text, 'the projection reports the absent city as null');
select is((select status from minimal), 'pending', 'the minimal storefront is pending too');

-- ---------------------------------------------------------------------------------------------------
-- One storefront per user
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000001', 'another-shop', 'Another Shop',
    null, null, null, 'ZY', null, null, null, null)),
  'exists',
  'a second attempt by the same account answers exists');

select is(
  (select count(*) from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  1::bigint,
  'and wrote nothing: there is still exactly one storefront for that account');

select is(
  (select s.slug from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'good-shop',
  'the existing storefront was not replaced or renamed by the second attempt');

select is(
  (select count(*) from public.seller_profiles s where s.slug = 'another-shop'),
  0::bigint,
  'the slug from the refused second attempt was not taken');

-- ---------------------------------------------------------------------------------------------------
-- One holder per slug
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000003', 'good-shop', 'Impostor Shop',
    null, null, null, 'ZY', null, null, null, null)),
  'slug_taken',
  'a slug somebody else holds answers slug_taken');

select is(
  (select count(*) from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000003'),
  0::bigint,
  'and nothing was written for the caller who asked for it');

select is(
  (select s.display_name from public.seller_profiles s where s.slug = 'good-shop'),
  'Good Shop',
  'the storefront that holds the slug was not touched');

select isnt(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000003', 'good-shop', 'Impostor Shop',
    null, null, null, 'ZY', null, null, null, null)),
  'exists',
  'slug_taken and exists are different answers: a taken slug never reads as "you already have one"');

-- ---------------------------------------------------------------------------------------------------
-- Validation — every limit is 0009's, tested from both sides
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_create_profile(
    null, 'no-owner-shop', 'No Owner', null, null, null, 'ZY', null, null, null, null)),
  'invalid',
  'no caller id is invalid: there is no storefront without an owner');

select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-00000000ffff', 'ghost-shop', 'Ghost Shop',
    null, null, null, 'ZY', null, null, null, null)),
  'invalid',
  'an id that matches no account is invalid, refused by the foreign key rather than trusted');

-- Slug.
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'Good-Shop-2', 'Refused', null, null, null, 'ZY', null, null, null, null)),
  'invalid',
  'an uppercase slug is refused, not silently lower-cased into a different public address');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'bad_slug', 'Refused', null, null, null, 'ZY', null, null, null, null)),
  'invalid',
  'an underscore is not a slug character');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'ab', 'Refused', null, null, null, 'ZY', null, null, null, null)),
  'invalid',
  'a two-character slug is below 0009''s minimum of three');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', repeat('a', 51), 'Refused', null, null, null, 'ZY', null, null, null, null)),
  'invalid',
  'a fifty-one-character slug is above 0009''s maximum of fifty');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', '-leading', 'Refused', null, null, null, 'ZY', null, null, null, null)),
  'invalid',
  'a leading hyphen is refused');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'trailing-', 'Refused', null, null, null, 'ZY', null, null, null, null)),
  'invalid',
  'a trailing hyphen is refused');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', '  spaced-shop  ', 'Refused', null, null, null, 'ZY', null, null, null, null)),
  'invalid',
  'a slug with surrounding whitespace is refused rather than trimmed into shape');

-- Display name.
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'name-one', 'A', null, null, null, 'ZY', null, null, null, null)),
  'invalid',
  'a one-character display name is below 0009''s minimum of two');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'name-blank', '     ', null, null, null, 'ZY', null, null, null, null)),
  'invalid',
  'a display name of whitespace is refused: the limit is on the trimmed value');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'name-long', repeat('n', 81), null, null, null, 'ZY', null, null, null, null)),
  'invalid',
  'an eighty-one-character display name is above 0009''s maximum of eighty');

-- Bio.
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'bio-long', 'Bio Shop', null, repeat('b', 2001), null, 'ZY', null, null, null, null)),
  'invalid',
  'a 2001-character bio is above 0009''s maximum of 2000');

-- Locale.
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'locale-shop', 'Locale Shop', null, null, 'qq', 'ZY', null, null, null, null)),
  'invalid',
  'a content language that is not a locale is refused');

-- Country: D17 from both sides.
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'off-shop', 'Off Shop', null, null, null, 'ZX', null, null, null, null)),
  'invalid',
  'a country that exists but is not marketplace-enabled is refused (D17)');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'unknown-shop', 'Unknown Shop', null, null, null, 'QQ', null, null, null, null)),
  'invalid',
  'a country that does not exist is refused');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'long-country', 'Long Country', null, null, null, 'ZYZ', null, null, null, null)),
  'invalid',
  'a country code that is not exactly two characters is refused');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'no-country', 'No Country', null, null, null, null, null, null, null, null)),
  'invalid',
  'an absent country is refused: the column is not null');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'lower-country', 'Lower Country', null, null, null, 'zy', null, null, null, null)),
  'invalid',
  'a lower-case country code is refused rather than case-folded into a foreign key');

-- Contact email: the floor beneath the API's strict contract.
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'email-shop', 'Email Shop', null, null, null, 'ZY', null, null, 'not-an-email', null)),
  'invalid',
  'an address with no domain is refused');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'email-space', 'Email Shop', null, null, null, 'ZY', null, null, 'two words@example.invalid', null)),
  'invalid',
  'an address with whitespace inside it is refused');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'email-long', 'Email Shop', null, null, null, 'ZY', null, null,
    repeat('e', 310) || '@example.invalid', null)),
  'invalid',
  'an address longer than 320 characters is refused');

-- Contact phone.
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'phone-shop', 'Phone Shop', null, null, null, 'ZY', null, null, null, '0201555000')),
  'invalid',
  'a phone number without the E.164 plus is refused');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'phone-short', 'Phone Shop', null, null, null, 'ZY', null, null, null, '+2015')),
  'invalid',
  'a phone number shorter than 0009''s E.164 pattern allows is refused');
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'phone-zero', 'Phone Shop', null, null, null, 'ZY', null, null, null, '+0201555000001')),
  'invalid',
  'a phone number whose country digit is zero is refused');

-- Not one of those refusals wrote anything.
select is(
  (select count(*) from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000004'),
  0::bigint,
  'after every refusal above, the caller still has no storefront');
select is(
  (select count(*) from public.seller_profiles),
  2::bigint,
  'and the table holds only the two storefronts that were legitimately created');

-- ---------------------------------------------------------------------------------------------------
-- The boundaries that must be accepted
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000004', 'abc', 'Ab', null, repeat('b', 2000), 'zy', 'ZY', null, null,
    'a@b.co', '+2015550001')),
  'created',
  'the far side of every boundary is accepted: a three-character slug, a two-character name, a 2000-character bio');
select is(
  (select length(s.bio) from public.seller_profiles s where s.slug = 'abc'),
  2000,
  'the 2000-character bio was stored whole');
select is(
  (select s.display_name from public.seller_profiles s where s.slug = 'abc'),
  'Ab',
  'the two-character display name was stored');
select is(
  (select s.status from public.seller_profiles s where s.slug = 'abc'),
  'pending',
  'and it is pending, like every other creation');

select is(
  (select outcome from app_private.seller_create_profile(
    '80000000-0000-4000-8000-000000000005', left(repeat('a', 49) || 'b', 50), repeat('n', 80),
    null, null, null, 'ZY', null, null, null, '+201555000014')),
  'created',
  'a fifty-character slug and an eighty-character display name are accepted');
select is(
  (select length(s.slug) from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000005'),
  50,
  'the fifty-character slug was stored whole');
select is(
  (select length(s.display_name) from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000005'),
  80,
  'the eighty-character display name was stored whole');

-- ---------------------------------------------------------------------------------------------------
-- No path produces a state the caller is not allowed to have
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.seller_profiles s where s.status <> 'pending'),
  0::bigint,
  'every storefront this migration created is pending: none is active, suspended or closed');
select is(
  (select count(*) from public.seller_profiles s where s.verification_status <> 'unverified'),
  0::bigint,
  'and every one is unverified: none is pending, verified or rejected review');
select is(
  (select count(*) from public.seller_profiles s
    where s.suspended_at is not null or s.closed_at is not null or s.verified_at is not null
       or s.suspension_reason is not null),
  0::bigint,
  'no state-bearing timestamp or reason was set by any creation');
select is(
  (select count(*) from public.user_roles),
  0::bigint,
  'no role was assigned to anybody: nothing here writes to user_roles');
select is(
  (select count(*) from public.seller_verifications),
  0::bigint,
  'no verification record exists anywhere: 6-I owns submission');

-- ---------------------------------------------------------------------------------------------------
-- Audit: 0009's own trigger, doing its ordinary job
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'),
  4::bigint,
  'one audit entry per creation, from 0009''s existing trigger — no second audit mechanism');
select is(
  (select array_to_string(array_agg(distinct a.action order by a.action), ',') from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'),
  'insert',
  'every one of them is an insert: no update or delete was performed');
select is(
  (select count(*) from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'
      and a.new_values ->> 'status' = 'pending'),
  4::bigint,
  'each audit entry records the pending state that was actually written');
select is(
  (select count(*) from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'
      and a.new_values ->> 'verification_status' = 'unverified'),
  4::bigint,
  'and the unverified verification state');
select is(
  (select count(*) from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles' and a.old_values is not null),
  0::bigint,
  'an insert has no previous values, so none were recorded');

-- The refused attempts are not audited, because nothing happened: an audit log is a record of change.
select is(
  (select count(*) from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'
      and a.new_values ->> 'slug' in ('another-shop', 'Good-Shop-2', 'bad_slug', 'off-shop', 'unknown-shop')),
  0::bigint,
  'no refusal left an audit entry behind');

-- ---------------------------------------------------------------------------------------------------
-- 0057's reader sees exactly what was created, and still discloses nothing more
-- ---------------------------------------------------------------------------------------------------
select is(
  (select i.status from app_private.seller_identity('80000000-0000-4000-8000-000000000001') i),
  'pending',
  'the 6-A reader reports the new storefront as pending');
select is(
  (select i.verification_status from app_private.seller_identity('80000000-0000-4000-8000-000000000001') i),
  'unverified',
  'and unverified');
select is(
  (select i.slug from app_private.seller_identity('80000000-0000-4000-8000-000000000001') i),
  'good-shop',
  'and by the slug that was chosen');
select is(
  (select count(*) from app_private.seller_identity('80000000-0000-4000-8000-000000000004') i
    where i.slug = 'abc'),
  1::bigint,
  'a caller who onboarded through a boundary case reads back normally too');
select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_identity'),
  'TABLE(slug text, display_name text, status text, verification_status text, city text, country_code character)',
  '0057''s projection is untouched by this migration');

-- ---------------------------------------------------------------------------------------------------
-- 0050's public reader is untouched: a pending storefront is still not public
-- ---------------------------------------------------------------------------------------------------
select is(
  (select r.outcome from app_private.public_seller_by_slug('good-shop') r),
  'not_found',
  'a newly created pending storefront is not publicly visible: 4-E is unchanged');
select is(
  (select count(*) from public.seller_profiles s where s.status = 'active'),
  0::bigint,
  'nothing this path creates could be publicly visible, because nothing it creates is active');

select * from finish();
rollback;
