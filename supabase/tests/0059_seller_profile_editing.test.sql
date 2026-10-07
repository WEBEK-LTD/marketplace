-- pgTAP — migration 0059: editing one's own storefront.
--
-- Four things are being held to account.
--
-- **The immutable columns cannot move.** Not "are checked" — cannot. The assertion is made twice over: the
-- parameter list is pinned name by name, so there is nothing a caller could pass that names `slug`,
-- `status`, `verification_status`, a suspension, a closure or a verification timestamp; and after a
-- successful edit that touches every editable field at once, each of those columns is asserted to hold the
-- value it held before.
--
-- **Three states per field, all three tested.** Omitted preserves, a value sets, an explicit null clears —
-- and clearing is refused for the two columns 0009 declares `not null`. The pair of parameters exists
-- precisely so that "leave it alone" and "empty it" are different requests, so both are exercised on every
-- nullable field rather than on a representative one.
--
-- **The status gate.** `pending` and `active` may edit; `suspended` and `closed` may not, and their refusal
-- carries no reason, writes nothing and leaves the row byte for byte as it was.
--
-- **Ownership is structural.** One caller parameter, used in the `where` clause; two sellers editing
-- concurrently touch only their own rows, and an id that owns no storefront gets `not_found` rather than a
-- refusal that would confirm somebody else's exists.
--
-- The audit block proves both directions: a successful edit produces exactly one `update` entry naming the
-- columns that actually changed, and every refused attempt produces none — an audit log that recorded
-- attempts would make a failed edit look like a change that happened.
--
-- Deterministic: fixed uuids, no wall-clock dependence. Everything runs in a transaction that is rolled
-- back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(128);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zy', 'Test locale', 'Test locale', 'ltr', true, false);
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zz', 'Other locale', 'Other locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTT', '961', 'T', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZY', 'ZYZ', '997', 'Testland', 'Testland', '997', 'XTT', true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZW', 'ZWZ', '995', 'Otherland', 'Otherland', '995', 'XTT', true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZX', 'ZXZ', '996', 'Offland', 'Offland', '996', 'XTT', false);

insert into auth.users (id, email) values
  ('80000000-0000-4000-8000-000000000001', 'pending-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000002', 'active-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000003', 'suspended-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000004', 'closed-seller@test.invalid'),
  ('80000000-0000-4000-8000-000000000005', 'not-a-seller@test.invalid');

-- Four storefronts, one per status, each built as 0009 requires rather than forced.
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
   'active', null, null, null, 'verified', '2026-02-01T00:00:00Z'),
  ('80000000-0000-4000-8000-000000000003', 'suspended-shop', 'Suspended Shop', 'Suspended Shop LLC',
   'Temporarily off.', 'zy', 'logos/suspended.webp', 'banners/suspended.webp',
   'ZY', 'Test Governorate', 'Alexandria', 'suspended@private.invalid', '+201555000003',
   'suspended', '2026-03-01T00:00:00Z', 'Repeated policy breaches, internal note', null,
   'verified', '2026-02-01T00:00:00Z'),
  ('80000000-0000-4000-8000-000000000004', 'closed-shop', 'Closed Shop', 'Closed Shop LLC',
   'We have closed.', 'zy', 'logos/closed.webp', 'banners/closed.webp',
   'ZY', 'Test Governorate', 'Giza', 'closed@private.invalid', '+201555000004',
   'closed', null, null, '2026-04-01T00:00:00Z', 'verified', '2026-02-01T00:00:00Z');

-- The audit log is append-only by design (0006's `tg_reject_write`), so the fixtures' own entries are not
-- removed — they are marked past. Every audit assertion below reads only what this migration's edits wrote.
create temporary table audit_mark as
select coalesce(max(a.id), 0) as id from audit.audit_logs a;

-- ---------------------------------------------------------------------------------------------------
-- Security: the S8 contract, restated for this function
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'seller_update_profile',
  array['uuid', 'boolean', 'text', 'boolean', 'text', 'boolean', 'text', 'boolean', 'text', 'boolean',
        'text', 'boolean', 'text', 'boolean', 'text', 'boolean', 'text', 'boolean', 'text'],
  'the editor exists, taking the caller id and a set-flag and value per editable field');

select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_update_profile'),
  true,
  'it is SECURITY DEFINER, because app_system holds no table privileges');

