-- 0045 — Reading the public category tree (Phase 4-A).
--
-- The first guest-facing read in the system, and therefore the first time the question "how does a
-- browser with no session see anything at all?" has to be answered. The owner's decision for Phase 4-A
-- answers it the same way every server-side read has been answered since 0034: a named SECURITY DEFINER
-- function in `app_private`, EXECUTE granted to `app_system` alone, no table privilege anywhere, and
-- nothing whatsoever granted to `anon`.
--
-- That matters more here than it looks. `0010` gives `categories` and `category_translations` a
-- `_public_read` policy **to `authenticated`** — a signed-in browser role. A guest has no such role, and
-- `0001` revokes `app_private` from `public`, `anon` and `authenticated` outright, so without this
-- function there is no path from a guest request to a category at all. The alternative, a grant to
-- `anon`, is refused by the repository's own migration policy and by the Supabase exposure controls. So
-- the guest path is: browser → Next.js BFF → API → this function, and the deny-by-default model is
-- untouched.
--
-- **The projection is fixed and minimal.** Four columns leave this function: the identifier, the parent
-- (structure, not content), the slug and one resolved name. Everything else `0010` stores —
-- `listing_type_code`, `icon`, `image_object_path`, `is_active`, `depth`, timestamps, and the
-- translations' `description`, `meta_title` and `meta_description` — stays inside. A caller cannot ask
-- for more, because there is nothing else to ask for.
--
-- **Visibility is inherited, not per-row.** The walk starts at active roots and descends only through
-- active parents, so deactivating a branch hides everything under it. A flat `where is_active` would
-- have leaked the children of a deactivated parent into the public tree, which is exactly the kind of
-- half-hidden state the listing-visibility rules exist to prevent.
--
-- **Name resolution.** The requested locale first; then the default locale; then the slug. The schema
-- does not require a translation row per category per locale, so some fallback is unavoidable — the
-- response contract has no nullable name and dropping an active category for want of a translation
-- would hide real data. An unknown or inactive locale resolves to the default rather than failing: a
-- locale is a representation choice, not an authorisation one.

create or replace function app_private.public_categories(p_locale text)
returns table (
  id uuid,
  parent_id uuid,
  slug text,
  name text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive
  -- The locale actually used: the requested one when it exists and is active, otherwise the default.
  requested as (
    select coalesce(
      (select l.code from public.locales l
        where l.code = lower(btrim(coalesce(p_locale, ''))) and l.is_active),
      (select l.code from public.locales l where l.is_default limit 1)
    ) as code
  ),
  fallback as (
    select l.code from public.locales l where l.is_default limit 1
  ),
  -- Active roots, then active children of anything already visible. A category under a deactivated
  -- ancestor never enters the set.
  visible as (
    select c.id, c.parent_id, c.slug, c.sort_order, c.depth
      from public.categories c
     where c.parent_id is null and c.is_active
    union all
    select c.id, c.parent_id, c.slug, c.sort_order, c.depth
      from public.categories c
      join visible v on c.parent_id = v.id
     where c.is_active
  )
  select v.id,
         v.parent_id,
         v.slug,
         coalesce(t.name, d.name, v.slug) as name
    from visible v
    left join public.category_translations t
      on t.category_id = v.id and t.locale_code = (select code from requested)
    left join public.category_translations d
      on d.category_id = v.id and d.locale_code = (select code from fallback)
   -- Siblings follow the order the catalogue was given (`categories_parent` indexes exactly this);
   -- the slug breaks ties so the answer is stable rather than merely sorted.
   order by v.depth, v.sort_order, v.slug;
$$;

comment on function app_private.public_categories(text) is
  'The public category tree for one locale: id, parent, slug and a resolved name, for active categories under active ancestors only. Returns no administrative field and no unpublished category. Name falls back from the requested locale to the default locale to the slug.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.public_categories(text) from public;

-- The API role alone, as for every reader and writer since 0034. A guest reaches this only through the
-- API; no browser role can call it, and none needs to.
grant execute on function app_private.public_categories(text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
