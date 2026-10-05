-- 0087 — Managing the category tree (admin catalogue, D8).
--
-- Migration 0010 created `categories`, `category_translations` and the tree trigger, and seeded nothing: no
-- migration anywhere inserts a category, because the tree is operator data. So the table has been there since
-- 0010 with public readers over it (0045, 0049) and **no way to put a row in it**. That is what this adds.
--
-- It matters more than its size suggests. `listings.category_id` is `not null` and the seller contracts require
-- a `categorySlug` on every listing and service, so until a category exists no seller can publish anything and
-- every public catalogue surface has nothing to show.
--
-- **No table, constraint, trigger or policy of 0010 is changed.** Nothing is created either. These are named
-- readers and writers over what is already there.
--
-- ---------------------------------------------------------------------------------------------------
-- What this does not decide
-- ---------------------------------------------------------------------------------------------------
-- The tree rules are 0010's and are called rather than restated:
--
--   `app_private.tg_categories_tree_rule()`   maintains `depth`, refuses a fourth level, refuses a cycle or a
--                                             self-parent, and refuses a move that would re-depth a category
--                                             that has children
--   `app_private.public_category_visible(id)` active, and so is every ancestor (0049)
--   `categories_slug_format`, `categories_slug` unique, `categories_depth_range`, the translation length
--                                             constraints — all left to the constraints that own them
--
-- So `depth` is never written here: it is the trigger's, and a writer that set it would be a second opinion
-- about the shape of the tree. Deactivation needs no propagation code either, because every public reader
-- already resolves through the ancestor rule — a deactivated parent takes its branch out of the tree, the
-- landing pages, the search facet and the sitemap at once.
--
-- **The slug is immutable after creation** (owner decision, this increment). There is no `category_slug_history`
-- and the public reader has no `moved` answer, so a rename would break a live address with no redirect. The
-- update writer therefore does not take a slug, which is the difference between a rule and a hope.
--
-- ---------------------------------------------------------------------------------------------------
-- Attribution
-- ---------------------------------------------------------------------------------------------------
-- 0010's `categories_audit` trigger already records every change through `audit.tg_record_change()`, so these
-- writers add no audit code. They deliberately do **not** publish an audit actor: `app.audit_actor_id` is the
-- 8-B channel, whose contract (`app_private.audit_attribution_contract`) is a closed list that
-- `public.audit_attribution_problems()` enforces, and every writer in it is a financial one. Naming the channel
-- from here would fail that guard; adding a row to the contract would reopen closed 8-B. `categories` has no
-- `created_by`/`updated_by` column to fall back on and D8 defines none, so the audit row records the truthful
-- `system` actor rather than an invented one. Attributing a category edit to a person is its own increment.

-- ---------------------------------------------------------------------------------------------------
-- 1. The permission predicates
-- ---------------------------------------------------------------------------------------------------
-- The keys are 0033's, seeded, and held by `admin` and `super_admin` — both `requires_mfa`, so 0003's rule
-- means a staff session at `aal1` holds neither. The key is a literal in each function so that no caller can
-- pass a different one.
create or replace function app_private.category_can_read(p_user_id uuid, p_is_aal2 boolean)
returns boolean
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
       and rp.permission_key = 'catalog.category.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.category_can_read(uuid, boolean) is
  'Whether a staff account may read the category tree in the console: it holds catalog.category.read through a role that either does not require MFA or is presented at aal2 (0003).';

create or replace function app_private.category_can_manage(p_user_id uuid, p_is_aal2 boolean)
returns boolean
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
       and rp.permission_key = 'catalog.category.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.category_can_manage(uuid, boolean) is
  'Whether a staff account may change the category tree. The table''s own RLS write policy names the same key with is_aal2(); this is the same rule applied where app_system reaches the table through a definer function.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The staff tree
