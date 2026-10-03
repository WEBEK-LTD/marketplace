-- 0098 — The CMS media library: the bucket `cms_media` has always named, and the functions that fill it.
--
-- `public.cms_media` has existed since 0030 with its unique object path, its MIME and dimension constraints, its
-- alt-text bounds, its `updated_at` trigger and its two RLS policies. Its own comment states the design this
-- migration finally implements: *"Stored in the private `cms-media` bucket and served by signed URL (C15)."*
--
-- **The bucket did not exist.** 0012 registers seven and 0060 registers an eighth (`seller-media`); `cms-media`
-- was in none of them, while `cms_media_object_path_in_bucket` requires `object_path ~ '^cms-media/…'`. So every
-- row that table could hold named a bucket that was not there: nothing could be uploaded and nothing could be read.
-- Four closed increments already hand out a `cms-media/…` path that nothing can resolve — a page cover (0085), a
-- blog cover (0092), a per-entity share image (0091) and the default share image (0096) — and `banners` carries two
-- more columns and cannot start at all. This migration creates the bucket and the path to it.
--
-- **No table, column, constraint, index, trigger or policy of 0030 is created or changed.** The media schema is
-- 0030's and stays 0030's.
--
-- ---------------------------------------------------------------------------------------------------
-- THE OWNER DECISIONS THIS MIGRATION ENFORCES
-- ---------------------------------------------------------------------------------------------------
--
-- **1. The bucket is private, and gets no `storage.objects` policy.** That is 0012's architecture and 0030's own
-- stated design, not a choice made here: the one public bucket holds approved listing variants, and every other
-- object is reached through a short-lived API-issued signed URL (C15). 0012 raises if it finds a policy on
-- `storage.objects` that it did not itself define — *"bucket access must stay defined here and nowhere else"* — so
-- a private bucket is also the only shape a later migration can add without reopening it. 0012's own assertions
-- (one public bucket, one policy) stay true as written, and `storage_bucket_problems()` keeps returning nothing
-- because the bucket is registered in its contract table below. Staff previews use the existing generic
-- `signDownload(bucket, objectPath)` capability Phase 7-G added to the one storage port.
--
-- **2. SVG is excluded from the bucket.** 0030's `cms_media_mime_allowed` lists `image/svg+xml` and **is left
-- exactly as it is**; the bucket's `allowed_mime_types` is deliberately narrower, so the column keeps its value and
-- an SVG upload is refused before it is authorized. An SVG is a script container and site imagery has no need to
-- be one — the same reasoning, and the same four types, 0060 chose for `seller-media`.
--
-- **3. No request ever names a path.** Every component of an object path is the server's: the bucket name, a fresh
-- `gen_random_uuid()` and an extension derived from the content type this function validated. There is no
-- caller-supplied component, which makes traversal, a nested path and an escape out of the namespace
-- *unexpressible* rather than merely refused — and the attach below re-checks the whole shape anyway.
--
-- **4. Nothing public consumes this.** No function here is read by a public surface, and no public reader is added.
-- The library, its metadata, its usage, its deletion and a staff signed preview are the whole of it. Rendering a
-- cover, a share image, an `og:image`, a Twitter card or any structured data stays exactly where 0085, 0091, 0092,
-- 0095, 0096 and 0097 left it, and is a separate increment.
--
-- **5. A delete removes the row and nothing else.** The six referencing columns are `on delete set null` in 0030,
-- and that is the only thing that touches them: no statement here updates `pages`, `blog_posts`, `banners`,
-- `seo_settings` or `seo_metadata`. `cms_media_usage` exists so an operator is shown every reference *before* they
-- decide, rather than discovering afterwards which cover went blank.
--
-- **6. The size limit is 10 MiB**, on the bucket row, as a technical upload boundary. It is not a business rule and
-- nothing depends on its value; the authorizer reads it from the bucket rather than restating it, so the bucket row
-- is the single place it lives.
--
-- **7. Both alt texts are editable and neither is required.** 0030's 300-character bounds and its bilingual model
-- are untouched; D7 keeps Arabic optional throughout.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT A DELETE LEAVES BEHIND, STATED RATHER THAN HIDDEN
-- ---------------------------------------------------------------------------------------------------
--
-- Deleting a row removes the library entry. **The stored object stays in the bucket.** The storage port has three
-- calls — sign an upload, ask whether an object is there, sign a read — and no delete; inventing a fourth would be
-- adding unverified provider behaviour, which this increment is not the place for. The consequence is bounded and
-- safe: the bucket is private with no read policy, and `cms_media_read_target` will only sign a read for an object
-- a row still points at, so a deleted object becomes unreferenced **and** unreachable. Reclaiming the bytes is an
-- operations task, not a correctness one.
--
-- ---------------------------------------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------------------------------------
--
-- One seeded key, from 0033, pinned here as a literal, with 0003's own `requires_mfa` rule applied to the assurance
-- level as a parameter: `cms.media.manage`. 0033 seeds no `cms.media.read`, and none is invented, so whoever can
-- reach this surface may change it — the same one-key shape 0088's vocabularies and 0096's SEO settings have.
-- 0030's own `cms_media_admin_write` policy names exactly this key. No role name is tested anywhere in this file.
--
-- ---------------------------------------------------------------------------------------------------
-- AUDIT ATTRIBUTION
-- ---------------------------------------------------------------------------------------------------
--
-- These writers do **not** touch the 8-B attribution channel. 0030 gave `cms_media` an `updated_at` trigger and no
-- audit trigger, so the actor is recorded where 0030's own schema puts it: `uploaded_by` is a column of the row.
-- That is a property of 0030's schema and is not changed here.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS NOT HERE
-- ---------------------------------------------------------------------------------------------------
--
-- **No banner.** `public.banners` keeps its seeded keys and no functions: this increment makes a banner's media
-- possible and composing, placing and serving banners is its own scope.
--
-- **No second storage client, and no change to 0012.** The bucket row and the contract row are additive; 0012's
-- buckets, its one policy and its guard are untouched, and `listing-originals` and `listing-variants` are not read,
-- written or mentioned by any function below.
--
-- **No variant pipeline, no image processing, no moderation, no public exposure**, and nothing financial: no
-- function here reads a promotion, a placement, a wallet, a ledger, a payout, a payment, a settlement or any
-- `finance.*` setting.

