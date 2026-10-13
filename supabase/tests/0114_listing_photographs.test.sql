-- pgTAP — migration 0114: listing photographs.
--
-- What this file is about is **the rules 0011 and 0012 already wrote, finally exercised** — plus the one
-- branch 0114 adds to them. In order of how much it would cost to get wrong:
--
--   * **a path is never the caller's.** Every object path is derived server-side from the bucket, the
--     listing and a fresh name; an attach naming a path under another listing, the wrong bucket for its
--     key, or a traversal is refused rather than stored and served;
--   * **the original never reaches the public.** It goes to the private bucket, it is the row's
--     `original_object_path`, and the public reader cannot return it;
--   * **a variant is public only while its listing is.** Attaching to a draft stores it unpublished;
--     approval publishes it — the branch 0114 adds — and withdrawal unpublishes it again, which is 0011's;
--   * **`metadata_stripped_at` is never claimed**, because the stripping happens in a browser and this
--     database cannot see the bytes. A test that lets a future edit quietly start claiming it is the point;
--   * **who may do any of it**: the listing's own seller, or staff holding `catalog.listing.moderate` under
--     the platform's `requires_mfa` rule. Nobody else, and no key was invented.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(49);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('cc140000-0000-4000-8000-000000000001', 'm-seller@test.invalid'),
  ('cc140000-0000-4000-8000-000000000002', 'm-other@test.invalid'),
  ('cc140000-0000-4000-8000-000000000003', 'm-admin@test.invalid'),
  ('cc140000-0000-4000-8000-000000000004', 'm-nobody@test.invalid');

insert into public.user_roles (user_id, role_key, granted_at) values
  ('cc140000-0000-4000-8000-000000000003', 'admin', now() - interval '10 days');

insert into public.seller_profiles (
  user_id, slug, display_name, legal_name, bio, content_language, contact_email, contact_phone_e164,
  country_code, governorate, city, status, verification_status, verified_at
) values
  ('cc140000-0000-4000-8000-000000000001', 'm-shop', 'Shop', 'Shop LLC', 'A bio.', 'en',
   'm-shop@test.invalid', '+201000114001', 'EG', 'Cairo', 'Cairo', 'active', 'verified', now()),
  ('cc140000-0000-4000-8000-000000000002', 'm-other', 'Other', 'Other LLC', 'A bio.', 'en',
   'm-other@test.invalid', '+201000114002', 'EG', 'Cairo', 'Cairo', 'active', 'verified', now());

insert into public.categories (id, slug, listing_type_code, depth) values
  ('cc140000-0000-4000-8000-0000000000c1', 'm-category', 'property', 0);

create or replace function pg_temp.listing(p_id uuid, p_slug text, p_seller uuid, p_status text)
returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description,
    content_language, currency_code, price_minor, status, country_code, approved_at
  ) values (
    p_id, p_seller, 'property', 'cc140000-0000-4000-8000-0000000000c1', p_slug, 'A property',
    'A description long enough to be real.', 'en', 'EGP', 42500000, p_status, 'EG',
    case when p_status = 'active' then now() end
  );
end;
$$;

select pg_temp.listing('cc140000-0000-4000-8000-00000000aa01', 'm-live', 'cc140000-0000-4000-8000-000000000001', 'active');
select pg_temp.listing('cc140000-0000-4000-8000-00000000aa02', 'm-draft', 'cc140000-0000-4000-8000-000000000001', 'draft');
select pg_temp.listing('cc140000-0000-4000-8000-00000000aa03', 'm-theirs', 'cc140000-0000-4000-8000-000000000002', 'active');

/** The four objects one photograph is, for a listing, with the widths given. */
create or replace function pg_temp.photo(
  p_listing uuid, p_name text, p_original_bucket text default 'listing-originals'
) returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('variant_key', 'original', 'width', 2000, 'height', 1500, 'byte_size', 400000,
      'object_path', p_original_bucket || '/' || p_listing::text || '/original/' || p_name || '.webp'),
    jsonb_build_object('variant_key', 'thumb', 'width', 400, 'height', 300, 'byte_size', 9000,
      'object_path', 'listing-variants/' || p_listing::text || '/thumb/' || p_name || '.webp'),
    jsonb_build_object('variant_key', 'card', 'width', 800, 'height', 600, 'byte_size', 40000,
      'object_path', 'listing-variants/' || p_listing::text || '/card/' || p_name || '.webp'),
    jsonb_build_object('variant_key', 'full', 'width', 1600, 'height', 1200, 'byte_size', 150000,
      'object_path', 'listing-variants/' || p_listing::text || '/full/' || p_name || '.webp')
  );
$$;

-- ---------------------------------------------------------------------------------------------------
-- 1. Who may manage a listing's photographs
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.listing_media_can_manage(
    'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01'),
  'the listing''s own seller may');
