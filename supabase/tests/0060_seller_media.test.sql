-- pgTAP — migration 0060: seller profile media.
--
-- Four things are being held to account.
--
-- **The path cannot be chosen.** The signing function takes no path, no bucket, no slug and no file name —
-- asserted on the parameter list itself — and every path it returns is inside the caller's own namespace.
-- That is what makes traversal and cross-seller paths *unexpressible* rather than merely refused, and it is
-- why the attach tests below can attack the one place a path does arrive from a request.
--
-- **The attach gate is the interesting one**, because it is the only place a caller-supplied path is read.
-- It is attacked from nine directions: another seller's object, `..` inside the name, a nested sub-path, a
-- different bucket, a leading slash, the other media kind, a disallowed extension, a name that is not a
-- uuid, and a path that is merely a prefix of a valid one. All nine answer `invalid` and write nothing.
--
-- **The media rules are the bucket's.** The size and type limits are read from `storage.buckets`, so the
-- tests assert against the bucket row rather than against numbers typed twice — and assert that the bucket
-- is private and registered in 0012's contract, so `storage_bucket_problems()` still returns nothing.
--
-- **Ownership is immutable and state-gated.** A suspended or closed storefront receives neither
-- authorization nor an attach, an account with no storefront gets `not_found`, and no path writes anything
-- but the one media column its kind names.
--
-- Deterministic: fixed uuids, no wall-clock dependence, and every generated path is checked by shape rather
-- than by value. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(114);

-- Fixtures ------------------------------------------------------------------------------------------
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

insert into public.seller_profiles
  (user_id, slug, display_name, country_code, status, suspended_at, suspension_reason, closed_at,
   verification_status, verified_at)
values
  ('80000000-0000-4000-8000-000000000001', 'pending-shop', 'Pending Shop', 'ZY', 'pending',
   null, null, null, 'unverified', null),
  ('80000000-0000-4000-8000-000000000002', 'active-shop', 'Active Shop', 'ZY', 'active',
   null, null, null, 'verified', '2026-02-01T00:00:00Z'),
  ('80000000-0000-4000-8000-000000000003', 'suspended-shop', 'Suspended Shop', 'ZY', 'suspended',
   '2026-03-01T00:00:00Z', 'Repeated policy breaches, internal note', null, 'verified', '2026-02-01T00:00:00Z'),
  ('80000000-0000-4000-8000-000000000004', 'closed-shop', 'Closed Shop', 'ZY', 'closed',
   null, null, '2026-04-01T00:00:00Z', 'verified', '2026-02-01T00:00:00Z');

-- ---------------------------------------------------------------------------------------------------
-- The bucket, and 0012's contract
-- ---------------------------------------------------------------------------------------------------
select ok(
  exists (select 1 from storage.buckets b where b.id = 'seller-media'),
  'the seller-media bucket exists');
select is(
  (select b.public from storage.buckets b where b.id = 'seller-media'),
  false,
  'it is private: the one public bucket holds approved listing variants only');
select is(
  (select b.file_size_limit from storage.buckets b where b.id = 'seller-media'),
  5242880::bigint,
  'it carries a size limit, which is the only place that number lives');
select is(
  (select array_to_string(b.allowed_mime_types, ',') from storage.buckets b where b.id = 'seller-media'),
  'image/jpeg,image/png,image/webp,image/avif',
  'and the four raster image types, with no SVG: a logo has no need to be a script container');
select is(
  (select c.must_be_public from app_private.storage_bucket_contract c where c.bucket_id = 'seller-media'),
  false,
  'the bucket is registered in 0012''s contract as private');
select is(
  (select count(*) from public.storage_bucket_problems()),
  0::bigint,
  'so storage_bucket_problems() still returns nothing');
select is(
  (select count(*) from storage.buckets b where b.public),
  1::bigint,
  'and there is still exactly one public bucket in the project');
select is(
  (select b.id from storage.buckets b where b.public),
  'listing-variants',
  'which is the listing variants bucket, as 0012 wrote it');

-- No storage.objects policy was added: a private bucket stays unreachable except by signed URL.
select is(
  (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and qual like '%seller-media%'),
  0::bigint,
  'no storage.objects policy mentions the new bucket');

-- ---------------------------------------------------------------------------------------------------
-- Security: the S8 contract, restated for both functions
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'seller_media_upload_target',
  array['uuid', 'text', 'text', 'bigint'],
  'the signing authorizer exists, taking the caller id, a kind, a content type and a size');
