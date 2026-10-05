-- 0093 — The homepage: the named definer functions that compose it and author it.
--
-- 0030 built `public.homepage_sections` and then left it unreachable: a `section_key`, a nine-value
-- `section_type`, bilingual titles and subtitles, a `config jsonb` constrained to an object, a `sort_order`, an
-- `is_active` flag, a partial index for the active set and an audit trigger — and not one function the
-- application could call. `app_system` holds no table privileges, so every read and every write goes through a
-- named SECURITY DEFINER function. This migration adds exactly those functions.
--
-- Nothing about the schema changes here. No column, constraint, index, trigger or policy of 0030 is touched,
-- and no table is created.
--
-- WHAT A SECTION IS, AND WHAT IT IS NOT
--
-- 0030's own comment states the principle every reader below follows: **`config` holds ids of marketplace rows,
-- never copies of them.** A section names what to show; the rows themselves are read live, through the
-- visibility predicates that already own that question. So a curated listing that has since been sold, a seller
-- who has been suspended and a category that has been deactivated all disappear from the homepage by
-- themselves, with nothing here deciding it a second time.
--
-- THE OWNER DECISIONS FOR THIS INCREMENT (0093)
--
--   * **A — featured means editorial, and only editorial.** A featured section is the ordered ids an
--     administrator chose. **Nothing in this migration reads a promotion, a promotion package, a placement, a
--     ranking setting, a wallet or any payment row.** That is deliberate twice over: `promotion_package_placements`
--     already has a `homepage` placement and promotions are paid, so reading them here would open a financial
--     path; and 0089 records twice that the ranking formula and promoted-result merging are a **Phase 9**
--     decision. Neither is pre-empted.
--   * **B — each section type has one config shape**, checked in the contract layer and never guessed at here:
--     `hero`, `value_props` and `rich_text` carry text; the three `featured_*` types carry an ordered id array
--     with a maximum; `latest_listings` and `blog_highlights` carry a count, because "latest" is a query and not
--     a selection. This migration serves `config` to the caller as stored and resolves ids on request; it does
--     not interpret the document.
--   * **C — content that has disappeared is omitted.** A resolver returns the rows that are still visible and
--     nothing else; a section left with none of its content is skipped by the public surface. The staff reader
--     reports the counts so a console can show an operator that a section has gone empty.
--   * **D — `rich_text` is text.** Nothing here renders anything, but the column is served as stored and no
--     reader below treats it as markup.
--   * **E — the homepage is indexable.** That is a decision the web layer carries out; this migration only
--     makes the content available.
--
-- `banner_strip` is one of 0030's nine types and is **deliberately not served**. A banner is its image, and this
-- platform has no media origin: `PUBLIC_WEB_ORIGIN` is the only origin in the environment inventory and it is
-- deferred until the production domain is chosen, so there is nothing to build an image URL from. The
-- `public.banners` table therefore keeps its rows, its `banner_is_live()` predicate and no reader, exactly as
-- 0030 left it. The section type stays in the constraint untouched; the public reader simply never returns one.
--
-- ORDER IS THE ADMINISTRATOR'S, AND IT IS PRESERVED EXACTLY
--
-- Every by-id resolver joins `unnest(…) with ordinality` rather than filtering with `= any(…)`. A curated order
-- that silently became the planner's order would be a bug nobody could see on a screen, and `= any` gives no
-- ordering guarantee at all.
--
-- AUDIT ATTRIBUTION
--
-- These writers do **not** touch the 8-B attribution channel. 8-B's approved scope is the financial subset, and
-- `public.audit_attribution_problems()` fails any function that names the channel without being in the approved
-- contract. `homepage_sections` has no `created_by`/`updated_by` column, so there is no row-level actor to write
-- either: the audit trigger 0030 installed records the change itself, which is what that table was given.
--
-- WHAT IS NOT HERE
--
-- Banners, navigation menus, FAQs, promoted or paid placement, any ranking or popularity signal, the four
-- addresses the specification still reserves, a revalidation consumer and any media-origin work are all out of
-- scope by instruction.

