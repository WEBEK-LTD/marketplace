-- 0047 — Reading public services, and splitting them out of the listing surface (Phase 4-C).
--
-- Products and services share one `listings` table and one slug namespace (0011). Phase 4-C gives them
-- two public surfaces — `/listings` and `/services`, `/listing/<slug>` and `/service/<slug>` — while that
-- single namespace stays exactly as it is. Two consequences follow, and this migration exists for them:
--
--   1. the listing readers must stop returning services, and the service readers must return only those;
--   2. a slug always names one listing, so asking the wrong surface for it is a redirect to the right
--      one, not a 404. `/listing/<a-service>` is a 301 to `/service/<a-service>`, and the reverse.
--
-- **The state rules are not written twice.** `app_private.public_listing_resolve` answers "which listing
-- does this slug name, may the public see it, and what type is it" for both surfaces. Everything above it
-- projects fields; nothing above it re-decides visibility. That is what keeps the two surfaces from
-- drifting apart as states are added.
--
-- Visibility itself is still 0011's and 0009's, called through the same helpers the RLS policies call:
--
--   `public.listing_status_is_public(status)`      approved, active, sold, expired, archived
--   `public.listing_status_is_purchasable(status)` approved, active
--   `public.is_seller_publicly_visible(user_id)`   the seller's profile is active

