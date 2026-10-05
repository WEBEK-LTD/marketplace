-- 0092 — The blog: the named definer functions the API needs to serve it and to author it.
--
-- 0030 built the whole schema and then left it unreachable. `blog_categories`, `blog_tags`, `blog_posts`,
-- `blog_post_slug_history`, `blog_post_translations` and `blog_post_tags` all exist, with their status
-- machine, their slug-history permanence rule (`tg_blog_posts_slug_rule`), the shared lifecycle trigger
-- (`tg_cms_transition`), the revalidation announcement (`tg_cms_announce('blog_post')`), the audit trigger
-- and a generated bilingual `search_vector`. 0032 even registered the cron job that publishes a scheduled
-- post when its moment arrives (`cms.publish_due` → `app_private.publish_due_content()`, which already
-- moves `blog_posts`). What 0030 did not build is a single function the application could call: `app_system`
-- holds no table privileges, so every read and every write goes through a named SECURITY DEFINER function,
-- and there was none for the blog. 0085's own header says so in as many words. This migration adds exactly
-- those functions.
--
-- Nothing about the schema changes here. No column, constraint, index, trigger or policy of 0030 is touched,
-- and no table is created. Every rule stays where it already lives:
--
--   * which lifecycle edges are legal, and which timestamp each state owns → `tg_cms_transition`;
--   * that a retired slug can never be taken over by another post → `tg_blog_posts_slug_rule`;
--   * what the public may see → `public.cms_content_is_public(status, published_at)`, the same predicate
--     pages use, unchanged;
--   * every slug format and every text length → 0030's own CHECK constraints, left to raise their own
--     errors rather than restated here.
--
-- WHAT THIS INCREMENT DELIBERATELY DOES NOT DO (owner decisions, 0092)
--
--   * **The blog does not enter the sitemap.** `app_private.public_sitemap_counts()` declares exactly five
--     kinds — page, listing, service, category, seller — and it is not touched here. Sitemap inclusion for
--     the blog is a separate future increment, so 0086's contract and its closed assertions stand exactly
--     as they are.
--   * **`seo_metadata` does not override a blog post.** `blog_post` remains an allowed entity type in
--     `seo_metadata_entity_type_allowed` with no public reader and no writable path, exactly as 0091 left
--     it. A post's head comes from its own `blog_post_translations.meta_title` and `.meta_description`,
--     which is why those columns exist. 0091 is neither reopened nor widened.
--
-- WHAT THE PUBLIC SIDE ANSWERS
--
-- One slug has three possible answers, and `blog_post_for_public` returns which one it is rather than
-- making the API guess — the same three `cms_page_for_public` returns, for the same reasons:
--
--   * `post`      — a published post whose moment has passed, with the requested locale's text (or the
--                   default locale's, when the requested one is untranslated);
--   * `moved`     — the slug is in `blog_post_slug_history`, so it names a post that has since been
--                   renamed. The current slug comes back and the caller issues a 301. 0030 guarantees a
--                   historical slug can never be taken over by another post, so this is never ambiguous;
--   * `not_found` — anything else: a draft, a scheduled post, an archived post, a post whose moment has not
--                   arrived, a post with no translation at all, and a slug that never existed. They share
--                   one answer deliberately: a distinguishable refusal is a way to ask whether an
--                   unpublished post exists.
--
-- ORDERING IS NEWEST FIRST, AND `is_featured` DOES NOT CHANGE IT
--
-- 0030 gives a post an `is_featured` flag and a constraint tying it to the published state, and says nothing
-- about ordering. Promoting featured posts to the top of the index would be a presentation rule nobody
-- approved, so the feed is strictly newest-published-first — the order 0030's own partial index is built
-- for — and `is_featured` is reported so a surface can mark a post without the order being decided here.
--
-- THE TAXONOMY FILTERS ARE COMPARISONS, NOT SUBSETS
--
-- A category or tag slug that names nothing, or names something deactivated, yields an empty page rather
-- than an error: the same choice 0085 and 0089 make, so a stale link in a bookmark is a quiet empty result.
--
-- AUDIT ATTRIBUTION
--
-- These writers do **not** touch the 8-B attribution channel, and that is deliberate. 8-B's approved scope
-- is the financial subset, and `public.audit_attribution_problems()` fails any function that names the
-- channel without being in the approved contract; extending that contract would reopen a closed increment.
-- The actor is recorded where the schema already puts it — `blog_posts.created_by` and `.updated_by` are
-- columns of the row, so the audit trigger 0030 installed captures the actor inside the audited payload.
--
-- WHAT IS NOT HERE
--
-- Comments, author profiles, reactions, related-post algorithms, an RSS feed, a newsletter, a revalidation
-- consumer and any media-origin work are all out of scope by instruction. FAQs, homepage sections, banners
-- and navigation menus remain as 0030 left them: tables with no functions, each its own cluster with its own
-- seeded permissions, and a half-reader for one of them would be worse than leaving it untouched.

