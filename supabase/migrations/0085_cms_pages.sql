-- 0085 — CMS static pages: the named definer functions the API needs to serve and author them.
--
-- 0030 built the schema: `pages`, `page_translations`, `page_slug_history`, the shared publication rule
-- `public.cms_content_is_public()`, the lifecycle trigger `tg_cms_transition()`, the slug rule
-- `tg_pages_slug_rule()` and the revalidation announcement `tg_cms_announce('page')`. What it did not build
-- is any way for the application to reach them: `app_system` holds no table privileges, so every read and
-- every write goes through a named SECURITY DEFINER function, and 0030 defined none for pages. This
-- migration adds exactly those functions and nothing else.
--
-- Nothing about the pages schema changes here. No column, constraint, index, trigger or policy of 0030 is
-- touched, and no new table is created.
--
-- WHAT THE PUBLIC SIDE ANSWERS
--
-- One slug has three possible answers, and `cms_page_for_public` returns which one it is rather than making
-- the API guess:
--
--   * `page`      — a published page whose publication moment has passed, with the requested locale's text
--                   (or the default locale's, when the requested one is untranslated);
--   * `moved`     — the slug is in `page_slug_history`, so it names a page that has since been renamed. The
--                   current slug comes back and the caller issues a 301. 0030 guarantees a historical slug
--                   can never be taken over by another page, so this answer is never ambiguous;
--   * `not_found` — anything else: a draft, a scheduled page, an archived page, a page whose publication
--                   moment has not arrived, a page with no translation at all, and a slug that never
--                   existed. They share one answer deliberately, exactly as the category reader does: a
--                   distinguishable refusal is a way to ask whether an unpublished page exists.
--
-- A page that is published but carries no translation in any locale is `not_found`, because there would be
-- nothing to render. That is a real state — 0030 lets a page be published before it is written — and the
-- reader treats it as absence rather than as an empty page.
--
-- WHAT THE STAFF SIDE ANSWERS
--
-- Two seeded keys, both from 0033, pinned here as literals and tested with 0003's own `requires_mfa` rule
-- applied to the assurance level as a parameter: `cms.page.read` to see the section, `cms.page.manage` to
-- change anything. Neither is invented, granted or assigned here.
--
-- Every staff function re-applies its own test before it reaches a row, and an unauthorized caller gets the
-- same answer as a caller asking about a page that does not exist. The detail reports the manage capability
-- so a console does not have to guess whether to render a control.
--
-- AUDIT ATTRIBUTION
--
-- These writers do **not** touch the 8-B attribution channel, and that is deliberate rather than an
-- oversight. 8-B's approved scope is the financial subset, its Q4 preserved the existing actor parameters,
-- and `public.audit_attribution_problems()` fails any function that names the channel without being in the
-- approved contract. Extending that contract would reopen a closed increment.
--
-- The authoring actor is recorded instead where the schema already puts it: `pages.created_by` and
-- `pages.updated_by` are columns of the row, so the audit trigger 0030 installed captures the actor inside
-- the audited payload. Every writer below takes `p_user_id` and writes it to `updated_by`, so who changed a
-- page is recorded on the page and in its audit history without a GUC.
--
-- WHAT IS NOT HERE
--
-- Blog posts, FAQs, homepage sections, banners, navigation menus, SEO settings, SEO metadata and redirects
-- all have tables in 0030 and no functions here. Each is its own cluster with its own seeded permissions,
-- and giving one of them a half-reader would be worse than leaving it untouched.

-- ---------------------------------------------------------------------------------------------------
-- 1. The two permission predicates
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.cms_page_can_read(
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
       and rp.permission_key = 'cms.page.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.cms_page_can_read(uuid, boolean) is
  'Whether one account effectively holds cms.page.read — the key as a literal, with 0003''s own requires_mfa rule applied to the assurance level as a parameter. No role name is tested anywhere.';

create or replace function app_private.cms_page_can_manage(
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
       and rp.permission_key = 'cms.page.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.cms_page_can_manage(uuid, boolean) is
  'Whether one account effectively holds cms.page.manage — the separate key 0030''s own write policy requires. A reader may hold the first key and not this one, which is why the detail reports the capability.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The public reader
-- ---------------------------------------------------------------------------------------------------
-- `p_locale` selects a representation, never a subset: the same page is returned in either language, and a
-- locale with no row falls back to the default locale rather than to an empty body (D7 forbids machine
-- translation, so the fallback is real text somebody wrote, not a generated one). `resolved_locale` says
-- which language actually came back so a page can be honest about it in its markup.
create or replace function app_private.cms_page_for_public(
  p_slug text,
  p_locale text
) returns table (
  kind text,
  page_id uuid,
  slug text,
  page_key text,
  template text,
  is_indexable boolean,
  published_at timestamptz,
  updated_at timestamptz,
  resolved_locale text,
  title text,
  excerpt text,
  body text,
  meta_title text,
  meta_description text,
  cover_object_path text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  page public.pages;
  wanted text := coalesce(nullif(btrim(p_locale), ''), 'en');
  moved_to text;
begin
  select p.* into page from public.pages p where p.slug = p_slug;

  if page.id is not null and public.cms_content_is_public(page.status, page.published_at) then
    return query
      select
        'page'::text,
        page.id,
        page.slug,
        page.page_key,
        page.template,
        page.is_indexable,
        page.published_at,
        page.updated_at,
        t.locale_code,
        t.title,
        t.excerpt,
        t.body,
        t.meta_title,
        t.meta_description,
        m.object_path
        from public.page_translations t
        left join public.cms_media m on m.id = page.cover_media_id
       where t.page_id = page.id
         -- The requested locale first, then the default. Ordering by a boolean rather than filtering is
         -- what makes the fallback one index scan instead of two statements.
         and t.locale_code in (wanted, 'en')
       order by (t.locale_code = wanted) desc
       limit 1;
    -- A published page nobody has written yet has no row above, so the loop below reports absence.
    if found then
      return;
    end if;
  end if;

  -- Not a page the public may see. It may still be a slug that moved: 0030 keeps every previous slug and
  -- forbids another page from taking it, so at most one page can own this history row.
  select p.slug into moved_to
    from public.page_slug_history h
    join public.pages p on p.id = h.page_id
   where h.slug = p_slug
     and public.cms_content_is_public(p.status, p.published_at);

  if moved_to is not null then
    return query select 'moved'::text, null::uuid, moved_to, null::text, null::text, null::boolean,
      null::timestamptz, null::timestamptz, null::text, null::text, null::text, null::text, null::text,
      null::text, null::text;
    return;
  end if;

  return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::boolean,
    null::timestamptz, null::timestamptz, null::text, null::text, null::text, null::text, null::text,
    null::text, null::text;
end;
$$;

comment on function app_private.cms_page_for_public(text, text) is
  'One public page by slug, as one of three answers: the page, the slug it moved to, or absence. A draft, a schedule, an archive, a future publication, an unwritten page and a slug that never existed all share the last one.';

-- The published index, for a footer or a sitemap. Ordered the way 0030's partial index is, so the order is
-- the admin's `sort_order` and the slug only breaks ties.
create or replace function app_private.cms_pages_for_public(
  p_locale text
) returns table (
  page_id uuid,
  slug text,
  page_key text,
  template text,
  is_indexable boolean,
  sort_order integer,
  published_at timestamptz,
  updated_at timestamptz,
  resolved_locale text,
  title text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    p.id,
    p.slug,
    p.page_key,
    p.template,
    p.is_indexable,
    p.sort_order,
    p.published_at,
    p.updated_at,
    t.locale_code,
    t.title
    from public.pages p
    join lateral (
      select tr.locale_code, tr.title
        from public.page_translations tr
       where tr.page_id = p.id
         and tr.locale_code in (coalesce(nullif(btrim(p_locale), ''), 'en'), 'en')
       order by (tr.locale_code = coalesce(nullif(btrim(p_locale), ''), 'en')) desc
       limit 1
    ) t on true
   where public.cms_content_is_public(p.status, p.published_at)
   order by p.sort_order, p.slug;
$$;

comment on function app_private.cms_pages_for_public(text) is
  'Every page the public may see, titled in the requested locale with the default as fallback. A published page with no translation at all is absent, for the same reason it is absent by slug: there is nothing to name it with.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The staff list
-- ---------------------------------------------------------------------------------------------------
-- Newest first, because this is an authoring list rather than a queue: somebody opening it is most often
-- looking for what they touched last. That is the same order the audit trail and the job runs use, and the
-- opposite of the support, recovery and dispute queues, which are things waiting to be worked.
--
-- The status filter compares a parameter, so nothing is hidden and a stale filter in a bookmark shows an
-- empty page rather than an error.
create or replace function app_private.cms_pages_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_status text default null,
  p_cursor_updated_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  page_id uuid,
  slug text,
  page_key text,
  status text,
  template text,
  is_indexable boolean,
  sort_order integer,
  scheduled_for timestamptz,
  published_at timestamptz,
  archived_at timestamptz,
  updated_at timestamptz,
  translated_locales text[],
  title text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    p.id,
    p.slug,
    p.page_key,
    p.status,
    p.template,
    p.is_indexable,
    p.sort_order,
    p.scheduled_for,
    p.published_at,
    p.archived_at,
    p.updated_at,
    coalesce(
      (select array_agg(t.locale_code order by t.locale_code) from public.page_translations t where t.page_id = p.id),
      '{}'::text[]
    ),
    (select t.title from public.page_translations t
      where t.page_id = p.id order by (t.locale_code = 'en') desc, t.locale_code limit 1)
    from public.pages p
   where app_private.cms_page_can_read(p_user_id, p_is_aal2)
     and (p_status is null or p.status = p_status)
     and (
       p_cursor_updated_at is null
       or p_cursor_id is null
       or (p.updated_at, p.id) < (p_cursor_updated_at, p_cursor_id)
     )
   order by p.updated_at desc, p.id desc
   limit greatest(coalesce(p_limit, 25), 1);
$$;

comment on function app_private.cms_pages_for_staff(uuid, boolean, integer, text, timestamptz, uuid) is
  'One page of authored pages, newest edit first, for a holder of cms.page.read. The permission is tested in the WHERE clause, so an unauthorized caller reads nothing rather than being told so.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The staff detail
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.cms_page_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_page_id uuid
) returns table (
  page_id uuid,
  slug text,
  page_key text,
  status text,
  template text,
  is_indexable boolean,
  sort_order integer,
  scheduled_for timestamptz,
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  created_by uuid,
  updated_by uuid,
  can_manage boolean,
  previous_slugs text[]
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    p.id,
    p.slug,
    p.page_key,
    p.status,
    p.template,
    p.is_indexable,
    p.sort_order,
    p.scheduled_for,
    p.published_at,
    p.archived_at,
    p.created_at,
    p.updated_at,
    p.created_by,
    p.updated_by,
    app_private.cms_page_can_manage(p_user_id, p_is_aal2),
    coalesce(
      (select array_agg(h.slug order by h.replaced_at desc) from public.page_slug_history h where h.page_id = p.id),
      '{}'::text[]
    )
    from public.pages p
   where p.id = p_page_id
     and app_private.cms_page_can_read(p_user_id, p_is_aal2);
$$;

comment on function app_private.cms_page_for_staff(uuid, boolean, uuid) is
  'One authored page with its previous slugs and whether this caller may change it. No row for a page that does not exist and no row for a caller without the read key: the console cannot tell the two apart.';

create or replace function app_private.cms_page_translations_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_page_id uuid
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
    from public.page_translations t
   where t.page_id = p_page_id
     and app_private.cms_page_can_read(p_user_id, p_is_aal2)
     and exists (select 1 from public.pages p where p.id = p_page_id)
   order by t.locale_code;
$$;

comment on function app_private.cms_page_translations_for_staff(uuid, boolean, uuid) is
  'Every locale a page has been written in. Separate from the detail because a page has zero or more of these and the detail has exactly one row.';

-- ---------------------------------------------------------------------------------------------------
-- 5. The writers
-- ---------------------------------------------------------------------------------------------------
-- Each one re-applies `cms_page_can_manage` first, raises 42501 when it fails, and records the actor in
-- `updated_by`. None of them decides a rule 0030 already decides: the slug format, the page key format, the
-- template set, the status set, the lifecycle edges, the timestamps each state owns and the permanence of a
-- previous slug are all constraints and triggers, and are left to raise their own errors.
create or replace function app_private.cms_page_create_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_slug text,
  p_page_key text default null,
  p_template text default 'standard',
  p_sort_order integer default 0,
  p_is_indexable boolean default true
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  if not app_private.cms_page_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.page.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- A page is always born a draft. 0030's lifecycle allows draft->published, so publishing is the separate
  -- call below and never a side effect of creation: a page cannot go live before anybody has written it.
  insert into public.pages (slug, page_key, template, sort_order, is_indexable, created_by, updated_by)
  values (
    btrim(p_slug),
    nullif(btrim(coalesce(p_page_key, '')), ''),
    coalesce(p_template, 'standard'),
    coalesce(p_sort_order, 0),
    coalesce(p_is_indexable, true),
    p_user_id,
    p_user_id
  )
  returning id into new_id;

  return new_id;
end;
$$;

comment on function app_private.cms_page_create_for_staff(uuid, boolean, text, text, text, integer, boolean) is
  'Creates a draft page. Always a draft: publishing is its own call, so a page cannot go live before it has been written.';

create or replace function app_private.cms_page_update_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_page_id uuid,
  p_slug text,
  p_page_key text,
  p_template text,
  p_sort_order integer,
  p_is_indexable boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if not app_private.cms_page_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.page.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- The status is deliberately absent from this statement: changing it is the next function, so an edit to
  -- a page's address or template can never publish or archive it by accident.
  update public.pages p
     set slug = coalesce(nullif(btrim(p_slug), ''), p.slug),
         page_key = case when p_page_key is null then p.page_key else nullif(btrim(p_page_key), '') end,
         template = coalesce(p_template, p.template),
         sort_order = coalesce(p_sort_order, p.sort_order),
         is_indexable = coalesce(p_is_indexable, p.is_indexable),
         updated_by = p_user_id
   where p.id = p_page_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.cms_page_update_for_staff(uuid, boolean, uuid, text, text, text, integer, boolean) is
  'Changes a page''s address, key, template, order or indexability. Never its status: a rename cannot publish a page. A null argument leaves that field alone; an empty page key clears it.';

create or replace function app_private.cms_page_status_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_page_id uuid,
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
  if not app_private.cms_page_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.page.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Publishing a page nobody has written would put an empty page in front of the public, and the public
  -- reader would then report it as absent — a live URL that 404s. Refused here rather than allowed to
  -- become that.
  if p_status in ('published', 'scheduled')
     and not exists (select 1 from public.page_translations t where t.page_id = p_page_id) then
    raise exception 'a page cannot be published before it has been written in at least one locale'
      using errcode = 'restrict_violation';
  end if;

  -- Which edges are legal, and which timestamp each state owns, belong to 0030's own trigger. This
  -- statement only proposes the state; an illegal edge raises there.
  update public.pages p
     set status = p_status,
         scheduled_for = case when p_status = 'scheduled' then p_scheduled_for else null end,
         updated_by = p_user_id
   where p.id = p_page_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.cms_page_status_for_staff(uuid, boolean, uuid, text, timestamptz) is
  'Moves a page through 0030''s lifecycle, refusing to publish or schedule one that has not been written in any locale. The legal edges and the state timestamps stay in 0030''s trigger.';

create or replace function app_private.cms_page_translation_save_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_page_id uuid,
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
  if not app_private.cms_page_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.page.manage is required' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.pages p where p.id = p_page_id) then
    return false;
  end if;

  insert into public.page_translations (
    page_id, locale_code, title, excerpt, body, meta_title, meta_description
  )
  values (
    p_page_id,
    p_locale_code,
    btrim(p_title),
    nullif(btrim(coalesce(p_excerpt, '')), ''),
    p_body,
    nullif(btrim(coalesce(p_meta_title, '')), ''),
    nullif(btrim(coalesce(p_meta_description, '')), '')
  )
  on conflict (page_id, locale_code) do update
     set title = excluded.title,
         excerpt = excluded.excerpt,
         body = excluded.body,
         meta_title = excluded.meta_title,
         meta_description = excluded.meta_description;

  -- The page itself did not change, but who last touched its content did, and `updated_at` is what the
  -- authoring list orders by. Without this a translation edit would be invisible in that list.
  update public.pages set updated_by = p_user_id, updated_at = now() where id = p_page_id;
  return true;
end;
$$;

comment on function app_private.cms_page_translation_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, text) is
  'Writes one locale of a page, creating or replacing it, and touches the page so the edit is visible in the authoring list. Lengths and emptiness are 0030''s constraints and raise there.';

create or replace function app_private.cms_page_translation_delete_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_page_id uuid,
  p_locale_code text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deleted integer;
  page_status text;
  remaining integer;
begin
  if not app_private.cms_page_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.page.manage is required' using errcode = 'insufficient_privilege';
  end if;

  select p.status into page_status from public.pages p where p.id = p_page_id;
  if page_status is null then
    return false;
  end if;

  -- Nothing to remove is not a refusal. The count check below must not fire for a locale that was never
  -- there: removing an absent locale from a live page changes nothing, so it answers false rather than
  -- raising, and only a removal that would really empty the page is refused.
  if not exists (
    select 1 from public.page_translations t where t.page_id = p_page_id and t.locale_code = p_locale_code
  ) then
    return false;
  end if;

  select count(*) into remaining from public.page_translations t where t.page_id = p_page_id;
  -- The mirror of the publish rule: a live page must keep at least one locale, or its URL would start
  -- answering 404 while still being published and in the public index.
  if page_status in ('published', 'scheduled') and remaining <= 1 then
    raise exception 'a published page must keep at least one locale'
      using errcode = 'restrict_violation';
  end if;

  delete from public.page_translations t where t.page_id = p_page_id and t.locale_code = p_locale_code;
  get diagnostics deleted = row_count;
  if deleted = 1 then
    update public.pages set updated_by = p_user_id, updated_at = now() where id = p_page_id;
  end if;
  return deleted = 1;
end;
$$;

comment on function app_private.cms_page_translation_delete_for_staff(uuid, boolean, uuid, text) is
  'Removes one locale of a page, refusing to leave a published page with none — the mirror of the rule that a page cannot be published before it is written.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.cms_page_can_read(uuid, boolean) from public;
revoke execute on function app_private.cms_page_can_manage(uuid, boolean) from public;
revoke execute on function app_private.cms_page_for_public(text, text) from public;
revoke execute on function app_private.cms_pages_for_public(text) from public;
revoke execute on function app_private.cms_pages_for_staff(uuid, boolean, integer, text, timestamptz, uuid) from public;
revoke execute on function app_private.cms_page_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.cms_page_translations_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.cms_page_create_for_staff(uuid, boolean, text, text, text, integer, boolean) from public;
revoke execute on function app_private.cms_page_update_for_staff(uuid, boolean, uuid, text, text, text, integer, boolean) from public;
revoke execute on function app_private.cms_page_status_for_staff(uuid, boolean, uuid, text, timestamptz) from public;
revoke execute on function app_private.cms_page_translation_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, text) from public;
revoke execute on function app_private.cms_page_translation_delete_for_staff(uuid, boolean, uuid, text) from public;

-- `app_system` only. The worker has no business with authored pages: it reacts to the revalidation event
-- 0030's announce trigger already publishes, and that needs no reader here.
grant execute on function app_private.cms_page_can_read(uuid, boolean) to app_system;
grant execute on function app_private.cms_page_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.cms_page_for_public(text, text) to app_system;
grant execute on function app_private.cms_pages_for_public(text) to app_system;
grant execute on function app_private.cms_pages_for_staff(uuid, boolean, integer, text, timestamptz, uuid) to app_system;
grant execute on function app_private.cms_page_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.cms_page_translations_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.cms_page_create_for_staff(uuid, boolean, text, text, text, integer, boolean) to app_system;
grant execute on function app_private.cms_page_update_for_staff(uuid, boolean, uuid, text, text, text, integer, boolean) to app_system;
grant execute on function app_private.cms_page_status_for_staff(uuid, boolean, uuid, text, timestamptz) to app_system;
grant execute on function app_private.cms_page_translation_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, text) to app_system;
grant execute on function app_private.cms_page_translation_delete_for_staff(uuid, boolean, uuid, text) to app_system;

select app_private.assert_security_contract();