-- ---------------------------------------------------------------------------------------------------
-- 1. The bucket
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise exception 'Supabase Storage is not installed in this database'
      using hint = 'Migration 0098 registers the cms-media bucket; it needs the storage schema.';
  end if;
end;
$$;

-- Private, like every bucket but the listing variants. 10 MiB, and the four raster types — SVG is excluded for the
-- reason 0060 gives for `seller-media`: an SVG is a script container.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cms-media', 'cms-media', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into app_private.storage_bucket_contract (bucket_id, must_be_public, purpose)
values ('cms-media', false, 'images used by CMS content; served through API-issued signed URLs, never publicly listed')
on conflict (bucket_id) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- 2. The permission predicate
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.cms_media_can_manage(
  p_user_id uuid,
  p_is_aal2 boolean
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
      join public.role_permissions rp on rp.role_key = r.key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
       and rp.permission_key = 'cms.media.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.cms_media_can_manage(uuid, boolean) is
  'Whether one account effectively holds cms.media.manage — the key as a literal, with 0003''s own requires_mfa rule applied to the assurance level as a parameter. The only key this cluster has: 0033 seeds no cms.media.read, so reading and changing the library are the same capability. No role name is tested anywhere.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The one place a content type becomes an extension
-- ---------------------------------------------------------------------------------------------------
-- Stated once, because the authorizer composes a path with it and the attach below re-derives it to check that the
-- recorded MIME type and the stored file name cannot disagree. Two copies would be two things to keep in step.
create or replace function app_private.cms_media_extension_for(p_content_type text)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select case p_content_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'image/avif' then 'avif'
  end;
$$;

comment on function app_private.cms_media_extension_for(text) is
  'The stored file extension for one allowed content type, or null for anything else. One copy, used to compose a path and to verify one, so a recorded MIME type and a stored file name cannot disagree. image/svg+xml is deliberately absent (owner decision 2).';

-- ---------------------------------------------------------------------------------------------------
-- 4. Authorizing one upload
-- ---------------------------------------------------------------------------------------------------
-- Outcomes:
--
--   * `authorized` — the caller may upload one object to the returned bucket and path. The path is new and nothing
--                    is recorded yet, because nothing has been uploaded yet.
--   * `not_found`  — the caller does not effectively hold the key. The same answer an absence gets everywhere on
--                    this surface, and it carries no reason.
--   * `invalid`    — the content type is not one the bucket allows, or the size is outside its limit.
--
-- The limits are the bucket's own, read from `storage.buckets` rather than restated, so the bucket row is the single
-- place the media rules live. A missing or unreadable bucket is `invalid`: authorizing an upload into a bucket whose
-- rules cannot be read would be authorizing an unbounded one.
create or replace function app_private.cms_media_upload_target(
  p_user_id uuid,
  p_is_aal2 boolean,
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
  v_bucket text := 'cms-media';
  v_limit bigint;
  v_allowed text[];
  v_extension text;
begin
  if not app_private.cms_media_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text, null::text, null::bigint;
    return;
  end if;

  select b.file_size_limit, b.allowed_mime_types into v_limit, v_allowed
    from storage.buckets b
   where b.id = v_bucket;

  if v_limit is null or v_allowed is null then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- The bucket decides what may be stored in it, which is how SVG is refused here without 0030's own column
  -- constraint being touched (owner decision 2).
  if p_content_type is null or not (p_content_type = any (v_allowed)) then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_limit then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  v_extension := app_private.cms_media_extension_for(p_content_type);
  if v_extension is null then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- Owner decision 3. Every component is the server's: the bucket name, a fresh random name and an extension
  -- derived from the validated type. Nothing from the request appears in the path. There is no per-caller
  -- namespace because this is one shared library rather than somebody's own storefront, which is the single way
  -- this differs from 0060's path.
  return query select
    'authorized'::text,
    v_bucket,
    v_bucket || '/' || gen_random_uuid()::text || '.' || v_extension,
    v_limit;
end;
$$;

comment on function app_private.cms_media_upload_target(uuid, boolean, text, bigint) is
  'Authorizes one CMS media upload and returns the object path to upload to. The path is derived entirely server-side from a fresh random name and an extension derived from the validated content type, so no request can choose a path or traverse out of the bucket. The size and type limits are read from the bucket row, not restated, which is how SVG is refused without changing 0030''s own column constraint. Writes nothing.';

-- ---------------------------------------------------------------------------------------------------
-- 5. Recording an upload that happened
-- ---------------------------------------------------------------------------------------------------
-- The "API confirms" half of the flow. The path must match the exact shape the authorizer issues, so the only
-- paths that can be recorded are ones this cluster could itself have handed out.
--
-- Outcomes: `attached`, `not_found`, `invalid`, `taken` (the path already has a row — 0030's unique index, reported
-- rather than raised, because a retried confirmation is a client's accident and not an error worth a 500).
create or replace function app_private.cms_media_attach(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_object_path text,
  p_mime_type text,
  p_byte_size bigint,
  p_width integer default null,
  p_height integer default null,
  p_alt_text_en text default null,
  p_alt_text_ar text default null
) returns table (
  outcome text,
  media_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bucket text := 'cms-media';
  v_limit bigint;
  v_allowed text[];
  v_extension text;
  v_tail text;
  v_new_id uuid;
begin
  if not app_private.cms_media_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  select b.file_size_limit, b.allowed_mime_types into v_limit, v_allowed
    from storage.buckets b
   where b.id = v_bucket;

  if v_limit is null or v_allowed is null then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  if p_mime_type is null or not (p_mime_type = any (v_allowed)) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_limit then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  v_extension := app_private.cms_media_extension_for(p_mime_type);
  if v_extension is null then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- The prefix is the bucket's own name and nothing else. A path for another bucket, or with anything before the
  -- prefix, cannot match it.
  if p_object_path is null or left(p_object_path, length(v_bucket) + 1) <> v_bucket || '/' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- And the remainder must be one plain file name of the shape the authorizer issues: a uuid and the extension the
  -- declared type implies. No slash, so nothing can be nested below the bucket; no dot-segment, so `..` is
  -- unrepresentable; no control character, no backslash, no encoded separator. The extension is compared against
  -- the one derived from `p_mime_type`, so a PNG cannot be recorded under a `.jpg` name or the other way round.
  v_tail := substr(p_object_path, length(v_bucket) + 2);
  if v_tail <> '' and v_tail !~ ('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.'
                                 || v_extension || '$') then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  if v_tail = '' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- 0030's unique index makes a second row for one object impossible; reported as an outcome rather than raised.
  if exists (select 1 from public.cms_media m where m.object_path = p_object_path) then
    return query select 'taken'::text, null::uuid;
    return;
  end if;

  -- Every remaining rule is 0030's: the dimensions must be positive or absent, the alt texts at most 300
  -- characters, and the MIME type one of its own allowed list. A blank alt text is stored as absent rather than as
  -- an empty string, so no surface could ever carry an empty `alt`.
  insert into public.cms_media (
    object_path, mime_type, width, height, byte_size, alt_text_en, alt_text_ar, uploaded_by
  )
  values (
    p_object_path,
    p_mime_type,
    p_width,
    p_height,
    p_byte_size,
    nullif(btrim(coalesce(p_alt_text_en, '')), ''),
    nullif(btrim(coalesce(p_alt_text_ar, '')), ''),
    p_user_id
  )
  returning id into v_new_id;

  return query select 'attached'::text, v_new_id;
end;
$$;

comment on function app_private.cms_media_attach(uuid, boolean, text, text, bigint, integer, integer, text, text) is
  'Records an uploaded CMS media object in the library. The path must lie in the cms-media bucket and match the exact shape cms_media_upload_target issues, with an extension that agrees with the declared MIME type, so no nested path, no traversal and no mislabelled file can be recorded. A path that already has a row is reported as taken. The actor is recorded in 0030''s own uploaded_by column.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Where one media row is used
-- ---------------------------------------------------------------------------------------------------
-- Owner decision 5, and the reason it exists: all six referencing columns are `on delete set null`, so removing a
-- row silently blanks a page cover, a blog cover, a banner image or a share image. An operator has to be able to
-- see that *before* deciding, not discover it afterwards.
--
-- Split in two: this inner function takes only the media id, so the staff list above can call it per row without
-- re-testing the permission for each one, and the staff-facing wrapper below applies the permission once. Neither
-- writes anything, and neither updates a referencing row — the `set null` is 0030's foreign key and stays the only
-- thing that touches them.
--
-- `entity_id` is null for `seo_settings`, whose primary key is a locale code rather than a uuid; `entity_label`
-- carries the human-recognisable part for every kind.
create or replace function app_private.cms_media_references(p_media_id uuid)
returns table (
  entity_type text,
  entity_id uuid,
  entity_label text,
  entity_column text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select 'page'::text, p.id, p.slug, 'cover_media_id'::text
    from public.pages p
   where p_media_id is not null and p.cover_media_id = p_media_id
  union all
  select 'blog_post'::text, b.id, b.slug, 'cover_media_id'::text
    from public.blog_posts b
   where p_media_id is not null and b.cover_media_id = p_media_id
  union all
  select 'banner'::text, n.id, n.banner_key, 'media_id'::text
    from public.banners n
   where p_media_id is not null and n.media_id = p_media_id
  union all
  select 'banner'::text, n.id, n.banner_key, 'media_ar_id'::text
    from public.banners n
   where p_media_id is not null and n.media_ar_id = p_media_id
  union all
  select 'seo_settings'::text, null::uuid, s.locale_code, 'default_share_media_id'::text
    from public.seo_settings s
   where p_media_id is not null and s.default_share_media_id = p_media_id
  union all
  select 'seo_metadata'::text, d.id, d.entity_type || ' · ' || d.locale_code, 'share_media_id'::text
    from public.seo_metadata d
   where p_media_id is not null and d.share_media_id = p_media_id
   order by 1, 4, 3;
$$;

comment on function app_private.cms_media_references(uuid) is
  'Every CMS row that points at one media entry, across all six of 0030''s referencing columns. Read-only and permission-free so the staff list can call it per row; the staff-facing wrapper applies the key. Nothing here writes to a referencing table.';

create or replace function app_private.cms_media_usage(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_media_id uuid
) returns table (
  entity_type text,
  entity_id uuid,
  entity_label text,
  entity_column text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.entity_type, r.entity_id, r.entity_label, r.entity_column
    from app_private.cms_media_references(p_media_id) r
   where app_private.cms_media_can_manage(p_user_id, p_is_aal2)
     and exists (select 1 from public.cms_media m where m.id = p_media_id);
$$;

comment on function app_private.cms_media_usage(uuid, boolean, uuid) is
  'Every CMS row that points at one media entry, for a caller holding cms.media.manage. No row for a caller without the key and none for a media entry that does not exist, so an absence and a refusal look alike (owner decision 5).';

-- ---------------------------------------------------------------------------------------------------
-- 7. The staff reader
-- ---------------------------------------------------------------------------------------------------
-- One page of the library, newest first. Keyset by `(created_at, id)` descending, which is total: `created_at` is
-- `not null` and `id` is the primary key, so the pair names exactly one row and a page is stable while the order
-- holds.
--
-- `usage_count` is how many of 0030's six referencing columns point at the row. It is on the list so an operator
-- can see at a glance which entries are in use, and `cms_media_usage` below says exactly where.
create or replace function app_private.cms_media_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 24
) returns table (
  media_id uuid,
  object_path text,
  mime_type text,
  width integer,
  height integer,
  byte_size bigint,
  alt_text_en text,
  alt_text_ar text,
  uploaded_by uuid,
  usage_count integer,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    m.id,
    m.object_path,
    m.mime_type,
    m.width,
    m.height,
    m.byte_size,
    m.alt_text_en,
    m.alt_text_ar,
    m.uploaded_by,
    (select count(*)::integer from app_private.cms_media_references(m.id)),
    m.created_at,
    m.updated_at
    from public.cms_media m
   where app_private.cms_media_can_manage(p_user_id, p_is_aal2)
     and (
       p_after_created_at is null
       or p_after_id is null
       or (m.created_at, m.id) < (p_after_created_at, p_after_id)
     )
   order by m.created_at desc, m.id desc
   limit greatest(coalesce(p_limit, 1), 1);
$$;

comment on function app_private.cms_media_for_staff(uuid, boolean, timestamptz, uuid, integer) is
  'One page of the CMS media library, newest first, with how many CMS rows point at each entry. No row at all for a caller without cms.media.manage. Keyset by (created_at, id), which is total, so a page is stable.';

-- ---------------------------------------------------------------------------------------------------
-- 8. What a signed preview is issued for
-- ---------------------------------------------------------------------------------------------------
-- The bucket and the path of one stored row, so a signed read is always for the one object that row points at. The
-- path is never composed here and never supplied by a browser: it comes out of the row the request named, which is
-- the rule Phase 7-G set when it added `signDownload` for the reviewer surface.
create or replace function app_private.cms_media_read_target(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_media_id uuid
) returns table (
  outcome text,
  bucket_id text,
  object_path text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_path text;
begin
  if not app_private.cms_media_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  select m.object_path into v_path from public.cms_media m where m.id = p_media_id;

  if v_path is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  return query select 'authorized'::text, 'cms-media'::text, v_path;
end;
$$;

comment on function app_private.cms_media_read_target(uuid, boolean, uuid) is
  'The bucket and object path of one stored media row, so a signed read is issued for exactly that object and nothing else. A caller without the key and a row that does not exist get the same neutral answer.';

-- ---------------------------------------------------------------------------------------------------
-- 9. The two writers that change a row
-- ---------------------------------------------------------------------------------------------------
-- Alt text only. Nothing else about a stored object is editable: the path, the type, the size and the dimensions
-- describe a file that has already been uploaded, and changing any of them would make the row disagree with the
-- bucket. Replacing an image means uploading another one.
create or replace function app_private.cms_media_alt_text_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_media_id uuid,
  p_alt_text_en text default null,
  p_alt_text_ar text default null
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if not app_private.cms_media_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.media.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Both are replaced on every call, so clearing one is sending it blank (owner decision 7); neither is required.
  update public.cms_media m
     set alt_text_en = nullif(btrim(coalesce(p_alt_text_en, '')), ''),
         alt_text_ar = nullif(btrim(coalesce(p_alt_text_ar, '')), '')
   where m.id = p_media_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.cms_media_alt_text_for_staff(uuid, boolean, uuid, text, text) is
  'Replaces one media entry''s English and Arabic alt text. Neither is required and a blank one is stored as absent, so no surface could carry an empty alt attribute. 0030''s 300-character bounds govern. Nothing else about a stored object is editable.';

-- Owner decision 5. The row and nothing else: no statement here touches a referencing table, and the `set null` on
-- all six columns is 0030's foreign key doing exactly what it has always done. The stored object stays in the
-- bucket, which the header explains.
create or replace function app_private.cms_media_delete_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_media_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deleted integer;
begin
  if not app_private.cms_media_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.media.manage is required' using errcode = 'insufficient_privilege';
  end if;

  delete from public.cms_media m where m.id = p_media_id;

  get diagnostics deleted = row_count;
  return deleted = 1;
end;
$$;

comment on function app_private.cms_media_delete_for_staff(uuid, boolean, uuid) is
  'Removes one media entry from the library, returning false when the id named nothing. Every reference to it becomes null through 0030''s own on-delete-set-null foreign keys and through nothing else; the console shows those references before the delete is offered. The stored object remains in the private bucket and becomes unreachable, because a signed read is only ever issued for an object a row still points at.';

-- ---------------------------------------------------------------------------------------------------
-- 10. Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.cms_media_can_manage(uuid, boolean) from public, app_worker;
revoke execute on function app_private.cms_media_extension_for(text) from public, app_worker;
revoke execute on function app_private.cms_media_upload_target(uuid, boolean, text, bigint) from public, app_worker;
revoke execute on function app_private.cms_media_attach(uuid, boolean, text, text, bigint, integer, integer, text, text) from public, app_worker;
revoke execute on function app_private.cms_media_for_staff(uuid, boolean, timestamptz, uuid, integer) from public, app_worker;
revoke execute on function app_private.cms_media_references(uuid) from public, app_worker;
revoke execute on function app_private.cms_media_usage(uuid, boolean, uuid) from public, app_worker;
revoke execute on function app_private.cms_media_read_target(uuid, boolean, uuid) from public, app_worker;
revoke execute on function app_private.cms_media_alt_text_for_staff(uuid, boolean, uuid, text, text) from public, app_worker;
revoke execute on function app_private.cms_media_delete_for_staff(uuid, boolean, uuid) from public, app_worker;

-- `app_system` only. The worker has no business with the media library: it uploads nothing on a schedule here and
-- reacts to no event this migration adds. No table privilege on `public.cms_media`, on `storage.buckets` or on
-- `storage.objects` is granted anywhere by this migration.
grant execute on function app_private.cms_media_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.cms_media_extension_for(text) to app_system;
grant execute on function app_private.cms_media_upload_target(uuid, boolean, text, bigint) to app_system;
grant execute on function app_private.cms_media_attach(uuid, boolean, text, text, bigint, integer, integer, text, text) to app_system;
grant execute on function app_private.cms_media_for_staff(uuid, boolean, timestamptz, uuid, integer) to app_system;
grant execute on function app_private.cms_media_references(uuid) to app_system;
grant execute on function app_private.cms_media_usage(uuid, boolean, uuid) to app_system;
grant execute on function app_private.cms_media_read_target(uuid, boolean, uuid) to app_system;
grant execute on function app_private.cms_media_alt_text_for_staff(uuid, boolean, uuid, text, text) to app_system;
grant execute on function app_private.cms_media_delete_for_staff(uuid, boolean, uuid) to app_system;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