-- ---------------------------------------------------------------------------------------------------
-- 1. The two permission predicates
-- ---------------------------------------------------------------------------------------------------
-- Both keys are seeded in 0033 (`cms.homepage.read`, `cms.homepage.manage`). Neither is invented, granted or
-- assigned here, and no role name is tested anywhere: 0003's own `requires_mfa` rule is applied to the
-- assurance level as a parameter, exactly as every other console gate does it.
create or replace function app_private.homepage_can_read(
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
       and rp.permission_key = 'cms.homepage.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.homepage_can_read(uuid, boolean) is
  'Whether one account effectively holds cms.homepage.read — the key as a literal, with 0003''s own requires_mfa rule applied to the assurance level as a parameter. No role name is tested anywhere.';

create or replace function app_private.homepage_can_manage(
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
       and rp.permission_key = 'cms.homepage.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.homepage_can_manage(uuid, boolean) is
  'Whether one account effectively holds cms.homepage.manage — the separate key every write below requires. A reader may hold the first key and not this one, which is why the detail reports the capability.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The types this increment serves
-- ---------------------------------------------------------------------------------------------------
-- A named function rather than a literal repeated in three places, so the one exclusion this increment makes is
-- stated once and cannot drift. `banner_strip` is absent because a banner is an image and there is no media
-- origin to address one with; the type remains legal in 0030's constraint and simply has no reader.
create or replace function app_private.homepage_section_type_is_served(p_section_type text) returns boolean
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select p_section_type in (
    'hero', 'featured_listings', 'featured_categories', 'featured_sellers',
    'latest_listings', 'blog_highlights', 'value_props', 'rich_text'
  );
$$;

comment on function app_private.homepage_section_type_is_served(text) is
  'The eight of 0030''s nine section types this increment serves. banner_strip is excluded because a banner is its image and no media origin exists to build one from; the type stays legal and has no reader.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The public section reader
-- ---------------------------------------------------------------------------------------------------
-- The active sections in the administrator's order, titled in the requested locale with the English text as the
-- fallback (D7: Arabic is optional throughout and nothing is machine translated). `config` comes back as stored:
-- what each shape means is the contract's business, and a database that re-interpreted it would be a second
-- opinion to keep in step.
create or replace function app_private.public_homepage_sections(
  p_locale text
) returns table (
  section_id uuid,
  section_key text,
  section_type text,
  title text,
  subtitle text,
  sort_order integer,
  config jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    s.id,
    s.section_key,
    s.section_type,
    case when coalesce(nullif(btrim(p_locale), ''), 'en') = 'ar' then coalesce(s.title_ar, s.title_en)
         else s.title_en end,
    case when coalesce(nullif(btrim(p_locale), ''), 'en') = 'ar' then coalesce(s.subtitle_ar, s.subtitle_en)
         else s.subtitle_en end,
    s.sort_order,
    s.config
    from public.homepage_sections s
   where s.is_active
     and app_private.homepage_section_type_is_served(s.section_type)
   order by s.sort_order, s.section_key;
$$;

comment on function app_private.public_homepage_sections(text) is
  'The active homepage sections in the administrator''s order, titled in the requested locale with English as the fallback. config is returned as stored: what each shape means belongs to the contract. A banner_strip section is never returned.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The by-id resolvers
-- ---------------------------------------------------------------------------------------------------
-- Each one composes the visibility predicate that already owns its question and adds nothing:
-- `listing_status_is_purchasable` and `is_seller_publicly_visible` for a listing, `public_category_visible` for
-- a category, `is_seller_publicly_visible` for a seller, `cms_content_is_public` for a post. A row that no
-- longer passes is simply absent from the result, which is owner decision C applied at the only place it can be
-- applied honestly.
--
-- The card fields are 0089's, exactly: never the seller, the location or the view count.
create or replace function app_private.public_homepage_listings(
  p_ids uuid[],
  p_limit integer default 12
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
  created_at timestamptz,
  chosen_position integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    case when l.listing_type_code = 'service' then 'service' else 'listing' end,
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
    l.created_at,
    chosen.ordinality::integer
    -- `with ordinality` rather than `= any(...)`: the administrator's order is the whole point of a curated
    -- section, and `= any` guarantees no ordering at all.
    from unnest(coalesce(p_ids, '{}'::uuid[])) with ordinality as chosen(listing_id, ordinality)
    join public.listings l on l.id = chosen.listing_id
    join public.currencies c on c.code = l.currency_code
    left join public.listing_service_details d on d.listing_id = l.id
   where public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
   order by chosen.ordinality
   limit greatest(coalesce(p_limit, 12), 0);
$$;

comment on function app_private.public_homepage_listings(uuid[], integer) is
  'The chosen listings that are still purchasable and whose sellers are still visible, in the order they were chosen. A sold listing or a suspended seller simply drops out (owner decision C). No promotion, placement, ranking or weight is read anywhere.';

-- The newest purchasable listings, for `latest_listings`. A query rather than a selection, which is why it takes
-- a count and no ids — and it is 0051's provisional ordering, unchanged, with no ranking of any kind.
create or replace function app_private.public_homepage_latest_listings(
  p_limit integer default 8
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
  select
    case when l.listing_type_code = 'service' then 'service' else 'listing' end,
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
   where public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
   order by l.created_at desc, l.id desc
   limit greatest(coalesce(p_limit, 8), 0);
$$;

comment on function app_private.public_homepage_latest_listings(integer) is
  'The newest purchasable listings of publicly visible sellers — 0051''s provisional newest-first ordering, unchanged. No promotion, placement, ranking, weight or popularity signal is read: promoted merging is a Phase 9 decision.';

create or replace function app_private.public_homepage_categories(
  p_ids uuid[],
  p_locale text default 'en',
  p_limit integer default 12
) returns table (
  category_id uuid,
  slug text,
  name text,
  listing_type_code text,
  icon text,
  chosen_position integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    cat.id,
    cat.slug,
    -- The translated name, the English name, then the slug — the same most-specific-first fallback the public
    -- tree uses, so a category never appears unnamed on the homepage.
    coalesce(t.name, fallback.name, cat.slug),
    cat.listing_type_code,
    cat.icon,
    chosen.ordinality::integer
    from unnest(coalesce(p_ids, '{}'::uuid[])) with ordinality as chosen(category_id, ordinality)
    join public.categories cat on cat.id = chosen.category_id
    left join public.category_translations t
      on t.category_id = cat.id and t.locale_code = coalesce(nullif(btrim(p_locale), ''), 'en')
    left join public.category_translations fallback
      on fallback.category_id = cat.id and fallback.locale_code = 'en'
   where app_private.public_category_visible(cat.id)
   order by chosen.ordinality
   limit greatest(coalesce(p_limit, 12), 0);
$$;

comment on function app_private.public_homepage_categories(uuid[], text, integer) is
  'The chosen categories that are still visible — 0049''s own ancestry rule — in the order they were chosen, named in the requested locale with English and then the slug as fallbacks. A deactivated category, or one under a deactivated ancestor, drops out.';

create or replace function app_private.public_homepage_sellers(
  p_ids uuid[],
  p_limit integer default 12
) returns table (
  seller_user_id uuid,
  slug text,
  display_name text,
  city text,
  bio text,
  chosen_position integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    s.user_id,
    s.slug,
    s.display_name,
    s.city,
    s.bio,
    chosen.ordinality::integer
    from unnest(coalesce(p_ids, '{}'::uuid[])) with ordinality as chosen(seller_user_id, ordinality)
    join public.seller_profiles s on s.user_id = chosen.seller_user_id
   where public.is_seller_publicly_visible(s.user_id)
   order by chosen.ordinality
   limit greatest(coalesce(p_limit, 12), 0);
$$;

comment on function app_private.public_homepage_sellers(uuid[], integer) is
  'The chosen sellers who are still publicly visible, in the order they were chosen. A suspended or closed seller drops out, which is 0009''s own rule rather than a second opinion here. The logo and banner paths are deliberately absent: no media origin exists to address them.';

-- The newest public posts, for `blog_highlights`. Count-based for the same reason `latest_listings` is, and it
-- composes 0030's publication predicate rather than restating it.
create or replace function app_private.public_homepage_posts(
  p_locale text default 'en',
  p_limit integer default 3
) returns table (
  post_id uuid,
  slug text,
  resolved_locale text,
  title text,
  excerpt text,
  category_slug text,
  category_name text,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    b.id,
    b.slug,
    t.locale_code,
    t.title,
    t.excerpt,
    bc.slug,
    case when bc.id is null then null
         when coalesce(nullif(btrim(p_locale), ''), 'en') = 'ar' then coalesce(bc.name_ar, bc.name_en)
         else bc.name_en end,
    b.published_at
    from public.blog_posts b
    join lateral (
      select tr.locale_code, tr.title, tr.excerpt
        from public.blog_post_translations tr
       where tr.blog_post_id = b.id
         and tr.locale_code in (coalesce(nullif(btrim(p_locale), ''), 'en'), 'en')
       order by (tr.locale_code = coalesce(nullif(btrim(p_locale), ''), 'en')) desc
       limit 1
    ) t on true
    left join public.blog_categories bc on bc.id = b.blog_category_id and bc.is_active
   where public.cms_content_is_public(b.status, b.published_at)
   order by b.published_at desc, b.id desc
   limit greatest(coalesce(p_limit, 3), 0);
$$;

comment on function app_private.public_homepage_posts(text, integer) is
  'The newest public blog posts, newest first — 0092''s own ordering and 0030''s own publication rule, composed rather than restated. A post with no text in any locale is absent, for the same reason it is absent from the blog index.';

-- ---------------------------------------------------------------------------------------------------
-- 5. The staff readers
-- ---------------------------------------------------------------------------------------------------
-- Every section, active or not, including a `banner_strip` one if somebody has authored it: a console has to be
-- able to see what is stored, and `is_served` tells it which rows the public homepage will actually render. That
-- is the honest way to show an operator that a section is authored and not displayed.
create or replace function app_private.homepage_sections_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  section_id uuid,
  section_key text,
  section_type text,
  title_en text,
  title_ar text,
  subtitle_en text,
  subtitle_ar text,
  config jsonb,
  sort_order integer,
  is_active boolean,
  is_served boolean,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    s.id,
    s.section_key,
    s.section_type,
    s.title_en,
    s.title_ar,
    s.subtitle_en,
    s.subtitle_ar,
    s.config,
    s.sort_order,
    s.is_active,
    app_private.homepage_section_type_is_served(s.section_type),
    s.updated_at
    from public.homepage_sections s
   where app_private.homepage_can_read(p_user_id, p_is_aal2)
   order by s.sort_order, s.section_key;
$$;

comment on function app_private.homepage_sections_for_staff(uuid, boolean) is
  'Every homepage section in order, active or not, for a holder of cms.homepage.read. The permission is tested in the WHERE clause, so an unauthorized caller reads nothing rather than being told so. is_served marks a section the public homepage will not render.';

-- One section, with `can_manage` and with how much of its content is still renderable. The counts are owner
-- decision C made visible: a section whose chosen rows have all gone is skipped on the public homepage, and this
-- is where an operator finds out why.
create or replace function app_private.homepage_section_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_section_id uuid
) returns table (
  section_id uuid,
  section_key text,
  section_type text,
  title_en text,
  title_ar text,
  subtitle_en text,
  subtitle_ar text,
  config jsonb,
  sort_order integer,
  is_active boolean,
  is_served boolean,
  created_at timestamptz,
  updated_at timestamptz,
  can_manage boolean,
  chosen_count integer,
  renderable_count integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with section as (
    select s.*
      from public.homepage_sections s
     where s.id = p_section_id
       and app_private.homepage_can_read(p_user_id, p_is_aal2)
  ),
  -- The ids this section names, if its type names any. A malformed array is treated as none rather than raising:
  -- a reader must not fail because a stored document is wrong, and the console is where that is reported.
  ids as (
    select case
             when s.section_type in ('featured_listings', 'featured_categories', 'featured_sellers')
               and jsonb_typeof(s.config -> 'ids') = 'array'
             then (
               select coalesce(
                 array_agg((value #>> '{}')::uuid order by index)
                 filter (where value #>> '{}' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'),
                 '{}'::uuid[])
                 from jsonb_array_elements(s.config -> 'ids') with ordinality as entry(value, index)
             )
             else '{}'::uuid[]
           end as chosen
      from section s
  )
  select
    s.id,
    s.section_key,
    s.section_type,
    s.title_en,
    s.title_ar,
    s.subtitle_en,
    s.subtitle_ar,
    s.config,
    s.sort_order,
    s.is_active,
    app_private.homepage_section_type_is_served(s.section_type),
    s.created_at,
    s.updated_at,
    app_private.homepage_can_manage(p_user_id, p_is_aal2),
    coalesce(array_length(i.chosen, 1), 0),
    case s.section_type
      when 'featured_listings' then
        (select count(*)::integer from app_private.public_homepage_listings(i.chosen, 1000))
      when 'featured_categories' then
        (select count(*)::integer from app_private.public_homepage_categories(i.chosen, 'en', 1000))
      when 'featured_sellers' then
        (select count(*)::integer from app_private.public_homepage_sellers(i.chosen, 1000))
      else coalesce(array_length(i.chosen, 1), 0)
    end
    from section s
    cross join ids i;
$$;

comment on function app_private.homepage_section_for_staff(uuid, boolean, uuid) is
  'One section with whether this caller may change it, how many rows it names and how many of those are still renderable — owner decision C made visible, so an operator learns from the console why a section is skipped. No row for a section that does not exist and none for a caller without the read key.';

-- ---------------------------------------------------------------------------------------------------
-- 6. The writers
-- ---------------------------------------------------------------------------------------------------
-- Each one re-applies `homepage_can_manage` first and raises 42501 when it fails. None decides a rule 0030
-- already decides: the key format, the nine legal types, that `config` is an object, and the title lengths are
-- constraints and are left to raise their own errors.
create or replace function app_private.homepage_section_save_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_section_id uuid,
  p_section_key text,
  p_section_type text,
  p_title_en text default null,
  p_title_ar text default null,
  p_subtitle_en text default null,
  p_subtitle_ar text default null,
  p_config jsonb default null,
  -- Null rather than 0, and that is load-bearing: this is a create-or-replace writer, so a non-null parameter
  -- default would be substituted before the body runs and an omitted argument would be indistinguishable from an
  -- explicit one — reordering the homepage every time somebody corrected a title. The insert branch supplies the
  -- schema's own default instead.
  p_sort_order integer default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  saved_id uuid;
begin
  if not app_private.homepage_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.homepage.manage is required' using errcode = 'insufficient_privilege';
  end if;

  if p_section_id is null then
    -- A section is always born inactive. 0030's column default says so, and it means a half-configured section
    -- can never appear on the homepage before somebody has looked at it.
    insert into public.homepage_sections (
      section_key, section_type, title_en, title_ar, subtitle_en, subtitle_ar, config, sort_order
    )
    values (
      btrim(p_section_key),
      p_section_type,
      nullif(btrim(coalesce(p_title_en, '')), ''),
      nullif(btrim(coalesce(p_title_ar, '')), ''),
      nullif(btrim(coalesce(p_subtitle_en, '')), ''),
      nullif(btrim(coalesce(p_subtitle_ar, '')), ''),
      coalesce(p_config, '{}'::jsonb),
      coalesce(p_sort_order, 0)
    )
    returning id into saved_id;
    return saved_id;
  end if;

  -- The type is deliberately changeable only to another legal one, which 0030's constraint enforces; and
  -- `is_active` is absent from this statement, because activating a section is its own call below. An edit to a
  -- section's text can never put it in front of the public.
  update public.homepage_sections s
     set section_key = coalesce(nullif(btrim(p_section_key), ''), s.section_key),
         section_type = coalesce(p_section_type, s.section_type),
         title_en = case when p_title_en is null then s.title_en else nullif(btrim(p_title_en), '') end,
         title_ar = case when p_title_ar is null then s.title_ar else nullif(btrim(p_title_ar), '') end,
         subtitle_en = case when p_subtitle_en is null then s.subtitle_en
                            else nullif(btrim(p_subtitle_en), '') end,
         subtitle_ar = case when p_subtitle_ar is null then s.subtitle_ar
                            else nullif(btrim(p_subtitle_ar), '') end,
         config = coalesce(p_config, s.config),
         sort_order = coalesce(p_sort_order, s.sort_order)
   where s.id = p_section_id
  returning s.id into saved_id;

  return saved_id;
end;
$$;

comment on function app_private.homepage_section_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, text, jsonb, integer) is
  'Creates or replaces one homepage section, returning its id — or null when the named id does not exist. A new section is always inactive. is_active is not settable here: showing a section is its own call, so editing text cannot publish it.';

create or replace function app_private.homepage_section_state_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_section_id uuid,
  p_is_active boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if not app_private.homepage_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.homepage.manage is required' using errcode = 'insufficient_privilege';
  end if;

  update public.homepage_sections s
     set is_active = coalesce(p_is_active, s.is_active)
   where s.id = p_section_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.homepage_section_state_for_staff(uuid, boolean, uuid, boolean) is
  'Shows or hides one section. The only call that can put a section in front of the public, which is why it is separate from the save.';

-- One statement for the whole order, because an order is a set of positions rather than a sequence of edits:
-- sending the order that should hold cannot leave a half-applied result the way a series of single moves can.
create or replace function app_private.homepage_sections_reorder_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_section_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  moved integer;
begin
  if not app_private.homepage_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.homepage.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Position comes from the argument's own ordering, so the caller sends the order it means and this does not
  -- invent one. An id that names no section updates nothing; a section the caller left out keeps its position.
  update public.homepage_sections s
     set sort_order = (chosen.ordinality - 1) * 10
    from unnest(coalesce(p_section_ids, '{}'::uuid[])) with ordinality as chosen(section_id, ordinality)
   where s.id = chosen.section_id;

  get diagnostics moved = row_count;
  return moved;
end;
$$;

comment on function app_private.homepage_sections_reorder_for_staff(uuid, boolean, uuid[]) is
  'Sets the order of the sections named, from the argument''s own ordering, in one statement. Positions are spaced by ten so a later insertion between two sections needs no rewrite. Returns how many rows moved.';

create or replace function app_private.homepage_section_delete_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_section_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deleted integer;
begin
  if not app_private.homepage_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.homepage.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- A real delete. A section is a composition choice rather than a record of anything that happened, so there is
  -- nothing here to keep for history — and 0030's audit trigger has already recorded that it existed.
  delete from public.homepage_sections s where s.id = p_section_id;
  get diagnostics deleted = row_count;
  return deleted = 1;
end;
$$;

comment on function app_private.homepage_section_delete_for_staff(uuid, boolean, uuid) is
  'Removes one section. A real delete: a section is a composition choice, not a record of an event, and 0030''s audit trigger has already recorded that it existed.';

-- ---------------------------------------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.homepage_can_read(uuid, boolean) from public, app_worker;
revoke execute on function app_private.homepage_can_manage(uuid, boolean) from public, app_worker;
revoke execute on function app_private.homepage_section_type_is_served(text) from public, app_worker;
revoke execute on function app_private.public_homepage_sections(text) from public, app_worker;
revoke execute on function app_private.public_homepage_listings(uuid[], integer) from public, app_worker;
revoke execute on function app_private.public_homepage_latest_listings(integer) from public, app_worker;
revoke execute on function app_private.public_homepage_categories(uuid[], text, integer) from public, app_worker;
revoke execute on function app_private.public_homepage_sellers(uuid[], integer) from public, app_worker;
revoke execute on function app_private.public_homepage_posts(text, integer) from public, app_worker;
revoke execute on function app_private.homepage_sections_for_staff(uuid, boolean) from public, app_worker;
revoke execute on function app_private.homepage_section_for_staff(uuid, boolean, uuid) from public, app_worker;
revoke execute on function app_private.homepage_section_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, text, jsonb, integer) from public, app_worker;
revoke execute on function app_private.homepage_section_state_for_staff(uuid, boolean, uuid, boolean) from public, app_worker;
revoke execute on function app_private.homepage_sections_reorder_for_staff(uuid, boolean, uuid[]) from public, app_worker;
revoke execute on function app_private.homepage_section_delete_for_staff(uuid, boolean, uuid) from public, app_worker;

-- `app_system` only. The worker has no business with the homepage: it composes nothing and reacts to no event
-- this migration adds.
grant execute on function app_private.homepage_can_read(uuid, boolean) to app_system;
grant execute on function app_private.homepage_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.homepage_section_type_is_served(text) to app_system;
grant execute on function app_private.public_homepage_sections(text) to app_system;
grant execute on function app_private.public_homepage_listings(uuid[], integer) to app_system;
grant execute on function app_private.public_homepage_latest_listings(integer) to app_system;
grant execute on function app_private.public_homepage_categories(uuid[], text, integer) to app_system;
grant execute on function app_private.public_homepage_sellers(uuid[], integer) to app_system;
grant execute on function app_private.public_homepage_posts(text, integer) to app_system;
grant execute on function app_private.homepage_sections_for_staff(uuid, boolean) to app_system;
grant execute on function app_private.homepage_section_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.homepage_section_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, text, jsonb, integer) to app_system;
grant execute on function app_private.homepage_section_state_for_staff(uuid, boolean, uuid, boolean) to app_system;
grant execute on function app_private.homepage_sections_reorder_for_staff(uuid, boolean, uuid[]) to app_system;
grant execute on function app_private.homepage_section_delete_for_staff(uuid, boolean, uuid) to app_system;

select app_private.assert_security_contract();
