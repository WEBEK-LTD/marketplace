-- 0114 — Listing photographs: the functions that finally fill the tables 0011 built.
--
-- `public.listing_media` and `public.media_variants` have existed since 0011, with their kinds, their
-- statuses, their dimension rules and their publication gate. `listing-originals` and `listing-variants`
-- have existed since 0012, the second of them public with a read policy that names it and nothing else. In
-- every phase since, no row has ever been written to either table: there was no way in. A marketplace for
-- property whose catalogue cannot show a photograph is not finished, and this is the missing path.
--
-- **No schema is created or changed here.** Not a table, not a column, not a constraint, not an index, not a
-- trigger, not a policy, not a bucket. Every rule this file appears to apply is 0011's or 0012's; the
-- functions below are the first callers of them.
--
-- ---------------------------------------------------------------------------------------------------
-- HOW AN IMAGE BECOMES A PHOTOGRAPH ON THE SITE, AND WHERE THE METADATA GOES
-- ---------------------------------------------------------------------------------------------------
--
-- The owner's decision, taken on the alternatives: **the browser produces the web-sized images.** It draws
-- the chosen file into a canvas at each width and re-encodes it as WebP, and that re-encode is what removes
-- the metadata — a canvas holds pixels and nothing else, so the bytes it produces carry no EXIF, no XMP and
-- no GPS. For property this is not a nicety: a photograph of a flat taken on a telephone carries the
-- coordinates of the flat, and publishing that is publishing somebody's address.
--
-- The alternative was a server-side image library. It is the stronger guarantee — the server would see the
-- bytes — and it costs a new native dependency with an install script, which this repository's policy blocks
-- without an owner decision, and an increment of its own before a single photograph appeared. The owner
-- chose the browser.
--
-- **What that means for `metadata_stripped_at`, stated plainly: this migration never sets it.** The column
-- stays null, because the only honest value is one the database can stand behind, and the stripping happens
-- in a browser this function cannot see. A timestamp here would be a record of somebody else's promise. The
-- residual risk is recorded rather than papered over: a caller who bypasses the console and uploads to their
-- own signed target by hand could publish an image with its metadata intact. Closing that needs a byte-level
-- check on the server, which needs a storage read the port does not have — a later increment, and the
-- column is waiting for it.
--
-- **Only `image/webp` may be uploaded through this path**, which is narrower than the bucket allows. The
-- browser's canvas produces WebP; nothing else needs to. Refusing the other two formats the bucket accepts
-- costs nothing and removes two shapes nobody meant to send.
--
-- **Four objects per photograph: one original and three variants.** The browser produces all four, so all
-- four are metadata-free; the original is the largest rendering and goes to the private `listing-originals`,
-- the three sizes the catalogue serves go to the public `listing-variants`.
--
-- The original is not a copy kept out of habit. 0011 requires one — `listing_media_source_matches_kind` says
-- an image row carries an `original_object_path` — and `tg_media_variants_rule` refuses a variant that
-- *points at* it, so the original cannot simply be one of the three. Keeping it also leaves a server-side
-- pipeline something to re-process from if one is ever added, which is the increment this design defers.
-- What is **not** kept is the camera's file: the thing the browser uploads as the original is already the
-- canvas's output, so nothing with GPS in it reaches the platform at all.
--
-- **A variant is published when the listing is, and not before.** 0011's `tg_media_variants_rule` refuses a
-- public variant on a listing that is not visible, which is the right rule and is why attaching to a draft
-- stores the variants unpublished. 0011 wrote the other direction of that rule into
-- `tg_listings_status_change` — a withdrawal unpublishes every variant — and left the publishing direction
-- to the processing step it expected. There is no processing step, so §6 adds the missing half to that same
-- trigger: a listing that becomes visible publishes the variants of its ready photographs. It is the
-- symmetric branch of a rule already half-written, in the place the other half lives.
--
-- ---------------------------------------------------------------------------------------------------
-- WHO MAY DO IT
-- ---------------------------------------------------------------------------------------------------
--
-- The listing's own seller, while the listing is theirs — the same test `seller_listing_update_draft`
-- applies, by the same predicate — and staff holding `catalog.listing.moderate`, which 0033 seeds and which
-- the office holds. Both are needed: a seller photographs their own property, and under OD-A4 the office
-- handles the listing and will often be the one doing it. **No key is invented.**
--
-- Unlike a draft's text, a photograph may be added to a listing that is already published. A seller who has
-- taken a better picture should not have to unpublish to use it, and an office correcting a wrong photograph
-- on a live listing is the case that matters most.