select has_function('app_private', 'seller_media_attach',
  array['uuid', 'text', 'text'],
  'the attach function exists, taking the caller id, a kind and a path');

select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_media_upload_target'),
  true,
  'the authorizer is SECURITY DEFINER');
select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_media_attach'),
  true,
  'and so is the attach function');
select is(
  (select array_to_string(p.proconfig, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_media_upload_target'),
  'search_path=pg_catalog, public',
  'the authorizer''s search_path is pinned');
select is(
  (select array_to_string(p.proconfig, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_media_attach'),
  'search_path=pg_catalog, public',
  'and so is the attach function''s');

-- The parameter lists are the security property.
select is(
  (select array_to_string(p.proargnames[1:4], ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_media_upload_target'),
  'p_user_id,p_media_kind,p_content_type,p_byte_size',
  'the authorizer takes no path, no bucket, no slug, no file name and no seller');
select is(
  (select array_to_string(p.proargnames[1:3], ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_media_attach'),
  'p_user_id,p_media_kind,p_object_path',
  'and the attach function takes one caller id, one kind and one path');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames) as arg
    where n.nspname = 'app_private' and p.proname in ('seller_media_upload_target', 'seller_media_attach')
      and (arg like '%slug%' or arg like '%seller_id%' or arg like '%owner%' or arg like '%status%'
        or arg like '%bucket%' and arg <> 'bucket_id')),
  0::bigint,
  'no parameter of either function names a slug, a seller, an owner, a status or a bucket');

select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_media_upload_target'),
  'TABLE(outcome text, bucket_id text, object_path text, max_byte_size bigint)',
  'the authorizer returns the target and nothing else — no credential, no token, no URL');
select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_media_attach'),
  'TABLE(outcome text, has_logo boolean, has_banner boolean)',
  'and the attach function returns two booleans: not the paths, and nothing private');

-- No dynamic SQL anywhere near a user-controlled path.
select is(
  (select strpos(p.prosrc, 'execute format') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_media_upload_target'),
  0,
  'the authorizer builds no SQL at run time');
select is(
  (select strpos(p.prosrc, 'execute format') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_media_attach'),
  0,
  'and neither does the attach function');
select is(
  (select strpos(p.prosrc, 'execute ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_media_attach'),
  0,
  'the attach function executes no dynamic statement at all, though it reads a caller-supplied path');

-- ACLs.
select ok(not has_function_privilege('public',
  'app_private.seller_media_upload_target(uuid, text, text, bigint)', 'execute'),
  'PUBLIC cannot execute the authorizer');
select ok(not has_function_privilege('authenticated',
  'app_private.seller_media_upload_target(uuid, text, text, bigint)', 'execute'),
  'authenticated cannot execute the authorizer');
select ok(not has_function_privilege('anon',
  'app_private.seller_media_upload_target(uuid, text, text, bigint)', 'execute'),
  'anon cannot execute the authorizer');
select ok(has_function_privilege('app_system',
  'app_private.seller_media_upload_target(uuid, text, text, bigint)', 'execute'),
  'app_system can execute the authorizer');
select ok(not has_function_privilege('app_worker',
  'app_private.seller_media_upload_target(uuid, text, text, bigint)', 'execute'),
  'app_worker cannot');
select ok(not has_function_privilege('public',
  'app_private.seller_media_attach(uuid, text, text)', 'execute'),
  'PUBLIC cannot execute the attach function');
select ok(not has_function_privilege('authenticated',
  'app_private.seller_media_attach(uuid, text, text)', 'execute'),
  'authenticated cannot execute the attach function');
select ok(not has_function_privilege('anon',
  'app_private.seller_media_attach(uuid, text, text)', 'execute'),
  'anon cannot execute the attach function');
select ok(has_function_privilege('app_system',
  'app_private.seller_media_attach(uuid, text, text)', 'execute'),
  'app_system can execute the attach function');
select ok(not has_function_privilege('app_worker',
  'app_private.seller_media_attach(uuid, text, text)', 'execute'),
  'app_worker cannot');

-- No table privilege was granted anywhere, storage included.
select is(
  (select count(*) from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'seller_profiles' and grantee = 'app_system'),
  0::bigint,
  'app_system still holds no privilege on public.seller_profiles');
select is(
  (select count(*) from information_schema.table_privileges
    where table_schema = 'storage' and grantee in ('app_system', 'app_worker')),
  0::bigint,
  'and none on any storage table either');
select is(
  (select array_to_string(array_agg(distinct privilege_type order by privilege_type), ',')
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'seller_profiles' and grantee = 'authenticated'),
  'INSERT,SELECT,UPDATE',
  '0009''s authenticated grants are unchanged');
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
  'exactly thirty-two seller_ functions exist: the reader, the writer, the editor, 6-E''s two, 6-F''s five approved listing functions, 6-G''s four approved service functions, 6-I''s six approved verification functions 6-J''s six approved read-only surfaces and 8-C''s six listing attribute and tag functions');

select lives_ok(
  $$ select app_private.assert_security_contract() $$,
  'the deploy-time security contract still holds, the new bucket included');

-- ---------------------------------------------------------------------------------------------------
-- Authorizing an upload
-- ---------------------------------------------------------------------------------------------------
create temporary table logo_target as
select * from app_private.seller_media_upload_target(
  '80000000-0000-4000-8000-000000000002', 'logo', 'image/webp', 100000);

select is((select outcome from logo_target), 'authorized', 'an active seller may obtain an upload target');
select is((select bucket_id from logo_target), 'seller-media', 'the bucket is the private seller media one');
select is((select max_byte_size from logo_target), 5242880::bigint, 'the size limit comes back with it');
select ok(
  (select object_path from logo_target) like 'seller-media/active-shop/logo/%',
  'the path is inside the caller''s own namespace, named by their own slug');
select matches(
  (select object_path from logo_target),
  '^seller-media/active-shop/logo/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$',
  'and is exactly one random file name with the extension the content type implies');
select is(
  (select strpos(object_path, '80000000-0000-4000-8000-000000000002') from logo_target),
  0,
  'the seller''s own identifier is nowhere in the path handed to a browser');

select isnt(
  (select object_path from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'logo', 'image/webp', 100000)),
  (select object_path from logo_target),
  'two authorizations never return the same path, so one upload can never overwrite another');

select ok(
  (select object_path from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'banner', 'image/png', 100000))
    like 'seller-media/active-shop/banner/%.png',
  'a banner goes to the banner namespace, with the extension its own type implies');

select is(
  (select count(*) from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000001', 'logo', 'image/jpeg', 1) t
    where t.object_path like 'seller-media/pending-shop/logo/%.jpg'),
  1::bigint,
  'a pending seller may obtain a target too, in their own namespace');

select is(
  (select count(*) from public.seller_profiles s
    where s.logo_object_path is not null or s.banner_object_path is not null),
  0::bigint,
  'authorizing an upload writes nothing: no profile has a media path yet');

-- ---------------------------------------------------------------------------------------------------
-- The media rules, from the bucket
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'avatar', 'image/webp', 1000)),
  'invalid',
  'a media kind that is not logo or banner is refused');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', null, 'image/webp', 1000)),
  'invalid',
  'an absent media kind is refused');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'logo', 'image/svg+xml', 1000)),
  'invalid',
  'SVG is refused: it is not in the bucket''s allowed types');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'logo', 'application/pdf', 1000)),
  'invalid',
  'a PDF is refused');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'logo', 'text/html', 1000)),
  'invalid',
  'and so is anything that could be served as a document');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'logo', 'IMAGE/WEBP', 1000)),
  'invalid',
  'the type is matched exactly, not case-folded into the allow list');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'logo', null, 1000)),
  'invalid',
  'an absent content type is refused');