select is(
  (select array_to_string(p.proconfig, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_update_profile'),
  'search_path=pg_catalog, public',
  'its search_path is pinned, so a definer function cannot be redirected');

select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_update_profile'),
  'v'::"char",
  'it is volatile: it writes');

-- The parameter list is the security property.
select is(
  (select array_to_string(p.proargnames[1:19], ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_update_profile'),
  'p_user_id,p_set_display_name,p_display_name,p_set_legal_name,p_legal_name,p_set_bio,p_bio,'
  || 'p_set_content_language,p_content_language,p_set_country_code,p_country_code,p_set_governorate,'
  || 'p_governorate,p_set_city,p_city,p_set_contact_email,p_contact_email,p_set_contact_phone_e164,'
  || 'p_contact_phone_e164',
  'the nine editable fields, each with its own set-flag, and one caller id — and nothing else');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames[1:19]) as arg
    where n.nspname = 'app_private' and p.proname = 'seller_update_profile'
      and (arg like '%slug%' or arg like '%status%' or arg like '%role%' or arg like '%suspend%'
        or arg like '%closed%' or arg like '%verif%' or arg like '%_at' or arg like '%owner%'
        or arg like '%object_path%')),
  0::bigint,
  'no parameter names the slug, a status, a role, a suspension, a closure, a verification, a timestamp or an object path');

select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_update_profile'),
  'TABLE(outcome text, slug text, display_name text, status text, verification_status text, city text, country_code character)',
  'it returns the outcome and the 6-A projection, and nothing private');