-- ---------------------------------------------------------------------------------------------------
-- 1. Who may manage one listing's photographs
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.listing_media_can_manage(
  p_user_id uuid,
  p_listing_id uuid,
  p_is_aal2 boolean default false
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_user_id is not null and p_listing_id is not null and (
    -- The listing's own seller, whose storefront is in a state that may be edited. The same two predicates
    -- `seller_listing_update_draft` applies, asked together.
    exists (
      select 1
        from public.listings l
        join public.seller_profiles s on s.user_id = l.seller_user_id
       where l.id = p_listing_id
         and l.seller_user_id = p_user_id
         and s.status in ('pending', 'active')
    )
    -- Or staff who may moderate the catalogue. 0033 seeds this key; nothing here invents one. The platform's
    -- own `requires_mfa` rule is applied to the assurance level as a parameter, exactly as every other
    -- permission test in this repository does it.
    or exists (
      select 1
        from public.user_roles ur
        join public.roles r on r.key = ur.role_key
        join public.role_permissions rp on rp.role_key = r.key
       where ur.user_id = p_user_id
         and ur.revoked_at is null
         and (ur.expires_at is null or ur.expires_at > now())
         and rp.permission_key = 'catalog.listing.moderate'
         and (not r.requires_mfa or coalesce(p_is_aal2, false))
    )
  );
$$;

comment on function app_private.listing_media_can_manage(uuid, uuid, boolean) is
  'Whether one account may manage one listing''s photographs: the listing''s own seller with a storefront in an editable state, or staff effectively holding catalog.listing.moderate under 0003''s requires_mfa rule. Both keys are 0033''s and no role name is tested. Reads nothing else and writes nothing.';

-- **Finding the listing in the first place.** Every function below takes a listing identifier, and no
-- surface above them has one: the seller's own dashboard is addressed entirely by slug — 0048's
-- `SellerListingSchema` carries "no identifier of any kind" on purpose — and the console reaches a listing
-- the same way. So this resolves a slug to the identifier the rest of this file needs, and it is gated by the
-- same predicate: a slug belonging to somebody else's listing resolves to nothing, exactly as if it did not
-- exist. That keeps the identifier out of every contract without putting the authorization in the API.
create or replace function app_private.listing_media_resolve(
  p_user_id uuid,
  p_slug text,
  p_is_aal2 boolean default false
) returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select l.id
    from public.listings l
   where l.slug = p_slug
     and l.deleted_at is null
     and app_private.listing_media_can_manage(p_user_id, l.id, p_is_aal2)
   limit 1;
$$;

comment on function app_private.listing_media_resolve(uuid, text, boolean) is
  'One listing''s identifier from its slug, but only for an account that may manage its photographs. Null for everybody else and for a slug that does not exist — one answer, so this cannot be used to ask whether somebody else''s listing is there. Exists so the seller and console surfaces stay addressed by slug, as 0048 decided, without moving the authorization out of the database.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The upload target
-- ---------------------------------------------------------------------------------------------------
-- 0060's `seller_media_upload_target`, applied to a listing. Every component of the path is the server's:
-- the bucket name, the listing's own identifier, a fresh random name and an extension derived from the
-- validated type. Nothing from the request appears in it, which is what makes traversal and cross-listing
-- paths unexpressible rather than merely refused.
--
-- The variant key travels into the path so an operator reading the bucket can see which size an object is,
-- and it is validated against the set below rather than taken as given.
create or replace function app_private.listing_media_upload_target(
  p_user_id uuid,
  p_listing_id uuid,
  p_variant_key text,
  p_content_type text,
  p_byte_size bigint,
  p_is_aal2 boolean default false
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
  v_bucket text;
  v_limit bigint;
  v_allowed text[];
begin
  if not app_private.listing_media_can_manage(p_user_id, p_listing_id, p_is_aal2) then
    return query select 'not_found'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- The three widths the catalogue asks for, and the original it keeps. A set rather than a free string,
  -- because the key is part of a stored path and part of a unique constraint.
  if p_variant_key is null or p_variant_key not in ('original', 'thumb', 'card', 'full') then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- **The original goes to the private bucket and the three sizes to the public one.** That separation is
  -- 0012's, and routing by the validated key rather than by anything in the request is what keeps a caller
  -- from asking for a public path for something meant to stay private.
  v_bucket := case when p_variant_key = 'original' then 'listing-originals' else 'listing-variants' end;

  -- The bucket is the authority on what may be stored in it.
  select b.file_size_limit, b.allowed_mime_types into v_limit, v_allowed
    from storage.buckets b
   where b.id = v_bucket;

  if v_limit is null or v_allowed is null then
    -- Authorizing an upload into a bucket whose rules cannot be read would be authorizing an unbounded one.
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- **WebP only**, which is narrower than the bucket's three. See the header: the browser's canvas produces
  -- WebP, and the formats nobody means to send are the ones worth refusing.
  if p_content_type is distinct from 'image/webp' or not (p_content_type = any (v_allowed)) then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_limit then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  return query select
    'authorized'::text,
    v_bucket,
    v_bucket || '/' || p_listing_id::text || '/' || p_variant_key || '/'
      || gen_random_uuid()::text || '.webp',
    v_limit;
end;
$$;

comment on function app_private.listing_media_upload_target(uuid, uuid, text, text, bigint, boolean) is
  'Authorizes one listing photograph upload and returns the object path to upload to. The key routes the bucket: original to the private listing-originals, thumb/card/full to the public listing-variants. The path is derived entirely server-side from the bucket, the listing''s identifier, the validated key and a fresh random name, so no request can choose a path, reach another listing''s, or ask for a public path for a private object. WebP only, which is narrower than either bucket allows. The size limit is read from the bucket row, not restated. Writes nothing.';

-- ---------------------------------------------------------------------------------------------------
-- 3. Attaching the uploaded variants as one photograph
-- ---------------------------------------------------------------------------------------------------
-- One call per photograph, carrying its three variants. One call rather than four because a photograph with
-- two of its three sizes is not a photograph the catalogue can show: the card would have a size the detail
-- page does not, and a half-written set would be a state every reader has to handle. One transaction, three
-- variant rows, or nothing.
--
-- **The caller declares the dimensions and this function checks what it can.** 0011's own constraints require
-- them positive; this adds that the three widths are distinct and ordered, which is what makes them three
-- sizes rather than the same image three times. What it cannot check is that the bytes at the path have those
-- dimensions — that needs a byte read, and the service confirms the object exists before calling this.
--
-- `status` is `ready` and the variants are published immediately. There is no processing step to wait for:
-- the images arrive finished. `published_at` is set because `media_variants_public_has_time` requires it.
create or replace function app_private.listing_media_attach(
  p_user_id uuid,
  p_listing_id uuid,
  p_variants jsonb,
  p_is_aal2 boolean default false
) returns table (outcome text, media_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_media_id uuid;
  v_count integer;
  v_position integer;
  v_is_first boolean;
  v_entry jsonb;
  v_key text;
  v_prefix text;
  v_visible boolean;
  v_original text;
begin
  if not app_private.listing_media_can_manage(p_user_id, p_listing_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  if p_variants is null or jsonb_typeof(p_variants) <> 'array' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- Exactly the four keys, once each. Checked as a set so the order they arrive in does not matter.
  select count(*) into v_count from jsonb_array_elements(p_variants);
  if v_count <> 4 then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  if (select count(distinct e ->> 'variant_key') from jsonb_array_elements(p_variants) e) <> 4
     or exists (
       select 1 from jsonb_array_elements(p_variants) e
        where coalesce(e ->> 'variant_key', '') not in ('original', 'thumb', 'card', 'full')
     ) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- Every path must be one this function's own authorizer could have issued for this listing, in the bucket
  -- that key belongs to. A path under the wrong bucket, outside the listing's own prefix, or carrying a
  -- traversal is refused outright rather than stored and served.
  for v_entry in select e from jsonb_array_elements(p_variants) e loop
    v_key := v_entry ->> 'variant_key';
    v_prefix := case when v_key = 'original' then 'listing-originals/' else 'listing-variants/' end
      || p_listing_id::text || '/' || v_key || '/';
    if coalesce(v_entry ->> 'object_path', '') not like v_prefix || '%'
       or v_entry ->> 'object_path' like '%..%'
       or coalesce(v_entry ->> 'object_path', '') !~ '\.webp$' then
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
    if coalesce((v_entry ->> 'width')::integer, 0) <= 0
       or coalesce((v_entry ->> 'height')::integer, 0) <= 0
       or coalesce((v_entry ->> 'byte_size')::bigint, 0) <= 0 then
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
  end loop;

  -- Three distinct widths among the served sizes, ascending with the key. Three copies of one size is not
  -- three sizes, and the catalogue picks by key expecting the smaller one to be smaller. The original is
  -- outside this check: it is not a served size and may legitimately be any width at or above the largest.
  if (select count(distinct (e ->> 'width')::integer) from jsonb_array_elements(p_variants) e
       where e ->> 'variant_key' <> 'original') <> 3
     or (select (e ->> 'width')::integer from jsonb_array_elements(p_variants) e
          where e ->> 'variant_key' = 'thumb')
        >= (select (e ->> 'width')::integer from jsonb_array_elements(p_variants) e
             where e ->> 'variant_key' = 'card')
     or (select (e ->> 'width')::integer from jsonb_array_elements(p_variants) e
          where e ->> 'variant_key' = 'card')
        >= (select (e ->> 'width')::integer from jsonb_array_elements(p_variants) e
             where e ->> 'variant_key' = 'full') then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- Where it goes in the order, and whether it is the first photograph this listing has. The first one is
  -- the primary: a listing's first picture is the one the card shows, and nobody should have to say so.
  select coalesce(max(m.position), -1) + 1, count(*) = 0
    into v_position, v_is_first
    from public.listing_media m
   where m.listing_id = p_listing_id;

  -- **Whether the variants may be public yet.** 0011's `tg_media_variants_rule` refuses a public variant
  -- on a listing that is not visible, so this is asked rather than assumed: a photograph added to a draft
  -- is stored unpublished and goes public with the listing (§6).
  v_visible := public.listing_is_visible(p_listing_id);

  select e ->> 'object_path' into v_original
    from jsonb_array_elements(p_variants) e
   where e ->> 'variant_key' = 'original';

  insert into public.listing_media (
    listing_id, kind, original_object_path, status, position, is_primary, content_type,
    byte_size, width, height, published_at
  )
  select
    p_listing_id, 'image',
    v_original, 'ready', v_position, v_is_first, 'image/webp',
    (e ->> 'byte_size')::bigint, (e ->> 'width')::integer, (e ->> 'height')::integer,
    case when v_visible then now() end
    from jsonb_array_elements(p_variants) e
   where e ->> 'variant_key' = 'full'
  returning id into v_media_id;

  -- The three served sizes. The original is not one of them: it is the row's `original_object_path`, and
  -- `tg_media_variants_rule` would refuse a variant pointing at it.
  insert into public.media_variants (
    listing_media_id, variant_key, format, object_path, width, height, byte_size, is_public, published_at
  )
  select v_media_id, e ->> 'variant_key', 'webp', e ->> 'object_path',
         (e ->> 'width')::integer, (e ->> 'height')::integer, (e ->> 'byte_size')::bigint,
         v_visible, case when v_visible then now() end
    from jsonb_array_elements(p_variants) e
   where e ->> 'variant_key' <> 'original';

  return query select 'attached'::text, v_media_id;
end;
$$;

comment on function app_private.listing_media_attach(uuid, uuid, jsonb, boolean) is
  'Records one listing photograph — its private original and its three WebP variants — in one transaction. Refuses a set that is not exactly original, thumb, card and full; a path outside the bucket and prefix its key belongs to; a non-WebP path; and widths that are not three distinct ascending sizes. The variants are public only if the listing is already visible, which is 0011''s own rule; a photograph added to a draft goes public with the listing. The first photograph a listing gets is its primary. metadata_stripped_at is deliberately left null: the stripping happens in the browser''s canvas and this function cannot see the bytes.';

-- ---------------------------------------------------------------------------------------------------
-- 4. Reordering, choosing the primary, and removing
-- ---------------------------------------------------------------------------------------------------
-- `withdrawn` rather than deleted, which is 0011's own status and the honest one: the object is still in a
-- public bucket, so a row claiming the photograph is gone would be claiming more than the platform did.
create or replace function app_private.listing_media_withdraw(
  p_user_id uuid,
  p_listing_id uuid,
  p_media_id uuid,
  p_is_aal2 boolean default false
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_was_primary boolean;
begin
  if not app_private.listing_media_can_manage(p_user_id, p_listing_id, p_is_aal2) then
    return false;
  end if;

  -- **Read before the write.** `returning is_primary` would hand back the *new* value — false, which this
  -- statement has just set — so the promotion below would never run and a listing could be left with
  -- photographs and no primary. A test caught exactly that.
  select m.is_primary into v_was_primary
    from public.listing_media m
   where m.id = p_media_id and m.listing_id = p_listing_id and m.status <> 'withdrawn';

  if v_was_primary is null then
    return false;
  end if;

  update public.listing_media
     set status = 'withdrawn', withdrawn_at = now(), is_primary = false
   where id = p_media_id and listing_id = p_listing_id and status <> 'withdrawn';

  -- A withdrawn variant is no longer public. `media_variants_removed_is_not_public` requires the two to
  -- move together, so they do.
  update public.media_variants
     set is_public = false, removed_at = now()
   where listing_media_id = p_media_id and removed_at is null;

  -- A listing is never left with photographs and no primary: the next one in order takes it.
  if coalesce(v_was_primary, false) then
    update public.listing_media
       set is_primary = true
     where id = (
       select m.id from public.listing_media m
        where m.listing_id = p_listing_id and m.status = 'ready'
        order by m.position, m.id
        limit 1
     );
  end if;

  return true;
end;
$$;

comment on function app_private.listing_media_withdraw(uuid, uuid, uuid, boolean) is
  'Withdraws one listing photograph and unpublishes its variants together, which 0011''s own constraint requires. Withdrawn rather than deleted, because the object is still in a public bucket. When the primary is withdrawn the next photograph in order becomes primary, so a listing with pictures always has one.';

create or replace function app_private.listing_media_set_primary(
  p_user_id uuid,
  p_listing_id uuid,
  p_media_id uuid,
  p_is_aal2 boolean default false
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not app_private.listing_media_can_manage(p_user_id, p_listing_id, p_is_aal2) then
    return false;
  end if;

  -- A withdrawn photograph cannot become the one the card shows.
  if not exists (
    select 1 from public.listing_media m
     where m.id = p_media_id and m.listing_id = p_listing_id and m.status = 'ready'
  ) then
    return false;
  end if;

  update public.listing_media set is_primary = (id = p_media_id) where listing_id = p_listing_id;
  return true;
end;
$$;

comment on function app_private.listing_media_set_primary(uuid, uuid, uuid, boolean) is
  'Makes one of a listing''s photographs the one the card shows, and the others not, in one statement so the listing is never without a primary or with two. A withdrawn photograph is refused.';

-- ---------------------------------------------------------------------------------------------------
-- 5. Reading them — for the owner, and for the public
-- ---------------------------------------------------------------------------------------------------
-- Dropped first, and only this one. `create or replace` cannot change the row type a `returns table`
-- function declares, and this one gained `is_public` after it was first written. A fresh database makes the
-- drop a no-op; a database that already has the earlier shape gets the new one instead of an error, which is
-- what keeps this file re-runnable. Nothing depends on the function, so there is nothing to cascade.
drop function if exists app_private.listing_media_for_manager(uuid, uuid, boolean);

create function app_private.listing_media_for_manager(
  p_user_id uuid,
  p_listing_id uuid,
  p_is_aal2 boolean default false
) returns table (
  media_id uuid,
  media_position integer,
  is_primary boolean,
  status text,
  variant_key text,
  object_path text,
  width integer,
  height integer,
  -- Whether this variant is published. A photograph added to a draft is stored unpublished and goes public
  -- with the listing (§6), so the screen that manages one has to be able to say which state it is in —
  -- otherwise "I uploaded it and the page does not show it" has no answer on the screen that caused it.
  is_public boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select m.id, m.position, m.is_primary, m.status, v.variant_key, v.object_path, v.width, v.height,
         v.is_public
    from public.listing_media m
    join public.media_variants v on v.listing_media_id = m.id and v.removed_at is null
   where m.listing_id = p_listing_id
     and m.status <> 'withdrawn'
     and app_private.listing_media_can_manage(p_user_id, p_listing_id, p_is_aal2)
   order by m.position, m.id, v.width;
$$;

comment on function app_private.listing_media_for_manager(uuid, uuid, boolean) is
  'One listing''s photographs and their variants, for whoever may manage them, with each variant''s published state so a draft''s unpublished pictures can be told apart. Withdrawn photographs are absent. No row at all for anybody else, by a predicate rather than an error.';

-- The public reader. **It takes an array of listing identifiers** so a page of twenty-four cards costs one
-- round trip rather than twenty-four, and it applies the same visibility predicates the catalogue readers
-- do — a photograph of a listing nobody may see is not served because that listing is not served.
create or replace function app_private.public_listing_media(p_listing_ids uuid[])
returns table (
  listing_id uuid,
  media_id uuid,
  media_position integer,
  is_primary boolean,
  variant_key text,
  object_path text,
  width integer,
  height integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select m.listing_id, m.id, m.position, m.is_primary, v.variant_key, v.object_path, v.width, v.height
    from public.listing_media m
    join public.listings l on l.id = m.listing_id
    join public.media_variants v on v.listing_media_id = m.id
   where m.listing_id = any (coalesce(p_listing_ids, '{}'::uuid[]))
     and m.status = 'ready'
     -- Published, and still published. `is_public` is the gate 0011 defined for exactly this.
     and v.is_public
     and v.removed_at is null
     -- The catalogue's own two visibility predicates, so this reader can never show a photograph of
     -- something the catalogue itself would not show.
     and public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
   order by m.listing_id, m.position, m.id, v.width;
$$;

comment on function app_private.public_listing_media(uuid[]) is
  'The published photographs of the listings named, with their public variants, for anybody. Takes an array so a page of cards costs one round trip. Applies the catalogue''s own two visibility predicates, so a photograph of a listing the catalogue would not show is never served. Variants that were withdrawn or never published are absent.';

-- ---------------------------------------------------------------------------------------------------
-- 6. The missing half of 0011's publication rule
-- ---------------------------------------------------------------------------------------------------
-- **This redefines one 0011 function, and only to add the branch that was always missing.**
--
-- 0011 wrote half a rule. `tg_media_variants_rule` refuses a public variant on a listing that is not
-- visible; `tg_listings_status_change` unpublishes every variant when a listing stops being public. What it
-- never did was the opposite: publish them when a listing *starts* being public. That was not an oversight
-- in 0011 — it expected a processing step to create the variants after approval, so there was nothing to
-- publish at the moment of approval. The owner's decision removes that step: the variants exist before
-- approval, which is exactly the case 0011 did not have.
--
-- Without this branch a photograph added to a draft would be stored, correctly refused publication, and then
-- stay unpublished for ever — the listing would go live with pictures nobody can see.
--
-- **Everything else in the function is byte-for-byte 0011's.** The history row, the three outbox events and
-- their payloads, the withdrawal branch and its unpublishing are unchanged; the `is_public and not
-- was_public` branch gains four lines and nothing else moves. It is restated in full because that is what
-- `create or replace` requires, not because any of it is being revised.
create or replace function app_private.tg_listings_status_change() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  was_public boolean := tg_op = 'UPDATE' and public.listing_status_is_public(old.status);
  is_public boolean := public.listing_status_is_public(new.status);
begin
  insert into public.listing_status_history (listing_id, from_status, to_status, changed_by)
  values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, public.current_user_id());

  if is_public and not was_public then
    -- **0114's addition.** The photographs attached while this listing was a draft become public with it.
    -- Only the variants of photographs that are `ready`, and only ones not already withdrawn, so a
    -- withdrawn picture is not resurrected by a republication.
    update public.media_variants v
       set is_public = true, published_at = coalesce(v.published_at, now())
      from public.listing_media m
     where m.id = v.listing_media_id
       and m.listing_id = new.id
       and m.status = 'ready'
       and v.removed_at is null
       and not v.is_public;
    update public.listing_media m
       set published_at = coalesce(m.published_at, now())
     where m.listing_id = new.id and m.status = 'ready';

    perform public.enqueue_outbox_event('listing', new.id::text, 'listing.published',
      jsonb_build_object('listing_id', new.id, 'seller_user_id', new.seller_user_id, 'status', new.status));
  elsif was_public and not is_public then
    -- Withdrawal: public variants stop being public immediately; the worker removes the objects and
    -- invalidates the public cache. Originals stay private and untouched.
    update public.media_variants v
       set is_public = false, removed_at = now()
      from public.listing_media m
     where m.id = v.listing_media_id and m.listing_id = new.id and v.is_public;
    perform public.enqueue_outbox_event('listing', new.id::text, 'listing.withdrawn',
      jsonb_build_object('listing_id', new.id, 'seller_user_id', new.seller_user_id, 'status', new.status));
  elsif is_public then
    perform public.enqueue_outbox_event('listing', new.id::text, 'listing.updated',
      jsonb_build_object('listing_id', new.id, 'seller_user_id', new.seller_user_id, 'status', new.status));
  end if;
  return null;
end;
$$;

comment on function app_private.tg_listings_status_change() is
  'AFTER INSERT OR UPDATE OF status on listings: 0011''s status history and three outbox events, unchanged, plus 0114''s missing half of the publication rule — a listing that becomes public publishes the variants of its ready photographs, which is the symmetric branch of the withdrawal 0011 already wrote. A withdrawn variant is never resurrected.';

-- ---------------------------------------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.listing_media_can_manage(uuid, uuid, boolean) from public, app_worker;
revoke execute on function app_private.listing_media_upload_target(uuid, uuid, text, text, bigint, boolean) from public, app_worker;
revoke execute on function app_private.listing_media_attach(uuid, uuid, jsonb, boolean) from public, app_worker;
revoke execute on function app_private.listing_media_withdraw(uuid, uuid, uuid, boolean) from public, app_worker;
revoke execute on function app_private.listing_media_set_primary(uuid, uuid, uuid, boolean) from public, app_worker;
revoke execute on function app_private.listing_media_resolve(uuid, text, boolean) from public, app_worker;
revoke execute on function app_private.listing_media_for_manager(uuid, uuid, boolean) from public, app_worker;
revoke execute on function app_private.public_listing_media(uuid[]) from public, app_worker;

-- `app_system` only. The worker has no part in this: there is no processing step for it to run, which is
-- the whole consequence of the browser producing the images.
grant execute on function app_private.listing_media_can_manage(uuid, uuid, boolean) to app_system;
grant execute on function app_private.listing_media_upload_target(uuid, uuid, text, text, bigint, boolean) to app_system;
grant execute on function app_private.listing_media_attach(uuid, uuid, jsonb, boolean) to app_system;
grant execute on function app_private.listing_media_withdraw(uuid, uuid, uuid, boolean) to app_system;
grant execute on function app_private.listing_media_set_primary(uuid, uuid, uuid, boolean) to app_system;
grant execute on function app_private.listing_media_resolve(uuid, text, boolean) to app_system;
grant execute on function app_private.listing_media_for_manager(uuid, uuid, boolean) to app_system;
grant execute on function app_private.public_listing_media(uuid[]) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- 8. Assertions
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_tables integer;
  v_public boolean;
begin
  -- No table was created, and 0011's two are where it left them.
  select count(*) into v_tables from pg_tables
   where schemaname = 'public' and tablename in ('listing_media', 'media_variants');
  if v_tables <> 2 then
    raise exception '0011''s media tables are not where it left them';
  end if;

  -- The bucket this path writes to is the public one, which is what makes an object address an address
  -- rather than something that has to be signed.
  select b.public into v_public from storage.buckets b where b.id = 'listing-variants';
  if v_public is not true then
    raise exception 'listing-variants is not public; the catalogue could not show a photograph';
  end if;

  -- And the private one is still private, and still empty of anything this migration put there.
  select b.public into v_public from storage.buckets b where b.id = 'listing-originals';
  if v_public is not false then
    raise exception 'listing-originals is public; originals must never be served';
  end if;

  -- The permission this path tests for staff is 0033's, not a new one.
  if not exists (select 1 from public.permissions where key = 'catalog.listing.moderate') then
    raise exception 'catalog.listing.moderate is missing; this migration must not invent it';
  end if;
end;
$$;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