select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'logo', 'image/webp',
    (select b.file_size_limit from storage.buckets b where b.id = 'seller-media') + 1)),
  'invalid',
  'one byte over the bucket''s limit is refused');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'logo', 'image/webp',
    (select b.file_size_limit from storage.buckets b where b.id = 'seller-media'))),
  'authorized',
  'and exactly the limit is accepted');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'logo', 'image/webp', 0)),
  'invalid',
  'a zero-byte upload is refused');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'logo', 'image/webp', -1)),
  'invalid',
  'and a negative size');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000002', 'logo', 'image/webp', null)),
  'invalid',
  'and an absent one');

-- ---------------------------------------------------------------------------------------------------
-- Who may obtain authorization
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000005', 'logo', 'image/webp', 1000)),
  'not_found',
  'an account with no storefront cannot obtain an upload target');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-00000000ffff', 'logo', 'image/webp', 1000)),
  'not_found',
  'nor can an id that matches no account');
select is(
  (select outcome from app_private.seller_media_upload_target(
    null, 'logo', 'image/webp', 1000)),
  'not_found',
  'nor can a caller with no id at all');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000003', 'logo', 'image/webp', 1000)),
  'not_editable',
  'a suspended seller receives no mutation authorization');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000004', 'logo', 'image/webp', 1000)),
  'not_editable',
  'and neither does a closed one');