select ok(
  not app_private.listing_media_can_manage(
    'cc140000-0000-4000-8000-000000000002', 'cc140000-0000-4000-8000-00000000aa01'),
  'another seller may not');
select ok(
  not app_private.listing_media_can_manage(
    'cc140000-0000-4000-8000-000000000004', 'cc140000-0000-4000-8000-00000000aa01'),
  'and neither may somebody with no storefront at all');
select ok(
  not app_private.listing_media_can_manage(null, 'cc140000-0000-4000-8000-00000000aa01'),
  'nor nobody');
select ok(
  app_private.listing_media_can_manage(
    'cc140000-0000-4000-8000-000000000003', 'cc140000-0000-4000-8000-00000000aa01', true),
  'staff holding catalog.listing.moderate may, which is how the office manages a listing (OD-A4)');
select ok(
  not app_private.listing_media_can_manage(
    'cc140000-0000-4000-8000-000000000003', 'cc140000-0000-4000-8000-00000000aa01', false),
  'but not at aal1: the role requires MFA and the rule is the platform''s own');

-- A suspended storefront loses it, which is the same gate `seller_listing_update_draft` applies.
-- `seller_profiles_suspended_has_time` wants the moment with the status, which is the table's own rule.
update public.seller_profiles set status = 'suspended', suspended_at = now()
 where user_id = 'cc140000-0000-4000-8000-000000000001';
select ok(
  not app_private.listing_media_can_manage(
    'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01'),
  'a suspended storefront may not, by the same gate the listing editor applies');
update public.seller_profiles set status = 'active', suspended_at = null
 where user_id = 'cc140000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------------------------------
-- 2. The upload target
-- ---------------------------------------------------------------------------------------------------
select is(
  (select bucket_id from app_private.listing_media_upload_target(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
     'card', 'image/webp', 90000)),
  'listing-variants', 'a served size is authorized into the public bucket');
select is(
  (select bucket_id from app_private.listing_media_upload_target(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
     'original', 'image/webp', 900000)),
  'listing-originals', 'and the original into the private one: the key routes the bucket, not the request');
select ok(
  (select object_path like 'listing-variants/cc140000-0000-4000-8000-00000000aa01/card/%.webp'
     from app_private.listing_media_upload_target(
       'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
       'card', 'image/webp', 90000)),
  'the path is the bucket, the listing and a fresh name: nothing from the request appears in it');
select is(
  (select outcome from app_private.listing_media_upload_target(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
     'card', 'image/png', 90000)),
  'invalid', 'PNG is refused, which is narrower than the bucket allows and deliberately so');
select is(
  (select outcome from app_private.listing_media_upload_target(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
     'enormous', 'image/webp', 90000)),
  'invalid', 'a key nobody declared is refused');
select is(
  (select outcome from app_private.listing_media_upload_target(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
     'card', 'image/webp', 999999999)),
  'invalid', 'and a size past the bucket''s own limit, which is read from the bucket rather than restated');
select is(
  (select outcome from app_private.listing_media_upload_target(
     'cc140000-0000-4000-8000-000000000002', 'cc140000-0000-4000-8000-00000000aa01',
     'card', 'image/webp', 90000)),
  'not_found', 'another seller is refused as an absence, not as a forbidden');

-- ---------------------------------------------------------------------------------------------------
-- 3. Attaching
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.listing_media_attach(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
     pg_temp.photo('cc140000-0000-4000-8000-00000000aa01', 'one'))),
  'attached', 'a complete set attaches');

select is(
  (select count(*)::integer from public.media_variants v
     join public.listing_media m on m.id = v.listing_media_id
    where m.listing_id = 'cc140000-0000-4000-8000-00000000aa01'),
  3, 'three variants are stored: the original is the row''s own path and never a variant');

select ok(
  (select original_object_path like 'listing-originals/%'
     from public.listing_media where listing_id = 'cc140000-0000-4000-8000-00000000aa01'),
  'and the original is in the private bucket');

select ok(
  (select is_primary from public.listing_media where listing_id = 'cc140000-0000-4000-8000-00000000aa01'),
  'the first photograph a listing gets is its primary, without anybody saying so');

-- **The path checks.** Each of these is a way of reaching somewhere the caller was never authorized for.
select is(
  (select outcome from app_private.listing_media_attach(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
     pg_temp.photo('cc140000-0000-4000-8000-00000000aa03', 'theirs'))),
  'invalid', 'a set whose paths belong to another listing is refused');

select is(
  (select outcome from app_private.listing_media_attach(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
     pg_temp.photo('cc140000-0000-4000-8000-00000000aa01', 'pub', 'listing-variants'))),
  'invalid', 'and so is an original claiming a path in the public bucket');

