-- 0046 — Reading public listings (Phase 4-B).
--
-- Two readers, built on the pattern 0045 established for categories: SECURITY DEFINER in `app_private`,
-- pinned `search_path`, EXECUTE to `app_system` alone, no table privilege, nothing to `anon`, and a
-- fixed projection that cannot be widened by a caller.
--
-- **Visibility is not re-decided here.** 0011 and 0009 already own it, and both readers call the same
-- helpers the RLS policy calls:
--
--   `public.listing_status_is_public(status)`      approved, active, sold, expired, archived
--   `public.listing_status_is_purchasable(status)` approved, active
--   `public.is_seller_publicly_visible(user_id)`   the seller's profile is active
--
-- The browse list uses *purchasable*, the detail reader uses *public*. That is the specification's own
-- split: a sold, expired or archived listing keeps a reachable page that says "No longer available"
-- (D2, N7), while the same states are "excluded from sitemaps and active search". A browse list is the
-- active surface, and a card with no availability marker on it — the approved card carries eight fields
-- and no marker — would otherwise present a sold item as if it could be bought.
--
-- **Nothing private is selected.** No `seller_user_id`, no `view_count`, no `location`, no lifecycle
-- timestamps beyond `created_at`, and from the seller only `display_name` and `slug`. The columns are
-- not filtered out downstream; they are never read.
--
-- **No search, no geocoding, no media.** The `tsvector` columns, the PostGIS point and the media tables
-- exist and are deliberately untouched: ranking is a Phase 9 decision, D4 is unresolved, and image
-- variant keys are still a proposal.

-- ---------------------------------------------------------------------------------------------------
-- The browse list
-- ---------------------------------------------------------------------------------------------------
-- Keyset pagination, not offset. `(created_at, id)` is a total order — `created_at` is the sort the
-- owner approved and `id` breaks ties — so a cursor names an exact position rather than a count of rows
-- that may have shifted. A listing published while someone reads page two therefore cannot push a row
-- onto page three unseen, which is exactly what `offset` does.
--
-- The currency's minor unit travels with the price because the money package has no built-in currency
-- table ("No currency is built in"), so a client cannot turn 125000 into a formatted amount without it.
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
  'One page of the public browse list, newest first with the id as tie-breaker. Purchasable listings of publicly visible sellers only; card fields only, never the seller, the location or the view count.';

-- ---------------------------------------------------------------------------------------------------
-- The detail page
-- ---------------------------------------------------------------------------------------------------
-- One call answers three questions the page asks: does this slug name a listing anyone may see, is it
-- still available, and is this slug the current one. `outcome` carries the answer:
--
--   found      the slug is current; render the listing
--   moved      the slug is a previous one; 301 to `canonical_slug`
--   not_found  no listing, or one in a state the public never sees
--
-- A previous slug of a listing that is *not* publicly visible reports `not_found` rather than `moved`:
-- redirecting to a page that would 404 tells a visitor the listing exists, which the non-public states
-- exist to avoid.
create or replace function app_private.public_listing_by_slug(
  p_slug text,
  p_locale text default null
) returns table (
  outcome text,
  canonical_slug text,
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
  v_id uuid;
  v_current_slug text;
  v_visible boolean := false;
begin
  select coalesce(
    (select l.code from public.locales l where l.code = lower(btrim(coalesce(p_locale, ''))) and l.is_active),
    (select l.code from public.locales l where l.is_default limit 1)
  ) into v_locale;
  select l.code into v_fallback from public.locales l where l.is_default limit 1;

  -- The current slug first: the common case, and the only one that renders a page.
  select l.id, l.slug,
         public.listing_status_is_public(l.status) and public.is_seller_publicly_visible(l.seller_user_id)
    into v_id, v_current_slug, v_visible
    from public.listings l
   where l.slug = p_slug;

  if v_id is null then
    -- A previous slug. `listing_slug_history.slug` is unique across the table, so at most one matches.
    select l.id, l.slug,
           public.listing_status_is_public(l.status) and public.is_seller_publicly_visible(l.seller_user_id)
      into v_id, v_current_slug, v_visible
      from public.listing_slug_history h
      join public.listings l on l.id = h.listing_id
     where h.slug = p_slug;

    if v_id is null or not v_visible then
      return query select 'not_found'::text, null::text, null::uuid, null::text, null::text, null::text,
                          null::text, null::text, null::bigint, null::text, null::smallint, null::boolean,
                          null::text, null::timestamptz, null::text, null::jsonb, null::jsonb, null::jsonb,
                          null::jsonb;
      return;
    end if;

    return query select 'moved'::text, v_current_slug, null::uuid, null::text, null::text, null::text,
                        null::text, null::text, null::bigint, null::text, null::smallint, null::boolean,
                        null::text, null::timestamptz, null::text, null::jsonb, null::jsonb, null::jsonb,
                        null::jsonb;
    return;
  end if;

  if not v_visible then
    return query select 'not_found'::text, null::text, null::uuid, null::text, null::text, null::text,
                        null::text, null::text, null::bigint, null::text, null::smallint, null::boolean,
                        null::text, null::timestamptz, null::text, null::jsonb, null::jsonb, null::jsonb,
                        null::jsonb;
    return;
  end if;

  return query
    select 'found'::text,
           l.slug,
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
           -- The approved marker. Purchasable states are available; the rest of the public states are
           -- the "No longer available" page the specification describes.
           case when public.listing_status_is_purchasable(l.status) then 'available' else 'no_longer_available' end,
           jsonb_build_object(
             'slug', cat.slug,
             'name', coalesce(ct.name, cd.name, cat.slug)
           ),
           jsonb_build_object(
             'slug', s.slug,
             'displayName', s.display_name
           ),
           coalesce(
             (select jsonb_agg(attribute order by attribute ->> 'key')
                from (
                  select jsonb_build_object(
                           'key', d.key,
                           'label', case when v_locale = 'ar' then d.name_ar else d.name_en end,
                           'unit', d.unit,
                           'kind', d.data_type,
                           -- A number arrives as the value itself, with trailing zeros trimmed only
                           -- when there is a decimal point to trim them from: '180' must not become
                           -- '18'. No thousands separator and no rounding — display is the client's.
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
                             (select jsonb_agg(case when v_locale = 'ar' then o.label_ar else o.label_en end
                                               order by o.sort_order, o.value)
                                from public.attribute_options o
                               where o.attribute_definition_id = d.id
                                 and o.id = any (av.option_ids)
                                 and o.is_active),
                             '[]'::jsonb)
                         ) as attribute
                    from public.listing_attribute_values av
                    join public.attribute_definitions d on d.id = av.attribute_definition_id
                   where av.listing_id = l.id and d.is_active
                ) rows),
             '[]'::jsonb),
           coalesce(
             (select jsonb_agg(jsonb_build_object(
                       'slug', t.slug,
                       'name', case when v_locale = 'ar' then t.name_ar else t.name_en end)
                     order by t.slug)
                from public.listing_tags lt
                join public.tags t on t.id = lt.tag_id
               where lt.listing_id = l.id and t.is_active),
             '[]'::jsonb)
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
  'One public listing by slug, or a redirect to its current slug, or nothing. Detail fields only: never the seller id, the view count, the location or any lifecycle history. The seller projection is display_name and slug alone.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.public_listings(integer, timestamptz, uuid) from public;
revoke execute on function app_private.public_listing_by_slug(text, text) from public;

grant execute on function app_private.public_listings(integer, timestamptz, uuid) to app_system;
grant execute on function app_private.public_listing_by_slug(text, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
