-- 0098 — The CMS media library: the bucket, the two-step upload, and everything that must not be reachable.
--
-- What is proven here, in order: the bucket exists, is **private**, carries the approved limit and MIME list, and is
-- registered in 0012's contract so `storage_bucket_problems()` still returns nothing; **0012's two invariants hold
-- unchanged** — one public bucket and exactly one `storage.objects` policy, the one 0012 itself defined; SVG is
-- refused by the bucket while 0030's own column constraint is untouched (owner decision 2); an object path is
-- composed entirely server-side and a traversal, a nested path, another bucket's path and a mislabelled extension are
-- all unattachable (owner decision 3); the size limit is the bucket's own and is enforced at both steps (owner
-- decision 6); every reference to a media row is reported before a delete, and the delete touches no referencing
-- table itself — the `set null` is 0030's foreign key (owner decision 5); a signed preview targets exactly the
-- stored object; both alt texts are editable and neither is required (owner decision 7); and every function refuses
-- a caller who does not effectively hold `cms.media.manage`, at `aal1` included.
--
-- Also proven: no public reader was added (owner decision 4), nothing reads a banner, and nothing financial,
-- promotional or listing-media-related is touched.

-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(229);

-- ---------------------------------------------------------------------------------------------------
-- The bucket, and 0012's invariants
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.storage_bucket_problems()), 0::bigint,
  'the storage contract still holds with the new bucket registered');

select ok(exists (select 1 from storage.buckets where id = 'cms-media'), 'the cms-media bucket exists');
select ok(
  not (select b.public from storage.buckets b where b.id = 'cms-media'),
  'and it is private (owner decision 1)');
select is((select b.file_size_limit from storage.buckets b where b.id = 'cms-media'), 10485760::bigint,
  'with the approved 10 MiB upload boundary (owner decision 6)');
select is(
  (select b.allowed_mime_types from storage.buckets b where b.id = 'cms-media'),
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
  'and the four raster types, SVG excluded (owner decision 2)');
select ok(
  not exists (
    select 1
      from storage.buckets b
      cross join unnest(b.allowed_mime_types) as t(mime)
     where b.id = 'cms-media' and t.mime = 'image/svg+xml'
  ),
  'the bucket refuses SVG explicitly');

select ok(
  exists (select 1 from app_private.storage_bucket_contract where bucket_id = 'cms-media' and not must_be_public),
  'the bucket is registered in 0012''s contract as private, which is what keeps the contract check green');

-- 0012's own two assertions, restated here because this migration adds a bucket to the thing they are about.
select is((select count(*) from storage.buckets where public), 1::bigint,
  'there is still exactly one public bucket, and it is not this one');
select is((select id from storage.buckets where public), 'listing-variants',
  'and it is still the listing variants');
select is(
  (select count(*)::int
     from pg_policy p
     join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'),
  1, 'storage.objects still carries exactly one policy');
select is(
  (select p.polname
     from pg_policy p
     join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'),
  'listing_variants_public_read',
  'and it is the one 0012 defined — this migration added none (owner decision 1)');

-- The buckets this increment must not touch.
select ok(exists (select 1 from storage.buckets where id = 'listing-originals'),
  'listing-originals is untouched');
select ok(exists (select 1 from storage.buckets where id = 'listing-variants'),
  'and listing-variants');
select ok((select b.public from storage.buckets b where b.id = 'listing-variants'),
  'which is still the public one');
select ok(exists (select 1 from storage.buckets where id = 'seller-media'),
  'and 0060''s seller-media bucket');
select is((select count(*)::int from storage.buckets), 9,
  'nine buckets: 0012''s seven, 0060''s one, and this one');

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'cms_media_can_manage', array['uuid', 'boolean'], 'the manage predicate exists');
select has_function('app_private', 'cms_media_extension_for', array['text'], 'the extension helper exists');
select has_function('app_private', 'cms_media_upload_target', array['uuid', 'boolean', 'text', 'bigint'],
  'the upload authorizer exists');
select has_function('app_private', 'cms_media_attach',
  array['uuid', 'boolean', 'text', 'text', 'bigint', 'integer', 'integer', 'text', 'text'],
  'the attach writer exists');
select has_function('app_private', 'cms_media_for_staff',
  array['uuid', 'boolean', 'timestamptz', 'uuid', 'integer'], 'the staff list exists');
select has_function('app_private', 'cms_media_references', array['uuid'], 'the reference reader exists');
select has_function('app_private', 'cms_media_usage', array['uuid', 'boolean', 'uuid'],
  'the staff usage reader exists');
select has_function('app_private', 'cms_media_read_target', array['uuid', 'boolean', 'uuid'],
  'the signed-read target exists');
select has_function('app_private', 'cms_media_alt_text_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text'], 'the alt-text writer exists');
select has_function('app_private', 'cms_media_delete_for_staff', array['uuid', 'boolean', 'uuid'],
  'the delete writer exists');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'cms_media%'),
  10, 'this increment adds exactly ten functions');
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'cms_media%' and p.prosecdef),
  10, 'all ten are security definer');
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'cms_media%'
      and p.proconfig @> array['search_path=pg_catalog, public']),
  10, 'all ten pin search_path to pg_catalog, public');