select is(
  (select outcome from app_private.listing_media_attach(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
     jsonb_build_array(
       jsonb_build_object('variant_key', 'original', 'width', 2000, 'height', 1500, 'byte_size', 1,
         'object_path', 'listing-originals/cc140000-0000-4000-8000-00000000aa01/original/../../x.webp'),
       jsonb_build_object('variant_key', 'thumb', 'width', 400, 'height', 300, 'byte_size', 1,
         'object_path', 'listing-variants/cc140000-0000-4000-8000-00000000aa01/thumb/a.webp'),
       jsonb_build_object('variant_key', 'card', 'width', 800, 'height', 600, 'byte_size', 1,
         'object_path', 'listing-variants/cc140000-0000-4000-8000-00000000aa01/card/b.webp'),
       jsonb_build_object('variant_key', 'full', 'width', 1600, 'height', 1200, 'byte_size', 1,
         'object_path', 'listing-variants/cc140000-0000-4000-8000-00000000aa01/full/c.webp')))),
  'invalid', 'a traversal in a path is refused');

select is(
  (select outcome from app_private.listing_media_attach(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
     (select jsonb_agg(e) from jsonb_array_elements(
        pg_temp.photo('cc140000-0000-4000-8000-00000000aa01', 'short')) e
       where e ->> 'variant_key' <> 'thumb'))),
  'invalid', 'a set missing one of its four is refused: a half-written photograph is not one');

select is(
  (select outcome from app_private.listing_media_attach(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
     jsonb_build_array(
       jsonb_build_object('variant_key', 'original', 'width', 800, 'height', 600, 'byte_size', 1,
         'object_path', 'listing-originals/cc140000-0000-4000-8000-00000000aa01/original/o.webp'),
       jsonb_build_object('variant_key', 'thumb', 'width', 800, 'height', 600, 'byte_size', 1,
         'object_path', 'listing-variants/cc140000-0000-4000-8000-00000000aa01/thumb/a.webp'),
       jsonb_build_object('variant_key', 'card', 'width', 800, 'height', 600, 'byte_size', 1,
         'object_path', 'listing-variants/cc140000-0000-4000-8000-00000000aa01/card/b.webp'),
       jsonb_build_object('variant_key', 'full', 'width', 800, 'height', 600, 'byte_size', 1,
         'object_path', 'listing-variants/cc140000-0000-4000-8000-00000000aa01/full/c.webp')))),
  'invalid', 'three copies of one width is not three sizes');

select is(
  (select outcome from app_private.listing_media_attach(
     'cc140000-0000-4000-8000-000000000002', 'cc140000-0000-4000-8000-00000000aa01',
     pg_temp.photo('cc140000-0000-4000-8000-00000000aa01', 'nope'))),
  'not_found', 'and another seller cannot attach to a listing that is not theirs');

-- ---------------------------------------------------------------------------------------------------
-- 4. Publication follows the listing, in both directions
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.listing_media_attach(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa02',
     pg_temp.photo('cc140000-0000-4000-8000-00000000aa02', 'draft'))),
  'attached', 'a photograph can be added to a draft');

select is(
  (select count(*)::integer from public.media_variants v
     join public.listing_media m on m.id = v.listing_media_id
    where m.listing_id = 'cc140000-0000-4000-8000-00000000aa02' and v.is_public),
  0, 'and none of its variants is public, which is 0011''s own rule');

select is(
  (select count(*)::integer from app_private.public_listing_media(
     array['cc140000-0000-4000-8000-00000000aa02'::uuid])),
  0, 'so the public reader shows nothing for a draft');

update public.listings set status = 'active', approved_at = now()
 where id = 'cc140000-0000-4000-8000-00000000aa02';

select is(
  (select count(*)::integer from public.media_variants v
     join public.listing_media m on m.id = v.listing_media_id
    where m.listing_id = 'cc140000-0000-4000-8000-00000000aa02' and v.is_public),
  3, 'approving the listing publishes them: 0114''s missing half of 0011''s rule');

select is(
  (select count(*)::integer from public.media_variants v
     join public.listing_media m on m.id = v.listing_media_id
    where m.listing_id = 'cc140000-0000-4000-8000-00000000aa02'
      and v.is_public and v.published_at is null),
  0, 'each with the moment the constraint requires');

update public.listings set status = 'suspended' where id = 'cc140000-0000-4000-8000-00000000aa02';
select is(
  (select count(*)::integer from app_private.public_listing_media(
     array['cc140000-0000-4000-8000-00000000aa02'::uuid])),
  0, 'and suspending it takes them down again, which is 0011''s half');

-- ---------------------------------------------------------------------------------------------------
-- 5. The public reader
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_private.public_listing_media(
     array['cc140000-0000-4000-8000-00000000aa01'::uuid])),
  3, 'a live listing''s three sizes are served');