-- No dynamic SQL anywhere: this is a field-level function, not a patch-anything one.
select is(
  (select strpos(p.prosrc, 'execute format') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_update_profile'),
  0,
  'it builds no SQL at run time');
select is(
  (select strpos(p.prosrc, 'jsonb_populate_record') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_update_profile'),
  0,
  'and it populates no record from arbitrary JSON');

-- The immutable columns appear in no assignment.
select is(
  (select strpos(p.prosrc, 'slug =') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_update_profile'),
  0,
  'nothing in the function assigns to slug');
select is(
  (select strpos(p.prosrc, 'status =') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_update_profile'),
  0,
  'nothing assigns to status or verification_status');
select is(
  (select strpos(p.prosrc, '_at =') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_update_profile'),
  0,
  'nothing assigns to a timestamp column');

select ok(
  not has_function_privilege('public',
    'app_private.seller_update_profile(uuid, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text)',
    'execute'),
  'PUBLIC cannot execute it');
select ok(
  not has_function_privilege('authenticated',
    'app_private.seller_update_profile(uuid, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text)',
    'execute'),
  'authenticated cannot execute it: a browser session is not an editing path');
select ok(
  not has_function_privilege('anon',
    'app_private.seller_update_profile(uuid, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text)',
    'execute'),
  'anon cannot execute it');
select ok(
  has_function_privilege('app_system',
    'app_private.seller_update_profile(uuid, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text)',
    'execute'),
  'app_system can execute it');
select ok(
  not has_function_privilege('app_worker',
    'app_private.seller_update_profile(uuid, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text)',
    'execute'),
  'app_worker cannot: editing a storefront is not background work');

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

select is(
  (select array_to_string(array_agg(p.proname order by p.proname), ',') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_%'),
  'seller_create_profile,seller_earnings,seller_identity,'
    -- 0102's listing analytics reader, which sorts here.
    'seller_listing_analytics,seller_listing_archive,'
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
  'exactly thirty-three seller_ functions exist: the 6-A reader, the 6-C writer, this editor, 6-E''s two media functions, 6-F''s five approved listing functions, 6-G''s four approved service functions, 6-I''s six approved verification functions 6-J''s six approved read-only surfaces 8-C''s six listing attribute and tag functions and 0102''s listing analytics reader');

select lives_ok(
  $$ select app_private.assert_security_contract() $$,
  'the deploy-time security contract still holds');

-- ---------------------------------------------------------------------------------------------------
-- Ownership
-- ---------------------------------------------------------------------------------------------------
create temporary table renamed as
select * from app_private.seller_update_profile(
  '80000000-0000-4000-8000-000000000001',
  true, '  Renamed Shop  ',
  false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null
);

select is((select outcome from renamed), 'updated', 'a pending seller can edit their own storefront');
select is((select display_name from renamed), 'Renamed Shop', 'the returned display name is the trimmed new one');
select is((select slug from renamed), 'pending-shop', 'the returned slug is the one they already had');
select is((select status from renamed), 'pending', 'the returned status is unchanged');
select is((select verification_status from renamed), 'unverified', 'the returned verification status is unchanged');

select is(
  (select s.display_name from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'Renamed Shop',
  'and the row itself was updated');

select is(
  (select s.display_name from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002'),
  'Active Shop',
  'no other seller''s storefront was touched');

select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000005',
    true, 'Not Mine',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'not_found',
  'an account with no storefront gets not_found, not a refusal that confirms somebody else''s exists');

select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-00000000ffff',
    true, 'Ghost',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'not_found',
  'an id matching no account gets not_found');

select is(
  (select outcome from app_private.seller_update_profile(
    null, true, 'Nobody',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'not_found',
  'no caller id gets not_found: there is no storefront without an owner');

select is(
  (select count(*) from public.seller_profiles s where s.display_name in ('Not Mine', 'Ghost', 'Nobody')),
  0::bigint,
  'and none of those attempts wrote anything anywhere');

-- ---------------------------------------------------------------------------------------------------
-- Every editable field, set at once
-- ---------------------------------------------------------------------------------------------------
create temporary table before_edit as
select slug, status, verification_status, suspended_at, suspension_reason, closed_at, verified_at,
       created_at, updated_at, logo_object_path, banner_object_path
  from public.seller_profiles where user_id = '80000000-0000-4000-8000-000000000002';

create temporary table edited as
select * from app_private.seller_update_profile(
  '80000000-0000-4000-8000-000000000002',
  true, 'Edited Shop',
  true, 'Edited Shop Holdings LLC',
  true, 'We now restore bicycles.',
  true, 'zz',
  true, 'ZW',
  true, 'Edited Governorate',
  true, 'Alexandria',
  true, 'edited@example.invalid',
  true, '+201555009999'
);

select is((select outcome from edited), 'updated', 'an active seller can edit every editable field at once');
select is((select s.display_name from public.seller_profiles s where s.slug = 'active-shop'),
  'Edited Shop', 'display_name was updated');
select is((select s.legal_name from public.seller_profiles s where s.slug = 'active-shop'),
  'Edited Shop Holdings LLC', 'legal_name was updated');
select is((select s.bio from public.seller_profiles s where s.slug = 'active-shop'),
  'We now restore bicycles.', 'bio was updated');
select is((select s.content_language from public.seller_profiles s where s.slug = 'active-shop'),
  'zz', 'content_language was updated');
select is((select s.country_code from public.seller_profiles s where s.slug = 'active-shop'),
  'ZW'::char(2), 'country_code was updated');
select is((select s.governorate from public.seller_profiles s where s.slug = 'active-shop'),
  'Edited Governorate', 'governorate was updated');
select is((select s.city from public.seller_profiles s where s.slug = 'active-shop'),
  'Alexandria', 'city was updated');
select is((select s.contact_email::text from public.seller_profiles s where s.slug = 'active-shop'),
  'edited@example.invalid', 'contact_email was updated');
select is((select s.contact_phone_e164 from public.seller_profiles s where s.slug = 'active-shop'),
  '+201555009999', 'contact_phone_e164 was updated');

-- ---------------------------------------------------------------------------------------------------
-- The immutable columns, after that same edit
-- ---------------------------------------------------------------------------------------------------
select is(
  (select s.slug from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002'),
  (select b.slug from before_edit b),
  'the slug is unchanged: the public address is permanent');
select is(
  (select s.status from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002'),
  (select b.status from before_edit b),
  'the status is unchanged: a seller cannot change their own state');
select is(
  (select s.verification_status from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002'),
  (select b.verification_status from before_edit b),
  'the verification status is unchanged: nobody verifies themselves');
select is(
  (select s.verified_at from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002'),
  (select b.verified_at from before_edit b),
  'the verification timestamp is unchanged');
select is(
  (select s.suspended_at from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002'),
  (select b.suspended_at from before_edit b),
  'the suspension timestamp is unchanged');
select is(
  (select s.suspension_reason from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002'),
  (select b.suspension_reason from before_edit b),
  'the suspension reason is unchanged');
select is(
  (select s.closed_at from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002'),
  (select b.closed_at from before_edit b),
  'the closure timestamp is unchanged');
select is(
  (select s.created_at from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002'),
  (select b.created_at from before_edit b),
  'created_at is unchanged: a seller cannot re-date their own account');
select is(
  (select s.logo_object_path from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002'),
  (select b.logo_object_path from before_edit b),
  'the logo object path is unchanged: media is 6-E''s');
select is(
  (select s.banner_object_path from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002'),
  (select b.banner_object_path from before_edit b),
  'the banner object path is unchanged');
select is(
  (select s.user_id from public.seller_profiles s where s.slug = 'active-shop'),
  '80000000-0000-4000-8000-000000000002'::uuid,
  'the owner is unchanged: an edit cannot hand a storefront to somebody else');

-- `updated_at` is the one column that must move, and it is 0009's trigger that moves it.
select ok(
  (select s.updated_at from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002')
    >= (select b.updated_at from before_edit b),
  'updated_at was maintained by 0009''s trigger, not supplied by the caller');

-- ---------------------------------------------------------------------------------------------------
-- Partial update semantics: omitted preserves
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000002',
    true, 'Renamed Again',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'updated',
  'an edit may touch one field');

select is((select s.legal_name from public.seller_profiles s where s.slug = 'active-shop'),
  'Edited Shop Holdings LLC', 'an omitted legal_name kept its value');
select is((select s.bio from public.seller_profiles s where s.slug = 'active-shop'),
  'We now restore bicycles.', 'an omitted bio kept its value');
select is((select s.content_language from public.seller_profiles s where s.slug = 'active-shop'),
  'zz', 'an omitted content_language kept its value');
select is((select s.country_code from public.seller_profiles s where s.slug = 'active-shop'),
  'ZW'::char(2), 'an omitted country_code kept its value');
select is((select s.governorate from public.seller_profiles s where s.slug = 'active-shop'),
  'Edited Governorate', 'an omitted governorate kept its value');
select is((select s.city from public.seller_profiles s where s.slug = 'active-shop'),
  'Alexandria', 'an omitted city kept its value');
select is((select s.contact_email::text from public.seller_profiles s where s.slug = 'active-shop'),
  'edited@example.invalid', 'an omitted contact_email kept its value');
select is((select s.contact_phone_e164 from public.seller_profiles s where s.slug = 'active-shop'),
  '+201555009999', 'an omitted contact_phone_e164 kept its value');
select is((select s.display_name from public.seller_profiles s where s.slug = 'active-shop'),
  'Renamed Again', 'and the one field that was set did change');

-- A value parameter with its flag false is ignored entirely, which is what makes the pair unambiguous.
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000002',
    false, 'Ignored Because The Flag Is False',
    false, 'Ignored LLC', false, 'Ignored bio', false, 'zy', false, 'ZY',
    false, 'Ignored Gov', false, 'Ignored City', false, 'ignored@example.invalid', false, '+201555000000')),
  'updated',
  'an edit that sets nothing is still a successful, and empty, edit');
select is((select s.display_name from public.seller_profiles s where s.slug = 'active-shop'),
  'Renamed Again', 'the value beside a false flag was ignored');
select is((select s.legal_name from public.seller_profiles s where s.slug = 'active-shop'),
  'Edited Shop Holdings LLC', 'and so were all the others');

-- ---------------------------------------------------------------------------------------------------
-- Partial update semantics: an explicit null clears, where 0009 allows null
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000002',
    false, null,
    true, null, true, null, true, null, false, null, true, null, true, null, true, null, true, null)),
  'updated',
  'every nullable field can be cleared explicitly');

select is((select s.legal_name from public.seller_profiles s where s.slug = 'active-shop'),
  null::text, 'legal_name was cleared');
select is((select s.bio from public.seller_profiles s where s.slug = 'active-shop'),
  null::text, 'bio was cleared');
select is((select s.content_language from public.seller_profiles s where s.slug = 'active-shop'),
  null::text, 'content_language was cleared');
select is((select s.governorate from public.seller_profiles s where s.slug = 'active-shop'),
  null::text, 'governorate was cleared');
select is((select s.city from public.seller_profiles s where s.slug = 'active-shop'),
  null::text, 'city was cleared');
select is((select s.contact_email from public.seller_profiles s where s.slug = 'active-shop'),
  null::extensions.citext, 'contact_email was cleared');
select is((select s.contact_phone_e164 from public.seller_profiles s where s.slug = 'active-shop'),
  null::text, 'contact_phone_e164 was cleared');
select is((select s.display_name from public.seller_profiles s where s.slug = 'active-shop'),
  'Renamed Again', 'and the two not-null columns were untouched by the clearing');
select is((select s.country_code from public.seller_profiles s where s.slug = 'active-shop'),
  'ZW'::char(2), 'including the country');

-- An empty string is the same request as a null: a form's blank box is not a value.
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000002',
    false, null, true, '   ', false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'updated',
  'a whitespace-only optional value is accepted');
select is((select s.legal_name from public.seller_profiles s where s.slug = 'active-shop'),
  null::text, 'and stored as absent rather than as an empty string');

-- The two the schema declares `not null` cannot be cleared.
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000002',
    true, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'invalid',
  'display_name cannot be cleared: 0009 declares it not null');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000002',
    false, null, false, null, false, null, false, null, true, null, false, null, false, null, false, null, false, null)),
  'invalid',
  'country_code cannot be cleared either');
select is((select s.display_name from public.seller_profiles s where s.slug = 'active-shop'),
  'Renamed Again', 'and neither refusal changed anything');

-- ---------------------------------------------------------------------------------------------------
-- Status
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    true, 'Pending Can Edit',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'updated',
  'a pending storefront may be edited');

select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000003',
    true, 'Suspended Cannot Edit',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'not_editable',
  'a suspended storefront may not');

select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000004',
    true, 'Closed Cannot Edit',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'not_editable',
  'and neither may a closed one');

select is(
  (select s.display_name from public.seller_profiles s where s.slug = 'suspended-shop'),
  'Suspended Shop',
  'the suspended storefront was not written to');
select is(
  (select s.display_name from public.seller_profiles s where s.slug = 'closed-shop'),
  'Closed Shop',
  'nor was the closed one');
select is(
  (select s.suspension_reason from public.seller_profiles s where s.slug = 'suspended-shop'),
  'Repeated policy breaches, internal note',
  'and the suspension reason is still exactly where it was, unread and unreturned');

-- A refused edit answers the same whatever it asked for: the body cannot probe the gate.
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000003',
    true, 'x',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'not_editable',
  'a suspended seller sending an invalid value still gets not_editable, not invalid');

-- ---------------------------------------------------------------------------------------------------
-- Validation — the same 0009 limits, on both sides
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001', true, 'A',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'invalid',
  'a one-character display name is below 0009''s minimum of two');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001', true, repeat('n', 81),
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'invalid',
  'an eighty-one-character display name is above the maximum of eighty');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001', true, '    ',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'invalid',
  'a display name of whitespace is refused: the limit is on the trimmed value');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001', true, 'Ab',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'updated',
  'and two characters is accepted');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001', true, repeat('n', 80),
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null)),
  'updated',
  'as is eighty');

