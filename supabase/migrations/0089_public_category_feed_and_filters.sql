-- 0089 — The public category feed, and one filter language for it and for search.
--
-- Until now a visitor could walk the whole category tree 0087 made manageable and reach a dead end: the
-- public category reader returns a name, a description and the direct children, and nothing anywhere
-- returned the listings *in* a category. `public_listings` and `public_services` take a limit and a cursor
-- and nothing else. This migration adds the feed, and the filters 0051 recorded as "a later contract":
-- category, listing type, tag, attribute answer and price.
--
-- Five decisions are written here once, and everything else composes them.
--
-- **Rollup across descendants (owner decision).** A category's feed is the listings filed against it *and*
-- against every active category beneath it, inside the three levels D8 allows. A deactivated category
-- prunes its whole branch, because the walk down stops there — so hiding a mid-level category cannot widen
-- what a visitor sees, and a parent page is not empty while its children are full. The admin's
-- `listing_count` keeps its own direct-membership meaning (0087): that number answers "is a move or a
-- deactivation safe", which is a question about direct membership, and it is untouched.
--
-- **Visibility is not re-decided, anywhere.** Every reader here composes the same three helpers the rest of
-- the public surface already resolves through:
--
--   `app_private.public_category_visible(id)`      the category and every ancestor are active
--   `public.listing_status_is_purchasable(status)`  approved, active
--   `public.is_seller_publicly_visible(user_id)`    the seller's profile is active
--
-- so a draft, pending, rejected, sold, expired, archived, suspended or deleted listing cannot be reached
-- through a category or a filter, and neither can anything belonging to a seller who is not active. A
-- filter is a `where` clause on top of that set: **a filter can only ever narrow it.**
--
-- **One filter document, one definition.** The filters arrive as a `jsonb` document and are judged by two
-- functions — `catalog_filters_resolve` (is every value it names a real, active value?) and
-- `catalog_listing_matches` (does this listing satisfy it?) — which the feed, the facets and search all
-- call. The alternative was the same `where` clause written three times, and three copies of a rule are
-- three chances for a filtered search and a filtered category page to disagree about what a filter means.
--
-- **A value the vocabulary does not know makes the whole request empty**, rather than being dropped so the
-- request quietly widens to the values that were recognised. That is 0088's rule for a seller choosing
-- tags, applied to a reader: an unknown or hidden tag, attribute, option, listing type or currency returns
-- nothing at all. Silently ignoring it is the one behaviour that could show more than was asked for.
--
-- **Within one dimension the values are alternatives; across dimensions they accumulate.** Two chosen
-- options of the same attribute match a listing carrying either; a chosen option *and* a chosen tag match
-- only a listing carrying both. That is what makes a multi-select facet usable at all — the other reading
-- would make choosing a second option always return fewer things, and usually nothing.
--
-- **No ranking, no distance, no cache, no promotion.** Ordering is 0051's approved `created_at desc, id
-- desc` and nothing here reads a promotion, a weight or a slot cap; `location` and PostGIS are untouched
-- because D4 geocoding is deferred; `pg_trgm` stays unused because its similarity threshold has no
-- approved value. Facet counts are counts: arithmetic over the same visible, filtered set, never a
-- popularity signal and never an input to an order.
--
-- No table, column, constraint, index, trigger or policy is created or changed. Every function is a named
-- `app_private` SECURITY DEFINER function with a pinned `search_path`, revoked from `public` and granted to
-- `app_system` alone.

-- ---------------------------------------------------------------------------------------------------
-- The subtree a category's feed covers
-- ---------------------------------------------------------------------------------------------------
-- The root's own visibility is `public_category_visible`, which walks *up* and refuses if any ancestor is
-- deactivated. The walk down adds `is_active` per step, so a branch whose parent is hidden is never
-- entered. An unknown or invisible slug yields no rows, which every caller treats as "nothing here".
create or replace function app_private.public_category_subtree(p_slug text)
returns table (category_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive root as (
    select c.id
      from public.categories c
     where c.slug = p_slug
       and app_private.public_category_visible(c.id)
  ), tree as (
    select r.id from root r
    union all
    select c.id
      from public.categories c
      join tree t on c.parent_id = t.id
     where c.is_active
  )
  select id from tree;
$$;

comment on function app_private.public_category_subtree(text) is
  'The category a public slug names, plus every active category beneath it — the set one category feed covers (owner-approved rollup). Empty for a slug that names nothing, a deactivated category, or one under a deactivated ancestor. A deactivated category prunes its whole branch.';

-- ---------------------------------------------------------------------------------------------------
-- Is every value this filter document names a real, active value?
-- ---------------------------------------------------------------------------------------------------
-- False makes the whole request empty. The alternative — ignoring the parts that did not resolve — would
-- answer a narrower question than the one asked and return *more* rows than the caller expects, which is
-- the one direction a filter must never move.
--
-- Shape, all parts optional:
--
--   { "listingType": "product",
--     "tags": ["handmade"],
--     "attributes": [ {"key":"material","options":["oak"]},
--                     {"key":"assembled","boolean":true},
--                     {"key":"width","min":100,"max":200} ],
--     "price": {"currency":"<code>","min":"1000","max":"500000"} }   minor units, as strings
--
-- Every type is checked with `jsonb_typeof` before any cast, so no document can make a reader raise: a
-- search box that can be made to throw is a search box that can be made to return a 500.
create or replace function app_private.catalog_filters_resolve(p_filters jsonb)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    -- A document that is not an object at all is not a filter.
    coalesce(jsonb_typeof(p_filters), 'null') in ('object', 'null')
    -- The listing type must be a seeded one.
    and (
      p_filters -> 'listingType' is null
      or coalesce(jsonb_typeof(p_filters -> 'listingType'), 'absent') = 'null'
      or exists (
        select 1 from public.listing_types t where t.code = p_filters ->> 'listingType'
      )
    )
    -- Every tag must exist and be shown.
    and (
      p_filters -> 'tags' is null
      or (
        coalesce(jsonb_typeof(p_filters -> 'tags'), 'absent') = 'array'
        and not exists (
          select 1
            from jsonb_array_elements_text(p_filters -> 'tags') as asked(slug)
           where not exists (
             select 1 from public.tags t where t.slug = asked.slug and t.is_active
           )
        )
      )
    )
    -- Every attribute must exist, be shown, and be named with a value its own kind can take.
    and (
      p_filters -> 'attributes' is null
      or (
        coalesce(jsonb_typeof(p_filters -> 'attributes'), 'absent') = 'array'
        and not exists (
          select 1
            from jsonb_array_elements(p_filters -> 'attributes') as asked(spec)
            left join public.attribute_definitions d
              on d.key = asked.spec ->> 'key' and d.is_active
           where d.id is null
              -- A select attribute is filtered by options, and every option must be one of its own.
              or (
                coalesce(jsonb_typeof(asked.spec -> 'options'), 'absent') = 'array'
                and (
                  d.data_type not in ('single_select', 'multi_select')
                  or exists (
                    select 1
                      from jsonb_array_elements_text(asked.spec -> 'options') as chosen(value)
                     where not exists (
                       select 1 from public.attribute_options o
                        where o.attribute_definition_id = d.id
                          and o.value = chosen.value
                          and o.is_active
                     )
                  )
                )
              )
              -- A boolean is filtered by a boolean, a number by a number.
              or (coalesce(jsonb_typeof(asked.spec -> 'boolean'), 'absent') = 'boolean' and d.data_type <> 'boolean')
              or (coalesce(jsonb_typeof(asked.spec -> 'min'), 'absent') = 'number' and d.data_type <> 'number')
              or (coalesce(jsonb_typeof(asked.spec -> 'max'), 'absent') = 'number' and d.data_type <> 'number')
              -- An attribute named with nothing to match on narrows nothing, and is a malformed request
              -- rather than a no-op: a reader that ignored it would answer a different question.
              or (
                coalesce(jsonb_typeof(asked.spec -> 'options'), 'absent') <> 'array'
                and coalesce(jsonb_typeof(asked.spec -> 'boolean'), 'absent') <> 'boolean'
                and coalesce(jsonb_typeof(asked.spec -> 'min'), 'absent') <> 'number'
                and coalesce(jsonb_typeof(asked.spec -> 'max'), 'absent') <> 'number'
              )
        )
      )
    )
    -- A price bound is meaningless without a currency, and the currency must be one listings may be
    -- priced in. There is no FX anywhere in V1, so a bound compares only within its own currency.
    and (
      p_filters -> 'price' is null
      or (
        coalesce(jsonb_typeof(p_filters -> 'price'), 'absent') = 'object'
        and exists (
          select 1 from public.currencies c
           where c.code = p_filters -> 'price' ->> 'currency'
             and c.is_pricing_enabled
             and c.retired_at is null
        )
        -- A bound is a whole number of minor units carried as a string, which is this project's money
        -- JSON rule (Phase 1 Step 2): `bigint` outlives what a JSON number can hold exactly.
        and coalesce(jsonb_typeof(p_filters -> 'price' -> 'min'), 'absent') in ('null', 'absent', 'string')
        and coalesce(jsonb_typeof(p_filters -> 'price' -> 'max'), 'absent') in ('null', 'absent', 'string')
        and (coalesce(jsonb_typeof(p_filters -> 'price' -> 'min'), 'absent') <> 'string'
             or p_filters -> 'price' ->> 'min' ~ '^-?[0-9]{1,18}$')
        and (coalesce(jsonb_typeof(p_filters -> 'price' -> 'max'), 'absent') <> 'string'
             or p_filters -> 'price' ->> 'max' ~ '^-?[0-9]{1,18}$')
      )
    );
$$;

comment on function app_private.catalog_filters_resolve(jsonb) is
  'Whether every value a filter document names is a real, active value: a seeded listing type, shown tags, shown attributes filtered by a value their own kind can take, options belonging to their attribute, and a pricing-enabled currency for a price bound. False makes the whole request empty rather than letting it quietly widen to the values that did resolve.';

-- ---------------------------------------------------------------------------------------------------
-- Does one listing satisfy the filter document?
-- ---------------------------------------------------------------------------------------------------
-- One definition, called by the feed, the facets and search. Within a dimension the values are
-- alternatives; across dimensions they accumulate — the "not exists an unsatisfied filter" shape below is
-- how "every named attribute must match" is said in one pass.
--
-- Hidden definitions and hidden options are not matched, so hiding either removes it from every filter at
-- once while the seller's stored answer stays exactly where it is.
create or replace function app_private.catalog_listing_matches(p_listing_id uuid, p_filters jsonb)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    -- The listing type, which lives on the row itself.
    (
      p_filters -> 'listingType' is null
      or coalesce(jsonb_typeof(p_filters -> 'listingType'), 'absent') = 'null'
      or exists (
        select 1 from public.listings l
         where l.id = p_listing_id and l.listing_type_code = p_filters ->> 'listingType'
      )
    )
    -- The price, in the currency the filter names and no other. A listing with no price — a
    -- custom-priced service — cannot satisfy a price bound, and is excluded rather than assumed cheap.
    and (
      p_filters -> 'price' is null
      or exists (
        select 1 from public.listings l
         where l.id = p_listing_id
           and l.price_minor is not null
           and l.currency_code::text = p_filters -> 'price' ->> 'currency'
           and (coalesce(jsonb_typeof(p_filters -> 'price' -> 'min'), 'absent') <> 'string'
                or l.price_minor >= (p_filters -> 'price' ->> 'min')::bigint)
           and (coalesce(jsonb_typeof(p_filters -> 'price' -> 'max'), 'absent') <> 'string'
                or l.price_minor <= (p_filters -> 'price' ->> 'max')::bigint)
      )
    )
    -- The tags: any one of those asked for is enough, because they are one dimension.
    and (
      p_filters -> 'tags' is null
      or jsonb_array_length(p_filters -> 'tags') = 0
      or exists (
        select 1
          from public.listing_tags lt
          join public.tags t on t.id = lt.tag_id and t.is_active
         where lt.listing_id = p_listing_id
           and t.slug in (select value from jsonb_array_elements_text(p_filters -> 'tags'))
      )
    )
    -- Every attribute asked about must be answered acceptably. Read as: there is no named attribute for
    -- which this listing has no matching answer.
    and not exists (
      select 1
        from jsonb_array_elements(coalesce(p_filters -> 'attributes', '[]'::jsonb)) as asked(spec)
       where not exists (
         select 1
           from public.listing_attribute_values v
           join public.attribute_definitions d
             on d.id = v.attribute_definition_id
            and d.is_active
            and d.key = asked.spec ->> 'key'
          where v.listing_id = p_listing_id
            and (
              -- Any one of the chosen options, which is what makes a multi-select facet usable.
              (
                coalesce(jsonb_typeof(asked.spec -> 'options'), 'absent') = 'array'
                and exists (
                  select 1
                    from jsonb_array_elements_text(asked.spec -> 'options') as chosen(value)
                    join public.attribute_options o
                      on o.attribute_definition_id = d.id
                     and o.value = chosen.value
                     and o.is_active
                   where o.id = any (v.option_ids)
                )
              )
              -- A boolean compared as a boolean, never as text.
              or (
                coalesce(jsonb_typeof(asked.spec -> 'boolean'), 'absent') = 'boolean'
                and v.value_boolean is not null
                and to_jsonb(v.value_boolean) = asked.spec -> 'boolean'
              )
              -- An inclusive range, with either end optional.
              or (
                (coalesce(jsonb_typeof(asked.spec -> 'min'), 'absent') = 'number' or coalesce(jsonb_typeof(asked.spec -> 'max'), 'absent') = 'number')
                and v.value_number is not null
                and (coalesce(jsonb_typeof(asked.spec -> 'min'), 'absent') <> 'number'
                     or v.value_number >= (asked.spec ->> 'min')::numeric)
                and (coalesce(jsonb_typeof(asked.spec -> 'max'), 'absent') <> 'number'
                     or v.value_number <= (asked.spec ->> 'max')::numeric)
              )
            )
       )
    );
$$;

comment on function app_private.catalog_listing_matches(uuid, jsonb) is
  'Whether one listing satisfies a filter document. Within a dimension the values are alternatives, across dimensions they accumulate. Hidden definitions and hidden options match nothing, so hiding either removes it from every filter while the stored answer survives. The single definition of what a filter means, composed by the category feed, the facets and search.';

-- ---------------------------------------------------------------------------------------------------
-- The category feed
-- ---------------------------------------------------------------------------------------------------
-- The same fourteen-column projection `public_search` declares, for the same reason: one category can
-- hold products and services — `categories.listing_type_code` may be either or neither — so the result is
-- mixed, each surface keeps its own card fields, and `result_type` says which ones are meaningful.
--
-- Ordering is 0051's: newest first with the id as tie-breaker, and the cursor is a position in that same
-- total order rather than an offset.
create or replace function app_private.public_category_feed(
  p_slug text,
  p_filters jsonb default '{}'::jsonb,
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
   where app_private.catalog_filters_resolve(p_filters)
     and l.category_id in (select category_id from app_private.public_category_subtree(p_slug))
     and public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
     and app_private.catalog_listing_matches(l.id, p_filters)
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (l.created_at, l.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by l.created_at desc, l.id desc
   limit greatest(coalesce(p_limit, 20), 0);
$$;

comment on function app_private.public_category_feed(text, jsonb, integer, timestamptz, uuid) is
  'One page of the listings in a public category and every active category beneath it (owner-approved rollup), narrowed by the filter document. Purchasable products and services of publicly visible sellers only; card fields only, never the seller, the location or the view count. Newest first with the id as tie-breaker — 0051''s provisional ordering, unchanged, and no ranking.';

-- ---------------------------------------------------------------------------------------------------
-- Search, with the same filters
-- ---------------------------------------------------------------------------------------------------
-- The body is 0051's, unchanged in every respect but the two filter calls, so a filtered search and a
-- filtered category page cannot mean different things by the same filter.
create or replace function app_private.public_catalog_search(
  p_query text,
  p_locale text default null,
  p_filters jsonb default '{}'::jsonb,
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
   where app_private.catalog_filters_resolve(p_filters)
     and public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
     and case
           when a.arabic then l.search_vector_ar @@ websearch_to_tsquery('arabic'::regconfig, p_query)
           else l.search_vector_en @@ websearch_to_tsquery('english'::regconfig, p_query)
         end
     and app_private.catalog_listing_matches(l.id, p_filters)
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (l.created_at, l.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by l.created_at desc, l.id desc
   limit greatest(coalesce(p_limit, 20), 0);
$$;

comment on function app_private.public_catalog_search(text, text, jsonb, integer, timestamptz, uuid) is
  'Public search over listing titles and descriptions, in English or Arabic, narrowed by the same filter document the category feed takes. 0051''s reader with filters added and nothing else changed: the same visibility helpers, the same provisional newest-first ordering, and no promotion setting, weight or slot cap read anywhere.';

-- 0051's signature stays exactly as it was and keeps its own tests: it is now a thin delegation, so there
-- is still only one search body in the schema and an unfiltered search cannot drift from a filtered one.
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
  select * from app_private.public_catalog_search(
    p_query, p_locale, '{}'::jsonb, p_limit, p_cursor_created_at, p_cursor_id
  );
$$;

comment on function app_private.public_search(text, text, integer, timestamptz, uuid) is
  'Unfiltered public search: 0051''s signature, now delegating to app_private.public_catalog_search with an empty filter document so one body serves both. Returns purchasable products and services of publicly visible sellers, newest first with the id as tie-breaker. V1 ordering is provisional: the ranking formula and promoted-result merging are a Phase 9 decision, and nothing here reads promotion settings.';

-- ---------------------------------------------------------------------------------------------------
-- The facets a category offers
-- ---------------------------------------------------------------------------------------------------
-- One row shape for every kind of facet, so the contract above it groups rather than branches.
--
-- **Which values are offered** comes from the vocabulary and from the subtree's own visible listings, with
-- the active filters *ignored*: an attribute's active options, the tags some visible listing in the
-- subtree carries, the currencies some visible listing is priced in, the listing types present. That is
-- deliberate — a value that vanished because it currently matches nothing would take the visitor's own
-- selection away with it, and a filter panel that cannot be undone is a trap.
--
-- **Every count** is computed under exactly the semantics of the result set: the same subtree, the same
-- three visibility helpers, the same active filter document, plus the value the row is about. So a count
-- of zero is an honest "this would show you nothing", and the sum of a dimension's counts is not expected
-- to equal the result total — one listing can carry two tags.
--
-- An attribute is offered only when the category asks for it filterably *and* the definition is marked
-- filterable *and* the definition is shown: `is_filterable` is recorded in two places (0010), the
-- per-category intent and the vocabulary's own, and an attribute needs both to appear. Text attributes are
-- never offered: there is nothing to enumerate, and a free-text filter is not in this increment.
create or replace function app_private.public_category_facets(
  p_slug text,
  p_locale text default null,
  p_filters jsonb default '{}'::jsonb
) returns table (
  facet_kind text,
  attribute_key text,
  attribute_label text,
  data_type text,
  unit text,
  attribute_sort_order integer,
  value text,
  label text,
  value_sort_order integer,
  match_count integer,
  number_min numeric,
  number_max numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with arabic as (
    select lower(btrim(coalesce(p_locale, ''))) = 'ar' as yes
  ), subtree as (
    select category_id from app_private.public_category_subtree(p_slug)
  ),
  -- Every listing a visitor could reach through this category, before any filter. The vocabulary a panel
  -- offers is drawn from here.
  visible as (
    select l.id, l.listing_type_code, l.currency_code::text as currency_code, l.price_minor
      from public.listings l
     where l.category_id in (select category_id from subtree)
       and public.listing_status_is_purchasable(l.status)
       and public.is_seller_publicly_visible(l.seller_user_id)
  ),
  -- And the ones the active filters leave. Counts come from here.
  matching as (
    select v.id, v.listing_type_code, v.currency_code, v.price_minor
      from visible v
     where app_private.catalog_filters_resolve(p_filters)
       and app_private.catalog_listing_matches(v.id, p_filters)
  ),
  -- The attributes this category asks about and means to be filtered by.
  filterable as (
    select distinct d.id, d.key, d.data_type, d.unit,
           case when (select yes from arabic) then d.name_ar else d.name_en end as label,
           min(ca.sort_order) over (partition by d.id) as sort_order
      from public.category_attributes ca
      join public.attribute_definitions d
        on d.id = ca.attribute_definition_id
       and d.is_active
       and d.is_filterable
     where ca.category_id in (select category_id from subtree)
       and ca.is_filterable
  )
  -- One row per option of every select attribute.
  select 'attribute'::text,
         f.key,
         f.label,
         f.data_type,
         f.unit,
         f.sort_order,
         o.value,
         case when (select yes from arabic) then o.label_ar else o.label_en end,
         o.sort_order,
         (select count(*)::integer
            from matching m
            join public.listing_attribute_values v
              on v.listing_id = m.id and v.attribute_definition_id = f.id
           where o.id = any (v.option_ids)),
         null::numeric,
         null::numeric
    from filterable f
    join public.attribute_options o on o.attribute_definition_id = f.id and o.is_active
   where f.data_type in ('single_select', 'multi_select')

  union all

  -- Two rows per boolean attribute: a yes and a no are its whole domain.
  select 'attribute'::text,
         f.key,
         f.label,
         f.data_type,
         f.unit,
         f.sort_order,
         answer.value,
         answer.value,
         answer.position,
         (select count(*)::integer
            from matching m
            join public.listing_attribute_values v
              on v.listing_id = m.id and v.attribute_definition_id = f.id
           where v.value_boolean = (answer.value = 'true')),
         null::numeric,
         null::numeric
    from filterable f
   cross join (values ('true', 0), ('false', 1)) as answer(value, position)
   where f.data_type = 'boolean'

  union all

  -- One row per number attribute, carrying the range the matching listings actually span. A panel needs
  -- bounds to draw two boxes; it does not need a bucket, and inventing buckets would be inventing a rule.
  select 'attribute'::text,
         f.key,
         f.label,
         f.data_type,
         f.unit,
         f.sort_order,
         null::text,
         null::text,
         0,
         (select count(*)::integer
            from matching m
            join public.listing_attribute_values v
              on v.listing_id = m.id and v.attribute_definition_id = f.id
           where v.value_number is not null),
         (select min(v.value_number)
            from matching m
            join public.listing_attribute_values v
              on v.listing_id = m.id and v.attribute_definition_id = f.id),
         (select max(v.value_number)
            from matching m
            join public.listing_attribute_values v
              on v.listing_id = m.id and v.attribute_definition_id = f.id)
    from filterable f
   where f.data_type = 'number'

  union all

  -- The tags some visible listing in this subtree carries.
  select 'tag'::text,
         null::text,
         null::text,
         null::text,
         null::text,
         0,
         t.slug,
         case when (select yes from arabic) then t.name_ar else t.name_en end,
         0,
         (select count(*)::integer
            from matching m
            join public.listing_tags lt on lt.listing_id = m.id and lt.tag_id = t.id),
         null::numeric,
         null::numeric
    from public.tags t
   where t.is_active
     and exists (
       select 1 from public.listing_tags lt join visible v on v.id = lt.listing_id
        where lt.tag_id = t.id
     )

  union all

  -- The listing types present, which is what makes the product/service choice meaningful in a category
  -- that holds both and absent in one that holds either.
  select 'listing_type'::text,
         null::text,
         null::text,
         null::text,
         null::text,
         0,
         present.listing_type_code,
         present.listing_type_code,
         0,
         (select count(*)::integer from matching m where m.listing_type_code = present.listing_type_code),
         null::numeric,
         null::numeric
    from (select distinct v.listing_type_code from visible v) as present

  union all

  -- The currencies the visible listings are priced in, with the span of prices among the matching ones.
  -- This is where a price filter's currency comes from: it is read from the data and from `currencies`,
  -- never named in application source.
  select 'currency'::text,
         null::text,
         null::text,
         null::text,
         null::text,
         0,
         present.currency_code,
         present.currency_code,
         c.decimal_places::integer,
         (select count(*)::integer
            from matching m
           where m.currency_code = present.currency_code and m.price_minor is not null),
         (select min(m.price_minor)::numeric
            from matching m
           where m.currency_code = present.currency_code and m.price_minor is not null),
         (select max(m.price_minor)::numeric
            from matching m
           where m.currency_code = present.currency_code and m.price_minor is not null)
    from (select distinct v.currency_code from visible v where v.price_minor is not null) as present
    join public.currencies c on c.code = present.currency_code

   order by 1, 6, 2, 9, 7;
$$;

comment on function app_private.public_category_facets(text, text, jsonb) is
  'The filters one public category offers, localized: an option row per active option of every attribute the category asks for filterably, a yes and a no per boolean, a range row per number, the tags its visible listings carry, the listing types present, and the currencies they are priced in. The values offered ignore the active filters so a selection can always be undone; every count is computed under the same subtree, the same visibility helpers and the same active filters as the result set. Counts are arithmetic: nothing here ranks.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.public_category_subtree(text) from public;
revoke execute on function app_private.catalog_filters_resolve(jsonb) from public;
revoke execute on function app_private.catalog_listing_matches(uuid, jsonb) from public;
revoke execute on function app_private.public_category_feed(text, jsonb, integer, timestamptz, uuid) from public;
revoke execute on function app_private.public_catalog_search(text, text, jsonb, integer, timestamptz, uuid) from public;
revoke execute on function app_private.public_category_facets(text, text, jsonb) from public;
revoke execute on function app_private.public_search(text, text, integer, timestamptz, uuid) from public;

grant execute on function app_private.public_category_subtree(text) to app_system;
grant execute on function app_private.catalog_filters_resolve(jsonb) to app_system;
grant execute on function app_private.catalog_listing_matches(uuid, jsonb) to app_system;
grant execute on function app_private.public_category_feed(text, jsonb, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.public_catalog_search(text, text, jsonb, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.public_category_facets(text, text, jsonb) to app_system;
grant execute on function app_private.public_search(text, text, integer, timestamptz, uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
select app_private.assert_security_contract();