select is((select count(*)::int from public.audit_attribution_problems()), 0,
  '0098 adds no audit attribution problem');
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'cms_media%' and p.prosrc ~ 'audit_actor'),
  0, 'no 0098 function names the 8-B attribution channel');

-- Owner decision 4: no public reader was added.
select hasnt_function('app_private', 'public_cms_media', 'no public media reader was added');
select hasnt_function('app_private', 'public_media_url', 'and no public URL builder');
select hasnt_function('app_private', 'cms_media_public_url', 'and none under this increment''s own prefix');

-- ---------------------------------------------------------------------------------------------------
-- What this increment must not do
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'cms_media%'
      and (p.prosrc ~* 'promotion' or p.prosrc ~* 'placement' or p.prosrc ~* 'wallet'
           or p.prosrc ~* 'ranking' or p.prosrc ~* 'popularity')),
  0, 'no 0098 function mentions a promotion, a placement, a wallet, a ranking or a popularity signal');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'cms_media%'
      and (p.prosrc ~* 'ledger' or p.prosrc ~* 'payout' or p.prosrc ~* 'settlement'
           or p.prosrc ~* 'seller_balances' or p.prosrc ~* 'payment' or p.prosrc ~* 'finance\.')),
  0, 'and none touches a financial table or names a finance setting');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'cms_media%'
      and (p.prosrc ~ 'listing-originals' or p.prosrc ~ 'listing-variants' or p.prosrc ~ 'listing_media'
           or p.prosrc ~ 'seller-media')),
  0, 'and none names another bucket or the listing media pipeline');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'cms_media%'
      and (p.prosrc ~* 'https?://' or p.prosrc ~* 'signed' or p.prosrc ~* 'token')),
  0, 'and none builds a URL or signs anything — the signing is the API''s one storage port (owner decision 1)');

-- `seo_settings` is deliberately **not** in this list: `cms_media_references` reads its
-- `default_share_media_id`, because owner decision 5 requires every reference to be reported and that is one of the
-- six. What matters is that nothing here *writes* it, which the next assertion proves for all five referencing
-- tables at once.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'cms_media%'
      and (p.prosrc ~* 'site_settings' or p.prosrc ~* 'email_template' or p.prosrc ~* 'sitemap'
           or p.prosrc ~* 'robots')),
  0, 'and none reads site settings, an email template, a sitemap or the robots document');

-- The one write any 0098 function may make to another table is none: only `cms_media` is written.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'cms_media%'
      and p.prosrc ~* '(update|insert into|delete from)\s+public\.(pages|blog_posts|banners|seo_settings|seo_metadata)'),
  0, 'no 0098 function writes to a referencing table — the set null is 0030''s foreign key (owner decision 5)');

-- Owner decision 4 again, as a property of the code: no banner is composed or served here.
select has_table('public', 'banners', 'the banners table is untouched');
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'banner%'),
  0, 'and no banner function exists: 0098 makes a banner''s media possible and builds no banner');

-- ---------------------------------------------------------------------------------------------------
-- Nothing in 0030 was changed
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'cms_media', 'the media table is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'cms_media_mime_allowed'),
  '0030''s MIME constraint is untouched');