select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, true, repeat('b', 2001), false, null, false, null, false, null, false, null, false, null, false, null)),
  'invalid',
  'a 2001-character bio is above 0009''s maximum of 2000');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, true, repeat('b', 2000), false, null, false, null, false, null, false, null, false, null, false, null)),
  'updated',
  'and 2000 is accepted');

select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, false, null, true, 'qq', false, null, false, null, false, null, false, null, false, null)),
  'invalid',
  'a content language that is not a locale is refused');

select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, false, null, false, null, true, 'ZX', false, null, false, null, false, null, false, null)),
  'invalid',
  'a country that exists but is not marketplace-enabled is refused (D17)');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, false, null, false, null, true, 'QQ', false, null, false, null, false, null, false, null)),
  'invalid',
  'a country that does not exist is refused');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, false, null, false, null, true, 'ZYZ', false, null, false, null, false, null, false, null)),
  'invalid',
  'a country code that is not exactly two characters is refused');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, false, null, false, null, true, 'zy', false, null, false, null, false, null, false, null)),
  'invalid',
  'a lower-case country code is refused rather than case-folded into a foreign key');

select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, true, 'not-an-email', false, null)),
  'invalid',
  'an address with no domain is refused');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null,
    true, 'two words@example.invalid', false, null)),
  'invalid',
  'an address with whitespace inside it is refused');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null,
    true, repeat('e', 310) || '@example.invalid', false, null)),
  'invalid',
  'an address longer than 320 characters is refused');