-- ---------------------------------------------------------------------------------------------------
-- The whole tree, including what the public cannot see: a console that showed only active categories could not
-- be used to reactivate one. Depth order then sibling order then slug, so the answer is a tree a reader can
-- indent directly, and is stable.
--
-- `is_visible` is the public answer, carried per row, so the console can show that an active category under a
-- deactivated parent still reaches nobody. `translated_locales` is the locale coverage: the one thing an
-- author most needs to see and the one thing a row does not say by itself.
--
-- The permission test is in the WHERE clause, so a caller without the read key receives an empty set rather
-- than a refusal to distinguish from one.
create or replace function app_private.categories_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  category_id uuid,
  parent_id uuid,
  slug text,
  depth smallint,
  sort_order integer,
  listing_type_code text,
  is_active boolean,
  is_visible boolean,
  child_count integer,
  listing_count integer,
  translated_locales text[],
  name text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    c.id,
    c.parent_id,
    c.slug,
    c.depth,
    c.sort_order,
    c.listing_type_code,
    c.is_active,
    app_private.public_category_visible(c.id),
    (select count(*)::integer from public.categories ch where ch.parent_id = c.id),
    (select count(*)::integer from public.listings l where l.category_id = c.id),
    coalesce(
      (select array_agg(t.locale_code order by t.locale_code) from public.category_translations t where t.category_id = c.id),
      array[]::text[]),
    (select t.name
       from public.category_translations t
       join public.locales d on d.code = t.locale_code and d.is_default
      where t.category_id = c.id),
    c.updated_at
    from public.categories c
   where app_private.category_can_read(p_user_id, p_is_aal2)
   order by c.depth, c.sort_order, c.slug;
$$;

comment on function app_private.categories_for_staff(uuid, boolean) is
  'The whole category tree for the console, including the inactive: depth then sibling order then slug. Carries the public visibility answer, the locale coverage, and how much hangs off each node. Empty for a caller without the read key.';