select ok(
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'cms_media_mime_allowed') ~ 'svg',
  'and it still allows SVG at the column, which the bucket narrows rather than contradicts (owner decision 2)');
select ok(
  exists (select 1 from pg_constraint where conname = 'cms_media_object_path_in_bucket'),
  '0030''s object-path-in-bucket rule is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'cms_media_dimensions_positive'),
  '0030''s dimension rule is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'cms_media_alt_text_en_length'),
  '0030''s English alt-text bound is untouched (owner decision 7)');
select ok(
  exists (select 1 from pg_constraint where conname = 'cms_media_alt_text_ar_length'),
  'and its Arabic one');
select ok(
  exists (select 1 from pg_class where relname = 'cms_media_object_path'),
  '0030''s unique object-path index is still installed');
select ok(
  exists (select 1 from pg_trigger where tgname = 'cms_media_set_updated_at'),
  '0030''s updated_at trigger is still installed');
select ok(
  exists (select 1 from pg_policies where tablename = 'cms_media' and policyname = 'cms_media_admin_write'),
  '0030''s write policy naming cms.media.manage is untouched');

-- The six referencing columns, which owner decision 5 is about.
select col_type_is('public', 'pages', 'cover_media_id', 'uuid', 'the page cover column is untouched');
select col_type_is('public', 'blog_posts', 'cover_media_id', 'uuid', 'the blog cover column is untouched');
select col_type_is('public', 'banners', 'media_id', 'uuid', 'the banner image column is untouched');
select col_type_is('public', 'banners', 'media_ar_id', 'uuid', 'the Arabic banner image column is untouched');
select col_type_is('public', 'seo_settings', 'default_share_media_id', 'uuid',
  'the default share image column is untouched');
select col_type_is('public', 'seo_metadata', 'share_media_id', 'uuid', 'the per-entity share image column too');
select is(
  (select count(*)::int
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_class f on f.oid = c.confrelid
    where c.contype = 'f' and f.relname = 'cms_media' and c.confdeltype = 'n'),
  6, 'all six foreign keys still set null on delete, which is the only thing that blanks a reference');

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select ok(has_function_privilege('app_system', p.oid, 'execute'),
    format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname like 'cms_media%'
 order by p.proname;

select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
    format('%s may not execute %s', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_worker')) as r(rolname)
 where n.nspname = 'app_private' and p.proname like 'cms_media%'
 order by r.rolname, p.proname;

-- No table privilege on the storage tables was granted by this migration.
select ok(not has_table_privilege('authenticated', 'storage.buckets', 'select'),
  'authenticated gained no privilege on storage.buckets');
select ok(not has_table_privilege('app_worker', 'storage.objects', 'select'),
  'and the worker none on storage.objects');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- An operator who holds the one key through the admin role (0033 grants it to admin and super_admin, and both roles
-- require MFA), and a signed-in person who holds nothing here.
insert into auth.users (id, email) values
  ('ac100000-0000-4000-8000-000000000001', 'media-operator@example.test'),
  ('ac100000-0000-4000-8000-000000000002', 'media-nobody@example.test');
insert into public.user_roles (user_id, role_key) values
  ('ac100000-0000-4000-8000-000000000001', 'admin');

create function pg_temp.operator() returns uuid language sql immutable as
  $f$ select 'ac100000-0000-4000-8000-000000000001'::uuid $f$;
create function pg_temp.nobody() returns uuid language sql immutable as
  $f$ select 'ac100000-0000-4000-8000-000000000002'::uuid $f$;

-- ---------------------------------------------------------------------------------------------------
-- The permission predicate
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.cms_media_can_manage(pg_temp.operator(), true),
  'the operator holds cms.media.manage at aal2');
select ok(not app_private.cms_media_can_manage(pg_temp.operator(), false),
  'and holds nothing at aal1, because the role requires MFA');
select ok(not app_private.cms_media_can_manage(pg_temp.operator(), null),
  'a null assurance level is not an assurance');
select ok(not app_private.cms_media_can_manage(pg_temp.nobody(), true),
  'a signed-in person without the key holds nothing');
select ok(not app_private.cms_media_can_manage(null, true), 'and neither does nobody at all');

insert into public.user_roles (user_id, role_key, revoked_at) values
  ('ac100000-0000-4000-8000-000000000002', 'admin', '2026-01-01T00:00:00Z');
select ok(not app_private.cms_media_can_manage(pg_temp.nobody(), true), 'a revoked role grants nothing');
delete from public.user_roles where user_id = pg_temp.nobody();

-- ---------------------------------------------------------------------------------------------------
-- The extension helper
-- ---------------------------------------------------------------------------------------------------
select is(app_private.cms_media_extension_for('image/jpeg'), 'jpg', 'jpeg becomes jpg');
select is(app_private.cms_media_extension_for('image/png'), 'png', 'png becomes png');
select is(app_private.cms_media_extension_for('image/webp'), 'webp', 'webp becomes webp');
select is(app_private.cms_media_extension_for('image/avif'), 'avif', 'avif becomes avif');
select is(app_private.cms_media_extension_for('image/svg+xml'), null,
  'and SVG becomes nothing, so no path could ever be composed for one (owner decision 2)');
select is(app_private.cms_media_extension_for('text/html'), null, 'as does anything else');
select is(app_private.cms_media_extension_for(null), null, 'and nothing at all');

-- ---------------------------------------------------------------------------------------------------
-- Authorizing an upload
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/png', 2048)),
  'authorized', 'the operator may authorize a PNG upload');