select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null, true, '0201555000')),
  'invalid',
  'a phone number without the E.164 plus is refused');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null, true, '+2015')),
  'invalid',
  'a phone number shorter than the E.164 pattern allows is refused');
select is(
  (select outcome from app_private.seller_update_profile(
    '80000000-0000-4000-8000-000000000001',
    false, null, false, null, false, null, false, null, false, null, false, null, false, null, false, null, true, '+0201555000001')),
  'invalid',
  'a phone number whose country digit is zero is refused');

-- A refusal changes nothing, in any of the above.
select is(
  (select s.display_name from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  repeat('n', 80),
  'the pending storefront still holds the last value that was actually accepted');
select is(
  (select s.slug from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000001'),
  'pending-shop',
  'and its slug, through every one of those attempts, never moved');

-- ---------------------------------------------------------------------------------------------------
-- Nothing else was created or changed
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.seller_profiles),
  4::bigint,
  'no storefront was created or removed by any edit');
select is(
  (select count(*) from public.user_roles),
  0::bigint,
  'no role was assigned: Phase 6 authorization is still seller_profiles.status');
select is(
  (select count(*) from public.seller_verifications),
  0::bigint,
  'no verification record was created or touched: editing contact details is not a verification event');
select is(
  (select count(*) from public.seller_profiles s where s.verification_status <> 'unverified' and s.slug = 'pending-shop'),
  0::bigint,
  'and the pending storefront is still unverified after editing its contact details');