-- ---------------------------------------------------------------------------------------------------
-- 3. One category
-- ---------------------------------------------------------------------------------------------------
-- `can_manage` travels with the row because reading and managing are separate keys: a console renders its
-- controls from the server's answer rather than from a role name it guessed at.
--
-- `parent_slug` is carried so a detail screen can name the parent without a second read, and
-- `has_children`/`listing_count` because both decide whether a move or a deactivation is safe to offer.
create or replace function app_private.category_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_category_id uuid
) returns table (
  category_id uuid,
  parent_id uuid,
  parent_slug text,
  slug text,
  depth smallint,
  sort_order integer,
  listing_type_code text,
  is_active boolean,
  is_visible boolean,
  child_count integer,
  listing_count integer,
  translated_locales text[],
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
    c.id,
    c.parent_id,
    p.slug,
    c.slug,
    c.depth,
    c.sort_order,
    c.listing_type_code,
    c.is_active,
    app_private.public_category_visible(c.id),
    (select count(*)::integer from public.categories ch where ch.parent_id = c.id),
    (select count(*)::integer from public.listings l where l.category_id = c.id),
    coalesce(
      (select array_agg(t.locale_code order by t.locale_code) from public.category_translations t where t.category_id = c.id),
      array[]::text[]),
    c.created_at,
    c.updated_at,
    app_private.category_can_manage(p_user_id, p_is_aal2)
    from public.categories c
    left join public.categories p on p.id = c.parent_id
   where c.id = p_category_id
     and app_private.category_can_read(p_user_id, p_is_aal2);
$$;

comment on function app_private.category_for_staff(uuid, boolean, uuid) is
  'One category for the console, with the public visibility answer, the locale coverage, what hangs off it, and whether this caller may change it. No row for a caller without the read key, which is the same answer as a category that does not exist.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The translations of one category
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.category_translations_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_category_id uuid
) returns table (
  locale_code text,
  name text,
  description text,
  meta_title text,
  meta_description text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select t.locale_code, t.name, t.description, t.meta_title, t.meta_description, t.updated_at
    from public.category_translations t
   where t.category_id = p_category_id
     and app_private.category_can_read(p_user_id, p_is_aal2)
   order by t.locale_code;
$$;

comment on function app_private.category_translations_for_staff(uuid, boolean, uuid) is
  'Every written locale of one category, in locale order. Empty for a caller without the read key.';

-- ---------------------------------------------------------------------------------------------------
-- 5. Create
-- ---------------------------------------------------------------------------------------------------
-- The slug is given once, here, and never again: it is the category's public address and there is no slug
-- history to redirect from.
--
-- A new category is created **inactive**, whatever the caller asks. A category with no name in any locale would
-- otherwise appear in the public tree the moment it was created, labelled by its own slug — the fallback in
-- 0045 is `coalesce(t.name, d.name, v.slug)`. So it is written first and shown when somebody decides it is
-- ready, which is also why activation is a separate call.
--
-- `depth` is absent: the trigger derives it from the parent and refuses a fourth level.
create or replace function app_private.category_create_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_slug text,
  p_parent_id uuid default null,
  p_listing_type_code text default null,
  p_sort_order integer default 0
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  if not app_private.category_can_manage(p_user_id, p_is_aal2) then
    raise exception 'category management requires catalog.category.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.categories (parent_id, slug, listing_type_code, is_active, sort_order)
  values (p_parent_id, p_slug, nullif(btrim(coalesce(p_listing_type_code, '')), ''), false,
          coalesce(p_sort_order, 0))
  returning id into new_id;

  return new_id;
end;
$$;

comment on function app_private.category_create_for_staff(uuid, boolean, text, uuid, text, integer) is
  'Creates one category, always inactive and always at the slug given, which can never change. Depth comes from the tree trigger. Raises insufficient_privilege (42501) without the manage key.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Update
-- ---------------------------------------------------------------------------------------------------
-- Parent, listing type and ordering. **`slug` and `is_active` are deliberately absent**: the slug can never
-- change, and activation is its own call so that a visibility change is never a side effect of an edit.
--
-- The parent is passed as a pair — the value and whether to apply it — because `null` is a real parent: it
-- means a root. Without the flag, "move to the root" and "leave the parent alone" would be the same request.
create or replace function app_private.category_update_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_category_id uuid,
  p_set_parent boolean,
  p_parent_id uuid,
  p_listing_type_code text,
  p_sort_order integer
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed integer;
begin
  if not app_private.category_can_manage(p_user_id, p_is_aal2) then
    raise exception 'category management requires catalog.category.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  update public.categories c
     set parent_id = case when p_set_parent then p_parent_id else c.parent_id end,
         listing_type_code = nullif(btrim(coalesce(p_listing_type_code, '')), ''),
         sort_order = coalesce(p_sort_order, c.sort_order)
   where c.id = p_category_id;

  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

comment on function app_private.category_update_for_staff(uuid, boolean, uuid, boolean, uuid, text, integer) is
  'Changes a category''s parent, listing type and ordering. The slug cannot change and the active state is a separate call. The tree trigger decides whether a move is allowed; a category that does not exist returns false.';

-- ---------------------------------------------------------------------------------------------------
-- 7. Activate and deactivate
-- ---------------------------------------------------------------------------------------------------
-- Its own call, because this is the one edit a visitor sees.
--
-- **Activating refuses a category nobody has named.** 0045 falls back to the slug when no translation exists,
-- so an unnamed category would appear in the public tree labelled `winter-coats`. The same shape as the CMS
-- rule that a page cannot be published before it is written.
--
-- Deactivating needs no cascade: `public_category_visible` requires every ancestor to be active, so the branch
-- leaves every public surface at once. The children keep their own `is_active`, which is what lets a branch be
-- restored exactly as it was.
create or replace function app_private.category_state_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_category_id uuid,
  p_is_active boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed integer;
begin
  if not app_private.category_can_manage(p_user_id, p_is_aal2) then
    raise exception 'category management requires catalog.category.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  -- Existence first. A category that does not exist is "false", never a rule violation: a refusal that named
  -- a rule would tell a caller that the thing it asked about is there.
  if not exists (select 1 from public.categories c where c.id = p_category_id) then
    return false;
  end if;

  if p_is_active and not exists (
    select 1 from public.category_translations t where t.category_id = p_category_id
  ) then
    raise exception 'a category must be named in at least one locale before it is shown'
      using errcode = 'restrict_violation';
  end if;

  update public.categories c set is_active = p_is_active where c.id = p_category_id;

  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

comment on function app_private.category_state_for_staff(uuid, boolean, uuid, boolean) is
  'Shows or hides one category. Showing one that has been named in no locale is refused (restrict_violation), because the public tree would label it by its slug. Hiding needs no cascade: the ancestor rule takes the whole branch out.';

-- ---------------------------------------------------------------------------------------------------
-- 8. Write one locale
-- ---------------------------------------------------------------------------------------------------
-- An upsert, so an author writing a locale for the first time and correcting it later make the same call.
-- Blank optional fields are stored as null rather than as an empty string: a description nobody wrote and a
-- description somebody cleared are the same thing, and a `''` meta title would otherwise render as an empty tag.
-- `name` is `not null` in 0010 and stays required here.
--
-- The parent's `updated_at` is touched so that a console ordered by last edit sees a translation as an edit to
-- the category, which is what an author means by it.
create or replace function app_private.category_translation_save_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_category_id uuid,
  p_locale_code text,
  p_name text,
  p_description text default null,
  p_meta_title text default null,
  p_meta_description text default null
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed integer;
begin
  if not app_private.category_can_manage(p_user_id, p_is_aal2) then
    raise exception 'category management requires catalog.category.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.categories c where c.id = p_category_id) then
    return false;
  end if;

  insert into public.category_translations
    (category_id, locale_code, name, description, meta_title, meta_description)
  values (
    p_category_id,
    p_locale_code,
    p_name,
    nullif(btrim(coalesce(p_description, '')), ''),
    nullif(btrim(coalesce(p_meta_title, '')), ''),
    nullif(btrim(coalesce(p_meta_description, '')), '')
  )
  on conflict (category_id, locale_code) do update
     set name = excluded.name,
         description = excluded.description,
         meta_title = excluded.meta_title,
         meta_description = excluded.meta_description;

  get diagnostics changed = row_count;
  update public.categories c set updated_at = now() where c.id = p_category_id;
  return changed > 0;
end;
$$;

comment on function app_private.category_translation_save_for_staff(uuid, boolean, uuid, text, text, text, text, text) is
  'Writes or rewrites one locale of one category. Blank optional fields become null; the name stays required. False for a category that does not exist.';

-- ---------------------------------------------------------------------------------------------------
-- 9. Remove one locale
-- ---------------------------------------------------------------------------------------------------
-- A locale that is not there returns false **before** the last-locale guard, so removing something absent is
-- never reported as a rule violation. An active category keeps at least one locale, for the same reason it
-- could not be activated without one.
create or replace function app_private.category_translation_delete_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_category_id uuid,
  p_locale_code text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  remaining integer;
  active boolean;
  changed integer;
begin
  if not app_private.category_can_manage(p_user_id, p_is_aal2) then
    raise exception 'category management requires catalog.category.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.category_translations t
     where t.category_id = p_category_id and t.locale_code = p_locale_code
  ) then
    return false;
  end if;

  select c.is_active into active from public.categories c where c.id = p_category_id;
  select count(*) into remaining from public.category_translations t where t.category_id = p_category_id;

  if coalesce(active, false) and remaining <= 1 then
    raise exception 'a category that is shown must keep at least one locale'
      using errcode = 'restrict_violation';
  end if;

  delete from public.category_translations t
   where t.category_id = p_category_id and t.locale_code = p_locale_code;

  get diagnostics changed = row_count;
  update public.categories c set updated_at = now() where c.id = p_category_id;
  return changed > 0;