-- ---------------------------------------------------------------------------------------------------
-- The shared resolver
-- ---------------------------------------------------------------------------------------------------
-- One slug in, one answer out:
--
--   found      the slug is current and the public may see it
--   moved      the slug is a previous one; `canonical_slug` is the current one
--   not_found  no listing, or one in a state the public never sees
--
-- `listing_type_code` travels with the answer so that a caller can tell a product from a service without
-- reading the row itself. It is null when the outcome is `not_found`, because there is nothing to name.
--
-- A previous slug of a listing that is *not* publicly visible reports `not_found` rather than `moved`:
-- redirecting to a page that would 404 tells a visitor the listing exists, which the non-public states
-- exist to avoid.
create or replace function app_private.public_listing_resolve(p_slug text)
returns table (
  outcome text,
  canonical_slug text,
  listing_id uuid,
  listing_type_code text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_slug text;
  v_type text;
  v_visible boolean := false;
  v_current boolean := false;
begin
  -- The current slug first: the common case, and the only one that renders a page.
  select l.id, l.slug, l.listing_type_code,
         public.listing_status_is_public(l.status) and public.is_seller_publicly_visible(l.seller_user_id),
         true
    into v_id, v_slug, v_type, v_visible, v_current
    from public.listings l
   where l.slug = p_slug;

  if v_id is null then
    -- A previous slug. `listing_slug_history.slug` is unique across the table, so at most one matches.
    select l.id, l.slug, l.listing_type_code,
           public.listing_status_is_public(l.status) and public.is_seller_publicly_visible(l.seller_user_id),
           false
      into v_id, v_slug, v_type, v_visible, v_current
      from public.listing_slug_history h
      join public.listings l on l.id = h.listing_id
     where h.slug = p_slug;
  end if;

  if v_id is null or not v_visible then
    return query select 'not_found'::text, null::text, null::uuid, null::text;
    return;
  end if;

  if v_current then
    return query select 'found'::text, v_slug, v_id, v_type;
  else
    return query select 'moved'::text, v_slug, v_id, v_type;
  end if;
end;
$$;

comment on function app_private.public_listing_resolve(text) is
  'Which listing a public slug names, whether the public may see it, and whether it is a product or a service. The single place the public listing-state rules are applied for both surfaces.';

-- ---------------------------------------------------------------------------------------------------
-- The listing browse list — products only
-- ---------------------------------------------------------------------------------------------------
-- Unchanged from 0046 but for the type filter: services have their own surface now, and a service card
-- carries fields (delivery time, revisions, pricing model) that a listing card has no place for.
create or replace function app_private.public_listings(
  p_limit integer,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  slug text,
  title text,
  city text,
  price_minor bigint,
  currency_code text,
  currency_minor_unit smallint,
  is_negotiable boolean,
  listing_type_code text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select l.id,
         l.slug,
         l.title,
         l.city,
         l.price_minor,
         l.currency_code::text,
         c.decimal_places,
         l.is_negotiable,
         l.listing_type_code,
         l.created_at
    from public.listings l
    join public.currencies c on c.code = l.currency_code
   where public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
     and l.listing_type_code <> 'service'
     -- The cursor is a position, not an offset: strictly older than it, in the same total order.
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (l.created_at, l.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by l.created_at desc, l.id desc
   limit greatest(coalesce(p_limit, 20), 0);
$$;

comment on function app_private.public_listings(integer, timestamptz, uuid) is
  'One page of the public product browse list, newest first with the id as tie-breaker. Purchasable non-service listings of publicly visible sellers only; card fields only, never the seller, the location or the view count.';

-- ---------------------------------------------------------------------------------------------------
-- The service browse list
-- ---------------------------------------------------------------------------------------------------
-- The same keyset pagination, the same visibility, the same currency handling; a different projection
-- and the mirrored type filter. `listing_service_details` is joined on the left because the row is a
-- separate table: a service without one has no pricing model to state, and inventing `'fixed'` for it
-- would be asserting something nobody recorded.
create or replace function app_private.public_services(
  p_limit integer,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  slug text,
  title text,
  city text,
  price_minor bigint,
  currency_code text,
  currency_minor_unit smallint,
  pricing_model text,
  delivery_days smallint,
  revisions_included smallint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select l.id,
         l.slug,
         l.title,
         l.city,
         l.price_minor,
         l.currency_code::text,
         c.decimal_places,
         d.pricing_model,
         d.delivery_days,
         d.revisions_included,
         l.created_at
    from public.listings l
    join public.currencies c on c.code = l.currency_code
    left join public.listing_service_details d on d.listing_id = l.id
   where public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
     and l.listing_type_code = 'service'
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (l.created_at, l.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by l.created_at desc, l.id desc
   limit greatest(coalesce(p_limit, 20), 0);
$$;

comment on function app_private.public_services(integer, timestamptz, uuid) is
  'One page of the public service browse list, newest first with the id as tie-breaker. Purchasable service listings of publicly visible sellers only; card fields only, never the seller, the location or the view count.';

-- ---------------------------------------------------------------------------------------------------
-- Shared detail projections
-- ---------------------------------------------------------------------------------------------------
-- The attribute and tag shapes are identical on both detail surfaces, and they are the fiddliest part of
-- either reader. Lifted out of 0046 verbatim so there is one definition rather than two that must be
-- kept in step — a product and a service describe an attribute the same way.
create or replace function app_private.public_listing_attributes(p_listing_id uuid, p_locale text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select jsonb_agg(attribute order by attribute ->> 'key')
       from (
         select jsonb_build_object(
                  'key', d.key,
                  'label', case when p_locale = 'ar' then d.name_ar else d.name_en end,
                  'unit', d.unit,
                  'kind', d.data_type,
                  -- A number arrives as the value itself, with trailing zeros trimmed only when there is
                  -- a decimal point to trim them from: '180' must not become '18'. No thousands
                  -- separator and no rounding — display is the client's.
                  'text', case
                            when av.value_text is not null then av.value_text
                            when av.value_number is not null then
                              case when strpos(av.value_number::text, '.') > 0
                                   then rtrim(rtrim(av.value_number::text, '0'), '.')
                                   else av.value_number::text
                              end
                            else null
                          end,
                  'boolean', av.value_boolean,
                  'options', coalesce(
                    (select jsonb_agg(case when p_locale = 'ar' then o.label_ar else o.label_en end
                                      order by o.sort_order, o.value)
                       from public.attribute_options o
                      where o.attribute_definition_id = d.id
                        and o.id = any (av.option_ids)
                        and o.is_active),
                    '[]'::jsonb)
                ) as attribute
           from public.listing_attribute_values av
           join public.attribute_definitions d on d.id = av.attribute_definition_id
          where av.listing_id = p_listing_id and d.is_active
       ) rows),
    '[]'::jsonb);
$$;

comment on function app_private.public_listing_attributes(uuid, text) is
  'The public attribute projection for one listing, localized. Shared by the product and service detail readers.';

create or replace function app_private.public_listing_tags(p_listing_id uuid, p_locale text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select jsonb_agg(jsonb_build_object(
              'slug', t.slug,
              'name', case when p_locale = 'ar' then t.name_ar else t.name_en end)
            order by t.slug)
       from public.listing_tags lt
       join public.tags t on t.id = lt.tag_id
      where lt.listing_id = p_listing_id and t.is_active),
    '[]'::jsonb);
$$;

comment on function app_private.public_listing_tags(uuid, text) is
  'The public tag projection for one listing, localized. Shared by the product and service detail readers.';

-- ---------------------------------------------------------------------------------------------------
-- The detail readers
-- ---------------------------------------------------------------------------------------------------
-- Both gain a `canonical_type` column, so the return type changes and the old function goes first.
drop function if exists app_private.public_listing_by_slug(text, text);

-- `outcome` is the resolver's, with one addition each surface makes for itself: a slug that names a
-- listing of the *other* type is reported as `moved` to that listing's canonical slug, with
-- `canonical_type` naming the surface it belongs to. One slug, one canonical URL, on whichever surface
-- owns it — which is what keeps two public URLs from ever describing the same thing.
create or replace function app_private.public_listing_by_slug(
  p_slug text,
  p_locale text default null
) returns table (
  outcome text,
  canonical_slug text,
  canonical_type text,
  id uuid,
  slug text,
  title text,
  description text,
  content_language text,
  city text,
  price_minor bigint,
  currency_code text,
  currency_minor_unit smallint,
  is_negotiable boolean,
  listing_type_code text,
  created_at timestamptz,
  availability text,
  category jsonb,
  seller jsonb,
  attributes jsonb,
  tags jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_locale text;
  v_fallback text;
  v_outcome text;
  v_canonical text;
  v_id uuid;
  v_type text;
begin
  select r.outcome, r.canonical_slug, r.listing_id, r.listing_type_code
    into v_outcome, v_canonical, v_id, v_type
    from app_private.public_listing_resolve(p_slug) r;

  if v_outcome = 'not_found' then
    return query select 'not_found'::text, null::text, null::text, null::uuid, null::text, null::text,
                        null::text, null::text, null::text, null::bigint, null::text, null::smallint,
                        null::boolean, null::text, null::timestamptz, null::text, null::jsonb, null::jsonb,
                        null::jsonb, null::jsonb;
    return;
  end if;

  -- A service, or a slug this surface does not own: send the caller to the surface that does.
  if v_outcome = 'moved' or v_type = 'service' then
    return query select 'moved'::text, v_canonical, v_type, null::uuid, null::text, null::text,
                        null::text, null::text, null::text, null::bigint, null::text, null::smallint,
                        null::boolean, null::text, null::timestamptz, null::text, null::jsonb, null::jsonb,
                        null::jsonb, null::jsonb;
    return;
  end if;

  select coalesce(
    (select l.code from public.locales l where l.code = lower(btrim(coalesce(p_locale, ''))) and l.is_active),
    (select l.code from public.locales l where l.is_default limit 1)
  ) into v_locale;
  select l.code into v_fallback from public.locales l where l.is_default limit 1;

  return query
    select 'found'::text,
           l.slug,
           l.listing_type_code,
           l.id,
           l.slug,
           l.title,
           l.description,
           l.content_language,
           l.city,
           l.price_minor,
           l.currency_code::text,
           cur.decimal_places,
           l.is_negotiable,
           l.listing_type_code,
           l.created_at,
           case when public.listing_status_is_purchasable(l.status) then 'available' else 'no_longer_available' end,
           jsonb_build_object('slug', cat.slug, 'name', coalesce(ct.name, cd.name, cat.slug)),
           jsonb_build_object('slug', s.slug, 'displayName', s.display_name),
           app_private.public_listing_attributes(l.id, v_locale),
           app_private.public_listing_tags(l.id, v_locale)
      from public.listings l
      join public.currencies cur on cur.code = l.currency_code
      join public.categories cat on cat.id = l.category_id
      join public.seller_profiles s on s.user_id = l.seller_user_id
      left join public.category_translations ct on ct.category_id = cat.id and ct.locale_code = v_locale
      left join public.category_translations cd on cd.category_id = cat.id and cd.locale_code = v_fallback
     where l.id = v_id;
end;
$$;

comment on function app_private.public_listing_by_slug(text, text) is
  'One public product listing by slug, or a redirect to the canonical slug (and surface) that owns it, or nothing. Detail fields only: never the seller id, the view count, the location or any lifecycle history.';

create or replace function app_private.public_service_by_slug(
  p_slug text,
  p_locale text default null
) returns table (
  outcome text,
  canonical_slug text,
  canonical_type text,
  id uuid,
  slug text,
  title text,
  description text,
  content_language text,
  city text,
  price_minor bigint,
  currency_code text,
  currency_minor_unit smallint,
  pricing_model text,
  delivery_days smallint,
  revisions_included smallint,
  requires_brief boolean,
  scope text,
  availability text,
  category jsonb,
  seller jsonb,
  attributes jsonb,
  tags jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_locale text;
  v_fallback text;
  v_outcome text;
  v_canonical text;
  v_id uuid;
  v_type text;
begin
  select r.outcome, r.canonical_slug, r.listing_id, r.listing_type_code
    into v_outcome, v_canonical, v_id, v_type
    from app_private.public_listing_resolve(p_slug) r;

  if v_outcome = 'not_found' then
    return query select 'not_found'::text, null::text, null::text, null::uuid, null::text, null::text,
                        null::text, null::text, null::text, null::bigint, null::text, null::smallint,
                        null::text, null::smallint, null::smallint, null::boolean, null::text, null::text,
                        null::jsonb, null::jsonb, null::jsonb, null::jsonb;
    return;
  end if;

  -- A product, or a previous slug: send the caller to the surface and slug that own it.
  if v_outcome = 'moved' or v_type <> 'service' then
    return query select 'moved'::text, v_canonical, v_type, null::uuid, null::text, null::text,
                        null::text, null::text, null::text, null::bigint, null::text, null::smallint,
                        null::text, null::smallint, null::smallint, null::boolean, null::text, null::text,
                        null::jsonb, null::jsonb, null::jsonb, null::jsonb;
    return;
  end if;

  select coalesce(
    (select l.code from public.locales l where l.code = lower(btrim(coalesce(p_locale, ''))) and l.is_active),
    (select l.code from public.locales l where l.is_default limit 1)
  ) into v_locale;
  select l.code into v_fallback from public.locales l where l.is_default limit 1;

  return query
    select 'found'::text,
           l.slug,
           l.listing_type_code,
           l.id,
           l.slug,
           l.title,
           l.description,
           l.content_language,
           l.city,
           l.price_minor,
           l.currency_code::text,
           cur.decimal_places,
           d.pricing_model,
           d.delivery_days,
           d.revisions_included,
           d.requires_brief,
           d.scope,
           case when public.listing_status_is_purchasable(l.status) then 'available' else 'no_longer_available' end,
           jsonb_build_object('slug', cat.slug, 'name', coalesce(ct.name, cd.name, cat.slug)),
           jsonb_build_object('slug', s.slug, 'displayName', s.display_name),
           app_private.public_listing_attributes(l.id, v_locale),
           app_private.public_listing_tags(l.id, v_locale)
      from public.listings l
      join public.currencies cur on cur.code = l.currency_code
      join public.categories cat on cat.id = l.category_id
      join public.seller_profiles s on s.user_id = l.seller_user_id
      left join public.listing_service_details d on d.listing_id = l.id
      left join public.category_translations ct on ct.category_id = cat.id and ct.locale_code = v_locale
      left join public.category_translations cd on cd.category_id = cat.id and cd.locale_code = v_fallback
     where l.id = v_id;
end;
$$;

comment on function app_private.public_service_by_slug(text, text) is
  'One public service by slug, or a redirect to the canonical slug (and surface) that owns it, or nothing. Detail fields only: never the seller id, the view count, the location or any lifecycle history.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.public_listing_resolve(text) from public;
revoke execute on function app_private.public_listing_attributes(uuid, text) from public;
revoke execute on function app_private.public_listing_tags(uuid, text) from public;
revoke execute on function app_private.public_listings(integer, timestamptz, uuid) from public;
revoke execute on function app_private.public_services(integer, timestamptz, uuid) from public;
revoke execute on function app_private.public_listing_by_slug(text, text) from public;
revoke execute on function app_private.public_service_by_slug(text, text) from public;

grant execute on function app_private.public_listing_resolve(text) to app_system;
grant execute on function app_private.public_listing_attributes(uuid, text) to app_system;
grant execute on function app_private.public_listing_tags(uuid, text) to app_system;
grant execute on function app_private.public_listings(integer, timestamptz, uuid) to app_system;
grant execute on function app_private.public_services(integer, timestamptz, uuid) to app_system;
grant execute on function app_private.public_listing_by_slug(text, text) to app_system;
grant execute on function app_private.public_service_by_slug(text, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
