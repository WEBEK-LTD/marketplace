-- 0099 — Attaching a library entry to CMS content: the page cover writer nothing ever had, and one reader for both.
--
-- 0098 made a library entry exist. This migration makes one *attachable to the content that references
-- it*, which is the single gap 0098 opened and the only thing it opened.
--
-- **What was wrong.** `public.pages.cover_media_id` has existed since 0030 and no function in this
-- repository could write it: neither `cms_page_create_for_staff` nor `cms_page_update_for_staff` takes
-- it. 0085 only *reads* it, and publishes the resulting `cover_object_path` on its public reader. The
-- column was therefore permanently null. `public.blog_posts.cover_media_id` was never in that position
-- — 0092's writer takes `p_cover_media_id` and `p_clear_cover` and the whole stack above it carries
-- both — so **nothing in the blog cluster is changed here**; only the console learns to send what the
-- API has always accepted.
--
-- **Two functions, and the split between them is deliberate.**
--
--   1. A *writer* for the page cover alone. It is a function of its own rather than five more arguments
--      on `cms_page_update_for_staff`, because 0085 already separates content editing from the
--      lifecycle for exactly this reason — a rename must not be able to publish a page — and the same
--      reasoning says an edit to a page's address must not be able to change its cover. No signature
--      that 0085 shipped is altered, dropped or overloaded by this migration.
--   2. A *reader* that reports the attached entry, for both sections. 0085's `cms_page_for_staff` does
--      not mention the cover at all and 0092's `blog_post_for_staff` reports its id and path but not
--      its alt text, and neither return shape is changed here: a `returns table` cannot grow a column
--      under `create or replace`, and reshaping a closed increment's reader to add a label is not worth
--      doing. One new reader serves both consoles instead, which also means the page editor and the
--      post editor describe an attachment in precisely the same words.
--
-- **Three behaviours, which is what a nullable reference needs.** `p_cover_media_id` null with
-- `p_clear_cover` false leaves the cover alone, because null already means "unchanged"; `p_clear_cover`
-- true removes it. This is 0092's own shape for the same problem, reused rather than reinvented, and
-- the HTTP layer above maps an explicit null in the request to the clear flag.
--
-- **What validates a supplied id.** 0030's own foreign key, and nothing else. A media id that names no
-- row raises `23503` and the write fails; there is no second existence check here to drift from it, no
-- new permission key, and a page or post editor is not required to hold `cms.media.manage` to attach
-- something they can already name. The attachment is gated on the section's own manage key, which is
-- the key that governs the row being changed.
--
-- **What this migration does not do.** No public surface changes. Both public readers already return
-- `cover_object_path` and `apps/web` consumes no cover anywhere; after this migration a page's cover
-- path will be non-null for the first time and still nothing renders it, which is pinned by test rather
-- than left to be noticed. No bucket, no `storage.objects` policy, no signed URL, no provider call, no
-- media origin, no `og:image`, no banner, no listing media, no new permission key, and nothing on any
-- financial path.
-- ===================================================================================================