end;
$$;

comment on function app_private.category_translation_delete_for_staff(uuid, boolean, uuid, text) is
  'Removes one locale of one category. An absent locale is false rather than a refusal; the last locale of a category that is shown is refused (restrict_violation).';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.category_can_read(uuid, boolean) from public;
revoke execute on function app_private.category_can_manage(uuid, boolean) from public;
revoke execute on function app_private.categories_for_staff(uuid, boolean) from public;
revoke execute on function app_private.category_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.category_translations_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.category_create_for_staff(uuid, boolean, text, uuid, text, integer) from public;
revoke execute on function app_private.category_update_for_staff(uuid, boolean, uuid, boolean, uuid, text, integer) from public;
revoke execute on function app_private.category_state_for_staff(uuid, boolean, uuid, boolean) from public;
revoke execute on function app_private.category_translation_save_for_staff(uuid, boolean, uuid, text, text, text, text, text) from public;
revoke execute on function app_private.category_translation_delete_for_staff(uuid, boolean, uuid, text) from public;

-- `app_system` only. The worker neither reads nor edits the catalogue tree; it relays outboxes.
grant execute on function app_private.category_can_read(uuid, boolean) to app_system;
grant execute on function app_private.category_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.categories_for_staff(uuid, boolean) to app_system;
grant execute on function app_private.category_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.category_translations_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.category_create_for_staff(uuid, boolean, text, uuid, text, integer) to app_system;
grant execute on function app_private.category_update_for_staff(uuid, boolean, uuid, boolean, uuid, text, integer) to app_system;
grant execute on function app_private.category_state_for_staff(uuid, boolean, uuid, boolean) to app_system;
grant execute on function app_private.category_translation_save_for_staff(uuid, boolean, uuid, text, text, text, text, text) to app_system;
grant execute on function app_private.category_translation_delete_for_staff(uuid, boolean, uuid, text) to app_system;

select app_private.assert_security_contract();