-- ---------------------------------------------------------------------------------------------------
-- 1. The two permission predicates
-- ---------------------------------------------------------------------------------------------------
-- Both keys are seeded in 0033 (`cms.blog.read`, `cms.blog.manage`). Neither is invented, granted or
-- assigned here, and no role name is tested anywhere: 0003's own `requires_mfa` rule is applied to the
-- assurance level as a parameter, exactly as every other console gate does it.
create or replace function app_private.blog_can_read(
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
       and rp.permission_key = 'cms.blog.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.blog_can_read(uuid, boolean) is
  'Whether one account effectively holds cms.blog.read — the key as a literal, with 0003''s own requires_mfa rule applied to the assurance level as a parameter. No role name is tested anywhere.';

create or replace function app_private.blog_can_manage(
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
       and rp.permission_key = 'cms.blog.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.blog_can_manage(uuid, boolean) is
  'Whether one account effectively holds cms.blog.manage — the separate key every write below requires. A reader may hold the first key and not this one, which is why the detail reports the capability.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The public post reader
-- ---------------------------------------------------------------------------------------------------
-- `p_locale` selects a representation, never a subset: the same post comes back in either language, and a
-- locale with no row falls back to the default locale rather than to an empty body (D7 forbids machine
-- translation, so the fallback is real text somebody wrote). `resolved_locale` says which language actually
-- came back so the page can be honest about it in its markup.
--
-- The tags come back as two arrays built in one aggregate pass over the same rows with the same ORDER BY, so
-- `tag_slugs[i]` and `tag_names[i]` always name the same tag. One round trip, and no pairing to get wrong.
create or replace function app_private.blog_post_for_public(
  p_slug text,
  p_locale text
) returns table (
  kind text,
  post_id uuid,
  slug text,
  is_indexable boolean,
  is_featured boolean,
  published_at timestamptz,
  updated_at timestamptz,
  category_slug text,
  category_name text,
  cover_object_path text,
  resolved_locale text,
  title text,
  excerpt text,
  body text,
  meta_title text,
  meta_description text,
  tag_slugs text[],
  tag_names text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  post public.blog_posts;
  wanted text := coalesce(nullif(btrim(p_locale), ''), 'en');
  moved_to text;
begin
  select b.* into post from public.blog_posts b where b.slug = p_slug;

  if post.id is not null and public.cms_content_is_public(post.status, post.published_at) then
    return query
      select
        'post'::text,
        post.id,
        post.slug,
        post.is_indexable,
        post.is_featured,
        post.published_at,
        post.updated_at,
        c.slug,
        -- Arabic is optional throughout the taxonomy (D6/D7), so a missing Arabic name falls back to the
        -- English one rather than to nothing.
        case when c.id is null then null
             when wanted = 'ar' then coalesce(c.name_ar, c.name_en)
             else c.name_en end,
        m.object_path,
        t.locale_code,
        t.title,
        t.excerpt,
        t.body,
        t.meta_title,
        t.meta_description,
        coalesce(tg.slugs, '{}'::text[]),
        coalesce(tg.names, '{}'::text[])
        from public.blog_post_translations t
        left join public.blog_categories c
          on c.id = post.blog_category_id and c.is_active
        left join public.cms_media m on m.id = post.cover_media_id
        left join lateral (
          select array_agg(bt.slug order by bt.slug) as slugs,
                 array_agg(
                   case when wanted = 'ar' then coalesce(bt.name_ar, bt.name_en) else bt.name_en end
                   order by bt.slug
                 ) as names
            from public.blog_post_tags pt
            join public.blog_tags bt on bt.id = pt.blog_tag_id
           where pt.blog_post_id = post.id
             and bt.is_active
        ) tg on true
       where t.blog_post_id = post.id
         -- The requested locale first, then the default. Ordering by a boolean rather than filtering is what
         -- makes the fallback one index scan instead of two statements.
         and t.locale_code in (wanted, 'en')
       order by (t.locale_code = wanted) desc
       limit 1;
    -- A published post nobody has written yet has no row above, so it falls through to absence below.
    if found then
      return;
    end if;
  end if;

  -- Not a post the public may see. It may still be a slug that moved: 0030 keeps every previous slug and
  -- forbids another post from taking it, so at most one post can own this history row.
  select b.slug into moved_to
    from public.blog_post_slug_history h
    join public.blog_posts b on b.id = h.blog_post_id
   where h.slug = p_slug
     and public.cms_content_is_public(b.status, b.published_at);

  if moved_to is not null then
    return query select 'moved'::text, null::uuid, moved_to, null::boolean, null::boolean,
      null::timestamptz, null::timestamptz, null::text, null::text, null::text, null::text, null::text,
      null::text, null::text, null::text, null::text, null::text[], null::text[];
    return;
  end if;

  return query select 'not_found'::text, null::uuid, null::text, null::boolean, null::boolean,
    null::timestamptz, null::timestamptz, null::text, null::text, null::text, null::text, null::text,
    null::text, null::text, null::text, null::text, null::text[], null::text[];
end;
$$;

comment on function app_private.blog_post_for_public(text, text) is
  'One public post by slug, as one of three answers: the post, the slug it moved to, or absence. A draft, a schedule, an archive, a future publication, an unwritten post and a slug that never existed all share the last one.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The public index
-- ---------------------------------------------------------------------------------------------------
-- Keyset pagination on `(published_at desc, id desc)`, which is the order 0030's `blog_posts_public` partial
-- index is built for. A post with no translation in any locale is absent, for the same reason it is absent
-- by slug: there would be nothing to name it with.
create or replace function app_private.blog_posts_for_public(
  p_locale text,
  p_category_slug text default null,
  p_tag_slug text default null,
  p_limit integer default 20,
  p_cursor_published_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  post_id uuid,
  slug text,
  is_featured boolean,
  published_at timestamptz,
  updated_at timestamptz,
  category_slug text,
  category_name text,
  cover_object_path text,
  resolved_locale text,
  title text,
  excerpt text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    b.id,
    b.slug,
    b.is_featured,
    b.published_at,
    b.updated_at,
    c.slug,
    case when c.id is null then null
         when coalesce(nullif(btrim(p_locale), ''), 'en') = 'ar' then coalesce(c.name_ar, c.name_en)
         else c.name_en end,
    m.object_path,
    t.locale_code,
    t.title,
    t.excerpt
    from public.blog_posts b
    join lateral (
      select tr.locale_code, tr.title, tr.excerpt
        from public.blog_post_translations tr
       where tr.blog_post_id = b.id
         and tr.locale_code in (coalesce(nullif(btrim(p_locale), ''), 'en'), 'en')
       order by (tr.locale_code = coalesce(nullif(btrim(p_locale), ''), 'en')) desc
       limit 1
    ) t on true
    left join public.blog_categories c on c.id = b.blog_category_id and c.is_active
    left join public.cms_media m on m.id = b.cover_media_id
   where public.cms_content_is_public(b.status, b.published_at)
     -- Both filters are comparisons against an active row, so a slug that names nothing or names something
     -- deactivated yields an empty page rather than an error.
     and (
       p_category_slug is null
       or exists (
         select 1 from public.blog_categories fc
          where fc.id = b.blog_category_id and fc.is_active and fc.slug = p_category_slug
       )
     )
     and (
       p_tag_slug is null
       or exists (
         select 1
           from public.blog_post_tags pt
           join public.blog_tags ft on ft.id = pt.blog_tag_id
          where pt.blog_post_id = b.id and ft.is_active and ft.slug = p_tag_slug
       )
     )
     and (
       p_cursor_published_at is null
       or p_cursor_id is null
       or (b.published_at, b.id) < (p_cursor_published_at, p_cursor_id)
     )
   order by b.published_at desc, b.id desc
   limit greatest(coalesce(p_limit, 20), 1);
$$;

comment on function app_private.blog_posts_for_public(text, text, text, integer, timestamptz, uuid) is
  'One page of public posts, newest published first — the order 0030''s own partial index is built for. is_featured is reported, never ordered by: promoting featured posts would be a presentation rule nobody approved.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The public taxonomy
-- ---------------------------------------------------------------------------------------------------
-- What the index needs to render its filters: the active categories and tags, each with how many posts the
-- public may actually see under it. A taxonomy entry with nothing public under it still reports zero rather
-- than being absent, so a surface can decide for itself whether to show an empty filter.
create or replace function app_private.blog_taxonomy_for_public(
  p_locale text
) returns table (
  entry_type text,
  entry_id uuid,
  slug text,
  name text,
  sort_order integer,
  post_count bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    'category'::text,
    c.id,
    c.slug,
    case when coalesce(nullif(btrim(p_locale), ''), 'en') = 'ar' then coalesce(c.name_ar, c.name_en)
         else c.name_en end,
    c.sort_order,
    (select count(*)
       from public.blog_posts b
      where b.blog_category_id = c.id
        and public.cms_content_is_public(b.status, b.published_at)
        and exists (select 1 from public.blog_post_translations t where t.blog_post_id = b.id))
    from public.blog_categories c
   where c.is_active
  union all
  select
    'tag'::text,
    g.id,
    g.slug,
    case when coalesce(nullif(btrim(p_locale), ''), 'en') = 'ar' then coalesce(g.name_ar, g.name_en)
         else g.name_en end,
    0,
    (select count(*)
       from public.blog_post_tags pt
       join public.blog_posts b on b.id = pt.blog_post_id
      where pt.blog_tag_id = g.id
        and public.cms_content_is_public(b.status, b.published_at)
        and exists (select 1 from public.blog_post_translations t where t.blog_post_id = b.id))
    from public.blog_tags g
   where g.is_active
   order by 1, 5, 3;
$$;

comment on function app_private.blog_taxonomy_for_public(text) is
  'The active blog categories and tags with how many public posts each holds, for the index filters. Categories carry their own sort_order; tags have none in 0030, so they order by slug.';

-- ---------------------------------------------------------------------------------------------------
-- 5. The staff list
-- ---------------------------------------------------------------------------------------------------
-- Newest edit first, because this is an authoring list rather than a queue: somebody opening it is most
-- often looking for what they touched last. The same order the pages list uses.
--
-- The status filter and the category filter compare parameters, so nothing is hidden and a stale filter in a
-- bookmark shows an empty page rather than an error. The search is a literal substring over the post's
-- title in any locale — `position()` on the text, never a pattern the caller supplies, so no input can be
-- read as a wildcard.
create or replace function app_private.blog_posts_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_status text default null,
  p_search text default null,
  p_category_id uuid default null,
  p_cursor_updated_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  post_id uuid,
  slug text,
  status text,
  blog_category_id uuid,
  category_slug text,
  is_indexable boolean,
  is_featured boolean,
  scheduled_for timestamptz,
  published_at timestamptz,
  archived_at timestamptz,
  updated_at timestamptz,
  translated_locales text[],
  tag_count integer,
  title text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    b.id,
    b.slug,
    b.status,
    b.blog_category_id,
    c.slug,
    b.is_indexable,
    b.is_featured,
    b.scheduled_for,
    b.published_at,
    b.archived_at,
    b.updated_at,
    coalesce(
      (select array_agg(t.locale_code order by t.locale_code)
         from public.blog_post_translations t where t.blog_post_id = b.id),
      '{}'::text[]
    ),
    (select count(*)::integer from public.blog_post_tags pt where pt.blog_post_id = b.id),
    (select t.title from public.blog_post_translations t
      where t.blog_post_id = b.id order by (t.locale_code = 'en') desc, t.locale_code limit 1)
    from public.blog_posts b
    left join public.blog_categories c on c.id = b.blog_category_id
   where app_private.blog_can_read(p_user_id, p_is_aal2)
     and (p_status is null or b.status = p_status)
     and (p_category_id is null or b.blog_category_id = p_category_id)
     and (
       nullif(btrim(coalesce(p_search, '')), '') is null
       or exists (
         select 1 from public.blog_post_translations t
          where t.blog_post_id = b.id
            and position(lower(btrim(p_search)) in lower(t.title)) > 0
       )
       or position(lower(btrim(p_search)) in lower(b.slug)) > 0
     )
     and (
       p_cursor_updated_at is null
       or p_cursor_id is null
       or (b.updated_at, b.id) < (p_cursor_updated_at, p_cursor_id)
     )
   order by b.updated_at desc, b.id desc
   limit greatest(coalesce(p_limit, 25), 1);
$$;

comment on function app_private.blog_posts_for_staff(uuid, boolean, integer, text, text, uuid, timestamptz, uuid) is
  'One page of authored posts, newest edit first, for a holder of cms.blog.read. The permission is tested in the WHERE clause, so an unauthorized caller reads nothing rather than being told so. The search is a literal substring, never a caller-supplied pattern.';

-- ---------------------------------------------------------------------------------------------------
-- 6. The staff detail
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.blog_post_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_post_id uuid
) returns table (
  post_id uuid,
  slug text,
  status text,
  blog_category_id uuid,
  category_slug text,
  is_indexable boolean,
  is_featured boolean,
  cover_media_id uuid,
  cover_object_path text,
  author_user_id uuid,
  scheduled_for timestamptz,
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  created_by uuid,
  updated_by uuid,
  can_manage boolean,
  previous_slugs text[],
  translated_locales text[],
  tag_ids uuid[]
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    b.id,
    b.slug,
    b.status,
    b.blog_category_id,
    c.slug,
    b.is_indexable,
    b.is_featured,
    b.cover_media_id,
    m.object_path,
    b.author_user_id,
    b.scheduled_for,
    b.published_at,
    b.archived_at,
    b.created_at,
    b.updated_at,
    b.created_by,
    b.updated_by,
    app_private.blog_can_manage(p_user_id, p_is_aal2),
    coalesce(
      (select array_agg(h.slug order by h.replaced_at desc)
         from public.blog_post_slug_history h where h.blog_post_id = b.id),
      '{}'::text[]
    ),
    coalesce(
      (select array_agg(t.locale_code order by t.locale_code)
         from public.blog_post_translations t where t.blog_post_id = b.id),
      '{}'::text[]
    ),
    coalesce(
      (select array_agg(pt.blog_tag_id order by pt.blog_tag_id)
         from public.blog_post_tags pt where pt.blog_post_id = b.id),
      '{}'::uuid[]
    )
    from public.blog_posts b
    left join public.blog_categories c on c.id = b.blog_category_id
    left join public.cms_media m on m.id = b.cover_media_id
   where b.id = p_post_id
     and app_private.blog_can_read(p_user_id, p_is_aal2);
$$;

comment on function app_private.blog_post_for_staff(uuid, boolean, uuid) is
  'One authored post with its previous slugs, its locales, its tags and whether this caller may change it. No row for a post that does not exist and no row for a caller without the read key: the console cannot tell the two apart.';

create or replace function app_private.blog_post_translations_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_post_id uuid
) returns table (
  locale_code text,
  title text,
  excerpt text,
  body text,
  meta_title text,
  meta_description text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select t.locale_code, t.title, t.excerpt, t.body, t.meta_title, t.meta_description, t.updated_at
    from public.blog_post_translations t
   where t.blog_post_id = p_post_id
     and app_private.blog_can_read(p_user_id, p_is_aal2)
     and exists (select 1 from public.blog_posts b where b.id = p_post_id)
   order by t.locale_code;
$$;

comment on function app_private.blog_post_translations_for_staff(uuid, boolean, uuid) is
  'Every locale a post has been written in, with the meta fields that are the only source of its public head (0092 decision B). Separate from the detail because a post has zero or more of these and the detail has exactly one row.';

-- ---------------------------------------------------------------------------------------------------
-- 7. The staff taxonomy readers
-- ---------------------------------------------------------------------------------------------------
-- Both include deactivated rows, which is the difference from the public pair: a console has to be able to
-- see and reactivate what it deactivated.
create or replace function app_private.blog_categories_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  category_id uuid,
  slug text,
  name_en text,
  name_ar text,
  description_en text,
  description_ar text,
  sort_order integer,
  is_active boolean,
  post_count bigint,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    c.id,
    c.slug,
    c.name_en,
    c.name_ar,
    c.description_en,
    c.description_ar,
    c.sort_order,
    c.is_active,
    (select count(*) from public.blog_posts b where b.blog_category_id = c.id),
    c.updated_at
    from public.blog_categories c
   where app_private.blog_can_read(p_user_id, p_is_aal2)
   order by c.sort_order, c.slug;
$$;

comment on function app_private.blog_categories_for_staff(uuid, boolean) is
  'Every blog category, active or not, with how many posts sit in it. The count is of all posts, not public ones: it is there to warn before a deactivation, not to describe the public site.';

create or replace function app_private.blog_tags_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  tag_id uuid,
  slug text,
  name_en text,
  name_ar text,
  is_active boolean,
  post_count bigint,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    g.id,
    g.slug,
    g.name_en,
    g.name_ar,
    g.is_active,
    (select count(*) from public.blog_post_tags pt where pt.blog_tag_id = g.id),
    g.updated_at
    from public.blog_tags g
   where app_private.blog_can_read(p_user_id, p_is_aal2)
   order by g.slug;
$$;

comment on function app_private.blog_tags_for_staff(uuid, boolean) is
  'Every blog tag, active or not, with how many posts carry it. 0030 keeps these separate from `tags`, which belongs to the listing catalogue.';

-- ---------------------------------------------------------------------------------------------------
-- 8. The writers
-- ---------------------------------------------------------------------------------------------------
-- Each one re-applies `blog_can_manage` first, raises 42501 when it fails, and records the actor in
-- `updated_by`. None of them decides a rule 0030 already decides: the slug format, the status set, the
-- lifecycle edges, the timestamps each state owns, the permanence of a retired slug and every text length
-- are constraints and triggers, and are left to raise their own errors.
create or replace function app_private.blog_post_create_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_slug text,
  p_blog_category_id uuid default null,
  p_is_indexable boolean default true
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- A post is always born a draft, and never featured: 0030's `blog_posts_featured_is_published` would
  -- refuse a featured draft anyway, and publishing is the separate call below, so a post cannot go live
  -- before anybody has written it.
  --
  -- `author_user_id` is the staff member creating the post — the byline is the person who wrote it. Changing
  -- a byline to somebody else is not part of this increment, so no writer below touches that column.
  insert into public.blog_posts (
    slug, blog_category_id, author_user_id, is_indexable, created_by, updated_by
  )
  values (
    btrim(p_slug),
    p_blog_category_id,
    p_user_id,
    coalesce(p_is_indexable, true),
    p_user_id,
    p_user_id
  )
  returning id into new_id;

  return new_id;
end;
$$;

comment on function app_private.blog_post_create_for_staff(uuid, boolean, text, uuid, boolean) is
  'Creates a draft post, authored by the staff member creating it. Always a draft and never featured: publishing is its own call, so a post cannot go live before it has been written.';

create or replace function app_private.blog_post_update_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_post_id uuid,
  p_slug text,
  p_blog_category_id uuid,
  p_clear_category boolean,
  p_cover_media_id uuid,
  p_clear_cover boolean,
  p_is_indexable boolean,
  p_is_featured boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- The status is deliberately absent from this statement: changing it is the next function, so an edit to a
  -- post's address, category or cover can never publish or archive it by accident.
  --
  -- A null argument leaves a field alone. Clearing a nullable reference needs its own flag, because null
  -- already means "unchanged" — the same shape the category console uses for an optional parent.
  --
  -- Setting `is_featured` on a post that is not published raises 0030's own
  -- `blog_posts_featured_is_published`, which is left to do exactly that rather than being restated here.
  update public.blog_posts b
     set slug = coalesce(nullif(btrim(p_slug), ''), b.slug),
         blog_category_id = case
           when coalesce(p_clear_category, false) then null
           when p_blog_category_id is null then b.blog_category_id
           else p_blog_category_id end,
         cover_media_id = case
           when coalesce(p_clear_cover, false) then null
           when p_cover_media_id is null then b.cover_media_id
           else p_cover_media_id end,
         is_indexable = coalesce(p_is_indexable, b.is_indexable),
         is_featured = coalesce(p_is_featured, b.is_featured),
         updated_by = p_user_id
   where b.id = p_post_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.blog_post_update_for_staff(uuid, boolean, uuid, text, uuid, boolean, uuid, boolean, boolean, boolean) is
  'Changes a post''s address, category, cover, indexability or featured flag. Never its status: a rename cannot publish a post. A null argument leaves that field alone; clearing a nullable reference takes its own flag.';

create or replace function app_private.blog_post_status_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_post_id uuid,
  p_status text,
  p_scheduled_for timestamptz default null
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Publishing a post nobody has written would put an empty page in front of the public, and the public
  -- reader would then report it as absent — a live URL that 404s. Refused here rather than allowed to become
  -- that, exactly as the pages writer refuses it.
  if p_status in ('published', 'scheduled')
     and not exists (select 1 from public.blog_post_translations t where t.blog_post_id = p_post_id) then
    raise exception 'a post cannot be published before it has been written in at least one locale'
      using errcode = 'restrict_violation';
  end if;

  -- Which edges are legal, and which timestamp each state owns, belong to 0030's own trigger. This statement
  -- only proposes the state; an illegal edge raises there.
  --
  -- `is_featured` is cleared when the post leaves the published state, because
  -- `blog_posts_featured_is_published` forbids a featured post in any other state. That is the same
  -- mechanical clearing the pages writer does with `scheduled_for`: a state cannot own the field, so
  -- proposing the state clears it rather than colliding with the constraint.
  update public.blog_posts b
     set status = p_status,
         scheduled_for = case when p_status = 'scheduled' then p_scheduled_for else null end,
         is_featured = case when p_status = 'published' then b.is_featured else false end,
         updated_by = p_user_id
   where b.id = p_post_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.blog_post_status_for_staff(uuid, boolean, uuid, text, timestamptz) is
  'Moves a post through 0030''s lifecycle, refusing to publish or schedule one that has not been written in any locale, and clearing the featured flag a non-published state cannot own. The legal edges and the state timestamps stay in 0030''s trigger.';

create or replace function app_private.blog_post_translation_save_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_post_id uuid,
  p_locale_code text,
  p_title text,
  p_body text,
  p_excerpt text default null,
  p_meta_title text default null,
  p_meta_description text default null
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.blog_posts b where b.id = p_post_id) then
    return false;
  end if;

  -- `meta_title` and `meta_description` are written here and nowhere else. Under 0092's decision B they are
  -- the single source of a post's public head, so an empty one is stored as null and the public reader falls
  -- back to the post's own title rather than serving a blank tag.
  insert into public.blog_post_translations (
    blog_post_id, locale_code, title, excerpt, body, meta_title, meta_description
  )
  values (
    p_post_id,
    p_locale_code,
    btrim(p_title),
    nullif(btrim(coalesce(p_excerpt, '')), ''),
    p_body,
    nullif(btrim(coalesce(p_meta_title, '')), ''),
    nullif(btrim(coalesce(p_meta_description, '')), '')
  )
  on conflict (blog_post_id, locale_code) do update
     set title = excluded.title,
         excerpt = excluded.excerpt,
         body = excluded.body,
         meta_title = excluded.meta_title,
         meta_description = excluded.meta_description;

  -- The post row did not change, but who last touched its content did, and `updated_at` is what the
  -- authoring list orders by. Without this a translation edit would be invisible in that list.
  update public.blog_posts set updated_by = p_user_id, updated_at = now() where id = p_post_id;
  return true;
end;
$$;

comment on function app_private.blog_post_translation_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, text) is
  'Writes one locale of a post, creating or replacing it, and touches the post so the edit is visible in the authoring list. Lengths and emptiness are 0030''s constraints and raise there.';

create or replace function app_private.blog_post_translation_delete_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_post_id uuid,
  p_locale_code text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deleted integer;
  post_status text;
  remaining integer;
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;

  select b.status into post_status from public.blog_posts b where b.id = p_post_id;
  if post_status is null then
    return false;
  end if;

  -- Nothing to remove is not a refusal. The count check below must not fire for a locale that was never
  -- there: removing an absent locale from a live post changes nothing, so it answers false rather than
  -- raising, and only a removal that would really empty the post is refused.
  if not exists (
    select 1 from public.blog_post_translations t
     where t.blog_post_id = p_post_id and t.locale_code = p_locale_code
  ) then
    return false;
  end if;

  select count(*) into remaining from public.blog_post_translations t where t.blog_post_id = p_post_id;
  -- The mirror of the publish rule: a live post must keep at least one locale, or its URL would start
  -- answering 404 while still being published and in the public index.
  if post_status in ('published', 'scheduled') and remaining <= 1 then
    raise exception 'a published post must keep at least one locale'
      using errcode = 'restrict_violation';
  end if;

  delete from public.blog_post_translations t
   where t.blog_post_id = p_post_id and t.locale_code = p_locale_code;
  get diagnostics deleted = row_count;
  if deleted = 1 then
    update public.blog_posts set updated_by = p_user_id, updated_at = now() where id = p_post_id;
  end if;
  return deleted = 1;
end;
$$;

comment on function app_private.blog_post_translation_delete_for_staff(uuid, boolean, uuid, text) is
  'Removes one locale of a post, refusing to leave a published post with none — the mirror of the rule that a post cannot be published before it is written.';

-- One statement for the whole set, because a post's tags are a set rather than a sequence of edits: sending
-- the set that should be there cannot leave a half-applied result the way an add and a remove pair can.
create or replace function app_private.blog_post_tags_set_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_post_id uuid,
  p_tag_ids uuid[]
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  wanted uuid[] := coalesce(p_tag_ids, '{}'::uuid[]);
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.blog_posts b where b.id = p_post_id) then
    return false;
  end if;

  delete from public.blog_post_tags pt
   where pt.blog_post_id = p_post_id
     and not (pt.blog_tag_id = any (wanted));

  -- An unknown tag id raises 0030's own foreign key rather than being silently dropped: a console that sent
  -- a tag that does not exist has a bug, and quietly ignoring it would hide it. Duplicates in the argument
  -- are harmless, which is what the conflict clause is for.
  insert into public.blog_post_tags (blog_post_id, blog_tag_id)
  select p_post_id, t.id from unnest(wanted) as t(id)
  on conflict (blog_post_id, blog_tag_id) do nothing;

  update public.blog_posts set updated_by = p_user_id, updated_at = now() where id = p_post_id;
  return true;
end;
$$;

comment on function app_private.blog_post_tags_set_for_staff(uuid, boolean, uuid, uuid[]) is
  'Replaces a post''s whole tag set in one statement. An unknown tag raises 0030''s foreign key; a duplicate in the argument is harmless.';

create or replace function app_private.blog_category_save_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_category_id uuid,
  p_slug text,
  p_name_en text,
  p_name_ar text default null,
  p_description_en text default null,
  p_description_ar text default null,
  -- Both of these default to null rather than to the schema's own default, and that is load-bearing. These
  -- are create-or-replace writers: a non-null parameter default is substituted before the body runs, so an
  -- omitted argument would be indistinguishable from an explicit one and would silently overwrite the stored
  -- value — renaming a category would reset its order and reactivate it. Null means "leave it alone", and
  -- the insert branch below supplies the schema's default instead.
  p_sort_order integer default null,
  p_is_active boolean default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  saved_id uuid;
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Create or replace, branching on whether an id was named. English is required and Arabic optional
  -- throughout (D7), which is 0030's own constraint and is left to raise there.
  if p_category_id is null then
    insert into public.blog_categories (
      slug, name_en, name_ar, description_en, description_ar, sort_order, is_active
    )
    values (
      btrim(p_slug),
      btrim(p_name_en),
      nullif(btrim(coalesce(p_name_ar, '')), ''),
      nullif(btrim(coalesce(p_description_en, '')), ''),
      nullif(btrim(coalesce(p_description_ar, '')), ''),
      coalesce(p_sort_order, 0),
      coalesce(p_is_active, true)
    )
    returning id into saved_id;
    return saved_id;
  end if;

  update public.blog_categories c
     set slug = coalesce(nullif(btrim(p_slug), ''), c.slug),
         name_en = coalesce(nullif(btrim(coalesce(p_name_en, '')), ''), c.name_en),
         name_ar = case when p_name_ar is null then c.name_ar
                        else nullif(btrim(p_name_ar), '') end,
         description_en = case when p_description_en is null then c.description_en
                              else nullif(btrim(p_description_en), '') end,
         description_ar = case when p_description_ar is null then c.description_ar
                              else nullif(btrim(p_description_ar), '') end,
         sort_order = coalesce(p_sort_order, c.sort_order),
         is_active = coalesce(p_is_active, c.is_active)
   where c.id = p_category_id
  returning c.id into saved_id;

  return saved_id;
end;
$$;

comment on function app_private.blog_category_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, integer, boolean) is
  'Creates or replaces one blog category, returning its id — or null when the named id does not exist. A null text argument leaves that field alone; an empty one clears an optional field.';

create or replace function app_private.blog_tag_save_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_tag_id uuid,
  p_slug text,
  p_name_en text,
  p_name_ar text default null,
  -- Null rather than true, for the reason the category writer above spells out.
  p_is_active boolean default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  saved_id uuid;
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;

  if p_tag_id is null then
    insert into public.blog_tags (slug, name_en, name_ar, is_active)
    values (
      btrim(p_slug),
      btrim(p_name_en),
      nullif(btrim(coalesce(p_name_ar, '')), ''),
      coalesce(p_is_active, true)
    )
    returning id into saved_id;
    return saved_id;
  end if;

  update public.blog_tags g
     set slug = coalesce(nullif(btrim(p_slug), ''), g.slug),
         name_en = coalesce(nullif(btrim(coalesce(p_name_en, '')), ''), g.name_en),
         name_ar = case when p_name_ar is null then g.name_ar else nullif(btrim(p_name_ar), '') end,
         is_active = coalesce(p_is_active, g.is_active)
   where g.id = p_tag_id
  returning g.id into saved_id;

  return saved_id;
end;
$$;

comment on function app_private.blog_tag_save_for_staff(uuid, boolean, uuid, text, text, text, boolean) is
  'Creates or replaces one blog tag, returning its id — or null when the named id does not exist.';

-- ---------------------------------------------------------------------------------------------------
-- 9. Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.blog_can_read(uuid, boolean) from public, app_worker;
revoke execute on function app_private.blog_can_manage(uuid, boolean) from public, app_worker;
revoke execute on function app_private.blog_post_for_public(text, text) from public, app_worker;
revoke execute on function app_private.blog_posts_for_public(text, text, text, integer, timestamptz, uuid) from public, app_worker;
revoke execute on function app_private.blog_taxonomy_for_public(text) from public, app_worker;
revoke execute on function app_private.blog_posts_for_staff(uuid, boolean, integer, text, text, uuid, timestamptz, uuid) from public, app_worker;
revoke execute on function app_private.blog_post_for_staff(uuid, boolean, uuid) from public, app_worker;
revoke execute on function app_private.blog_post_translations_for_staff(uuid, boolean, uuid) from public, app_worker;
revoke execute on function app_private.blog_categories_for_staff(uuid, boolean) from public, app_worker;
revoke execute on function app_private.blog_tags_for_staff(uuid, boolean) from public, app_worker;
revoke execute on function app_private.blog_post_create_for_staff(uuid, boolean, text, uuid, boolean) from public, app_worker;
revoke execute on function app_private.blog_post_update_for_staff(uuid, boolean, uuid, text, uuid, boolean, uuid, boolean, boolean, boolean) from public, app_worker;
revoke execute on function app_private.blog_post_status_for_staff(uuid, boolean, uuid, text, timestamptz) from public, app_worker;
revoke execute on function app_private.blog_post_translation_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, text) from public, app_worker;
revoke execute on function app_private.blog_post_translation_delete_for_staff(uuid, boolean, uuid, text) from public, app_worker;
revoke execute on function app_private.blog_post_tags_set_for_staff(uuid, boolean, uuid, uuid[]) from public, app_worker;
revoke execute on function app_private.blog_category_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, integer, boolean) from public, app_worker;
revoke execute on function app_private.blog_tag_save_for_staff(uuid, boolean, uuid, text, text, text, boolean) from public, app_worker;

