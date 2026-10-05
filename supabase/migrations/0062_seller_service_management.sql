-- 0062 — The seller's own service write boundary (Phase 6-G).
--
-- ---------------------------------------------------------------------------------------------------
-- What the survey found, and why this migration is as small as it is
-- ---------------------------------------------------------------------------------------------------
-- **A service is a listing.** `listings.listing_type_code = 'service'`, plus at most one row in
-- `listing_service_details`, whose primary key *is* `listing_id` and whose only foreign key is
-- `listing_id → listings(id) on delete cascade`. The detail table has no owner column, no slug, no status
-- and no timestamps of its own beyond `created_at`/`updated_at`: ownership, addressing and state all belong
-- to the listing. 0011's own RLS says the same thing — `listing_service_details_owner_all` reaches the
-- owner through `listings.seller_user_id`. So the ownership relationship is unambiguous and there is
-- nothing here to disambiguate.
--
-- **There is no service state machine**, and this was verified rather than assumed: `listing_service_details`
-- holds no status column and no status-bearing timestamp, and the only status trigger anywhere near a
-- service is 0011's `listings_status_change` on `listings`. A service therefore moves through *exactly*
-- 0011's ten-name vocabulary, `listing_status_is_purchasable()` is still the live pair, and the 6-F mapping
-- applies to services because it is the same column and the same trigger — not because it was copied.
--
-- **The five editable detail fields** are the whole of the table, minus its key and its timestamps:
-- `pricing_model` (`fixed` | `custom`), `delivery_days` (1..365, and `not null` whenever the model is
-- `fixed`), `revisions_included` (>= 0), `requires_brief`, `scope` (<= 5000 characters). There is no money
-- column here at all: a service's price is `listings.price_minor` with `listings.currency_code`, which is
-- what 6-F already writes. No new financial field is introduced, and no currency is named in this file.
--
-- **Media never becomes mandatory.** `public_services()` reaches the detail row through a `left join` and
-- nothing constrains `listing_media`, so a service draft — like a product draft — needs no image. S-9 holds.
--
-- **The detail row itself is not mandatory either.** 0048's rule, read from
-- `app_private.live_listing_price_is_valid()`, is the only thing that ever requires one: a listing that is
-- `approved` or `active` must have a price *unless* it is a service whose `pricing_model` is `custom`. A
-- draft is unconstrained, and a priced service needs no detail row to go live.
--
-- **Nothing else is touched.** `service_requests` references `listings(id)` on the buyer's side and
-- `service_quotes` and `service_deliveries` reference neither listings nor this table; none of the three is
-- read or written here. The public 4-C surface — `public_services()`, `public_service_by_slug()` — is not
-- modified. No moderation, order, payment, shipping or promotion object is reached.
--
-- ---------------------------------------------------------------------------------------------------
-- Why this adds three functions and not five
-- ---------------------------------------------------------------------------------------------------
-- 6-F already owns the listing half of every one of these operations, and it is frozen. So:
--
--   * **create** and **edit** are *compositions*. `seller_service_create_draft()` calls
--     `app_private.seller_listing_create_draft()` with `'service'` as a literal and then writes the detail
--     row; `seller_service_update_draft()` calls `app_private.seller_listing_update_draft()` for the nine
--     listing columns and then the detail row. Not one of 6-F's rules — the slug format, the title and
--     description bounds, the reference-table checks, the seller-status gate, the draft-only gate, the
--     ownership scope — is restated here, so the two cannot drift and a refusal 6-F would give is the
--     refusal this gives. Both run in the caller's transaction, so a service and its details commit
--     together or not at all.
--
--   * **submit** and **archive** add nothing at all. `app_private.seller_listing_submit()` is already
--     service-aware — it is where 0048's `custom`-priced exemption is checked — and
--     `app_private.seller_listing_archive()` is type-agnostic by construction. A second pair of functions
--     would be a second copy of the state machine, which this increment must not create. The seller
--     services surface therefore *uses* 6-F's two transitions rather than reimplementing them, and that is
--     reported as the mapping.
--
-- Consequently the status history, the outbox events and the audit behaviour of a service are byte-for-byte
-- the ones 6-F established, because they are produced by the same trigger on the same table. Editing detail
-- fields writes no history row and no audit row, exactly as editing a draft's listing columns does not —
-- `listing_service_details` carries only `tg_set_updated_at` and 0048's deferred price trigger, and no audit
-- trigger, which was checked rather than assumed.