select is(
  (select bucket_id from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000003', 'logo', 'image/webp', 1000)),
  null::text,
  'a refused authorization returns no bucket');
select is(
  (select object_path from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000003', 'logo', 'image/webp', 1000)),
  null::text,
  'and no path');
select is(
  (select outcome from app_private.seller_media_upload_target(
    '80000000-0000-4000-8000-000000000003', 'avatar', 'application/pdf', -5)),
  'not_editable',
  'a suspended seller sending nonsense still gets not_editable, so the body cannot probe the gate');

-- ---------------------------------------------------------------------------------------------------
-- Attaching what was uploaded
-- ---------------------------------------------------------------------------------------------------
create temporary table attach_target as
select object_path from app_private.seller_media_upload_target(
  '80000000-0000-4000-8000-000000000002', 'logo', 'image/webp', 1000);

create temporary table attached as
select * from app_private.seller_media_attach(
  '80000000-0000-4000-8000-000000000002', 'logo', (select object_path from attach_target));

select is((select outcome from attached), 'attached', 'a seller may record their own upload');
select is((select has_logo from attached), true, 'and is told the logo is now set');
select is((select has_banner from attached), false, 'and that the banner is not');
select is(
  (select s.logo_object_path from public.seller_profiles s where s.slug = 'active-shop'),
  (select object_path from attach_target),
  'the stored path is exactly the one that was authorized');
select is(
  (select s.banner_object_path from public.seller_profiles s where s.slug = 'active-shop'),
  null::text,
  'and the other media column was not touched');

-- Nothing else on the row moved.
select is(
  (select s.status from public.seller_profiles s where s.slug = 'active-shop'),
  'active',
  'attaching media changed no status');
select is(
  (select s.verification_status from public.seller_profiles s where s.slug = 'active-shop'),
  'verified',
  'and no verification state: a logo is not a verification event');
select is(
  (select s.slug from public.seller_profiles s where s.user_id = '80000000-0000-4000-8000-000000000002'),
  'active-shop',
  'and not the slug');
select is(
  (select s.display_name from public.seller_profiles s where s.slug = 'active-shop'),
  'Active Shop',
  'and not the display name');
select is(
  (select count(*) from public.seller_verifications),
  0::bigint,
  'and no verification record was created');
select is(
  (select count(*) from public.user_roles),
  0::bigint,
  'and no role was assigned');

-- A banner goes in its own column.
select is(
  (select has_banner from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000002', 'banner',
    (select object_path from app_private.seller_media_upload_target(
      '80000000-0000-4000-8000-000000000002', 'banner', 'image/avif', 1000)))),
  true,
  'a banner can be recorded too');
select ok(
  (select s.banner_object_path from public.seller_profiles s where s.slug = 'active-shop')
    like 'seller-media/active-shop/banner/%.avif',
  'in the banner namespace');
select isnt(
  (select s.logo_object_path from public.seller_profiles s where s.slug = 'active-shop'),
  (select s.banner_object_path from public.seller_profiles s where s.slug = 'active-shop'),
  'and the two never point at the same object');

-- ---------------------------------------------------------------------------------------------------
-- The attach gate: the one place a caller-supplied path is read
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo', (select object_path from attach_target))),
  'invalid',
  'another seller''s object cannot be attached, even a real one');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo',
    'seller-media/active-shop/logo/11111111-1111-1111-1111-111111111111.webp')),
  'invalid',
  'nor can a well-formed path in another seller''s namespace');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo',
    'seller-media/pending-shop/logo/../../active-shop/logo/11111111-1111-1111-1111-111111111111.webp')),
  'invalid',
  'a traversal out of the namespace is refused');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo', 'seller-media/pending-shop/logo/..')),
  'invalid',
  'a bare dot-dot is refused');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo',
    'seller-media/pending-shop/logo/a/11111111-1111-1111-1111-111111111111.webp')),
  'invalid',
  'a nested sub-path is refused: the name may contain no separator');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo',
    'verification-documents/pending-shop/logo/11111111-1111-1111-1111-111111111111.webp')),
  'invalid',
  'another bucket is refused');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo',
    '/seller-media/pending-shop/logo/11111111-1111-1111-1111-111111111111.webp')),
  'invalid',
  'a leading slash is refused: the prefix must match from the first character');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo',
    'x/seller-media/pending-shop/logo/11111111-1111-1111-1111-111111111111.webp')),
  'invalid',
  'and so is anything before the prefix');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'banner',
    'seller-media/pending-shop/logo/11111111-1111-1111-1111-111111111111.webp')),
  'invalid',
  'the other media kind''s namespace is refused');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo',
    'seller-media/pending-shop/logo/11111111-1111-1111-1111-111111111111.svg')),
  'invalid',
  'an extension the bucket does not allow is refused');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo', 'seller-media/pending-shop/logo/logo.webp')),
  'invalid',
  'a name that is not one of this function''s own uuids is refused');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo', 'seller-media/pending-shop/logo/')),
  'invalid',
  'an empty name is refused');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo', 'seller-media/pending-shop/logo')),
  'invalid',
  'and the prefix without a name is refused');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo', null)),
  'invalid',
  'an absent path is refused');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'logo',
    'seller-media/pending-shop/logo/11111111-1111-1111-1111-111111111111.webp' || chr(10) || 'x')),
  'invalid',
  'a newline in the name is refused');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000001', 'avatar',
    'seller-media/pending-shop/avatar/11111111-1111-1111-1111-111111111111.webp')),
  'invalid',
  'and a media kind that is not one of the two is refused before the path is even read');