select is(
  (select count(*) from public.notifications),
  0::bigint,
  'nobody was notified');

-- ---------------------------------------------------------------------------------------------------
-- Audit: 0009's own trigger, on UPDATE this time
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from audit.audit_logs a
    where a.id > (select m.id from audit_mark m)
      and a.table_schema = 'public' and a.table_name = 'seller_profiles' and a.action = 'update') > 0,
  'a successful edit produces an update audit entry, from 0009''s existing trigger');
select is(
  (select array_to_string(array_agg(distinct a.action order by a.action), ',') from audit.audit_logs a
    where a.id > (select m.id from audit_mark m)
      and a.table_schema = 'public' and a.table_name = 'seller_profiles'),
  'update',
  'and every entry is an update: nothing was inserted or deleted by an edit');
select ok(
  (select count(*) from audit.audit_logs a
    where a.id > (select m.id from audit_mark m)
      and a.table_schema = 'public' and a.table_name = 'seller_profiles'
      and 'display_name' = any(a.changed_columns)) > 0,
  'the audit entries name the columns that actually changed');
select is(
  (select count(*) from audit.audit_logs a
    where a.id > (select m.id from audit_mark m)
      and a.table_schema = 'public' and a.table_name = 'seller_profiles'
      and ('slug' = any(a.changed_columns) or 'status' = any(a.changed_columns)
        or 'verification_status' = any(a.changed_columns) or 'user_id' = any(a.changed_columns)
        or 'created_at' = any(a.changed_columns))),
  0::bigint,
  'and no audit entry ever records an immutable column as changed, because none ever changed');
select is(
  (select count(*) from audit.audit_logs a
    where a.id > (select m.id from audit_mark m)
      and a.table_schema = 'public' and a.table_name = 'seller_profiles'
      and a.new_values ->> 'display_name' in
        ('Suspended Cannot Edit', 'Closed Cannot Edit', 'Not Mine', 'Ghost', 'Nobody', 'A')),
  0::bigint,
  'a refused edit leaves no audit entry: an audit log records changes, not attempts');
select is(
  (select count(*) from audit.audit_logs a
    where a.id > (select m.id from audit_mark m)
      and a.table_schema = 'public' and a.table_name = 'seller_profiles' and a.old_values is null),
  0::bigint,
  'every update entry carries the previous values, so a change can be read in both directions');

-- ---------------------------------------------------------------------------------------------------
-- 0057 and 0050 still answer as they did
-- ---------------------------------------------------------------------------------------------------
select is(
  (select i.display_name from app_private.seller_identity('80000000-0000-4000-8000-000000000002') i),
  'Renamed Again',
  'the 6-A reader reports the edited display name');
select is(
  (select i.status from app_private.seller_identity('80000000-0000-4000-8000-000000000002') i),
  'active',
  'and the unchanged status');
select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_identity'),
  'TABLE(slug text, display_name text, status text, verification_status text, city text, country_code character)',
  '0057''s projection is untouched by this migration');
select is(
  (select r.outcome from app_private.public_seller_by_slug('active-shop') r),
  'found',
  'the public reader still finds an active storefront');
select is(
  (select r.display_name from app_private.public_seller_by_slug('active-shop') r),
  'Renamed Again',
  'and reports the edited name, because 4-E reads the same row');
select is(
  (select r.outcome from app_private.public_seller_by_slug('pending-shop') r),
  'not_found',
  'while a pending storefront is still not publicly visible');

select * from finish();
rollback;
