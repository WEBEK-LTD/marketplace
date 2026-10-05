-- 0060 — Seller profile media: authorizing an upload, and recording it (Phase 6-E).
--
-- The approved upload flow is the spec's, unchanged: **API issues a signed URL → browser uploads → API
-- confirms.** This migration owns the two halves that must not be decided anywhere else — *where* a seller
-- may upload, and *what* may then be recorded against their profile — and it owns them because neither can
-- be decided outside the database: `app_system` holds no table privileges, so nothing else can read the
-- caller's storefront to find out which namespace is theirs.
--
-- **The object path is derived here, in full, and never supplied.** The browser sends a media kind, a
-- content type and a byte size. It does not send a path, a bucket, a seller, a slug or a file name, and
-- there is no parameter below through which it could. The path is built from the caller's *own* slug —
-- read from their own row — plus a fresh `gen_random_uuid()`, so:
--
--   * traversal is impossible: no part of the path comes from the request;
--   * a cross-seller path is impossible: the slug is the one on the caller's row;
--   * overwriting is impossible: every target is a new random name, so an old object is never clobbered by
--     a new upload, and a signed URL for one upload cannot be replayed onto another's object.
--
-- The slug rather than the user id, deliberately. It is already public, it is immutable (6-D), and it keeps
-- the seller's uuid out of a path that is handed to a browser — which is the same rule 6-A settled when it
-- kept the identifier out of the identity projection.
--
-- **The limits are the bucket's own.** `allowed_mime_types` and `file_size_limit` are read from
-- `storage.buckets` rather than restated, so the bucket row created below is the single place the media
-- rules live. Change the bucket and the authorization changes with it; there is no second list to forget.
--
-- **The bucket is private, and that is 0012's rule, not a choice made here.** The approved storage
-- architecture says the one public bucket holds approved listing variants only, so seller media is reached
-- the way every other private object is: a short-lived API-issued signed URL (C15). The bucket is registered
-- in 0012's contract table, so `storage_bucket_problems()` still returns nothing, and it gets no
-- `storage.objects` policy, which leaves 0012's own assertions — one public bucket, one policy — true as
-- written.
--
-- **What is not here.** No media table: `seller_profiles.logo_object_path` and `banner_object_path` already
-- exist and are the storage model this project chose, so a second one would be a second thing to reconcile.
-- No variant pipeline, no listing media, no deletion, no bucket management, no moderation, no approval, no
-- public exposure, and nothing that changes a seller's state.

-- ---------------------------------------------------------------------------------------------------
-- The bucket
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise exception 'Supabase Storage is not installed in this database'
      using hint = 'Migration 0060 registers the seller-media bucket; it needs the storage schema.';
  end if;
end;
$$;

