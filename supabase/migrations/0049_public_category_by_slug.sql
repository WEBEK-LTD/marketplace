-- 0049 — Reading one public category by slug (Phase 4-D).
--
-- 0045 answers "what is the whole visible tree". This answers "what is at this URL": the category, its
-- parent, its direct children, and the translated SEO metadata the page's `<head>` needs.
--
-- **The visibility rule is written once.** 0045 expresses it as a recursive CTE inside its own query,
-- and that migration is frozen. Rather than paste that CTE into a second reader and let the two drift,
-- the rule is lifted into `app_private.public_category_visible(uuid)` — a category is public when it is
-- active and every one of its ancestors is active — and the new readers call it. 0045 keeps its inline
-- form, so the two are checked against each other in the pgTAP suite: the set of ids 0045 returns must
-- be exactly the set this function admits. A change to one that is not made to the other fails there.
--
-- **Name and metadata resolution** follow 0045 exactly: the requested locale, then the default locale,
-- then the slug for the name. `description`, `meta_title` and `meta_description` have no slug to fall
-- back on, so they fall back to the default locale and then to null — a page without them renders
-- without them rather than inventing text.
--
-- **Nothing else is exposed.** No `is_active`, no `sort_order`, no `depth`, no `listing_type_code`, no
-- `icon`, no `image_object_path`, no timestamps, and no listing counts. The columns are not filtered out
-- downstream; they are never read.

-- ---------------------------------------------------------------------------------------------------
-- The visibility rule
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.public_category_visible(p_category_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive ancestry as (
    select c.id, c.parent_id, c.is_active
      from public.categories c
     where c.id = p_category_id
    union all
    select p.id, p.parent_id, p.is_active
      from public.categories p
      join ancestry a on a.parent_id = p.id
  )
  -- The category exists, and nothing on the path to the root is deactivated. `bool_and` over an empty
  -- set is null, so an unknown id is coalesced to false rather than leaking as "not invisible".
  select coalesce(bool_and(is_active), false) from ancestry;
$$;

comment on function app_private.public_category_visible(uuid) is
  'Whether one category is publicly visible: it is active and so is every ancestor. The single expression of the rule 0045 applies to the tree.';

-- ---------------------------------------------------------------------------------------------------
-- One category by slug
-- ---------------------------------------------------------------------------------------------------
-- `outcome` carries the answer:
--
--   found      the slug names a category the public may see
--   not_found  no category, or one that is inactive or under a deactivated ancestor
--
-- There is no `moved`: categories have no slug history, so there is nothing to redirect to. An inactive
-- category is `not_found` rather than anything more specific, so the surface cannot be used to learn
-- that a category exists but is switched off.
create or replace function app_private.public_category_by_slug(
  p_slug text,
  p_locale text default null
) returns table (
  outcome text,
  id uuid,
  slug text,
  name text,
  description text,
  meta_title text,
  meta_description text,
  parent jsonb,
  children jsonb
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
begin
  select coalesce(
    (select l.code from public.locales l where l.code = lower(btrim(coalesce(p_locale, ''))) and l.is_active),
    (select l.code from public.locales l where l.is_default limit 1)
  ) into v_locale;
  select l.code into v_fallback from public.locales l where l.is_default limit 1;

  select c.id into v_id
    from public.categories c
   where c.slug = p_slug and app_private.public_category_visible(c.id);

  if v_id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
                        null::text, null::jsonb, null::jsonb;
    return;
  end if;

  return query
    select 'found'::text,
           c.id,
           c.slug,
           coalesce(t.name, d.name, c.slug),
           coalesce(t.description, d.description),
           coalesce(t.meta_title, d.meta_title),
           coalesce(t.meta_description, d.meta_description),
           -- The parent, when there is one and the public may see it. A visible category's parent is
           -- always visible too — an inactive parent would have hidden this one — so this is null only
           -- at the root.
           (select jsonb_build_object(
                     'id', p.id,
                     'slug', p.slug,
                     'name', coalesce(pt.name, pd.name, p.slug))
              from public.categories p
              left join public.category_translations pt
                on pt.category_id = p.id and pt.locale_code = v_locale
              left join public.category_translations pd
                on pd.category_id = p.id and pd.locale_code = v_fallback
             where p.id = c.parent_id),
           -- Direct children only, in the catalogue's own order with the slug breaking ties.
           coalesce(
             (select jsonb_agg(jsonb_build_object(
                       'id', ch.id,
                       'slug', ch.slug,
                       'name', coalesce(cht.name, chd.name, ch.slug))
                     order by ch.sort_order, ch.slug)
                from public.categories ch
                left join public.category_translations cht
                  on cht.category_id = ch.id and cht.locale_code = v_locale
                left join public.category_translations chd
                  on chd.category_id = ch.id and chd.locale_code = v_fallback
               where ch.parent_id = c.id and ch.is_active),
             '[]'::jsonb)
      from public.categories c
      left join public.category_translations t on t.category_id = c.id and t.locale_code = v_locale
      left join public.category_translations d on d.category_id = c.id and d.locale_code = v_fallback
     where c.id = v_id;
end;
$$;

comment on function app_private.public_category_by_slug(text, text) is
  'One public category by slug, with its parent, its direct children and its translated SEO metadata. Inactive categories and those under a deactivated ancestor answer not_found, and no private, ordering or type column is returned.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.public_category_visible(uuid) from public;
revoke execute on function app_private.public_category_by_slug(text, text) from public;

grant execute on function app_private.public_category_visible(uuid) to app_system;
grant execute on function app_private.public_category_by_slug(text, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