select is(
  (select count(*)::integer from app_private.public_listing_media(
     array['cc140000-0000-4000-8000-00000000aa01'::uuid])
    where object_path not like 'listing-variants/%'),
  0, '**and never the original**: everything it returns is in the public bucket');

select is(
  (select string_agg(variant_key, ',' order by width)
     from app_private.public_listing_media(array['cc140000-0000-4000-8000-00000000aa01'::uuid])),
  'thumb,card,full', 'in ascending size, so a caller can build a srcset without sorting');

select is(
  (select count(*)::integer from app_private.public_listing_media(array[]::uuid[])),
  0, 'an empty request is an empty answer rather than every photograph on the platform');

select is(
  (select count(*)::integer from app_private.public_listing_media(null)),
  0, 'and so is no request at all');

-- ---------------------------------------------------------------------------------------------------
-- 6. Withdrawing one photograph
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.listing_media_attach(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
     pg_temp.photo('cc140000-0000-4000-8000-00000000aa01', 'two'))),
  'attached', 'a second photograph attaches');

select ok(
  app_private.listing_media_withdraw(
    'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01',
    (select id from public.listing_media
      where listing_id = 'cc140000-0000-4000-8000-00000000aa01' and is_primary)),
  'the primary can be withdrawn');

select is(
  (select count(*)::integer from public.listing_media
    where listing_id = 'cc140000-0000-4000-8000-00000000aa01' and is_primary),
  1, 'and the next one takes its place: a listing with pictures always has a primary');

select is(
  (select count(*)::integer from app_private.public_listing_media(
     array['cc140000-0000-4000-8000-00000000aa01'::uuid])),
  3, 'the withdrawn one''s variants stop being served, and the remaining one''s do not');

-- ---------------------------------------------------------------------------------------------------
-- 7. Finding the listing by slug, which is the only way any surface addresses one
-- ---------------------------------------------------------------------------------------------------
-- The seller dashboard and the console both carry a slug and no identifier, so this resolver is what stands
-- between them and every function above. Its predicate is the same one, which is the property worth pinning:
-- somebody else's slug and a slug that does not exist give the same answer.
select is(
  app_private.listing_media_resolve(
    'cc140000-0000-4000-8000-000000000001', 'm-live'),
  'cc140000-0000-4000-8000-00000000aa01'::uuid,
  'the owner resolves their own live listing');

select is(
  app_private.listing_media_resolve(
    'cc140000-0000-4000-8000-000000000001', 'm-draft'),
  'cc140000-0000-4000-8000-00000000aa02'::uuid,
  'and their own draft, because a draft is where photographs are added');

select ok(
  app_private.listing_media_resolve(
    'cc140000-0000-4000-8000-000000000001', 'm-theirs') is null,
  'somebody else''s slug resolves to nothing');

select ok(
  app_private.listing_media_resolve(
    'cc140000-0000-4000-8000-000000000001', 'no-such-listing-at-all') is null,
  'and so does a slug that does not exist: one answer, so this cannot be used to ask whether a listing is there');

select ok(
  app_private.listing_media_resolve(
    'cc140000-0000-4000-8000-000000000009', 'm-live') is null,
  'an account with neither the storefront nor the key resolves nothing');

-- ---------------------------------------------------------------------------------------------------
-- 8. What the manager's reader says about publication
-- ---------------------------------------------------------------------------------------------------
-- A photograph added to a draft is stored unpublished and goes public with the listing. The screen that
-- uploaded it has to be able to say which state it is in, so the reader carries it.
--
-- A draft of its own, because section 4 published the other one on its way through.
select pg_temp.listing('cc140000-0000-4000-8000-00000000aa04', 'm-still-draft', 'cc140000-0000-4000-8000-000000000001', 'draft');
select is(
  (select outcome from app_private.listing_media_attach(
     'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa04',
     pg_temp.photo('cc140000-0000-4000-8000-00000000aa04', 'unpublished'))),
  'attached', 'a photograph attaches to a listing that is still a draft');

select is(
  (select count(distinct is_public)::integer
     from app_private.listing_media_for_manager(
       'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa04')),
  1, 'a draft''s variants all agree about publication');

select ok(
  not (select bool_or(is_public)
         from app_private.listing_media_for_manager(
           'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa04')),
  'and they are not published: the draft''s photographs are stored, not served');

select ok(
  (select bool_and(is_public)
     from app_private.listing_media_for_manager(
       'cc140000-0000-4000-8000-000000000001', 'cc140000-0000-4000-8000-00000000aa01')),
  'a live listing''s are, so the two states are distinguishable on the screen that manages them');

-- ---------------------------------------------------------------------------------------------------
-- 7. The claim this migration refuses to make
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.listing_media where metadata_stripped_at is not null),
  0, '**metadata_stripped_at is never set**: the stripping is a browser''s and this database cannot see it');

select finish();
rollback;