-- Private, like every bucket but the listing variants. The size and the types are the same shape 0030 chose
-- for its own image bucket, minus SVG: an SVG is a script container, and a storefront logo has no need to be
-- one.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('seller-media', 'seller-media', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into app_private.storage_bucket_contract (bucket_id, must_be_public, purpose)
values ('seller-media', false, 'seller storefront logo and banner; served through API-issued signed URLs, never publicly listed')
on conflict (bucket_id) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Authorizing one upload
-- ---------------------------------------------------------------------------------------------------
-- Outcomes:
--
--   * `authorized`    — the caller may upload one object to the returned bucket and path. The path is new
--                       and belongs to them; nothing is written to their profile yet, because nothing has
--                       been uploaded yet.
--   * `not_found`     — the caller has no storefront.
--   * `not_editable`  — the storefront is suspended or closed. No reason is given, exactly as 0059 gives
--                       none: a seller cannot obtain mutation authorization in those states.
--   * `invalid`       — the media kind is not one of the two, or the content type or size is outside what
--                       the bucket allows.
create or replace function app_private.seller_media_upload_target(
  p_user_id uuid,
  p_media_kind text,
  p_content_type text,
  p_byte_size bigint
) returns table (
  outcome text,
  bucket_id text,
  object_path text,
  max_byte_size bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_slug text;
  v_status text;
  v_bucket text := 'seller-media';
  v_limit bigint;
  v_allowed text[];
  v_extension text;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- The caller's own storefront, and the state gate. Read first, so a suspended seller gets the same answer
  -- whatever they asked for.
  select s.slug, s.status into v_slug, v_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_slug is null then
    return query select 'not_found'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if v_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- Two kinds, because `seller_profiles` holds two paths. Nothing else is uploadable through this function.
  if p_media_kind is null or p_media_kind not in ('logo', 'banner') then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- The bucket is the authority on what may be stored in it.
  select b.file_size_limit, b.allowed_mime_types into v_limit, v_allowed
    from storage.buckets b
   where b.id = v_bucket;

  if v_limit is null or v_allowed is null then
    -- The bucket is missing or misconfigured. Refusing is the only safe answer: authorizing an upload into
    -- a bucket whose rules cannot be read would be authorizing an unbounded one.
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  if p_content_type is null or not (p_content_type = any (v_allowed)) then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_limit then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- The extension follows from the content type, so the stored name cannot disagree with what was declared.
  v_extension := case p_content_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'image/avif' then 'avif'
  end;
  if v_extension is null then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- Every component is the server's: the bucket name, the caller's own slug, the kind this function
  -- validated, a fresh random name and an extension derived from the validated type. Nothing from the
  -- request appears in the path, which is what makes traversal and cross-seller paths unexpressible rather
  -- than merely refused.
  return query select
    'authorized'::text,
    v_bucket,
    v_bucket || '/' || v_slug || '/' || p_media_kind || '/' || gen_random_uuid()::text || '.' || v_extension,
    v_limit;
end;
$$;
comment on function app_private.seller_media_upload_target(uuid, text, text, bigint) is
  'Authorizes one seller media upload and returns the object path to upload to. The path is derived entirely server-side from the caller''s own slug, the validated media kind and a fresh random name, so no request can choose a path, traverse out of its namespace or reach another seller''s. The size and type limits are read from the bucket row, not restated. A suspended or closed storefront is refused without a reason. Writes nothing.';

-- ---------------------------------------------------------------------------------------------------
-- Recording an upload that happened
-- ---------------------------------------------------------------------------------------------------
-- The "API confirms" half of the approved flow. The path is checked against the caller's *own* namespace
-- before it is stored, so the only paths a seller can attach are ones this function could itself have
-- issued to them.
--
-- Outcomes: `attached`, `not_found`, `not_editable`, `invalid`.
create or replace function app_private.seller_media_attach(
  p_user_id uuid,
  p_media_kind text,
  p_object_path text
) returns table (
  outcome text,
  has_logo boolean,
  has_banner boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_slug text;
  v_status text;
  v_expected_prefix text;
  v_tail text;
  v_logo boolean;
  v_banner boolean;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::boolean, null::boolean;
    return;
  end if;

  select s.slug, s.status into v_slug, v_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_slug is null then
    return query select 'not_found'::text, null::boolean, null::boolean;
    return;
  end if;
  if v_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::boolean, null::boolean;
    return;
  end if;

  if p_media_kind is null or p_media_kind not in ('logo', 'banner') then
    return query select 'invalid'::text, null::boolean, null::boolean;
    return;
  end if;

  -- The prefix is rebuilt from the caller's own slug and the validated kind. A path for another seller, for
  -- the other kind, for another bucket, or with anything before the prefix, cannot match it.
  v_expected_prefix := 'seller-media/' || v_slug || '/' || p_media_kind || '/';
  if p_object_path is null or left(p_object_path, length(v_expected_prefix)) <> v_expected_prefix then
    return query select 'invalid'::text, null::boolean, null::boolean;
    return;
  end if;

  -- And the remainder must be one plain file name of the shape this function issues: a uuid and one of the
  -- four extensions. No slash, so nothing can be nested below the namespace; no dot-segment, so `..` is
  -- unrepresentable; no control character, no backslash, no encoded separator.
  v_tail := substr(p_object_path, length(v_expected_prefix) + 1);
  if v_tail !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|avif)$' then
    return query select 'invalid'::text, null::boolean, null::boolean;
    return;
  end if;

  -- Exactly one column, chosen by the validated kind. No other column of `seller_profiles` appears in this
  -- statement, so recording a logo cannot change a status, a slug, a verification state or anything else.
  if p_media_kind = 'logo' then
    update public.seller_profiles as s
       set logo_object_path = p_object_path
     where s.user_id = p_user_id
    returning s.logo_object_path is not null, s.banner_object_path is not null
      into v_logo, v_banner;
  else
    update public.seller_profiles as s
       set banner_object_path = p_object_path
     where s.user_id = p_user_id
    returning s.logo_object_path is not null, s.banner_object_path is not null
      into v_logo, v_banner;
  end if;

  if v_logo is null then
    return query select 'not_found'::text, null::boolean, null::boolean;
    return;
  end if;

  -- Whether each kind is now set, and nothing else. The paths themselves are not returned: the caller
  -- already knows the one it just uploaded, and the other is none of its business.
  return query select 'attached'::text, v_logo, v_banner;
end;
$$;
comment on function app_private.seller_media_attach(uuid, text, text) is
  'Records an uploaded seller media object against the calling account''s own profile, setting only logo_object_path or banner_object_path. The path must lie in the caller''s own namespace and match the exact shape seller_media_upload_target issues, so no other seller''s object, no nested path and no traversal can be attached. A suspended or closed storefront is refused without a reason. Returns only whether each kind is now set.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- S8 unchanged: named functions, PUBLIC revoked, `app_system` only. `authenticated` gains nothing, `anon`
-- gains nothing, and no table privilege — on `public.seller_profiles`, on `storage.buckets` or on
-- `storage.objects` — is granted anywhere by this migration.
revoke execute on function app_private.seller_media_upload_target(uuid, text, text, bigint) from public;
grant execute on function app_private.seller_media_upload_target(uuid, text, text, bigint) to app_system;
revoke execute on function app_private.seller_media_attach(uuid, text, text) from public;
grant execute on function app_private.seller_media_attach(uuid, text, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds, the new bucket included
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