-- `app_system` only. The worker has no business with authored posts: it reacts to the revalidation event
-- 0030's announce trigger already publishes, and that needs no reader here. The scheduled publisher the
-- worker's cron runs is `app_private.publish_due_content()`, which 0030 and 0032 already own.
grant execute on function app_private.blog_can_read(uuid, boolean) to app_system;
grant execute on function app_private.blog_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.blog_post_for_public(text, text) to app_system;
grant execute on function app_private.blog_posts_for_public(text, text, text, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.blog_taxonomy_for_public(text) to app_system;
grant execute on function app_private.blog_posts_for_staff(uuid, boolean, integer, text, text, uuid, timestamptz, uuid) to app_system;
grant execute on function app_private.blog_post_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.blog_post_translations_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.blog_categories_for_staff(uuid, boolean) to app_system;
grant execute on function app_private.blog_tags_for_staff(uuid, boolean) to app_system;
grant execute on function app_private.blog_post_create_for_staff(uuid, boolean, text, uuid, boolean) to app_system;
grant execute on function app_private.blog_post_update_for_staff(uuid, boolean, uuid, text, uuid, boolean, uuid, boolean, boolean, boolean) to app_system;
grant execute on function app_private.blog_post_status_for_staff(uuid, boolean, uuid, text, timestamptz) to app_system;
grant execute on function app_private.blog_post_translation_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, text) to app_system;
grant execute on function app_private.blog_post_translation_delete_for_staff(uuid, boolean, uuid, text) to app_system;
grant execute on function app_private.blog_post_tags_set_for_staff(uuid, boolean, uuid, uuid[]) to app_system;
grant execute on function app_private.blog_category_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, integer, boolean) to app_system;
grant execute on function app_private.blog_tag_save_for_staff(uuid, boolean, uuid, text, text, text, boolean) to app_system;

select app_private.assert_security_contract();