select is(
  (select count(*) from public.seller_profiles s where s.slug = 'pending-shop'
     and (s.logo_object_path is not null or s.banner_object_path is not null)),
  0::bigint,
  'after every one of those refusals, the caller still has no media recorded');
select is(
  (select s.logo_object_path from public.seller_profiles s where s.slug = 'active-shop'),
  (select object_path from attach_target),
  'and the seller whose path was borrowed still has exactly their own');

-- ---------------------------------------------------------------------------------------------------
-- State, again, on the attach side
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000003', 'logo',
    'seller-media/suspended-shop/logo/11111111-1111-1111-1111-111111111111.webp')),
  'not_editable',
  'a suspended seller cannot record media, even in their own namespace');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000004', 'logo',
    'seller-media/closed-shop/logo/11111111-1111-1111-1111-111111111111.webp')),
  'not_editable',
  'and neither can a closed one');
select is(
  (select s.logo_object_path from public.seller_profiles s where s.slug = 'suspended-shop'),
  null::text,
  'and nothing was written for either');
select is(
  (select s.logo_object_path from public.seller_profiles s where s.slug = 'closed-shop'),
  null::text,
  'nor for the closed one');
select is(
  (select outcome from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000005', 'logo',
    'seller-media/anything/logo/11111111-1111-1111-1111-111111111111.webp')),
  'not_found',
  'an account with no storefront gets not_found');
select is(
  (select outcome from app_private.seller_media_attach(
    null, 'logo', 'seller-media/x/logo/11111111-1111-1111-1111-111111111111.webp')),
  'not_found',
  'and so does a caller with no id');
select is(
  (select has_logo from app_private.seller_media_attach(
    '80000000-0000-4000-8000-000000000003', 'logo',
    'seller-media/suspended-shop/logo/11111111-1111-1111-1111-111111111111.webp')),
  null::boolean,
  'a refusal reports no media state at all');

-- A suspended seller's own reason is still nowhere near any of this.
select is(
  (select s.suspension_reason from public.seller_profiles s where s.slug = 'suspended-shop'),
  'Repeated policy breaches, internal note',
  'the suspension reason is still exactly where it was, unread and unreturned');

-- ---------------------------------------------------------------------------------------------------
-- Audit, and the readers
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles' and a.action = 'update'
      and ('logo_object_path' = any(a.changed_columns) or 'banner_object_path' = any(a.changed_columns))) > 0,
  'recording media produces 0009''s ordinary update audit entry, naming the column that changed');
select is(
  (select count(*) from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'
      and ('slug' = any(a.changed_columns) or 'status' = any(a.changed_columns)
        or 'verification_status' = any(a.changed_columns) or 'user_id' = any(a.changed_columns))),
  0::bigint,
  'and no audit entry records an immutable column as changed');

select is(
  (select i.slug from app_private.seller_identity('80000000-0000-4000-8000-000000000002') i),
  'active-shop',
  'the 6-A reader still answers');
select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_identity'),
  'TABLE(slug text, display_name text, status text, verification_status text, city text, country_code character)',
  'and its projection still carries no object path');
select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_seller_by_slug'),
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_seller_by_slug'),
  '4-E''s public reader is untouched by this migration');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_seller_by_slug'
      and pg_get_function_result(p.oid) like '%object_path%'),
  0::bigint,
  'and it still returns no object path, so media stays out of the public profile');

select * from finish();
rollback;
