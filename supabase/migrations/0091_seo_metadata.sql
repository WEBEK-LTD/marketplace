-- 0091 — Per-entity SEO metadata: the named definer functions that finally serve and maintain it.
--
-- 0030 built this cluster and gave the application no way to reach it. `public.seo_metadata` has existed since
-- then with its columns, its two partial unique indexes, every one of its constraints, its `updated_at` trigger,
-- its audit trigger and the publication predicate `public.seo_metadata_is_public(text, uuid)`. What has never
-- existed is a caller. 0086 said so in its own header — *"`seo_metadata.robots_directives` is deliberately not
-- read. It exists in 0030 and has no reader"* — and that was still true until this migration.
--
-- **No table, column, constraint, index, trigger or policy is created or changed, and no new table exists after
-- it.** The metadata schema is 0030's and stays 0030's.
--
-- ---------------------------------------------------------------------------------------------------
-- THE TWO OWNER DECISIONS THIS MIGRATION ENFORCES STRUCTURALLY
-- ---------------------------------------------------------------------------------------------------
--
-- Both are enforced **in the reader**, not in the API and not in a page, so that no caller can get either wrong
-- and no second copy of the rule exists to drift.
--
-- **1. `canonical_path` is honoured for `route` and `page` only.** For `listing`, `category` and `seller` the
-- public reader returns it as NULL. Those three surfaces keep the self-referencing canonical the specification
-- fixes for them — *"every listing page uses a self-referencing canonical on its current slug; old slugs 301 to
-- it"* — and an override there would let one stored row deindex a live listing by pointing at another page. The
-- column keeps whatever an operator stored; the three catalogue surfaces simply never read it, and the staff
-- detail reports `canonical_is_honoured` so a console can say so rather than deciding it for itself.
--
-- **2. `robots_directives` may only restrict, never widen.** The reader returns only the restrictive members of
-- 0030's own allowed set — `noindex`, `nofollow`, `noarchive`, `nosnippet`, `noimageindex` — and drops `index`,
-- `follow` and `max-snippet:-1`, which are the permissive ones. A caller that merges what comes back can
-- therefore only ever narrow indexing. That is what keeps the state table's rules intact (a Sold, Expired or
-- Archived listing and a suspended seller's profile stay `noindex`) and what keeps 8-D's decision intact (a
-- filtered category or search view stays `noindex`), with no caller needing to remember either.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS COMPOSED AND NEVER RESTATED
-- ---------------------------------------------------------------------------------------------------
--
-- `public.seo_metadata_is_public(entity_type, entity_id)` is 0030's and is called, not copied. It owns the whole
-- of the question "is this metadata as public as the thing it describes": a draft or scheduled page's title, an
-- inactive category's, an inactive blog category's or tag's, a suspended or pending seller's, and a listing in a
-- state the public cannot reach all stay behind it.
--
-- Two of its clauses are worth stating because they are 0030's choices and not this migration's:
--
--   * for a listing it admits `active`, `sold`, `expired` and `archived` — the states whose pages are public per
--     the specification's own state table — and **not `approved`**. A listing that is approved and not yet
--     active therefore gets no override. That is narrower than the purchasable predicate the catalogue readers
--     use, and it is left exactly as it is: withholding an override is safe, and widening 0030's predicate would
--     be changing a rule this increment does not own.
--   * for `route` it is unconditionally true, because a fixed landing address is public by existing.
--
-- `cms_media` is joined for the share image exactly as 0085 joins it for a page cover, and yields a **relative
-- object path**. Nothing here builds an absolute URL: `PUBLIC_WEB_ORIGIN` is unset because the production domain
-- is not chosen, and guessing an origin from a request header is how a poisoned `Host` ends up in a crawler-facing
-- tag. The caller resolves the path against its own configured origin, or does not resolve it at all.
--
-- ---------------------------------------------------------------------------------------------------
-- NO LOCALE FALLBACK
-- ---------------------------------------------------------------------------------------------------
--
-- A missing `(entity, locale)` row is **no override**, not a fall back to the other language. A CMS page falls
-- back for its body text because D7 forbids machine translation and real text somebody wrote is better than an
-- empty page; a meta description is different — showing an Arabic visitor an English title an operator wrote for
-- the English page would be a decision nobody made. The surface keeps its own derived metadata instead.
--
-- ---------------------------------------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------------------------------------
--
-- Two seeded keys, both from 0033, pinned here as literals, with 0003's own `requires_mfa` rule applied to the
-- assurance level as a parameter: `seo.metadata.read` to see the section, `seo.metadata.manage` to change
-- anything. Neither is invented, granted or assigned here, and 0030's RLS policies on the table already name
-- exactly this pair. No role name is tested anywhere in this file.
--
-- ---------------------------------------------------------------------------------------------------
-- AUDIT ATTRIBUTION
-- ---------------------------------------------------------------------------------------------------
--
-- These writers do **not** touch the 8-B attribution channel, exactly as 0085's and 0090's do not. The actor is
-- recorded where 0030's own schema puts it: `seo_metadata.updated_by` is a column of the row, so the audit
-- trigger captures it inside the audited payload.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS NOT HERE
-- ---------------------------------------------------------------------------------------------------
--
-- **`structured_data` gets no reader.** It is an operator-supplied JSON-LD object and what belongs in it is fixed
-- by the Blueprint SEO section, which this increment does not have; emitting it would mean inventing schema.org
-- shapes. It keeps its column and its constraint and waits, for the same reason 0086 left `robots_directives`
-- waiting.
--
-- **`seo_settings` gets no functions.** The site-wide defaults are a separate cluster behind a separate seeded
-- key, `seo.settings.manage`, and nothing here needs them: without an override a surface keeps the metadata it
-- renders today.
--
-- **There is no `service` entity type**, because 0030's `seo_metadata_entity_type_allowed` does not list one. A
-- service is a row in `listings`, so its metadata is a `listing` entry, and the reader resolves a service slug
-- through the same table. The admin route map names a separate services screen; the constraint governs.
--
-- **The blog entity types resolve to nothing.** `blog_post`, `blog_category` and `blog_tag` are in 0030's
-- constraint and have no public surface yet, so a row for one is storable and reads back nothing. That is the
-- honest answer rather than a reader for pages that do not exist.