-- ---------------------------------------------------------------------------------------------------
-- 1. The attachment reader
-- ---------------------------------------------------------------------------------------------------
-- One row for the entry a page or a post currently points at, and no row in every other case: no row
-- when nothing is attached, no row when the entity does not exist, and no row for a caller without that
-- section's read key. The three absences are deliberately identical, which is the same answer 0085 and
-- 0092 already give for a page or post the caller may not see.
--
-- `p_entity_type` is matched against a literal in each arm rather than validated and dispatched, so an
-- unrecognised type simply returns nothing. The entity type naming follows 0091's own vocabulary for
-- the same two kinds of content.
--
-- **The read key, not `cms.media.manage`.** Whoever may open a page in the console may see which image
-- is on it. The library itself remains gated on `cms.media.manage` by 0098 and this function grants no
-- access to it: it answers for one entity's current cover and cannot enumerate, search or page the
-- library, and it reports what the attachment *is* — the stored path and the alt text somebody wrote —
-- and never a URL, because the bucket is private and this migration mints no credential.
create or replace function app_private.cms_cover_media_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_entity_type text,
  p_entity_id uuid
) returns table (
  media_id uuid,
  object_path text,
  alt_text_en text,
  alt_text_ar text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select m.id, m.object_path, m.alt_text_en, m.alt_text_ar
    from public.pages p
    join public.cms_media m on m.id = p.cover_media_id
   where p_entity_type = 'page'
     and p.id = p_entity_id
     and app_private.cms_page_can_read(p_user_id, p_is_aal2)
  union all
  select m.id, m.object_path, m.alt_text_en, m.alt_text_ar
    from public.blog_posts b
    join public.cms_media m on m.id = b.cover_media_id
   where p_entity_type = 'blog_post'
     and b.id = p_entity_id
     and app_private.blog_can_read(p_user_id, p_is_aal2);
$$;

comment on function app_private.cms_cover_media_for_staff(uuid, boolean, text, uuid) is
  'The media entry one page or one blog post currently has as its cover, as the stored object path and the bilingual alt text. No row when nothing is attached, when the entity does not exist, when the entity type is not recognised, or for a caller without that section''s read key: the console cannot tell those apart. Reports no URL and issues no credential, because the cms-media bucket is private. Needs no cms.media.manage: it answers for one entity and cannot reach the library.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The page cover writer
-- ---------------------------------------------------------------------------------------------------
-- Gated on `cms.page.manage`, the key 0030's own write policy requires for this table, through 0085's
-- own helper rather than a second copy of the rule. The status is not reachable from here and neither
-- is the slug: this function changes one column.
--
-- A media id that names no row raises 0030's `pages_cover_media_id_fkey` (`23503`) and nothing is
-- written. That foreign key is the only existence check, so there is no second rule to drift from it.
--
-- `updated_by` is set the way every other staff writer in this repository sets it. 8-B's audit channel
-- is deliberately not named here: `public.audit_attribution_problems()` fails any function that names
-- it, and `public.pages` already carries an audit trigger from 0030 that attributes the row change.
create or replace function app_private.cms_page_cover_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_page_id uuid,
  p_cover_media_id uuid default null,
  p_clear_cover boolean default false
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

  -- Three behaviours, because a nullable reference needs three: null already means "leave it alone", so
  -- removing a cover takes its own flag. 0092 settled this shape for the same column on the other table
  -- and it is reused here rather than restated differently.
  update public.pages p
     set cover_media_id = case
           when coalesce(p_clear_cover, false) then null
           when p_cover_media_id is null then p.cover_media_id
           else p_cover_media_id end,
         updated_by = p_user_id
   where p.id = p_page_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.cms_page_cover_for_staff(uuid, boolean, uuid, uuid, boolean) is
  'Attaches, leaves or removes one page''s cover image, returning false when the id named no page. Requires cms.page.manage and nothing else: a page editor does not need cms.media.manage to name an entry. A null media id leaves the cover alone and p_clear_cover removes it, which is 0092''s own shape for a nullable reference. A media id that names no row raises 0030''s foreign key, the only existence check there is. Changes no other column, so attaching a cover can never publish, rename or reindex a page.';

-- ---------------------------------------------------------------------------------------------------
-- 3. Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.cms_cover_media_for_staff(uuid, boolean, text, uuid) from public, app_worker;
revoke execute on function app_private.cms_page_cover_for_staff(uuid, boolean, uuid, uuid, boolean) from public, app_worker;

-- `app_system` only. The worker attaches nothing on a schedule and reacts to no event this migration
-- adds. No table privilege on `public.pages`, `public.blog_posts` or `public.cms_media` is granted
-- anywhere by this migration, and no privilege on `storage.buckets` or `storage.objects` is touched.
grant execute on function app_private.cms_cover_media_for_staff(uuid, boolean, text, uuid) to app_system;
grant execute on function app_private.cms_page_cover_for_staff(uuid, boolean, uuid, uuid, boolean) to app_system;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