-- ---------------------------------------------------------------------------------------------------
-- The readback
-- ---------------------------------------------------------------------------------------------------
-- The seller's own services, with everything their own surfaces render and nothing else: no `id`, no
-- `seller_user_id`, no `category_id`, no `approved_at`, `published_at` or `deleted_at`, no `view_count`, no
-- moderation action and no rejection reason. `currency_minor_unit` comes from `public.currencies` exactly as
-- `public_services()` reads it, so a surface can render a price without inventing a divisor. Keyset paging
-- on `(created_at desc, slug desc)`, which the `listings_seller` index already serves.
create or replace function app_private.seller_services(
  p_user_id uuid,
  p_limit integer,
  p_cursor_created_at timestamptz,
  p_cursor_slug text
) returns table (
  slug text,
  title text,
  description text,
  category_slug text,
  status text,
  currency_code char(3),
  currency_minor_unit smallint,
  price_minor bigint,
  is_negotiable boolean,
  content_language text,
  country_code char(2),
  governorate text,
  city text,
  pricing_model text,
  delivery_days smallint,
  revisions_included smallint,
  requires_brief boolean,
  scope text,
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
  select l.slug, l.title, l.description, c.slug, l.status, l.currency_code, cur.decimal_places,
         l.price_minor, l.is_negotiable, l.content_language, l.country_code, l.governorate, l.city,
         d.pricing_model, d.delivery_days, d.revisions_included, d.requires_brief, d.scope,
         (select count(*)::integer from public.listing_media m where m.listing_id = l.id),
         l.created_at, l.updated_at, l.submitted_at, l.archived_at
    from public.listings l
    join public.categories c on c.id = l.category_id
    join public.currencies cur on cur.code = l.currency_code
    left join public.listing_service_details d on d.listing_id = l.id
   where l.seller_user_id = p_user_id
     and l.listing_type_code = 'service'
     and l.status <> 'deleted'
     and (
       p_cursor_created_at is null
       or (l.created_at, l.slug) < (p_cursor_created_at, coalesce(p_cursor_slug, ''))
     )
   order by l.created_at desc, l.slug desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;
comment on function app_private.seller_services(uuid, integer, timestamptz, text) is
  'The calling seller''s own service listings, newest first, keyset-paged by (created_at, slug). Scoped to the caller''s own rows and to listing_type_code = service by the where clause. The five listing_service_details fields are left-joined, so a service without a detail row reads as nulls rather than vanishing. Carries no identifier of any kind, no moderation data, no rejection reason and no status history; a deleted listing is not listed at all.';

-- ---------------------------------------------------------------------------------------------------
-- The detail-field rule, in one place
-- ---------------------------------------------------------------------------------------------------
-- `pricing_model` decides whether a detail row exists at all. Null means the seller has stated nothing
-- about how the work is priced, so no row is written — a legitimate state, and the one a service created by
-- 6-F alone is already in. Stating anything else without stating the model is refused rather than guessed
-- at, because `revisions_included = 2` with no pricing model is not a fact about a service.
--
-- Everything else is the table's own constraints, checked here so the caller gets an outcome rather than an
-- exception: the two allowed models, the 1..365 delivery window, `fixed` requiring a delivery time at all,
-- a non-negative revision count and a 5000-character scope.
create or replace function app_private.seller_service_details_problem(
  p_pricing_model text,
  p_delivery_days integer,
  p_revisions_included integer,
  p_requires_brief boolean,
  p_scope text
) returns boolean
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select
    case
      when p_pricing_model is null then
        -- Nothing may be stated without the model it belongs to.
        p_delivery_days is not null
        or p_revisions_included is not null
        or p_requires_brief is not null
        or nullif(btrim(coalesce(p_scope, '')), '') is not null
      when p_pricing_model not in ('fixed', 'custom') then true
      when p_delivery_days is not null and (p_delivery_days < 1 or p_delivery_days > 365) then true
      -- `listing_service_details_fixed_needs_delivery`, restated as an outcome rather than an exception.
      when p_pricing_model = 'fixed' and p_delivery_days is null then true
      when p_revisions_included is not null and p_revisions_included < 0 then true
      when length(coalesce(p_scope, '')) > 5000 then true
      else false
    end;
$$;
comment on function app_private.seller_service_details_problem(text, integer, integer, boolean, text) is
  'True when the five seller-facing listing_service_details values could not be stored. Restates that table''s own checks so a caller receives an outcome instead of an exception, and adds one rule of its own: nothing may be stated without a pricing model, because a revision count with no model is not a fact about a service.';

-- ---------------------------------------------------------------------------------------------------
-- Create a service draft
-- ---------------------------------------------------------------------------------------------------
-- Outcomes are 6-F's, unchanged and mostly produced by 6-F: `created`, `not_found` (no storefront),
-- `not_editable` (suspended or closed storefront), `slug_taken`, `invalid`.
--
-- There is no `p_listing_type_code`: `'service'` is a literal, so this function cannot create a product, and
-- there is no `p_status` either — the status is whatever 6-F's creator writes, which is the literal `draft`.
create or replace function app_private.seller_service_create_draft(
  p_user_id uuid,
  p_slug text,
  p_title text,
  p_description text,
  p_category_slug text,
  p_content_language text,
  p_currency_code text,
  p_country_code text,
  p_price_minor bigint,
  p_is_negotiable boolean,
  p_governorate text,
  p_city text,
  p_pricing_model text,
  p_delivery_days integer,
  p_revisions_included integer,
  p_requires_brief boolean,
  p_scope text
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
  v_outcome text;
  v_slug text;
  v_status text;
  v_listing_id uuid;
begin
  -- The detail fields are validated **before** anything is written. The listing insert happens inside
  -- 6-F's function and is not undone by returning a string, so a detail value that could not be stored has
  -- to be refused while there is still nothing to leave behind.
  if app_private.seller_service_details_problem(
       p_pricing_model, p_delivery_days, p_revisions_included, p_requires_brief, p_scope) then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  -- 6-F's creator, called rather than copied. Every rule it applies — the slug format, the title and
  -- description bounds, the reference vocabularies, the category's type scope, the seller-status gate and
  -- the ownership of the row it writes — is applied here by being the same code.
  select r.outcome, r.slug, r.status
    into v_outcome, v_slug, v_status
    from app_private.seller_listing_create_draft(
      p_user_id, p_slug, p_title, p_description, 'service', p_category_slug, p_content_language,
      p_currency_code, p_country_code, p_price_minor, p_is_negotiable, p_governorate, p_city
    ) r;

  if v_outcome <> 'created' then
    return query select v_outcome, null::text, null::text;
    return;
  end if;

  -- Null model means the seller stated nothing about pricing, so there is no row to write. A service in
  -- that state is exactly what 6-F alone produces, and 0048 will require a price of it to go live.
  if p_pricing_model is not null then
    select l.id into v_listing_id
      from public.listings l
     where l.slug = v_slug and l.seller_user_id = p_user_id;

    insert into public.listing_service_details (
      listing_id, pricing_model, delivery_days, revisions_included, requires_brief, scope
    ) values (
      v_listing_id,
      p_pricing_model,
      p_delivery_days,
      coalesce(p_revisions_included, 0),
      coalesce(p_requires_brief, false),
      nullif(btrim(coalesce(p_scope, '')), '')
    );
  end if;

  return query select 'created'::text, v_slug, v_status;
end;
$$;
comment on function app_private.seller_service_create_draft(
  uuid, text, text, text, text, text, text, text, bigint, boolean, text, text, text, integer, integer,
  boolean, text
) is
  'Creates one service listing owned by the calling seller, always in draft, and its listing_service_details row when a pricing model is stated. The listing half is app_private.seller_listing_create_draft called with the literal service type, so none of 6-F''s rules is restated and none can drift; the type cannot be anything else and there is no status parameter. Detail values are validated before anything is written, so a refusal leaves no listing behind. Needs no media and no price.';

-- ---------------------------------------------------------------------------------------------------
-- Edit a service draft
-- ---------------------------------------------------------------------------------------------------
-- Draft only, because 6-F's editor is draft only and this defers to it. Fourteen editable fields: 6-F's
-- nine listing columns and this increment's five detail columns, each with a set-flag so an omitted field
-- keeps its value and an explicit null clears the ones that may be empty.
--
-- `slug`, `listing_type_code`, `category_id`, the owner, the status and every state-bearing timestamp
-- appear in no assignment and have no parameter — the first three because 6-F deliberately withheld them,
-- the rest because nothing here could reach them.
--
-- A listing of the caller's that is **not** a service answers `not_found`: this surface addresses services,
-- so there is no service at that address. It is the same answer a slug belonging to another seller gets,
-- and it discloses nothing the caller could not already read from their own listings index.
create or replace function app_private.seller_service_update_draft(
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
  p_city text,
  p_set_pricing_model boolean,
  p_pricing_model text,
  p_set_delivery_days boolean,
  p_delivery_days integer,
  p_set_revisions_included boolean,
  p_revisions_included integer,
  p_set_requires_brief boolean,
  p_requires_brief boolean,
  p_set_scope boolean,
  p_scope text
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
  v_listing_id uuid;
  v_listing_status text;
  v_has_details boolean;
  v_pricing_model text;
  v_delivery_days integer;
  v_revisions_included integer;
  v_requires_brief boolean;
  v_scope text;
  v_outcome text;
  v_slug text;
  v_status text;
  v_touches_details boolean;
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

  -- The caller's own service, by slug. A product, another seller's listing and a slug that does not exist
  -- are one answer, so asking cannot tell them apart.
  select l.id, l.status into v_listing_id, v_listing_status
    from public.listings l
   where l.slug = p_slug
     and l.seller_user_id = p_user_id
     and l.listing_type_code = 'service';

  if v_listing_id is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  if v_listing_status <> 'draft' then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  v_touches_details := coalesce(p_set_pricing_model, false)
    or coalesce(p_set_delivery_days, false)
    or coalesce(p_set_revisions_included, false)
    or coalesce(p_set_requires_brief, false)
    or coalesce(p_set_scope, false);

  if v_touches_details then
    -- The stored row, so the effective values can be computed and checked as a whole: the
    -- `fixed_needs_delivery` constraint is about the pair, not about either field on its own.
    select true, d.pricing_model, d.delivery_days, d.revisions_included, d.requires_brief, d.scope
      into v_has_details, v_pricing_model, v_delivery_days, v_revisions_included, v_requires_brief, v_scope
      from public.listing_service_details d
     where d.listing_id = v_listing_id;
    v_has_details := coalesce(v_has_details, false);

    if p_set_pricing_model then v_pricing_model := p_pricing_model; end if;
    if p_set_delivery_days then v_delivery_days := p_delivery_days; end if;
    if p_set_revisions_included then v_revisions_included := p_revisions_included; end if;
    if p_set_requires_brief then v_requires_brief := p_requires_brief; end if;
    if p_set_scope then v_scope := nullif(btrim(coalesce(p_scope, '')), ''); end if;

    -- Withdrawing the pricing model withdraws everything that hung off it, because the row itself goes.
    -- The stored delivery time and revision count are *not* carried into the check here: they are about to
    -- cease to exist, and treating them as things the caller is still asserting would refuse a legitimate
    -- withdrawal. A request that withdraws the model while also stating one of those fields is
    -- contradictory, though, and is refused rather than resolved in either direction.
    if p_set_pricing_model and p_pricing_model is null then
      if (coalesce(p_set_delivery_days, false) and p_delivery_days is not null)
         or (coalesce(p_set_revisions_included, false) and p_revisions_included is not null)
         or (coalesce(p_set_requires_brief, false) and p_requires_brief is not null)
         or (coalesce(p_set_scope, false) and nullif(btrim(coalesce(p_scope, '')), '') is not null) then
        return query select 'invalid'::text, null::text, null::text;
        return;
      end if;
      v_delivery_days := null;
      v_revisions_included := null;
      v_requires_brief := null;
      v_scope := null;
    end if;

    if app_private.seller_service_details_problem(
         v_pricing_model, v_delivery_days, v_revisions_included, v_requires_brief, v_scope) then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
  end if;

  -- 6-F's editor, called rather than copied, for the nine listing columns. It repeats the gates above,
  -- which is deliberate: it stays the authority on them, and this function cannot drift from it.
  select r.outcome, r.slug, r.status
    into v_outcome, v_slug, v_status
    from app_private.seller_listing_update_draft(
      p_user_id, p_slug,
      p_set_title, p_title,
      p_set_description, p_description,
      p_set_price_minor, p_price_minor,
      p_set_is_negotiable, p_is_negotiable,
      p_set_content_language, p_content_language,
      p_set_currency_code, p_currency_code,
      p_set_country_code, p_country_code,
      p_set_governorate, p_governorate,
      p_set_city, p_city
    ) r;

  if v_outcome <> 'updated' then
    return query select v_outcome, null::text, null::text;
    return;
  end if;

  if v_touches_details then
    if v_pricing_model is null then
      -- Every stated fact has been withdrawn. The row says nothing, so it should not exist — and its
      -- absence is a state the schema already has a meaning for.
      delete from public.listing_service_details d where d.listing_id = v_listing_id;
    elsif v_has_details then
      update public.listing_service_details as d
         set pricing_model = v_pricing_model,
             delivery_days = v_delivery_days,
             revisions_included = coalesce(v_revisions_included, 0),
             requires_brief = coalesce(v_requires_brief, false),
             scope = v_scope
       where d.listing_id = v_listing_id;
    else
      insert into public.listing_service_details (
        listing_id, pricing_model, delivery_days, revisions_included, requires_brief, scope
      ) values (
        v_listing_id, v_pricing_model, v_delivery_days, coalesce(v_revisions_included, 0),
        coalesce(v_requires_brief, false), v_scope
      );
    end if;
  end if;

  return query select 'updated'::text, v_slug, v_status;
end;
$$;
comment on function app_private.seller_service_update_draft(
  uuid, text, boolean, text, boolean, text, boolean, bigint, boolean, boolean, boolean, text, boolean,
  text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, integer, boolean, integer,
  boolean, boolean, boolean, text
) is
  'Edits one of the calling seller''s own service listings while it is a draft: 6-F''s nine listing columns, by calling app_private.seller_listing_update_draft, plus this increment''s five listing_service_details columns. Set-flags tell an omitted field from one deliberately cleared. Withdrawing the pricing model removes the detail row, which is the state a service created without one is already in. A listing that is not a service, not the caller''s, or not a draft is refused, and the first two answer identically.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- S8 unchanged: named functions, PUBLIC revoked, `app_system` only. `authenticated` gains nothing, no table
-- privilege is granted anywhere by this migration, and 0011's and 0009's owner policies stay exactly as they
-- are as defence in depth beneath a path that no longer goes through them.
--
-- `seller_service_details_problem` is a pure predicate over five scalars and reads no table, so it has
-- nothing to define away — but it is SECURITY DEFINER with a pinned `search_path` all the same, because the
-- rule for every new `app_private` function is exactly that and a predicate is not worth an exception to it.
revoke execute on function app_private.seller_services(uuid, integer, timestamptz, text) from public;
grant execute on function app_private.seller_services(uuid, integer, timestamptz, text) to app_system;
revoke execute on function app_private.seller_service_details_problem(text, integer, integer, boolean, text)
  from public;
grant execute on function app_private.seller_service_details_problem(text, integer, integer, boolean, text)
  to app_system;
revoke execute on function app_private.seller_service_create_draft(
  uuid, text, text, text, text, text, text, text, bigint, boolean, text, text, text, integer, integer,
  boolean, text
) from public;
grant execute on function app_private.seller_service_create_draft(
  uuid, text, text, text, text, text, text, text, bigint, boolean, text, text, text, integer, integer,
  boolean, text
) to app_system;
revoke execute on function app_private.seller_service_update_draft(
  uuid, text, boolean, text, boolean, text, boolean, bigint, boolean, boolean, boolean, text, boolean,
  text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, integer, boolean, integer,
  boolean, boolean, boolean, text
) from public;
grant execute on function app_private.seller_service_update_draft(
  uuid, text, boolean, text, boolean, text, boolean, bigint, boolean, boolean, boolean, text, boolean,
  text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, integer, boolean, integer,
  boolean, boolean, boolean, text
) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