select is(
  (select bucket_id from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/png', 2048)),
  'cms-media', 'into the cms-media bucket');
select is(
  (select max_byte_size from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/png', 2048)),
  10485760::bigint, 'with the limit read from the bucket row rather than restated (owner decision 6)');

-- Owner decision 3: the path is the server's, entirely.
select ok(
  (select object_path from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/png', 2048))
    ~ '^cms-media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$',
  'the path is the bucket, one generated uuid and the extension the type implies');
select ok(
  (select object_path from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/jpeg', 2048))
    like '%.jpg',
  'and the extension follows the declared type');
select isnt(
  (select object_path from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/png', 2048)),
  (select object_path from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/png', 2048)),
  'two authorizations never name the same object');

-- Owner decision 2, at the boundary that matters.
select is(
  (select outcome from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/svg+xml', 2048)),
  'invalid', 'an SVG upload is refused (owner decision 2)');
select is(
  (select object_path from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/svg+xml', 2048)),
  null, 'and no path is issued for one');
select is(
  (select outcome from app_private.cms_media_upload_target(pg_temp.operator(), true, 'text/html', 2048)),
  'invalid', 'and so is anything that is not an allowed image');
select is(
  (select outcome from app_private.cms_media_upload_target(pg_temp.operator(), true, null, 2048)),
  'invalid', 'and a missing type');

-- Owner decision 6, at both ends.
select is(
  (select outcome from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/png', 10485760)),
  'authorized', 'a file exactly at the limit is authorized');
select is(
  (select outcome from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/png', 10485761)),
  'invalid', 'and one byte over it is not');
select is(
  (select outcome from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/png', 0)),
  'invalid', 'an empty file is refused');
select is(
  (select outcome from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/png', -1)),
  'invalid', 'and a negative size');
select is(
  (select outcome from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/png', null)),
  'invalid', 'and no size at all');

-- Authorization, and the neutral refusal.
select is(
  (select outcome from app_private.cms_media_upload_target(pg_temp.nobody(), true, 'image/png', 2048)),
  'not_found', 'a caller without the key cannot authorize an upload');
select is(
  (select outcome from app_private.cms_media_upload_target(pg_temp.operator(), false, 'image/png', 2048)),
  'not_found', 'nor the operator at aal1');
select is(
  (select outcome from app_private.cms_media_upload_target(null, true, 'image/png', 2048)),
  'not_found', 'nor nobody at all');
select is(
  (select bucket_id from app_private.cms_media_upload_target(pg_temp.nobody(), true, 'image/png', 2048)),
  null, 'and a refusal names no bucket');
select is((select count(*)::int from public.cms_media), 0,
  'and not one authorization has written anything: an authorization is not an upload');

-- ---------------------------------------------------------------------------------------------------
-- Recording an upload
-- ---------------------------------------------------------------------------------------------------
create temporary table issued as
select object_path from app_private.cms_media_upload_target(pg_temp.operator(), true, 'image/png', 4096);

select is(
  (select outcome from app_private.cms_media_attach(
    pg_temp.operator(), true, (select object_path from issued), 'image/png', 4096, 800, 600, '  A photo  ', null)),
  'attached', 'the authorized path can be recorded');
select is((select count(*)::int from public.cms_media), 1, 'and the library now holds one entry');
select is((select mime_type from public.cms_media), 'image/png', 'with the declared type');
select is((select byte_size from public.cms_media), 4096::bigint, 'the declared size');
select is((select width from public.cms_media), 800, 'the declared width');
select is((select height from public.cms_media), 600, 'the declared height');
select is((select alt_text_en from public.cms_media), 'A photo', 'and the English alt text, trimmed');
select is((select alt_text_ar from public.cms_media), null, 'with the Arabic one absent (owner decision 7)');
select is((select uploaded_by from public.cms_media), pg_temp.operator(),
  'and the actor recorded in 0030''s own column');

-- Owner decision 3, from the other side: nothing but a path this cluster could have issued is attachable.
select is(
  (select outcome from app_private.cms_media_attach(pg_temp.operator(), true, 'cms-media/../secret.png', 'image/png', 10)),
  'invalid', 'a traversal is not attachable');
select is(
  (select outcome from app_private.cms_media_attach(pg_temp.operator(), true, 'cms-media/a/b.png', 'image/png', 10)),
  'invalid', 'nor a nested path');
select is(
  (select outcome from app_private.cms_media_attach(pg_temp.operator(), true, 'seller-media/x.png', 'image/png', 10)),
  'invalid', 'nor another bucket''s path');
select is(
  (select outcome from app_private.cms_media_attach(pg_temp.operator(), true, 'listing-variants/x.png', 'image/png', 10)),
  'invalid', 'nor the public bucket''s');
select is(
  (select outcome from app_private.cms_media_attach(pg_temp.operator(), true, 'x/cms-media/y.png', 'image/png', 10)),
  'invalid', 'nor one with anything before the prefix');
select is(
  (select outcome from app_private.cms_media_attach(pg_temp.operator(), true, 'cms-media/', 'image/png', 10)),
  'invalid', 'nor the bare prefix');
select is(
  (select outcome from app_private.cms_media_attach(pg_temp.operator(), true, 'cms-media/photo.png', 'image/png', 10)),
  'invalid', 'nor a name that is not a uuid');
select is(
  (select outcome from app_private.cms_media_attach(
    pg_temp.operator(), true, 'cms-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png%00.html', 'image/png', 10)),
  'invalid', 'nor one with anything after the extension');
select is(
  (select outcome from app_private.cms_media_attach(pg_temp.operator(), true, null, 'image/png', 10)),
  'invalid', 'nor no path at all');

-- The extension and the declared type must agree, so a file cannot be recorded as something it is not.
select is(
  (select outcome from app_private.cms_media_attach(
    pg_temp.operator(), true, 'cms-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg', 'image/png', 10)),
  'invalid', 'a PNG cannot be recorded under a .jpg name');
select is(
  (select outcome from app_private.cms_media_attach(
    pg_temp.operator(), true, 'cms-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png', 'image/jpeg', 10)),
  'invalid', 'nor a JPEG under a .png name');

-- Owner decision 2 at the attach step too: the bucket's list governs here as well.
select is(
  (select outcome from app_private.cms_media_attach(
    pg_temp.operator(), true, 'cms-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.svg', 'image/svg+xml', 10)),
  'invalid', 'an SVG cannot be recorded even though 0030''s column would allow the type');

-- Owner decision 6 at the attach step.
select is(
  (select outcome from app_private.cms_media_attach(
    pg_temp.operator(), true, 'cms-media/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png', 'image/png', 10485761)),
  'invalid', 'a file over the bucket''s limit cannot be recorded');

-- A retried confirmation is reported, not raised.
select is(
  (select outcome from app_private.cms_media_attach(
    pg_temp.operator(), true, (select object_path from issued), 'image/png', 4096)),
  'taken', 'recording the same object twice is reported as taken');
select is((select count(*)::int from public.cms_media), 1, 'and creates no second row');

-- Authorization.
select is(
  (select outcome from app_private.cms_media_attach(
    pg_temp.nobody(), true, 'cms-media/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png', 'image/png', 10)),
  'not_found', 'a caller without the key cannot record anything');
select is(
  (select outcome from app_private.cms_media_attach(
    pg_temp.operator(), false, 'cms-media/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png', 'image/png', 10)),
  'not_found', 'nor the operator at aal1');
select is((select count(*)::int from public.cms_media), 1, 'and neither attempt wrote anything');

-- ---------------------------------------------------------------------------------------------------
-- The staff reader
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.cms_media_for_staff(pg_temp.nobody(), true)), 0,
  'a caller without the key reads nothing at all');
select is((select count(*)::int from app_private.cms_media_for_staff(pg_temp.operator(), false)), 0,
  'and neither does the operator at aal1');
select is((select count(*)::int from app_private.cms_media_for_staff(pg_temp.operator(), true)), 1,
  'the operator sees the entry');
select is(
  (select object_path from app_private.cms_media_for_staff(pg_temp.operator(), true)),
  (select object_path from issued), 'with its stored path');
select is((select usage_count from app_private.cms_media_for_staff(pg_temp.operator(), true)), 0,
  'and a usage count of zero while nothing points at it');

-- A second and third entry, so paging and ordering are real.
select is(
  (select outcome from app_private.cms_media_attach(
    pg_temp.operator(), true, 'cms-media/dddddddd-dddd-4ddd-8ddd-dddddddddddd.webp', 'image/webp', 2048)),
  'attached', 'a second entry is recorded');
select is(
  (select outcome from app_private.cms_media_attach(
    pg_temp.operator(), true, 'cms-media/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.avif', 'image/avif', 2048)),
  'attached', 'and a third');
update public.cms_media set created_at = '2026-05-01T09:00:00Z' where object_path like '%dddddddd%';
update public.cms_media set created_at = '2026-05-03T09:00:00Z' where object_path like '%eeeeeeee%';
update public.cms_media set created_at = '2026-05-02T09:00:00Z' where object_path = (select object_path from issued);

select is(
  (select array_agg(mime_type order by ordinality)
     from app_private.cms_media_for_staff(pg_temp.operator(), true, null, null, 10) with ordinality),
  array['image/avif', 'image/png', 'image/webp'], 'newest first');
select is((select count(*)::int from app_private.cms_media_for_staff(pg_temp.operator(), true, null, null, 2)), 2,
  'a page carries at most the limit');
select is(
  (select array_agg(mime_type)
     from app_private.cms_media_for_staff(
       pg_temp.operator(), true, '2026-05-03T09:00:00Z'::timestamptz,
       (select media_id from app_private.cms_media_for_staff(pg_temp.operator(), true, null, null, 1)), 10)),
  array['image/png', 'image/webp'], 'and the next page continues after it');
select is((select count(*)::int from app_private.cms_media_for_staff(pg_temp.operator(), true, null, null, 0)), 1,
  'a nonsense limit is clamped rather than refused');
select is((select count(*)::int from app_private.cms_media_for_staff(pg_temp.operator(), true, null, null, null)), 1,
  'and so is a null one');

-- ---------------------------------------------------------------------------------------------------
-- Usage, and the delete it exists to inform (owner decision 5)
-- ---------------------------------------------------------------------------------------------------
create temporary table target as select id from public.cms_media where object_path = (select object_path from issued);

select is((select count(*)::int from app_private.cms_media_usage(pg_temp.operator(), true, (select id from target))), 0,
  'an entry nothing points at reports no usage');

-- One reference of each kind the schema allows.
insert into public.pages (id, slug, status, published_at, template, cover_media_id) values
  ('ac200000-0000-4000-8000-000000000001', 'about', 'published', '2026-05-01T10:00:00Z', 'standard',
   (select id from target));
insert into public.blog_posts (id, slug, status, published_at, cover_media_id) values
  ('ac300000-0000-4000-8000-000000000001', 'a-post', 'published', '2026-05-01T10:00:00Z', (select id from target));
insert into public.banners (id, banner_key, placement, media_id, media_ar_id) values
  ('ac400000-0000-4000-8000-000000000001', 'home_top', 'home_hero', (select id from target), (select id from target));
insert into public.seo_settings (locale_code, site_name, default_share_media_id) values
  ('en', 'Egypt Market', (select id from target));
insert into public.seo_metadata (id, entity_type, route_path, locale_code, share_media_id) values
  ('ac500000-0000-4000-8000-000000000001', 'route', '/listings', 'en', (select id from target));

select is((select count(*)::int from app_private.cms_media_usage(pg_temp.operator(), true, (select id from target))), 6,
  'every one of the six referencing columns is reported');
select is(
  (select array_agg(distinct entity_type order by entity_type)
     from app_private.cms_media_usage(pg_temp.operator(), true, (select id from target))),
  array['banner', 'blog_post', 'page', 'seo_metadata', 'seo_settings'],
  'across all five referencing tables');
select is(
  (select array_agg(entity_column order by entity_column)
     from app_private.cms_media_usage(pg_temp.operator(), true, (select id from target))
    where entity_type = 'banner'),
  array['media_ar_id', 'media_id'], 'with both banner columns named separately');
select is(
  (select entity_label from app_private.cms_media_usage(pg_temp.operator(), true, (select id from target))
    where entity_type = 'page'),
  'about', 'and a label an operator can recognise');
select is(
  (select entity_id from app_private.cms_media_usage(pg_temp.operator(), true, (select id from target))
    where entity_type = 'seo_settings'),
  null, 'the locale-keyed row reports no uuid, because it has none');
select is(
  (select entity_label from app_private.cms_media_usage(pg_temp.operator(), true, (select id from target))
    where entity_type = 'seo_settings'),
  'en', 'and names its locale instead');
select is((select usage_count from app_private.cms_media_for_staff(pg_temp.operator(), true)
            where object_path = (select object_path from issued)),
  6, 'and the list agrees with the detail');

select is((select count(*)::int from app_private.cms_media_usage(pg_temp.nobody(), true, (select id from target))), 0,
  'a caller without the key sees no usage');
select is((select count(*)::int from app_private.cms_media_usage(pg_temp.operator(), false, (select id from target))), 0,
  'nor the operator at aal1');
select is(
  (select count(*)::int
     from app_private.cms_media_usage(pg_temp.operator(), true, 'ac900000-0000-4000-8000-0000000000fe')),
  0, 'and an entry that does not exist reports nothing rather than failing');

-- ---------------------------------------------------------------------------------------------------
-- The signed-read target
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.cms_media_read_target(pg_temp.operator(), true, (select id from target))),
  'authorized', 'a stored entry can be previewed');
select is(
  (select bucket_id from app_private.cms_media_read_target(pg_temp.operator(), true, (select id from target))),
  'cms-media', 'from the private bucket');
select is(
  (select object_path from app_private.cms_media_read_target(pg_temp.operator(), true, (select id from target))),
  (select object_path from issued),
  'and the target is exactly the object that row stores, never a composed one');
select is(
  (select outcome from app_private.cms_media_read_target(pg_temp.nobody(), true, (select id from target))),
  'not_found', 'a caller without the key gets a neutral absence');
select is(
  (select outcome from app_private.cms_media_read_target(pg_temp.operator(), false, (select id from target))),
  'not_found', 'and so does the operator at aal1');
select is(
  (select object_path from app_private.cms_media_read_target(pg_temp.nobody(), true, (select id from target))),
  null, 'and no path leaves the database for them');
select is(
  (select outcome from app_private.cms_media_read_target(
    pg_temp.operator(), true, 'ac900000-0000-4000-8000-0000000000fe')),
  'not_found', 'an entry that does not exist is the same absence');

-- ---------------------------------------------------------------------------------------------------
-- Alt text (owner decision 7)
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.cms_media_alt_text_for_staff(
    pg_temp.operator(), true, (select id from target), 'An English description', 'وصف عربي'),
  'both alt texts can be written');
select is((select alt_text_en from public.cms_media where id = (select id from target)), 'An English description',
  'the English one is stored');
select is((select alt_text_ar from public.cms_media where id = (select id from target)), 'وصف عربي',
  'and the Arabic one');
select ok(
  app_private.cms_media_alt_text_for_staff(pg_temp.operator(), true, (select id from target), 'Only English', null),
  'and either may be cleared by sending it empty');
select is((select alt_text_ar from public.cms_media where id = (select id from target)), null,
  'the Arabic one is now absent, which is legal because neither is required');
select ok(
  app_private.cms_media_alt_text_for_staff(pg_temp.operator(), true, (select id from target), '   ', '   '),
  'a blank alt text is accepted');
select is((select alt_text_en from public.cms_media where id = (select id from target)), null,
  'and stored as absent rather than as an empty string, so no surface carries an empty alt');
select throws_ok(
  format($q$ select app_private.cms_media_alt_text_for_staff(%L, true, %L, 'x', null) $q$,
    pg_temp.nobody(), (select id from target)),
  '42501', null, 'a caller without the key cannot write alt text');
select throws_ok(
  format($q$ select app_private.cms_media_alt_text_for_staff(%L, false, %L, 'x', null) $q$,
    pg_temp.operator(), (select id from target)),
  '42501', null, 'nor the operator at aal1');
select ok(
  not app_private.cms_media_alt_text_for_staff(
    pg_temp.operator(), true, 'ac900000-0000-4000-8000-0000000000fe', 'x', null),
  'and an entry that does not exist reports that nothing changed');
select throws_ok(
  format($q$ select app_private.cms_media_alt_text_for_staff(%L, true, %L, %L, null) $q$,
    pg_temp.operator(), (select id from target), repeat('a', 301)),
  '23514', null, '0030''s 300-character bound still refuses a longer one');

-- ---------------------------------------------------------------------------------------------------
-- The delete (owner decision 5)
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.cms_media_delete_for_staff(%L, true, %L) $q$,
    pg_temp.nobody(), (select id from target)),
  '42501', null, 'a caller without the key cannot delete an entry');
select throws_ok(
  format($q$ select app_private.cms_media_delete_for_staff(%L, false, %L) $q$,
    pg_temp.operator(), (select id from target)),
  '42501', null, 'nor the operator at aal1');
select is((select count(*)::int from public.cms_media), 3, 'and neither attempt deleted anything');

select ok(
  not app_private.cms_media_delete_for_staff(pg_temp.operator(), true, 'ac900000-0000-4000-8000-0000000000fe'),
  'deleting an entry that does not exist reports that nothing changed');

select ok(app_private.cms_media_delete_for_staff(pg_temp.operator(), true, (select id from target)),
  'the referenced entry is deleted');
select is((select count(*)::int from public.cms_media), 2, 'the library now holds two entries');

-- The whole of owner decision 5: six references became null, through 0030's foreign keys and nothing else.
select ok((select cover_media_id is null from public.pages where slug = 'about'),
  'the page cover is now null');
select ok((select cover_media_id is null from public.blog_posts where slug = 'a-post'),
  'the blog cover is now null');
select ok((select media_id is null and media_ar_id is null from public.banners where banner_key = 'home_top'),
  'both banner images are now null');
select ok((select default_share_media_id is null from public.seo_settings where locale_code = 'en'),
  'the default share image is now null');
select ok((select share_media_id is null from public.seo_metadata where route_path = '/listings'),
  'and the per-entity share image');

-- And the rows themselves survived: a delete blanks a reference, it does not remove the thing referring.
select is((select count(*)::int from public.pages where slug = 'about'), 1, 'the page itself still exists');
select is((select count(*)::int from public.blog_posts where slug = 'a-post'), 1, 'and the post');
select is((select count(*)::int from public.banners where banner_key = 'home_top'), 1, 'and the banner');
select is((select count(*)::int from public.seo_settings where locale_code = 'en'), 1, 'and the SEO settings row');
select is((select count(*)::int from public.seo_metadata where route_path = '/listings'), 1, 'and the metadata row');

-- A deleted entry can no longer be previewed, which is what makes its orphaned object unreachable.
select is(
  (select outcome from app_private.cms_media_read_target(pg_temp.operator(), true, (select id from target))),
  'not_found', 'and no signed read can be issued for it any more');

select * from finish();
rollback;