-- ---------------------------------------------------------------------------------------------------
-- 1. The two permission predicates
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.seo_metadata_can_read(
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
       and rp.permission_key = 'seo.metadata.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.seo_metadata_can_read(uuid, boolean) is
  'Whether one account effectively holds seo.metadata.read — the key as a literal, with 0003''s own requires_mfa rule applied to the assurance level as a parameter. No role name is tested anywhere.';

create or replace function app_private.seo_metadata_can_manage(
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
       and rp.permission_key = 'seo.metadata.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.seo_metadata_can_manage(uuid, boolean) is
  'Whether one account effectively holds seo.metadata.manage — the separate key 0030''s own write policy requires. A reader may hold the first key and not this one, which is why the detail reports the capability.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The two rules, as functions, so there is one copy of each
-- ---------------------------------------------------------------------------------------------------
-- Owner decision 1. Named rather than inlined so that the public reader and the staff detail answer from the
-- same place: a console that showed "this is honoured" while the reader withheld it would be worse than no
-- indication at all.
create or replace function app_private.seo_canonical_is_honoured(
  p_entity_type text
) returns boolean
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select p_entity_type in ('route', 'page');
$$;

comment on function app_private.seo_canonical_is_honoured(text) is
  'Whether a stored canonical_path is read for this kind of entity. True for route and page only: a listing, a category and a seller keep the self-referencing canonical the specification fixes for them (owner decision, 8-F).';

-- Owner decision 2. The restrictive members of 0030's own allowed set, and only those. `index`, `follow` and
-- `max-snippet:-1` are the permissive ones and are dropped, so what leaves this schema can only narrow indexing
-- however a caller merges it.
create or replace function app_private.seo_directives_restrictive_only(
  p_directives text[]
) returns text[]
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    array(
      select d
        from unnest(coalesce(p_directives, '{}'::text[])) as d
       where d in ('noindex', 'nofollow', 'noarchive', 'nosnippet', 'noimageindex')
       order by d
    ),
    '{}'::text[]
  );
$$;

comment on function app_private.seo_directives_restrictive_only(text[]) is
  'The restrictive directives only, sorted. index, follow and max-snippet:-1 are dropped, so a stored value can never widen indexing past what a platform rule already decided (owner decision, 8-F).';

-- ---------------------------------------------------------------------------------------------------
-- 3. The public readers
-- ---------------------------------------------------------------------------------------------------
-- Keyed on the **slug**, not on an identifier. Two public contracts carry no id — a CMS page's and a seller
-- profile's — and widening them would put an internal identifier into a browser to save a lookup that belongs in
-- the database anyway. Resolving the slug here also keeps one authority for what a slug means.
create or replace function app_private.public_seo_metadata_for_entity(
  p_entity_type text,
  p_slug text,
  p_locale text
) returns table (
  meta_title text,
  meta_description text,
  canonical_path text,
  robots_directives text[],
  og_title text,
  og_description text,
  share_object_path text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with target as (
    select case p_entity_type
      -- Resolved by slug alone; whether the row is public is 0030's predicate's business and is applied below,
      -- so there is one authority for publicness rather than two that can disagree.
      when 'page' then (select p.id from public.pages p where p.slug = p_slug limit 1)
      when 'category' then (select c.id from public.categories c where c.slug = p_slug limit 1)
      -- Products and services are one table, so one branch answers for both; 0030 has no `service` kind.
      when 'listing' then (
        select l.id from public.listings l where l.slug = p_slug and l.deleted_at is null limit 1)
      -- 0030's predicate matches a seller on `user_id`, which is the profile's primary key.
      when 'seller' then (select s.user_id from public.seller_profiles s where s.slug = p_slug limit 1)
      -- blog_post, blog_category and blog_tag have no public surface yet, and `route` is not addressed by slug.
      else null
    end as entity_id
  )
  select
    m.meta_title,
    m.meta_description,
    -- Owner decision 1, applied where it cannot be forgotten.
    case when app_private.seo_canonical_is_honoured(m.entity_type) then m.canonical_path else null end,
    -- Owner decision 2, likewise.
    app_private.seo_directives_restrictive_only(m.robots_directives),
    m.og_title,
    m.og_description,
    media.object_path
    from target
    join public.seo_metadata m
      on m.entity_type = p_entity_type
     and m.entity_id = target.entity_id
     and m.locale_code = p_locale
    left join public.cms_media media on media.id = m.share_media_id
   where target.entity_id is not null
     and public.seo_metadata_is_public(m.entity_type, m.entity_id);
$$;

comment on function app_private.public_seo_metadata_for_entity(text, text, text) is
  'One entity''s metadata override for one locale, or no row. Keyed on slug so no identifier crosses the API. Composes 0030''s seo_metadata_is_public for publicness, withholds canonical_path for listing, category and seller, and returns only restrictive robots directives. A missing locale is no override, never a fallback.';

create or replace function app_private.public_seo_metadata_for_route(
  p_route_path text,
  p_locale text
) returns table (
  meta_title text,
  meta_description text,
  canonical_path text,
  robots_directives text[],
  og_title text,
  og_description text,
  share_object_path text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    m.meta_title,
    m.meta_description,
    -- A route honours its canonical: it is a fixed landing address with no row behind it, so there is no
    -- derived self-referencing canonical for an override to contradict.
    m.canonical_path,
    app_private.seo_directives_restrictive_only(m.robots_directives),
    m.og_title,
    m.og_description,
    media.object_path
    from public.seo_metadata m
    left join public.cms_media media on media.id = m.share_media_id
   where m.entity_type = 'route'
     and m.route_path = p_route_path
     and m.locale_code = p_locale
     and public.seo_metadata_is_public('route', null);
$$;

comment on function app_private.public_seo_metadata_for_route(text, text) is
  'One fixed landing address''s metadata override for one locale, or no row. A route honours its stored canonical_path, because there is no derived one to contradict.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The staff list
-- ---------------------------------------------------------------------------------------------------
-- Newest edit first, like the authored pages and the redirect map, and for the same reason: this is a
-- maintenance list rather than a queue.
--
-- `target_slug` is resolved per kind so the list is usable. Without it a row reads as a uuid and an operator has
-- no way to tell which category they are looking at. It reports what the row points at; it decides nothing.
create or replace function app_private.seo_metadata_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_entity_type text default null,
  p_locale text default null,
  p_cursor_updated_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  entry_id uuid,
  entity_type text,
  entity_id uuid,
  route_path text,
  target_slug text,
  locale_code text,
  meta_title text,
  meta_description text,
  canonical_path text,
  robots_directives text[],
  og_title text,
  og_description text,
  share_media_id uuid,
  canonical_is_honoured boolean,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    m.id,
    m.entity_type,
    m.entity_id,
    m.route_path,
    case m.entity_type
      when 'page' then (select p.slug from public.pages p where p.id = m.entity_id)
      when 'category' then (select c.slug from public.categories c where c.id = m.entity_id)
      when 'listing' then (select l.slug from public.listings l where l.id = m.entity_id)
      when 'seller' then (select s.slug from public.seller_profiles s where s.user_id = m.entity_id)
      when 'blog_post' then (select b.slug from public.blog_posts b where b.id = m.entity_id)
      when 'blog_category' then (select c.slug from public.blog_categories c where c.id = m.entity_id)
      when 'blog_tag' then (select t.slug from public.blog_tags t where t.id = m.entity_id)
      else null
    end,
    m.locale_code,
    m.meta_title,
    m.meta_description,
    m.canonical_path,
    m.robots_directives,
    m.og_title,
    m.og_description,
    m.share_media_id,
    app_private.seo_canonical_is_honoured(m.entity_type),
    m.updated_at
    from public.seo_metadata m
   where app_private.seo_metadata_can_read(p_user_id, p_is_aal2)
     and (p_entity_type is null or m.entity_type = p_entity_type)
     and (p_locale is null or m.locale_code = p_locale)
     and (
       p_cursor_updated_at is null
       or p_cursor_id is null
       or (m.updated_at, m.id) < (p_cursor_updated_at, p_cursor_id)
     )
   order by m.updated_at desc, m.id desc
   limit greatest(coalesce(p_limit, 25), 1);
$$;

comment on function app_private.seo_metadata_for_staff(uuid, boolean, integer, text, text, timestamptz, uuid) is
  'One page of metadata entries, newest edit first, for a holder of seo.metadata.read. The permission is tested in the WHERE clause, so an unauthorized caller reads nothing rather than being told so. The stored values are returned as stored — the two owner rules apply to what the public reads, not to what an operator sees they wrote.';

-- ---------------------------------------------------------------------------------------------------
-- 5. The staff detail
-- ---------------------------------------------------------------------------------------------------
-- The stored row as stored, plus three things the list does not carry: who may change it, whether this kind of
-- entity honours a canonical, and what the public would actually receive. The last is the point: an operator who
-- has written `index` into a row should be able to see that nothing will come of it, from the server's own answer
-- rather than from a sentence on a screen that could drift from the reader.
create or replace function app_private.seo_metadata_entry_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_entry_id uuid
) returns table (
  entry_id uuid,
  entity_type text,
  entity_id uuid,
  route_path text,
  target_slug text,
  locale_code text,
  meta_title text,
  meta_description text,
  canonical_path text,
  robots_directives text[],
  og_title text,
  og_description text,
  share_media_id uuid,
  share_object_path text,
  canonical_is_honoured boolean,
  effective_canonical_path text,
  effective_robots_directives text[],
  created_at timestamptz,
  updated_at timestamptz,
  updated_by uuid,
  can_manage boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    m.id,
    m.entity_type,
    m.entity_id,
    m.route_path,
    case m.entity_type
      when 'page' then (select p.slug from public.pages p where p.id = m.entity_id)
      when 'category' then (select c.slug from public.categories c where c.id = m.entity_id)
      when 'listing' then (select l.slug from public.listings l where l.id = m.entity_id)
      when 'seller' then (select s.slug from public.seller_profiles s where s.user_id = m.entity_id)
      when 'blog_post' then (select b.slug from public.blog_posts b where b.id = m.entity_id)
      when 'blog_category' then (select c.slug from public.blog_categories c where c.id = m.entity_id)
      when 'blog_tag' then (select t.slug from public.blog_tags t where t.id = m.entity_id)
      else null
    end,
    m.locale_code,
    m.meta_title,
    m.meta_description,
    m.canonical_path,
    m.robots_directives,
    m.og_title,
    m.og_description,
    m.share_media_id,
    media.object_path,
    app_private.seo_canonical_is_honoured(m.entity_type),
    case when app_private.seo_canonical_is_honoured(m.entity_type) then m.canonical_path else null end,
    app_private.seo_directives_restrictive_only(m.robots_directives),
    m.created_at,
    m.updated_at,
    m.updated_by,
    app_private.seo_metadata_can_manage(p_user_id, p_is_aal2)
    from public.seo_metadata m
    left join public.cms_media media on media.id = m.share_media_id
   where app_private.seo_metadata_can_read(p_user_id, p_is_aal2)
     and m.id = p_entry_id;
$$;

comment on function app_private.seo_metadata_entry_for_staff(uuid, boolean, uuid) is
  'One entry for a holder of seo.metadata.read, with the manage capability and with what the public would actually receive beside what was stored. No row covers both an entry that does not exist and a caller without the read key.';

-- ---------------------------------------------------------------------------------------------------
-- 6. The writers
-- ---------------------------------------------------------------------------------------------------
-- Each re-applies `seo_metadata_can_manage` first and raises 42501 when it fails. None decides a rule 0030
-- already decides: which entity types exist, that a route carries a path and no identifier while everything else
-- carries an identifier and no path, that both paths are relative and cannot escape the site, every length
-- bound, that a directive set is non-empty, drawn from the allowed list and internally consistent, and that
-- `structured_data` is an object. All of those are constraints and are left to raise their own errors.
create or replace function app_private.seo_metadata_save_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_entity_type text,
  p_entity_id uuid,
  p_route_path text,
  p_locale_code text,
  p_meta_title text default null,
  p_meta_description text default null,
  p_canonical_path text default null,
  p_robots_directives text[] default null,
  p_og_title text default null,
  p_og_description text default null,
  p_share_media_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  saved_id uuid;
  directives text[] := coalesce(p_robots_directives, array['index', 'follow']);
begin
  if not app_private.seo_metadata_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.metadata.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Writing one locale of one entity is one request whether or not a row is there already: an operator editing a
  -- description does not care which, and two endpoints would mean a console having to find out first.
  --
  -- The conflict target is chosen by kind rather than guessed, because 0030 has two partial unique indexes and
  -- they cover disjoint sets of rows: `(route_path, locale_code)` for a route and
  -- `(entity_type, entity_id, locale_code)` for everything else.
  if p_entity_type = 'route' then
    insert into public.seo_metadata (
      entity_type, entity_id, route_path, locale_code, meta_title, meta_description, canonical_path,
      robots_directives, og_title, og_description, share_media_id, updated_by
    )
    values (
      'route', null, btrim(p_route_path), p_locale_code,
      nullif(btrim(coalesce(p_meta_title, '')), ''),
      nullif(btrim(coalesce(p_meta_description, '')), ''),
      nullif(btrim(coalesce(p_canonical_path, '')), ''),
      directives,
      nullif(btrim(coalesce(p_og_title, '')), ''),
      nullif(btrim(coalesce(p_og_description, '')), ''),
      p_share_media_id,
      p_user_id
    )
    on conflict (route_path, locale_code) where route_path is not null do update
      set meta_title = excluded.meta_title,
          meta_description = excluded.meta_description,
          canonical_path = excluded.canonical_path,
          robots_directives = excluded.robots_directives,
          og_title = excluded.og_title,
          og_description = excluded.og_description,
          share_media_id = excluded.share_media_id,
          updated_by = excluded.updated_by
      returning id into saved_id;
  else
    insert into public.seo_metadata (
      entity_type, entity_id, route_path, locale_code, meta_title, meta_description, canonical_path,
      robots_directives, og_title, og_description, share_media_id, updated_by
    )
    values (
      p_entity_type, p_entity_id, null, p_locale_code,
      nullif(btrim(coalesce(p_meta_title, '')), ''),
      nullif(btrim(coalesce(p_meta_description, '')), ''),
      nullif(btrim(coalesce(p_canonical_path, '')), ''),
      directives,
      nullif(btrim(coalesce(p_og_title, '')), ''),
      nullif(btrim(coalesce(p_og_description, '')), ''),
      p_share_media_id,
      p_user_id
    )
    on conflict (entity_type, entity_id, locale_code) where entity_id is not null do update
      set meta_title = excluded.meta_title,
          meta_description = excluded.meta_description,
          canonical_path = excluded.canonical_path,
          robots_directives = excluded.robots_directives,
          og_title = excluded.og_title,
          og_description = excluded.og_description,
          share_media_id = excluded.share_media_id,
          updated_by = excluded.updated_by
      returning id into saved_id;
  end if;

  return saved_id;
end;
$$;

comment on function app_private.seo_metadata_save_for_staff(uuid, boolean, text, uuid, text, text, text, text, text, text[], text, text, uuid) is
  'Writes one entity-and-locale''s metadata. Creating and replacing are the same request, against whichever of 0030''s two partial unique indexes the kind uses. A blank text field is stored as absent rather than as an empty string, so a surface never carries a blank meta tag. Every rule stays in 0030''s constraints.';

create or replace function app_private.seo_metadata_delete_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_entry_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed integer;
begin
  if not app_private.seo_metadata_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.metadata.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Removal is real here, as it is for a redirect and unlike an authored page: an override is an instruction
  -- about a surface rather than content with an address, and removing it returns the surface to the metadata it
  -- derives from its own content. The audit trigger records the removed row.
  delete from public.seo_metadata m where m.id = p_entry_id;

  get diagnostics removed = row_count;
  return removed = 1;
end;
$$;

comment on function app_private.seo_metadata_delete_for_staff(uuid, boolean, uuid) is
  'Removes one override, returning that surface to the metadata it derives from its own content. The audit trigger records the removed row.';

-- ---------------------------------------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------------------------------------
-- `app_system` is the only role that may call any of these. `app_worker` is named explicitly even though it
-- never held a grant on them: nothing in this increment is a background job.
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.seo_metadata_can_read(uuid, boolean) from public, app_worker;
revoke execute on function app_private.seo_metadata_can_manage(uuid, boolean) from public, app_worker;
revoke execute on function app_private.seo_canonical_is_honoured(text) from public, app_worker;
revoke execute on function app_private.seo_directives_restrictive_only(text[]) from public, app_worker;
revoke execute on function app_private.public_seo_metadata_for_entity(text, text, text) from public, app_worker;
revoke execute on function app_private.public_seo_metadata_for_route(text, text) from public, app_worker;
revoke execute on function app_private.seo_metadata_for_staff(uuid, boolean, integer, text, text, timestamptz, uuid) from public, app_worker;
revoke execute on function app_private.seo_metadata_entry_for_staff(uuid, boolean, uuid) from public, app_worker;
revoke execute on function app_private.seo_metadata_save_for_staff(uuid, boolean, text, uuid, text, text, text, text, text, text[], text, text, uuid) from public, app_worker;
revoke execute on function app_private.seo_metadata_delete_for_staff(uuid, boolean, uuid) from public, app_worker;

grant execute on function app_private.seo_metadata_can_read(uuid, boolean) to app_system;
grant execute on function app_private.seo_metadata_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.seo_canonical_is_honoured(text) to app_system;
grant execute on function app_private.seo_directives_restrictive_only(text[]) to app_system;
grant execute on function app_private.public_seo_metadata_for_entity(text, text, text) to app_system;
grant execute on function app_private.public_seo_metadata_for_route(text, text) to app_system;
grant execute on function app_private.seo_metadata_for_staff(uuid, boolean, integer, text, text, timestamptz, uuid) to app_system;
grant execute on function app_private.seo_metadata_entry_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.seo_metadata_save_for_staff(uuid, boolean, text, uuid, text, text, text, text, text, text[], text, text, uuid) to app_system;
grant execute on function app_private.seo_metadata_delete_for_staff(uuid, boolean, uuid) to app_system;

select app_private.assert_security_contract();
