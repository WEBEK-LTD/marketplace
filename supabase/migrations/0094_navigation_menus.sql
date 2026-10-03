-- 0094 — Navigation: the named definer functions that resolve it and author it.
--
-- 0030 built `public.navigation_menus` and `public.navigation_items` and then left both unreachable: a
-- `menu_key`, bilingual labels, an `is_active` flag, a four-value `target_kind` with a CHECK that the matching
-- target column is the only one filled, a relative-path constraint, an `opens_in_new_tab` flag, a `sort_order`,
-- a two-level depth trigger and audit triggers on both tables — and not one function the application could
-- call. `app_system` holds no table privileges, so every read and every write goes through a named SECURITY
-- DEFINER function. This migration adds exactly those functions.
--
-- Nothing about the schema changes here. No column, constraint, index, trigger or policy of 0030 is touched,
-- and no table is created.
--
-- WHAT A MENU ENTRY IS, AND WHAT IT IS NOT
--
-- 0030's own comment states the principle every reader below follows: **a menu entry points at a row by id; it
-- never copies that row's title or URL.** So the label is the operator's own words (`label_en` is NOT NULL,
-- `label_ar` optional — D6/D7, nothing machine translated), while the *address* is derived from the target row
-- every time it is read. A page that has been unpublished, a post that has been archived and a category that
-- has been deactivated therefore leave the menu by themselves, with nothing here deciding it a second time.
--
-- THE OWNER DECISIONS FOR THIS INCREMENT (0094)
--
--   * **1 — three fixed menu keys.** `header`, `footer` and `mobile`, stated once in
--     `navigation_menu_key_is_served()` below. Placement discovery is deliberately **not** dynamic: a menu
--     stored under any other key keeps its rows and has no public reader, exactly as a `banner_strip` section
--     does in 0093.
--   * **2 — public surfaces only.** Which surfaces render a menu is the web layer's business; this migration
--     only makes the content available. Nothing here knows or cares about the authenticated area.
--   * **3 — a target that is not public means the item is omitted**, and a menu left with no renderable item
--     returns no rows at all, which is how a menu disappears rather than rendering as an empty strip. The staff
--     readers report every item regardless, with the state of its target, so an operator can see exactly what
--     the public is not being shown.
--   * **4 — a published page at an address this application does not serve is unservable.** That rule cannot be
--     applied here and is deliberately not attempted: the closed set of served page addresses is the *web
--     application's* route map (`@repo/config`), not a database fact, and encoding a copy of it in SQL would be
--     a second list to keep in step. The public reader returns the target's slug and the surface that owns the
--     route map drops what it cannot serve. 0085 is not reopened and no arbitrary page routing is introduced.
--   * **5 — two levels, and the limit is 0030's.** The depth trigger already refuses a third level and already
--     refuses a child in a different menu from its parent. This migration adds no depth rule of its own; it
--     reports `depth` so a renderer can branch, and omits a child whose parent is not itself renderable,
--     because a second-level entry without its heading is not the thing the operator arranged.
--   * **6 — `opens_in_new_tab` is served as stored.** What a renderer does with it is the web layer's business.
--   * **7 — a site with no composed menu gets no rows**, and the web layer falls back to its own neutral chrome.
--   * **8 — the locale switch is platform code.** There is no reader here for it and no item kind that could
--     carry one.
--
-- A NEW MENU AND A NEW ITEM ARE BORN VISIBLE, AND THAT IS 0030'S DECISION
--
-- `navigation_menus.is_active` and `navigation_items.is_active` both default to **true** — unlike
-- `homepage_sections.is_active`, which 0030 defaults to false. The writers below therefore do not name
-- `is_active` on insert: they let the schema's own default stand. Substituting a different default here would be
-- inventing a business rule 0030 already made the other way, and the state writers exist for hiding one.
--
-- AUDIT ATTRIBUTION
--
-- These writers do **not** touch the 8-B attribution channel. 8-B's approved scope is the financial subset, and
-- `public.audit_attribution_problems()` fails any function that names the channel without being in the approved
-- contract. Neither navigation table has a `created_by`/`updated_by` column, so there is no row-level actor to
-- write either: the audit triggers 0030 installed record the changes themselves.
--
-- WHAT IS NOT HERE
--
-- Banners, FAQs, promoted or paid placement, any ranking or popularity signal, breadcrumbs, header search, the
-- authenticated area's own navigation, media-origin work, sitemap changes, a revalidation consumer and anything
-- financial are all out of scope by instruction.

