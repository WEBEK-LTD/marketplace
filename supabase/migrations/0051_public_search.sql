-- 0051 — Public search (Phase 4-F, V1).
--
-- One reader over the `listings` table, which already holds both products and services, using the
-- language-aware `tsvector` columns 0011 generated and the GIN indexes 0011 built. Nothing here is new
-- infrastructure: the vectors, the indexes and the visibility helpers all existed before this migration,
-- and the frozen generated columns are not touched.
--
-- **Ordering is provisional.** `created_at desc, id desc`, by owner decision, and explicitly a V1
-- placeholder: the approved ranking formula — admin weights, promoted results, slot caps — is a Phase 9
-- decision, and nothing here reads `promotion_ranking_settings` or merges a promotion. The consequence
-- is worth stating plainly: this is *recency-ordered filtering*, not relevance ranking. A better match
-- does not come first; a newer one does.
--
-- **Visibility is not re-decided here.** The same two helpers both browse lists call:
--
--   `public.listing_status_is_purchasable(status)` approved, active
--   `public.is_seller_publicly_visible(user_id)`   the seller's profile is active
--
-- so a draft, pending, rejected, sold, expired, archived, suspended or deleted listing cannot be found,
-- and neither can anything belonging to a seller who is not active. Search admits exactly what the two
-- browse surfaces admit, combined — no more, and by construction rather than by a rule written twice.
--
-- **`pg_trgm` is deliberately not used.** It exists (0001) and `listings_title_trgm` is indexed (0011),
-- but the `%` operator's behaviour depends on `pg_trgm.similarity_threshold`, a session GUC with no
-- approved value, and ordering by similarity would be ranking. Adding either would mean choosing a
-- number nobody has chosen. Typo tolerance therefore waits for the increment that decides its threshold.
--
-- **No filters, no distance, no cache.** Category, price, attribute, tag, seller and type filters are a
-- later contract; `location` and PostGIS are untouched because D4 geocoding is still deferred; Redis
-- caching waits for its own contract.

-- ---------------------------------------------------------------------------------------------------
-- The search reader
-- ---------------------------------------------------------------------------------------------------
-- The result set is mixed, so the row carries every card field of both surfaces and a `result_type` that
-- says which ones are meaningful. A service row leaves `is_negotiable` and `listing_type_code` null; a
-- listing row leaves `pricing_model`, `delivery_days` and `revisions_included` null. The API turns that
-- into the discriminated union the contract describes.
--
-- `websearch_to_tsquery` parses the query, rather than `to_tsquery`, because the input is whatever a
-- person typed into a box: it accepts quoted phrases and `or`, ignores stray punctuation, and — unlike
-- `to_tsquery` — never raises on malformed input. A search box that can be made to throw is a search box
-- that can be made to return a 500.
create or replace function app_private.public_search(
  p_query text,
  p_locale text default null,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  result_type text,
  id uuid,
  slug text,
  title text,
  city text,
  price_minor bigint,
  currency_code text,
  currency_minor_unit smallint,
  is_negotiable boolean,
  listing_type_code text,
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
  with asked as (
    -- Arabic is the only non-default configuration the schema generates a vector for; anything else,
    -- including an unknown locale, is searched in English. A locale is a representation choice.
    select lower(btrim(coalesce(p_locale, ''))) = 'ar' as arabic
  )
  select case when l.listing_type_code = 'service' then 'service' else 'listing' end,
         l.id,
         l.slug,
         l.title,
         l.city,
         l.price_minor,
         l.currency_code::text,
         c.decimal_places,
         case when l.listing_type_code = 'service' then null else l.is_negotiable end,
         case when l.listing_type_code = 'service' then null else l.listing_type_code end,
         case when l.listing_type_code = 'service' then d.pricing_model else null end,
         case when l.listing_type_code = 'service' then d.delivery_days else null end,
         case when l.listing_type_code = 'service' then d.revisions_included else null end,
         l.created_at
    from public.listings l
    join public.currencies c on c.code = l.currency_code
    left join public.listing_service_details d on d.listing_id = l.id
   cross join asked a
   where public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
     and case
           when a.arabic then l.search_vector_ar @@ websearch_to_tsquery('arabic'::regconfig, p_query)
           else l.search_vector_en @@ websearch_to_tsquery('english'::regconfig, p_query)
         end
     -- The cursor is a position, not an offset: strictly older than it, in the same total order.
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (l.created_at, l.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by l.created_at desc, l.id desc
   limit greatest(coalesce(p_limit, 20), 0);
$$;

comment on function app_private.public_search(text, text, integer, timestamptz, uuid) is
  'Public search over listing titles and descriptions, in English or Arabic. Returns purchasable products and services of publicly visible sellers, newest first with the id as tie-breaker. V1 ordering is provisional: the ranking formula and promoted-result merging are a Phase 9 decision, and nothing here reads promotion settings.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.public_search(text, text, integer, timestamptz, uuid) from public;
grant execute on function app_private.public_search(text, text, integer, timestamptz, uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
