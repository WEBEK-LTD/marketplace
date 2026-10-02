-- 0061 — The seller's own listing write boundary (Phase 6-F).
--
-- 0011 already owns listings: the table, the ten-state vocabulary, the slug format and its permanent
-- history, the title and description lengths, the price rule, the status-history trigger and the outbox
-- events. 0027 owns moderation. 0048 owns the live-price rule. 0046 owns the public reader. **This
-- migration adds no model and no state.** It adds the four seller-facing writes S-8 approved, and the
-- readback a seller needs to use them, and nothing else.
--
-- ---------------------------------------------------------------------------------------------------
-- The state machine, as it already exists
-- ---------------------------------------------------------------------------------------------------
-- 0011's vocabulary is `draft, pending_review, approved, active, sold, expired, archived, rejected,
-- suspended, deleted`, and 0011's own RLS tells you which of those a seller may write: the
-- `listings_owner_insert` policy admits `draft` and `pending_review` and nothing else. The four approved
-- transitions map onto those existing names with nothing added:
--
--   no listing → draft          `status` takes its own default
--   draft → draft               an edit; the status does not move
--   draft → pending_review      the submission. 0011's name for "submitted for review"
--   live → archived             the archive, with `archived_at`, which 0011 makes a biconditional
--
-- **"live" is the schema's own pair.** The instruction says "active → archived"; 0011 has two live states,
-- `approved` and `active`, grouped by its own `listing_status_is_purchasable()`, and nothing anywhere in
-- this project moves a listing from `approved` to `active` — `approved` is where moderation leaves a
-- listing it accepts, and `active` is only reached by a reinstatement. Restricting the archive to `active`
-- alone would therefore leave every moderator-approved listing unarchivable by its own seller. So the
-- archive accepts the live pair, which is the schema's name for the state the instruction describes. This
-- is a mapping onto existing names, not a new transition, and it is reported as such.
--
-- **What this migration cannot reach.** `approved`, `active`, `rejected`, `suspended`, `sold`, `expired`
-- and `deleted` appear in no assignment below. A seller cannot approve, activate, reject, suspend or
-- delete anything, and there is no parameter through which they could ask to: 0027's
-- `moderate_listing()` remains the only path to any of those, it refuses self-moderation, and nothing here
-- touches it. There is no seller delete at all — the archive is the end of the seller's own authority.
--
-- ---------------------------------------------------------------------------------------------------
-- Ownership, and why nothing takes a uuid
-- ---------------------------------------------------------------------------------------------------
-- `listings.seller_user_id` references `seller_profiles(user_id)`: one column, no ambiguity. Every
-- function below takes the caller's own id as its first parameter and scopes its statement by it, so a
-- listing belonging to somebody else is not refused so much as unreachable.
--
-- Listings are addressed **by slug**, and categories are named by slug too. Both are already public
-- vocabularies, so the seller surface carries no listing uuid, no category uuid and no seller uuid at all —
-- the same stance 6-A took when it kept the seller's own identifier out of the identity projection. A slug
-- that belongs to another seller answers `not_found`, exactly as one that does not exist.
--
-- ---------------------------------------------------------------------------------------------------
-- What a draft needs, and what it does not
-- ---------------------------------------------------------------------------------------------------
-- The required fields are 0011's `not null` columns: type, category, slug, title, description, content
-- language, currency and country. Everything else is nullable and therefore optional, which is what makes
-- S-9 true without a special case: **a draft needs no media**, because `listing_media` is a separate table
-- and nothing requires a row in it. It needs no price either — 0011's price rule binds `approved` and
-- `active` only.
--
-- Product and service detail rows (`listing_product_details`, `listing_service_details`) are **not** written
-- here. Nothing requires them for a draft or a submission, S-8's four operations do not name them, and a
-- seller-editable `shipping_profile_id` would be shipping consumption, which this increment must not
-- implement. A later increment can add them; this one does not guess at them.
--
-- **Submission validates what approval will require**, and that is 0048's rule rather than a new one:
-- a product needs a price, a `fixed` service needs a price, a `custom` service does not, and a service with
-- no details row states no pricing model and so is held to a price like anything else — 0048's own words.
-- Checking it at submission rather than only at approval means a seller learns now instead of after a
-- moderator's time has been spent.

-- ---------------------------------------------------------------------------------------------------
-- The readback
-- ---------------------------------------------------------------------------------------------------
-- Everything the seller's own surfaces render, and nothing else: no `seller_user_id`, no `id`, no
-- `category_id`, no `approved_at`, no `published_at`, no `deleted_at`, no `view_count`, no status history,
-- no moderation action and no rejection reason. Keyset pagination on `(created_at desc, slug desc)`, which
-- the `listings_seller` index already serves; the cursor is two already-public values, and the API is what
-- makes it opaque.
create or replace function app_private.seller_listings(
  p_user_id uuid,
  p_limit integer,
  p_cursor_created_at timestamptz,
  p_cursor_slug text
) returns table (
  slug text,
  title text,
  description text,
  listing_type_code text,
  category_slug text,
  status text,
  currency_code char(3),
  price_minor bigint,
  is_negotiable boolean,
  content_language text,
  country_code char(2),
  governorate text,
  city text,
  media_count integer,
  created_at timestamptz,
  updated_at timestamptz,
  submitted_at timestamptz,
  archived_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select l.slug, l.title, l.description, l.listing_type_code, c.slug, l.status, l.currency_code,
         l.price_minor, l.is_negotiable, l.content_language, l.country_code, l.governorate, l.city,
         (select count(*)::integer from public.listing_media m where m.listing_id = l.id),
         l.created_at, l.updated_at, l.submitted_at, l.archived_at
    from public.listings l
    join public.categories c on c.id = l.category_id
   where l.seller_user_id = p_user_id
     and l.status <> 'deleted'
     and (
       p_cursor_created_at is null
       or (l.created_at, l.slug) < (p_cursor_created_at, coalesce(p_cursor_slug, ''))
     )
   order by l.created_at desc, l.slug desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;
comment on function app_private.seller_listings(uuid, integer, timestamptz, text) is
  'The calling seller''s own listings, newest first, keyset-paged by (created_at, slug). Scoped to the caller''s own rows by the where clause. Carries no identifier of any kind, no moderation data, no rejection reason and no status history; a deleted listing is not listed at all.';

-- ---------------------------------------------------------------------------------------------------
-- Create a draft
-- ---------------------------------------------------------------------------------------------------
-- Outcomes: `created`, `not_found` (no storefront), `not_editable` (suspended or closed storefront),
-- `slug_taken` (the address is in use, now or historically), `invalid` (anything 0011 would refuse).
create or replace function app_private.seller_listing_create_draft(
  p_user_id uuid,
  p_slug text,
  p_title text,
  p_description text,
  p_listing_type_code text,
  p_category_slug text,
  p_content_language text,
  p_currency_code text,
  p_country_code text,
  p_price_minor bigint,
  p_is_negotiable boolean,
  p_governorate text,
  p_city text
) returns table (
  outcome text,
  slug text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_status text;
  v_category_id uuid;
  v_category_type text;
  v_title text;
  v_description text;
  v_governorate text;
  v_city text;
  v_slug text;
  v_status text;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  -- The caller's own storefront and its state, read first so a suspended seller gets the same answer
  -- whatever they sent.
  select s.status into v_seller_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_seller_status is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  -- 0011's own limits, restated nowhere else: the slug format, the trimmed title 3..140 and the trimmed
  -- description 10..20000.
  if coalesce(p_slug, '') !~ '^[a-z0-9](?:[a-z0-9-]{1,118}[a-z0-9])$' then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  v_title := btrim(coalesce(p_title, ''));
  if length(v_title) < 3 or length(v_title) > 140 then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  v_description := btrim(coalesce(p_description, ''));
  if length(v_description) < 10 or length(v_description) > 20000 then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  if p_price_minor is not null and p_price_minor < 0 then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  -- The reference vocabularies, each checked against its own table rather than against a list kept here.
  if p_listing_type_code is null
     or not exists (select 1 from public.listing_types t where t.code = p_listing_type_code and t.is_active) then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  if p_content_language is null
     or not exists (select 1 from public.locales l where l.code = p_content_language) then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  if p_currency_code is null or length(p_currency_code) <> 3
     or not exists (
       select 1 from public.currencies c
        where c.code = p_currency_code::char(3) and c.is_enabled and c.is_pricing_enabled
     ) then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  if p_country_code is null or length(p_country_code) <> 2
     or not exists (
       select 1 from public.countries c where c.code = p_country_code::char(2) and c.is_marketplace_enabled
     ) then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  -- The category, by its public slug. It must be active, and a category scoped to one listing type may not
  -- hold the other — which is the categories table's own `listing_type_code`, not a rule invented here.
  select c.id, c.listing_type_code into v_category_id, v_category_type
    from public.categories c
   where c.slug = p_category_slug and c.is_active;

  if v_category_id is null then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  if v_category_type is not null and v_category_type <> p_listing_type_code then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  v_governorate := nullif(btrim(coalesce(p_governorate, '')), '');
  v_city := nullif(btrim(coalesce(p_city, '')), '');

  -- `status` is a literal. There is no parameter for it, so a caller cannot create anything but a draft,
  -- and `seller_user_id` is the caller's own id and nothing else. None of 0011's timestamps is assigned:
  -- `created_at` and `updated_at` are the table's defaults, and every state-bearing timestamp stays null.
  begin
    insert into public.listings (
      seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
      currency_code, price_minor, is_negotiable, status, country_code, governorate, city
    ) values (
      p_user_id, p_listing_type_code, v_category_id, p_slug, v_title, v_description, p_content_language,
      p_currency_code::char(3), p_price_minor, coalesce(p_is_negotiable, false), 'draft',
      p_country_code::char(2), v_governorate, v_city
    )
    returning listings.slug, listings.status into v_slug, v_status;
  exception
    when unique_violation then
      -- Either the slug is live on another listing or 0011's slug-history trigger refused it because it is
      -- permanently redirected. Both mean the same thing to the caller: choose another address. Which one
      -- it was is not disclosed, because that would say whether a listing had ever existed at that address.
      return query select 'slug_taken'::text, null::text, null::text;
      return;
    when check_violation or foreign_key_violation or restrict_violation or invalid_text_representation
      or not_null_violation then
      return query select 'invalid'::text, null::text, null::text;
      return;
  end;

  return query select 'created'::text, v_slug, v_status;
end;
$$;
comment on function app_private.seller_listing_create_draft(
  uuid, text, text, text, text, text, text, text, text, bigint, boolean, text, text
) is
  'Creates one listing owned by the calling seller, always in draft. `status` is a literal and `seller_user_id` is the caller''s own id, so no request can create a listing in another state or for another seller. Requires only 0011''s not-null columns: no media, no price, no product or service detail row. Categories, types, locales, currencies and countries are checked against their own tables. A taken or permanently redirected slug answers slug_taken without saying which.';

-- ---------------------------------------------------------------------------------------------------
-- Edit a draft
-- ---------------------------------------------------------------------------------------------------
-- Draft only. Once a listing is submitted it is out of the seller's hands until moderation acts, which is
-- what the instruction requires and what 0027 already assumes.
--
-- Set-flag pairs, as 0059 uses them: an omitted field keeps its value and an explicit null clears it, for
-- the three columns 0011 allows to be empty. `slug`, `listing_type_code` and `category_id` are **not**
-- editable here: the slug carries permanent 301 history that a draft has no business accumulating, and the
-- type decides which detail table a listing would own. Both are reported as deliberate narrowings.
create or replace function app_private.seller_listing_update_draft(
  p_user_id uuid,
  p_slug text,
  p_set_title boolean,
  p_title text,
  p_set_description boolean,
  p_description text,
  p_set_price_minor boolean,
  p_price_minor bigint,
  p_set_is_negotiable boolean,
  p_is_negotiable boolean,
  p_set_content_language boolean,
  p_content_language text,
  p_set_currency_code boolean,
  p_currency_code text,
  p_set_country_code boolean,
  p_country_code text,
  p_set_governorate boolean,
  p_governorate text,
  p_set_city boolean,
  p_city text
) returns table (
  outcome text,
  slug text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_status text;
  v_listing_status text;
  v_new_title text;
  v_new_description text;
  v_new_currency char(3);
  v_new_country char(2);
  v_new_governorate text;
  v_new_city text;
  v_slug text;
  v_status text;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  select s.status into v_seller_status from public.seller_profiles s where s.user_id = p_user_id;
  if v_seller_status is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  -- The caller's own listing, by slug. A slug owned by somebody else does not match this predicate, so it
  -- answers exactly as one that does not exist.
  select l.status into v_listing_status
    from public.listings l
   where l.slug = p_slug and l.seller_user_id = p_user_id;

  if v_listing_status is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  if v_listing_status <> 'draft' then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  if p_set_title then
    if p_title is null then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
    v_new_title := btrim(p_title);
    if length(v_new_title) < 3 or length(v_new_title) > 140 then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
  end if;

  if p_set_description then
    if p_description is null then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
    v_new_description := btrim(p_description);
    if length(v_new_description) < 10 or length(v_new_description) > 20000 then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
  end if;

  if p_set_price_minor and p_price_minor is not null and p_price_minor < 0 then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  if p_set_is_negotiable and p_is_negotiable is null then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  if p_set_content_language then
    if p_content_language is null
       or not exists (select 1 from public.locales l where l.code = p_content_language) then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
  end if;

  if p_set_currency_code then
    if p_currency_code is null or length(p_currency_code) <> 3
       or not exists (
         select 1 from public.currencies c
          where c.code = p_currency_code::char(3) and c.is_enabled and c.is_pricing_enabled
       ) then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
    v_new_currency := p_currency_code::char(3);
  end if;

  if p_set_country_code then
    if p_country_code is null or length(p_country_code) <> 2
       or not exists (
         select 1 from public.countries c where c.code = p_country_code::char(2) and c.is_marketplace_enabled
       ) then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
    v_new_country := p_country_code::char(2);
  end if;

  if p_set_governorate then
    v_new_governorate := nullif(btrim(coalesce(p_governorate, '')), '');
  end if;
  if p_set_city then
    v_new_city := nullif(btrim(coalesce(p_city, '')), '');
  end if;

  -- Nine columns may be assigned. `slug`, `status`, `seller_user_id`, `listing_type_code`, `category_id`,
  -- `submitted_at`, `approved_at`, `published_at`, `sold_at`, `expires_at`, `archived_at`, `deleted_at`,
  -- `view_count` and `created_at` appear in no assignment and have no parameter. `updated_at` is 0011's
  -- own trigger's, as it is for every write to this table.
  begin
    update public.listings as l
       set title = case when p_set_title then v_new_title else l.title end,
           description = case when p_set_description then v_new_description else l.description end,
           price_minor = case when p_set_price_minor then p_price_minor else l.price_minor end,
           is_negotiable = case when p_set_is_negotiable then p_is_negotiable else l.is_negotiable end,
           content_language = case
             when p_set_content_language then p_content_language else l.content_language
           end,
           currency_code = case when p_set_currency_code then v_new_currency else l.currency_code end,
           country_code = case when p_set_country_code then v_new_country else l.country_code end,
           governorate = case when p_set_governorate then v_new_governorate else l.governorate end,
           city = case when p_set_city then v_new_city else l.city end
     where l.slug = p_slug and l.seller_user_id = p_user_id and l.status = 'draft'
    returning l.slug, l.status into v_slug, v_status;
  exception
    when check_violation or foreign_key_violation or restrict_violation or invalid_text_representation
      or not_null_violation or unique_violation then
      return query select 'invalid'::text, null::text, null::text;
      return;
  end;

  if v_slug is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  return query select 'updated'::text, v_slug, v_status;
end;
$$;
comment on function app_private.seller_listing_update_draft(
  uuid, text, boolean, text, boolean, text, boolean, bigint, boolean, boolean, boolean, text, boolean,
  text, boolean, text, boolean, text, boolean, text
) is
  'Edits one of the calling seller''s own listings while it is a draft. Nine editable columns, each with a set-flag so an omitted field keeps its value and an explicit null clears the three 0011 allows to be empty. The slug, the type, the category, the owner, the status, every state-bearing timestamp and the view count appear in no assignment and have no parameter, so none can be changed. A listing that is not a draft, or not the caller''s, is refused.';

-- ---------------------------------------------------------------------------------------------------
-- Submit for review
-- ---------------------------------------------------------------------------------------------------
-- Its own function, not a status field on the edit: submitting is a different act with different
-- preconditions, and a status the caller could pass to an update would be a status the caller could choose.
--
-- Outcomes: `submitted`, `not_found`, `not_editable` (the storefront, or a listing that is not a draft),
-- `incomplete` (the listing cannot be approved as it stands).
create or replace function app_private.seller_listing_submit(
  p_user_id uuid,
  p_slug text
) returns table (
  outcome text,
  slug text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_status text;
  v_listing public.listings;
  v_pricing_model text;
  v_slug text;
  v_status text;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  select s.status into v_seller_status from public.seller_profiles s where s.user_id = p_user_id;
  if v_seller_status is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  select * into v_listing
    from public.listings l
   where l.slug = p_slug and l.seller_user_id = p_user_id
     for update;

  if v_listing.id is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  if v_listing.status <> 'draft' then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  -- 0048's rule, applied one step early: what approval will require, required now. A product needs a
  -- price; a `fixed` service needs a price; a `custom` service does not; and a service with no details row
  -- states no pricing model, so it is held to a price like anything else.
  if v_listing.price_minor is null then
    select d.pricing_model into v_pricing_model
      from public.listing_service_details d
     where d.listing_id = v_listing.id;

    if v_listing.listing_type_code <> 'service' or coalesce(v_pricing_model, 'fixed') <> 'custom' then
      return query select 'incomplete'::text, null::text, null::text;
      return;
    end if;
  end if;

  -- `pending_review` and the submission time. No other column is assigned: the approval, publication, sale,
  -- expiry, archival and deletion timestamps are untouched, and so is the price.
  begin
    update public.listings as l
       set status = 'pending_review',
           submitted_at = now()
     where l.id = v_listing.id and l.seller_user_id = p_user_id and l.status = 'draft'
    returning l.slug, l.status into v_slug, v_status;
  exception
    when check_violation or restrict_violation or foreign_key_violation then
      return query select 'incomplete'::text, null::text, null::text;
      return;
  end;

  if v_slug is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  return query select 'submitted'::text, v_slug, v_status;
end;
$$;
comment on function app_private.seller_listing_submit(uuid, text) is
  'Moves one of the calling seller''s own drafts to pending_review and records submitted_at. Draft only, so a listing cannot be submitted twice and cannot be edited as a draft afterwards. Requires what approval will require, which is 0048''s price rule checked a step early. Approves nothing, publishes nothing and touches no moderation state; 0027''s moderate_listing remains the only path to approved, rejected or suspended.';

-- ---------------------------------------------------------------------------------------------------
-- Archive a live listing
-- ---------------------------------------------------------------------------------------------------
-- The live pair only, and `archived_at` with it, because 0011 makes that a biconditional. 0011's status
-- trigger keeps the media and the outbox in step; nothing here repeats that work.
--
-- Outcomes: `archived`, `not_found`, `not_editable` (the storefront, or a listing that is not live).
create or replace function app_private.seller_listing_archive(
  p_user_id uuid,
  p_slug text
) returns table (
  outcome text,
  slug text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_status text;
  v_listing_status text;
  v_slug text;
  v_status text;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  select s.status into v_seller_status from public.seller_profiles s where s.user_id = p_user_id;
  if v_seller_status is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  select l.status into v_listing_status
    from public.listings l
   where l.slug = p_slug and l.seller_user_id = p_user_id;

  if v_listing_status is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  -- `listing_status_is_purchasable()` is 0011's own name for "live". A draft, a submission, a sold, expired,
  -- rejected, suspended or already archived listing is not archivable by this surface.
  if not public.listing_status_is_purchasable(v_listing_status) then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  begin
    update public.listings as l
       set status = 'archived',
           archived_at = now()
     where l.slug = p_slug
       and l.seller_user_id = p_user_id
       and public.listing_status_is_purchasable(l.status)
    returning l.slug, l.status into v_slug, v_status;
  exception
    when check_violation or restrict_violation or foreign_key_violation then
      return query select 'not_editable'::text, null::text, null::text;
      return;
  end;

  if v_slug is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  return query select 'archived'::text, v_slug, v_status;
end;
$$;
comment on function app_private.seller_listing_archive(uuid, text) is
  'Archives one of the calling seller''s own live listings, setting archived_at as 0011''s biconditional requires. Live means listing_status_is_purchasable — approved or active — which is the schema''s own name for the state the approved transition describes. Deletes nothing: there is no seller-side delete. 0011''s status trigger writes the history, withdraws public variants where applicable and publishes the event; none of that is repeated here.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- S8 unchanged: named functions, PUBLIC revoked, `app_system` only. `authenticated` gains nothing — 0011's
-- owner-write policies stay exactly as they are, as defence in depth beneath a path that no longer goes
-- through them — and no table privilege is granted anywhere by this migration.
revoke execute on function app_private.seller_listings(uuid, integer, timestamptz, text) from public;
grant execute on function app_private.seller_listings(uuid, integer, timestamptz, text) to app_system;
revoke execute on function app_private.seller_listing_create_draft(
  uuid, text, text, text, text, text, text, text, text, bigint, boolean, text, text
) from public;
grant execute on function app_private.seller_listing_create_draft(
  uuid, text, text, text, text, text, text, text, text, bigint, boolean, text, text
) to app_system;
revoke execute on function app_private.seller_listing_update_draft(
  uuid, text, boolean, text, boolean, text, boolean, bigint, boolean, boolean, boolean, text, boolean,
  text, boolean, text, boolean, text, boolean, text
) from public;
grant execute on function app_private.seller_listing_update_draft(
  uuid, text, boolean, text, boolean, text, boolean, bigint, boolean, boolean, boolean, text, boolean,
  text, boolean, text, boolean, text, boolean, text
) to app_system;
revoke execute on function app_private.seller_listing_submit(uuid, text) from public;
grant execute on function app_private.seller_listing_submit(uuid, text) to app_system;
revoke execute on function app_private.seller_listing_archive(uuid, text) from public;
grant execute on function app_private.seller_listing_archive(uuid, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