-- ---------------------------------------------------------------------------------------------------
-- 1. The two permission predicates
-- ---------------------------------------------------------------------------------------------------
-- Both keys are seeded in 0033 (`cms.navigation.read`, `cms.navigation.manage`). Neither is invented, granted or
-- assigned here, and no role name is tested anywhere: 0003's own `requires_mfa` rule is applied to the assurance
-- level as a parameter, exactly as every other console gate does it.
create or replace function app_private.navigation_can_read(
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
       and rp.permission_key = 'cms.navigation.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.navigation_can_read(uuid, boolean) is
  'Whether one account effectively holds cms.navigation.read — the key as a literal, with 0003''s own requires_mfa rule applied to the assurance level as a parameter. No role name is tested anywhere.';

create or replace function app_private.navigation_can_manage(
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
       and rp.permission_key = 'cms.navigation.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.navigation_can_manage(uuid, boolean) is
  'Whether one account effectively holds cms.navigation.manage — the separate key every write below requires. A reader may hold the first key and not this one, which is why the detail reports the capability.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The menu keys this increment serves
-- ---------------------------------------------------------------------------------------------------
-- Owner decision 1, stated once so it cannot drift between the public reader and the staff reader. `menu_key` is
-- free-form in 0030 (`^[a-z][a-z0-9_]*$`), which means a stored menu under any other key is legal, keeps its
-- rows, and simply has no public reader — the same arrangement `banner_strip` has in 0093.
create or replace function app_private.navigation_menu_key_is_served(p_menu_key text) returns boolean
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  -- `coalesce`, so the answer is always a boolean. A three-valued predicate is a trap for the next caller: a
  -- null key would make `not served` neither true nor false, and the whole point of this function is that one
  -- `if` somewhere can rely on it.
  select coalesce(p_menu_key in ('header', 'footer', 'mobile'), false);
$$;

comment on function app_private.navigation_menu_key_is_served(text) is
  'The three menu keys this increment places: header, footer and mobile (owner decision 1). Placement is deliberately not discovered dynamically; a menu under any other key is legal and has no public reader.';

-- ---------------------------------------------------------------------------------------------------
-- 3. Whether one item's target is public, and what it points at
-- ---------------------------------------------------------------------------------------------------
-- One function, used by the public reader and by the staff reader, so "is this target public" is answered the
-- same way on both sides of the console. It composes the predicate that already owns each question and adds
-- nothing: `cms_content_is_public` for a page or a post (0030's own rule, which 0085 and 0092 both use) and
-- `public_category_visible` for a category (0049's ancestry walk).
--
-- A `path` item has no target row. It is public when it has a path at all, which 0030's CHECK already
-- guarantees for that kind — the coalesce is defence in depth, not a second rule.
--
-- `state` is deliberately three-valued rather than a boolean: an operator needs to know whether a target
-- disappeared or was merely unpublished, and the console is the only place that distinction can be explained.
create or replace function app_private.navigation_target_state(
  p_target_kind text,
  p_page_id uuid,
  p_blog_post_id uuid,
  p_category_id uuid,
  p_path text,
  p_locale text default 'en'
) returns table (
  state text,
  slug text,
  target_title text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    -- Each branch is a scalar subquery wrapped in `coalesce`: a subquery that matches no row yields null, not a
    -- row with null columns, so "the target was deleted" has to be read from the *absence* of a row. Testing
    -- `p.id is null` inside the subquery could never fire, and the state would come back null — which the public
    -- reader would treat as not-public, safely, while the console showed an operator nothing at all.
    case p_target_kind
      when 'page' then coalesce((
        select case when public.cms_content_is_public(p.status, p.published_at) then 'public' else 'not_public' end
          from public.pages p where p.id = p_page_id
      ), 'missing')
      when 'blog_post' then coalesce((
        select case when public.cms_content_is_public(b.status, b.published_at) then 'public' else 'not_public' end
          from public.blog_posts b where b.id = p_blog_post_id
      ), 'missing')
      when 'category' then coalesce((
        select case when app_private.public_category_visible(c.id) then 'public' else 'not_public' end
          from public.categories c where c.id = p_category_id
      ), 'missing')
      else case when nullif(btrim(coalesce(p_path, '')), '') is null then 'missing' else 'public' end
    end,
    case p_target_kind
      when 'page' then (select p.slug from public.pages p where p.id = p_page_id)
      when 'blog_post' then (select b.slug from public.blog_posts b where b.id = p_blog_post_id)
      when 'category' then (select c.slug from public.categories c where c.id = p_category_id)
      else null
    end,
    -- The target's own title, for the console only: it is never served to the public, because a menu entry's
    -- public words are the operator's authored label and nothing else.
    case p_target_kind
      when 'page' then (
        select coalesce(t.title, fallback.title)
          from public.pages p
          left join public.page_translations t
            on t.page_id = p.id and t.locale_code = coalesce(nullif(btrim(p_locale), ''), 'en')
          left join public.page_translations fallback on fallback.page_id = p.id and fallback.locale_code = 'en'
         where p.id = p_page_id
      )
      when 'blog_post' then (
        select coalesce(t.title, fallback.title)
          from public.blog_posts b
          left join public.blog_post_translations t
            on t.blog_post_id = b.id and t.locale_code = coalesce(nullif(btrim(p_locale), ''), 'en')
          left join public.blog_post_translations fallback
            on fallback.blog_post_id = b.id and fallback.locale_code = 'en'
         where b.id = p_blog_post_id
      )
      when 'category' then (
        select coalesce(t.name, fallback.name, c.slug)
          from public.categories c
          left join public.category_translations t
            on t.category_id = c.id and t.locale_code = coalesce(nullif(btrim(p_locale), ''), 'en')
          left join public.category_translations fallback
            on fallback.category_id = c.id and fallback.locale_code = 'en'
         where c.id = p_category_id
      )
      else null
    end;
$$;

comment on function app_private.navigation_target_state(text, uuid, uuid, uuid, text, text) is
  'What one navigation item points at: public, not_public or missing, with the target''s slug and — for the console only — its own title. Composes cms_content_is_public for a page or post and public_category_visible for a category; adds no rule of its own.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The public reader
-- ---------------------------------------------------------------------------------------------------
-- The renderable items of the named menus, in the operator's order, labelled in the requested locale with the
-- English label as the fallback.
--
-- Takes an array of keys rather than one, so a page that renders a header, a footer and a mobile drawer asks
-- once. Every row carries its menu's key and label, which is what lets a caller group them without a second
-- read.
--
-- Owner decision 3 is applied here, twice: an item whose target is not public is absent, and a child whose
-- parent is absent is absent with it — a second-level entry without its heading is not what was arranged. A
-- menu that ends up with no rows is simply not in the result, which is how it disappears.
--
-- Owner decision 4 is **not** applied here, deliberately: see the header. `target_slug` comes back so the
-- surface that owns the route map can drop what it cannot serve.
create or replace function app_private.public_navigation_items(
  p_menu_keys text[],
  p_locale text default 'en'
) returns table (
  menu_key text,
  menu_label text,
  item_id uuid,
  parent_item_id uuid,
  depth integer,
  label text,
  target_kind text,
  target_slug text,
  target_path text,
  opens_in_new_tab boolean,
  sort_order integer,
  root_sort_order integer,
  root_item_id uuid
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with wanted as (
    select distinct k.key
      from unnest(coalesce(p_menu_keys, '{}'::text[])) as k(key)
     where app_private.navigation_menu_key_is_served(k.key)
  ),
  menu as (
    select m.id, m.menu_key, m.label_en, m.label_ar
      from public.navigation_menus m
      join wanted w on w.key = m.menu_key
     where m.is_active
  ),
  -- Every active item of those menus, with its target resolved once.
  candidate as (
    select
      i.id,
      i.menu_id,
      i.parent_id,
      i.label_en,
      i.label_ar,
      i.target_kind,
      i.path,
      i.opens_in_new_tab,
      i.sort_order,
      resolved.state,
      resolved.slug
      from public.navigation_items i
      join menu m on m.id = i.menu_id
      cross join lateral app_private.navigation_target_state(
        i.target_kind, i.page_id, i.blog_post_id, i.category_id, i.path, p_locale
      ) as resolved
     where i.is_active
  ),
  renderable as (
    select * from candidate c where c.state = 'public'
  )
  select
    m.menu_key,
    case when coalesce(nullif(btrim(p_locale), ''), 'en') = 'ar' then coalesce(m.label_ar, m.label_en)
         else m.label_en end,
    r.id,
    r.parent_id,
    case when r.parent_id is null then 1 else 2 end,
    case when coalesce(nullif(btrim(p_locale), ''), 'en') = 'ar' then coalesce(r.label_ar, r.label_en)
         else r.label_en end,
    r.target_kind,
    r.slug,
    -- Only a `path` item carries a literal address. For the other three kinds the address is derived from the
    -- slug by the caller, which is where the route map lives.
    case when r.target_kind = 'path' then r.path else null end,
    r.opens_in_new_tab,
    r.sort_order,
    -- The ordering keys: a child sorts inside its parent, and a deterministic tiebreak follows, so two entries
    -- sharing a position never come back in whichever order the planner chose today.
    coalesce(parent.sort_order, r.sort_order),
    coalesce(parent.id, r.id)
    from renderable r
    join menu m on m.id = r.menu_id
    -- A child is kept only when its parent survived. The join is against `renderable`, not `candidate`.
    left join renderable parent on parent.id = r.parent_id
   where r.parent_id is null or parent.id is not null
   order by m.menu_key,
            coalesce(parent.sort_order, r.sort_order),
            coalesce(parent.id, r.id),
            case when r.parent_id is null then 0 else 1 end,
            r.sort_order,
            r.id;
$$;

comment on function app_private.public_navigation_items(text[], text) is
  'The renderable items of the named served menus, in the operator''s order, labelled in the requested locale with English as the fallback. An item whose target is not public is absent and so is any child of an absent parent (owner decision 3); a menu left with nothing returns no rows. target_slug is returned so the caller can derive the address from its own route map.';

-- ---------------------------------------------------------------------------------------------------
-- 5. The staff readers
-- ---------------------------------------------------------------------------------------------------
-- The permission is tested in the WHERE clause, so a caller who does not hold the read key reads nothing rather
-- than being told that something exists.
create or replace function app_private.navigation_menus_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  menu_id uuid,
  menu_key text,
  label_en text,
  label_ar text,
  is_active boolean,
  is_served boolean,
  item_count integer,
  renderable_item_count integer,
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
    m.menu_key,
    m.label_en,
    m.label_ar,
    m.is_active,
    app_private.navigation_menu_key_is_served(m.menu_key),
    (select count(*)::integer from public.navigation_items i where i.menu_id = m.id),
    -- How many the public would actually be shown if this menu were served and active. Owner decision 3 made
    -- visible: a menu that has quietly emptied is the thing an operator needs to be able to see.
    (select count(*)::integer
       from public.navigation_items i
       cross join lateral app_private.navigation_target_state(
         i.target_kind, i.page_id, i.blog_post_id, i.category_id, i.path, 'en'
       ) as resolved
      where i.menu_id = m.id and i.is_active and resolved.state = 'public'),
    m.created_at,
    m.updated_at
    from public.navigation_menus m
   where app_private.navigation_can_read(p_user_id, p_is_aal2)
   order by app_private.navigation_menu_key_is_served(m.menu_key) desc, m.menu_key;
$$;

comment on function app_private.navigation_menus_for_staff(uuid, boolean) is
  'Every navigation menu for a holder of cms.navigation.read, served ones first. is_served marks a menu the public site places; renderable_item_count is how much of it the public would be shown.';

create or replace function app_private.navigation_menu_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_menu_id uuid
) returns table (
  menu_id uuid,
  menu_key text,
  label_en text,
  label_ar text,
  is_active boolean,
  is_served boolean,
  item_count integer,
  renderable_item_count integer,
  created_at timestamptz,
  updated_at timestamptz,
  can_manage boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    m.id,
    m.menu_key,
    m.label_en,
    m.label_ar,
    m.is_active,
    app_private.navigation_menu_key_is_served(m.menu_key),
    (select count(*)::integer from public.navigation_items i where i.menu_id = m.id),
    (select count(*)::integer
       from public.navigation_items i
       cross join lateral app_private.navigation_target_state(
         i.target_kind, i.page_id, i.blog_post_id, i.category_id, i.path, 'en'
       ) as resolved
      where i.menu_id = m.id and i.is_active and resolved.state = 'public'),
    m.created_at,
    m.updated_at,
    app_private.navigation_can_manage(p_user_id, p_is_aal2)
    from public.navigation_menus m
   where m.id = p_menu_id
     and app_private.navigation_can_read(p_user_id, p_is_aal2);
$$;

comment on function app_private.navigation_menu_for_staff(uuid, boolean, uuid) is
  'One menu with whether this caller may change it. No row for a menu that does not exist and none for a caller without the read key, so a refusal and an absence look alike.';

-- Every item of one menu, active or not, with the state of its target. This is where owner decision 3's
-- "admin detail must still make unavailable targets visible" is answered: an item whose page was unpublished
-- or whose category was deactivated is listed, with `target_state` saying which, and with the target's own
-- title so an operator can recognise the row being pointed at.
create or replace function app_private.navigation_items_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_menu_id uuid,
  p_locale text default 'en'
) returns table (
  item_id uuid,
  menu_id uuid,
  parent_item_id uuid,
  depth integer,
  label_en text,
  label_ar text,
  target_kind text,
  page_id uuid,
  blog_post_id uuid,
  category_id uuid,
  target_path text,
  target_slug text,
  target_title text,
  target_state text,
  opens_in_new_tab boolean,
  sort_order integer,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    i.id,
    i.menu_id,
    i.parent_id,
    case when i.parent_id is null then 1 else 2 end,
    i.label_en,
    i.label_ar,
    i.target_kind,
    i.page_id,
    i.blog_post_id,
    i.category_id,
    i.path,
    resolved.slug,
    resolved.target_title,
    resolved.state,
    i.opens_in_new_tab,
    i.sort_order,
    i.is_active,
    i.created_at,
    i.updated_at
    from public.navigation_items i
    cross join lateral app_private.navigation_target_state(
      i.target_kind, i.page_id, i.blog_post_id, i.category_id, i.path, p_locale
    ) as resolved
    left join public.navigation_items parent on parent.id = i.parent_id
   where i.menu_id = p_menu_id
     and app_private.navigation_can_read(p_user_id, p_is_aal2)
   order by coalesce(parent.sort_order, i.sort_order),
            coalesce(parent.id, i.id),
            case when i.parent_id is null then 0 else 1 end,
            i.sort_order,
            i.id;
$$;

comment on function app_private.navigation_items_for_staff(uuid, boolean, uuid, text) is
  'Every item of one menu for a holder of cms.navigation.read, in tree order, including inactive ones and ones whose target is no longer public — target_state says public, not_public or missing, which is how the console explains an item the public is not being shown.';

-- ---------------------------------------------------------------------------------------------------
-- 6. The writers
-- ---------------------------------------------------------------------------------------------------
-- Each one re-applies `navigation_can_manage` first and raises 42501 when it fails. None decides a rule 0030
-- already decides: the key format, the label lengths, the four legal target kinds, that exactly the matching
-- target column is filled, that a path is relative, the two-level depth and the same-menu rule for a child are
-- all constraints and triggers, and are left to raise their own errors.
--
-- Every optional parameter defaults to null, and that is load-bearing: these are create-or-replace writers, so a
-- non-null default would be substituted before the body runs and an omitted argument would be indistinguishable
-- from an explicit one. The insert branches let the schema's own defaults stand.
create or replace function app_private.navigation_menu_save_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_menu_id uuid,
  p_menu_key text,
  p_label_en text default null,
  p_label_ar text default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  saved_id uuid;
begin
  if not app_private.navigation_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.navigation.manage is required' using errcode = 'insufficient_privilege';
  end if;

  if p_menu_id is null then
    -- `is_active` is absent on purpose: 0030 defaults a navigation menu to active, and overriding that here
    -- would be inventing the opposite rule. The state writer below exists for hiding one.
    insert into public.navigation_menus (menu_key, label_en, label_ar)
    values (
      btrim(p_menu_key),
      btrim(coalesce(p_label_en, '')),
      nullif(btrim(coalesce(p_label_ar, '')), '')
    )
    returning id into saved_id;
    return saved_id;
  end if;

  update public.navigation_menus m
     set menu_key = coalesce(nullif(btrim(p_menu_key), ''), m.menu_key),
         label_en = coalesce(nullif(btrim(coalesce(p_label_en, '')), ''), m.label_en),
         label_ar = case when p_label_ar is null then m.label_ar else nullif(btrim(p_label_ar), '') end
   where m.id = p_menu_id
  returning m.id into saved_id;

  return saved_id;
end;
$$;

comment on function app_private.navigation_menu_save_for_staff(uuid, boolean, uuid, text, text, text) is
  'Creates or replaces one navigation menu, returning its id — or null when the named id does not exist. is_active is not settable here: showing or hiding a menu is its own call.';

create or replace function app_private.navigation_menu_state_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_menu_id uuid,
  p_is_active boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if not app_private.navigation_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.navigation.manage is required' using errcode = 'insufficient_privilege';
  end if;

  update public.navigation_menus m
     set is_active = coalesce(p_is_active, m.is_active)
   where m.id = p_menu_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.navigation_menu_state_for_staff(uuid, boolean, uuid, boolean) is
  'Shows or hides one menu. Hiding a served menu removes it from every public surface at once, which is why it is separate from the save.';

create or replace function app_private.navigation_menu_delete_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_menu_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deleted integer;
begin
  if not app_private.navigation_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.navigation.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- A real delete, and 0030's `on delete cascade` takes the items with it. A menu is a composition choice
  -- rather than a record of anything that happened, and the audit triggers have already recorded that it
  -- existed — but a delete is a large action, which is why the console asks before it.
  delete from public.navigation_menus m where m.id = p_menu_id;
  get diagnostics deleted = row_count;
  return deleted = 1;
end;
$$;

comment on function app_private.navigation_menu_delete_for_staff(uuid, boolean, uuid) is
  'Removes one menu and, by 0030''s cascade, its items. A real delete: a menu is a composition choice, not a record of an event, and the audit triggers have already recorded that it existed.';

-- One item. The target is the one thing this writer treats as a unit: naming `p_target_kind` replaces all four
-- target columns from the arguments given, so changing a `page` item into a `path` item clears the page and
-- fills the path in one statement and 0030's CHECK is never momentarily unsatisfiable. Leaving
-- `p_target_kind` null leaves the target entirely alone — which is what an edit to a label is.
create or replace function app_private.navigation_item_save_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_item_id uuid,
  p_menu_id uuid,
  p_label_en text default null,
  p_label_ar text default null,
  p_target_kind text default null,
  p_page_id uuid default null,
  p_blog_post_id uuid default null,
  p_category_id uuid default null,
  p_path text default null,
  p_parent_id uuid default null,
  p_opens_in_new_tab boolean default null,
  p_sort_order integer default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  saved_id uuid;
begin
  if not app_private.navigation_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.navigation.manage is required' using errcode = 'insufficient_privilege';
  end if;

  if p_item_id is null then
    insert into public.navigation_items (
      menu_id, parent_id, label_en, label_ar, target_kind,
      page_id, blog_post_id, category_id, path, opens_in_new_tab, sort_order
    )
    values (
      p_menu_id,
      p_parent_id,
      btrim(coalesce(p_label_en, '')),
      nullif(btrim(coalesce(p_label_ar, '')), ''),
      p_target_kind,
      case when p_target_kind = 'page' then p_page_id else null end,
      case when p_target_kind = 'blog_post' then p_blog_post_id else null end,
      case when p_target_kind = 'category' then p_category_id else null end,
      case when p_target_kind = 'path' then nullif(btrim(coalesce(p_path, '')), '') else null end,
      coalesce(p_opens_in_new_tab, false),
      coalesce(p_sort_order, 0)
    )
    returning id into saved_id;
    return saved_id;
  end if;

  update public.navigation_items i
     set label_en = coalesce(nullif(btrim(coalesce(p_label_en, '')), ''), i.label_en),
         label_ar = case when p_label_ar is null then i.label_ar else nullif(btrim(p_label_ar), '') end,
         -- The parent is cleared by naming the item's own id, which the `is_not_its_own_parent` CHECK then
         -- refuses — so instead a null here means "leave it" and the console moves an item by sending the
         -- parent it should have. Promoting a child to the top level is its own edit, below.
         parent_id = coalesce(p_parent_id, i.parent_id),
         target_kind = coalesce(p_target_kind, i.target_kind),
         page_id = case
                     when p_target_kind is null then i.page_id
                     when p_target_kind = 'page' then p_page_id
                     else null
                   end,
         blog_post_id = case
                          when p_target_kind is null then i.blog_post_id
                          when p_target_kind = 'blog_post' then p_blog_post_id
                          else null
                        end,
         category_id = case
                         when p_target_kind is null then i.category_id
                         when p_target_kind = 'category' then p_category_id
                         else null
                       end,
         path = case
                  when p_target_kind is null then i.path
                  when p_target_kind = 'path' then nullif(btrim(coalesce(p_path, '')), '')
                  else null
                end,
         opens_in_new_tab = coalesce(p_opens_in_new_tab, i.opens_in_new_tab),
         sort_order = coalesce(p_sort_order, i.sort_order)
   where i.id = p_item_id
  returning i.id into saved_id;

  return saved_id;
end;
$$;

comment on function app_private.navigation_item_save_for_staff(uuid, boolean, uuid, uuid, text, text, text, uuid, uuid, uuid, text, uuid, boolean, integer) is
  'Creates or replaces one menu item, returning its id — or null when the named id does not exist. Naming the target kind replaces all four target columns at once so 0030''s CHECK is never momentarily unsatisfiable; omitting it leaves the target alone. is_active is not settable here.';

-- Promoting a second-level item to the top level. Separate from the save because `coalesce` cannot express
-- "set this to null": a null parent in the save means "leave it where it is", and one call has to be able to
-- mean the other thing.
create or replace function app_private.navigation_item_promote_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_item_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if not app_private.navigation_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.navigation.manage is required' using errcode = 'insufficient_privilege';
  end if;

  update public.navigation_items i set parent_id = null where i.id = p_item_id and i.parent_id is not null;
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.navigation_item_promote_for_staff(uuid, boolean, uuid) is
  'Moves one second-level item to the top level of its own menu. Separate from the save because a null parent there means "leave it alone", and clearing one has to be sayable.';

create or replace function app_private.navigation_item_state_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_item_id uuid,
  p_is_active boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if not app_private.navigation_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.navigation.manage is required' using errcode = 'insufficient_privilege';
  end if;

  update public.navigation_items i
     set is_active = coalesce(p_is_active, i.is_active)
   where i.id = p_item_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.navigation_item_state_for_staff(uuid, boolean, uuid, boolean) is
  'Shows or hides one item. Hiding a top-level item takes its children off the public menu with it, because a second-level entry without its heading is not what was arranged.';

-- One statement for the whole order, because an order is a set of positions rather than a sequence of edits.
-- Scoped to one menu: an id belonging to another menu updates nothing, so a stale screen cannot reorder a menu
-- nobody was looking at.
create or replace function app_private.navigation_items_reorder_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_menu_id uuid,
  p_item_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  moved integer;
begin
  if not app_private.navigation_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.navigation.manage is required' using errcode = 'insufficient_privilege';
  end if;

  update public.navigation_items i
     set sort_order = (chosen.ordinality - 1) * 10
    from unnest(coalesce(p_item_ids, '{}'::uuid[])) with ordinality as chosen(item_id, ordinality)
   where i.id = chosen.item_id
     and i.menu_id = p_menu_id;

  get diagnostics moved = row_count;
  return moved;
end;
$$;

comment on function app_private.navigation_items_reorder_for_staff(uuid, boolean, uuid, uuid[]) is
  'Sets the order of the items named, from the argument''s own ordering, in one statement, scoped to one menu. Positions are spaced by ten so a later insertion between two items needs no rewrite. Returns how many rows moved.';

create or replace function app_private.navigation_item_delete_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_item_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deleted integer;
begin
  if not app_private.navigation_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.navigation.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- 0030's self-reference cascades, so deleting a heading deletes the entries under it. That is the schema's
  -- decision and this writer does not work around it.
  delete from public.navigation_items i where i.id = p_item_id;
  get diagnostics deleted = row_count;
  return deleted = 1;
end;
$$;

comment on function app_private.navigation_item_delete_for_staff(uuid, boolean, uuid) is
  'Removes one item and, by 0030''s cascade, any item under it. A real delete, for the same reason a menu''s is.';

-- ---------------------------------------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.navigation_can_read(uuid, boolean) from public, app_worker;
revoke execute on function app_private.navigation_can_manage(uuid, boolean) from public, app_worker;
revoke execute on function app_private.navigation_menu_key_is_served(text) from public, app_worker;
revoke execute on function app_private.navigation_target_state(text, uuid, uuid, uuid, text, text) from public, app_worker;
revoke execute on function app_private.public_navigation_items(text[], text) from public, app_worker;
revoke execute on function app_private.navigation_menus_for_staff(uuid, boolean) from public, app_worker;
revoke execute on function app_private.navigation_menu_for_staff(uuid, boolean, uuid) from public, app_worker;
revoke execute on function app_private.navigation_items_for_staff(uuid, boolean, uuid, text) from public, app_worker;
revoke execute on function app_private.navigation_menu_save_for_staff(uuid, boolean, uuid, text, text, text) from public, app_worker;
revoke execute on function app_private.navigation_menu_state_for_staff(uuid, boolean, uuid, boolean) from public, app_worker;
revoke execute on function app_private.navigation_menu_delete_for_staff(uuid, boolean, uuid) from public, app_worker;
revoke execute on function app_private.navigation_item_save_for_staff(uuid, boolean, uuid, uuid, text, text, text, uuid, uuid, uuid, text, uuid, boolean, integer) from public, app_worker;
revoke execute on function app_private.navigation_item_promote_for_staff(uuid, boolean, uuid) from public, app_worker;
revoke execute on function app_private.navigation_item_state_for_staff(uuid, boolean, uuid, boolean) from public, app_worker;
revoke execute on function app_private.navigation_items_reorder_for_staff(uuid, boolean, uuid, uuid[]) from public, app_worker;
revoke execute on function app_private.navigation_item_delete_for_staff(uuid, boolean, uuid) from public, app_worker;

-- `app_system` only. The worker has no business with navigation: it composes nothing and reacts to no event
-- this migration adds.
grant execute on function app_private.navigation_can_read(uuid, boolean) to app_system;
grant execute on function app_private.navigation_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.navigation_menu_key_is_served(text) to app_system;
grant execute on function app_private.navigation_target_state(text, uuid, uuid, uuid, text, text) to app_system;
grant execute on function app_private.public_navigation_items(text[], text) to app_system;
grant execute on function app_private.navigation_menus_for_staff(uuid, boolean) to app_system;
grant execute on function app_private.navigation_menu_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.navigation_items_for_staff(uuid, boolean, uuid, text) to app_system;
grant execute on function app_private.navigation_menu_save_for_staff(uuid, boolean, uuid, text, text, text) to app_system;
grant execute on function app_private.navigation_menu_state_for_staff(uuid, boolean, uuid, boolean) to app_system;
grant execute on function app_private.navigation_menu_delete_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.navigation_item_save_for_staff(uuid, boolean, uuid, uuid, text, text, text, uuid, uuid, uuid, text, uuid, boolean, integer) to app_system;
grant execute on function app_private.navigation_item_promote_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.navigation_item_state_for_staff(uuid, boolean, uuid, boolean) to app_system;
grant execute on function app_private.navigation_items_reorder_for_staff(uuid, boolean, uuid, uuid[]) to app_system;
grant execute on function app_private.navigation_item_delete_for_staff(uuid, boolean, uuid) to app_system;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
