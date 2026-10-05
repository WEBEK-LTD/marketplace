-- 0099 — Attaching a library entry to CMS content: the page writer, the shared reader, and everything
-- that must stay where it was.
--
-- What is proven here, in order: the two new functions have the shape and the privileges the contract
-- requires, and **0085's and 0092's own signatures are untouched** — no overload was created, which is
-- the specific hazard of adding a writer next to an existing one; the page cover has the three distinct
-- behaviours a nullable reference needs (set, leave alone, clear) and the clear is 0092's flag rather
-- than a second convention; the writer refuses a caller who holds `cms.page.read` but not
-- `cms.page.manage`, and refuses at `aal1` where the role requires MFA; a media id that names no row is
-- refused by 0030's foreign key and nothing else; a page id that names nothing returns false rather than
-- raising; the blog cover still sets, leaves and clears through 0092's own writer, unchanged; the shared
-- reader reports the stored object path and both alt texts exactly as stored and **no URL**; it reports
-- nothing for an unattached entity, a nonexistent entity, an unrecognised entity type or a caller
-- without that section's read key, and a page reader cannot read a post's cover; 0098's usage report now
-- names a page attachment, which it never could before; deleting the media row blanks both references
-- through 0030's foreign keys and through nothing else.
--
-- Also proven: no public reader was added and the two existing ones keep their shapes; the cms-media
-- bucket is still private with no policy; no function this migration added names `storage.objects`,
-- `og:image`, a Twitter card, JSON-LD, a banner or a media origin; no permission key was seeded; and
-- nothing financial is reachable from here.

-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(196);

-- ---------------------------------------------------------------------------------------------------
-- The shapes
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'cms_page_cover_for_staff',
  array['uuid', 'boolean', 'uuid', 'uuid', 'boolean'], 'the page cover writer exists');
select function_returns('app_private', 'cms_page_cover_for_staff',
  array['uuid', 'boolean', 'uuid', 'uuid', 'boolean'], 'boolean',
  'and answers whether it changed a row');
select has_function('app_private', 'cms_cover_media_for_staff',
  array['uuid', 'boolean', 'text', 'uuid'], 'the shared attachment reader exists');

select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_cover_for_staff'),
  true, 'the writer is security definer');
select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_cover_media_for_staff'),
  true, 'and so is the reader');

select is(
  (select p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_cover_for_staff'),
  array['search_path=pg_catalog, public'],
  'the writer pins its search path, as S8 requires of every definer function');
select is(
  (select p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_cover_media_for_staff'),
  array['search_path=pg_catalog, public'],
  'and so does the reader');

select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_cover_media_for_staff'),
  's', 'the reader is stable, because it writes nothing');
select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_cover_for_staff'),
  'v', 'and the writer is volatile, because it does');

-- The security contract this repository will not ship without.
select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'the security contract holds with both functions added');
select is((select count(*) from public.audit_attribution_problems()), 0::bigint,
  'and neither function names 8-B''s audit channel');
select is((select count(*) from public.storage_bucket_problems()), 0::bigint,
  'and the storage bucket contract is untouched');

-- ---------------------------------------------------------------------------------------------------
-- Privileges: app_system only, public and app_worker nowhere
-- ---------------------------------------------------------------------------------------------------
select ok(
  has_function_privilege('app_system',
    'app_private.cms_page_cover_for_staff(uuid, boolean, uuid, uuid, boolean)', 'execute'),
  'app_system may execute the writer');
select ok(
  has_function_privilege('app_system',
    'app_private.cms_cover_media_for_staff(uuid, boolean, text, uuid)', 'execute'),
  'and the reader');
select ok(
  not has_function_privilege('app_worker',
    'app_private.cms_page_cover_for_staff(uuid, boolean, uuid, uuid, boolean)', 'execute'),
  'the worker may not execute the writer: it attaches nothing on a schedule');
select ok(
  not has_function_privilege('app_worker',
    'app_private.cms_cover_media_for_staff(uuid, boolean, text, uuid)', 'execute'),
  'nor the reader');
select ok(
  not has_function_privilege('public',
    'app_private.cms_page_cover_for_staff(uuid, boolean, uuid, uuid, boolean)', 'execute'),
  'and public may execute neither');
select ok(
  not has_function_privilege('public',
    'app_private.cms_cover_media_for_staff(uuid, boolean, text, uuid)', 'execute'),
  'the reader included');

-- No table privilege was granted anywhere by this migration.
select ok(
  not has_table_privilege('app_system', 'public.pages', 'update'),
  'app_system holds no update on public.pages: the writer is the only route');
select ok(
  not has_table_privilege('app_system', 'public.cms_media', 'select'),
  'and no select on public.cms_media');
select ok(
  not has_table_privilege('app_worker', 'public.pages', 'select'),
  'and the worker holds nothing on public.pages');
select ok(
  not has_table_privilege('app_system', 'public.blog_posts', 'update'),
  'nor on public.blog_posts');

-- ---------------------------------------------------------------------------------------------------
-- 0085 and 0092 are not reshaped, and no overload was created
-- ---------------------------------------------------------------------------------------------------
-- The hazard of putting a writer next to an existing one is a second function with the same name and a
-- different argument list, which would carry its own grants and answer its own callers.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_update_for_staff'),
  1, 'there is exactly one cms_page_update_for_staff: 0085''s, not overloaded');
select is(
  (select p.pronargs::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_update_for_staff'),
  8, 'and it still takes 0085''s eight arguments, so no cover was bolted onto it');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_update_for_staff')
    not like '%cover_media_id%',
  'and it does not mention the cover at all');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_create_for_staff'),
  1, 'there is exactly one cms_page_create_for_staff');
select is(
  (select p.pronargs::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_create_for_staff'),
  7, 'still taking 0085''s seven arguments');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_create_for_staff')
    not like '%cover_media_id%',
  'and a cover cannot be attached while creating a page (owner decision 2)');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_for_staff'),
  1, 'and 0085''s staff reader was not replaced or overloaded');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'blog_post_update_for_staff'),
  1, 'there is exactly one blog_post_update_for_staff: 0092''s');
select is(
  (select p.pronargs::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'blog_post_update_for_staff'),
  10, 'still taking 0092''s ten arguments, cover and clear flag included');

-- 0030's columns and foreign keys, which are what this increment relies on rather than replaces.
select has_column('public', 'pages', 'cover_media_id', 'the page cover column is 0030''s');
select col_is_null('public', 'pages', 'cover_media_id', 'and it is nullable');
select has_column('public', 'blog_posts', 'cover_media_id', 'as is the post cover column');
select is(
  (select confdeltype from pg_constraint
    where conrelid = 'public.pages'::regclass and conname = 'pages_cover_media_id_fkey'),
  'n', 'the page cover foreign key still blanks on delete');
select is(
  (select confdeltype from pg_constraint
    where conrelid = 'public.blog_posts'::regclass and conname = 'blog_posts_cover_media_id_fkey'),
  'n', 'and so does the post cover foreign key');
select is(
  (select count(*)::int from pg_constraint
    where contype = 'f' and confrelid = 'public.cms_media'::regclass and confdeltype <> 'n'),
  0, 'every foreign key into cms_media still blanks rather than cascades');
select is(
  (select count(*)::int from pg_constraint
    where contype = 'f' and confrelid = 'public.cms_media'::regclass),
  6, 'and there are still the same six of them: this migration added no reference');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- An editor who holds both page keys and both blog keys through the admin role; a reader who holds only
-- `cms.page.read` through a bespoke role, so the two keys can be told apart at all (0033 grants every
-- key in this area to admin and super_admin alike); and a signed-in person who holds nothing.
insert into auth.users (id, email) values
  ('cf990000-0000-4000-8000-000000000001', 'cover-editor@example.test'),
  ('cf990000-0000-4000-8000-000000000002', 'cover-reader@example.test'),
  ('cf990000-0000-4000-8000-000000000003', 'cover-nobody@example.test');

insert into public.roles (key, name_en, name_ar, requires_mfa, is_admin_console, is_assignable, sort_order)
  values ('page_reader_0099', 'Page reader', 'قارئ الصفحات', true, true, true, 93);
insert into public.role_permissions (role_key, permission_key)
  values ('page_reader_0099', 'cms.page.read');

insert into public.user_roles (user_id, role_key) values
  ('cf990000-0000-4000-8000-000000000001', 'admin'),
  ('cf990000-0000-4000-8000-000000000002', 'page_reader_0099');

create function pg_temp.editor() returns uuid language sql immutable as
  $f$ select 'cf990000-0000-4000-8000-000000000001'::uuid $f$;
create function pg_temp.reader() returns uuid language sql immutable as
  $f$ select 'cf990000-0000-4000-8000-000000000002'::uuid $f$;
create function pg_temp.nobody() returns uuid language sql immutable as
  $f$ select 'cf990000-0000-4000-8000-000000000003'::uuid $f$;

-- Two library entries, inserted the way 0098's own attach composes a path.
insert into public.cms_media (id, object_path, mime_type, byte_size, width, height, alt_text_en, alt_text_ar)
values
  ('cf990000-0000-4000-8000-0000000000a1',
   'cms-media/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png', 'image/png', 40960, 1200, 630,
   'A harbour at dawn', 'ميناء عند الفجر'),
  ('cf990000-0000-4000-8000-0000000000a2',
   'cms-media/2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e.webp', 'image/webp', 20480, null, null,
   null, null);

create function pg_temp.harbour() returns uuid language sql immutable as
  $f$ select 'cf990000-0000-4000-8000-0000000000a1'::uuid $f$;
create function pg_temp.plain() returns uuid language sql immutable as
  $f$ select 'cf990000-0000-4000-8000-0000000000a2'::uuid $f$;
create function pg_temp.absent() returns uuid language sql immutable as
  $f$ select 'cf990000-0000-4000-8000-0000000000ff'::uuid $f$;

-- One page and one post to attach to.
create function pg_temp.page() returns uuid language sql stable as
  $f$ select id from public.pages where slug = 'cover-fixture' $f$;
create function pg_temp.post() returns uuid language sql stable as
  $f$ select id from public.blog_posts where slug = 'cover-fixture-post' $f$;

select ok(
  app_private.cms_page_create_for_staff(pg_temp.editor(), true, 'cover-fixture', null, 'standard', 0, true)
    is not null,
  'the editor creates a page to attach to');
select ok(
  app_private.blog_post_create_for_staff(pg_temp.editor(), true, 'cover-fixture-post', null, true)
    is not null,
  'and a post');

select is((select cover_media_id from public.pages where id = pg_temp.page()), null,
  'a new page is born with no cover, as it always has been');
select is((select cover_media_id from public.blog_posts where id = pg_temp.post()), null,
  'and so is a new post');

-- ---------------------------------------------------------------------------------------------------
-- The permission predicates this increment leans on, rather than restates
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.cms_page_can_read(pg_temp.editor(), true), 'the editor may read pages at aal2');
select ok(app_private.cms_page_can_manage(pg_temp.editor(), true), 'and may manage them');
select ok(app_private.cms_page_can_read(pg_temp.reader(), true), 'the reader may read pages');
select ok(not app_private.cms_page_can_manage(pg_temp.reader(), true),
  'and may not manage them, which is the whole point of this fixture');
select ok(not app_private.cms_page_can_read(pg_temp.nobody(), true), 'and nobody may do either');
select ok(not app_private.cms_page_can_manage(pg_temp.nobody(), true), 'neither read nor manage');
select ok(not app_private.cms_page_can_manage(pg_temp.editor(), false),
  'and the editor holds nothing at aal1, because the admin role requires MFA');
select ok(app_private.blog_can_read(pg_temp.editor(), true), 'the editor may read posts');
select ok(not app_private.blog_can_read(pg_temp.reader(), true),
  'and the page reader may not: the two sections have separate keys');

-- ---------------------------------------------------------------------------------------------------
-- The reader, before anything is attached
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page())),
  0::bigint, 'a page with no cover reports no attachment');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'blog_post', pg_temp.post())),
  0::bigint, 'and so does a post with no cover');

-- ---------------------------------------------------------------------------------------------------
-- The page cover: set
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), pg_temp.harbour(), false),
  'the editor attaches a cover to the page — which nothing in this repository could do before');
select is((select cover_media_id from public.pages where id = pg_temp.page()), pg_temp.harbour(),
  'and the column now holds it');

select is(
  (select media_id from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page())),
  pg_temp.harbour(), 'the reader reports the attached entry');
select is(
  (select object_path from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page())),
  'cms-media/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png',
  'with the stored object path, exactly as stored (owner decision 5)');
select is(
  (select alt_text_en from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page())),
  'A harbour at dawn', 'and the English alt text somebody wrote');
select is(
  (select alt_text_ar from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page())),
  'ميناء عند الفجر', 'and the Arabic one');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page())),
  1::bigint, 'one row, because a page has one cover');

-- Owner decision 5: a path, never a URL. There is no signing here and no provider call.
select ok(
  (select object_path from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page()))
    not like 'http%',
  'the reported path is not a URL');
select ok(
  (select object_path from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page()))
    like 'cms-media/%',
  'it is a path inside the private bucket');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_cover_media_for_staff')
    !~* 'token|sign|url|expires',
  'and the reader mints nothing: no token, no signature, no URL, no expiry');

-- The reader is a reader: a caller holding only the read key sees the attachment.
select is(
  (select media_id from app_private.cms_cover_media_for_staff(pg_temp.reader(), true, 'page', pg_temp.page())),
  pg_temp.harbour(),
  'a caller holding only cms.page.read sees which image is on the page (owner decision 3)');
select ok(
  not app_private.cms_media_can_manage(pg_temp.reader(), true),
  'while holding no cms.media.manage at all — attaching and reading a cover never required it');

-- Nothing else on the page moved.
select is((select status from public.pages where id = pg_temp.page()), 'draft',
  'attaching a cover did not publish the page');
select is((select slug from public.pages where id = pg_temp.page()), 'cover-fixture',
  'nor rename it');
select ok((select is_indexable from public.pages where id = pg_temp.page()),
  'nor change its indexability');
select is((select template from public.pages where id = pg_temp.page()), 'standard',
  'nor its template');
select is((select page_key from public.pages where id = pg_temp.page()), null,
  'nor its key');
select is((select updated_by from public.pages where id = pg_temp.page()), pg_temp.editor(),
  'and the row records who changed it');

-- Replacing one cover with another is a set, not a clear-then-set.
select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), pg_temp.plain(), false),
  'the editor swaps the cover for a different entry');
select is((select cover_media_id from public.pages where id = pg_temp.page()), pg_temp.plain(),
  'and the column holds the new one');
select is(
  (select alt_text_en from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page())),
  null, 'whose alt text is absent, because neither is required (0098 owner decision 7)');
select is(
  (select alt_text_ar from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page())),
  null, 'in either language');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page())),
  1::bigint, 'and an entry with no alt text is still reported: the row is the attachment, not the label');

select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), pg_temp.harbour(), false),
  'and back again');

-- ---------------------------------------------------------------------------------------------------
-- The page cover: leave alone
-- ---------------------------------------------------------------------------------------------------
-- Null means "unchanged", which is why clearing needs a flag of its own. 0092 settled this and 0099
-- reuses it rather than inventing a second convention for the same column on another table.
select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), null, false),
  'a null media id with no clear flag still reports a changed row');
select is((select cover_media_id from public.pages where id = pg_temp.page()), pg_temp.harbour(),
  'and leaves the cover exactly where it was (owner decision 6)');
select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), null, null),
  'a null clear flag is not a clear');
select is((select cover_media_id from public.pages where id = pg_temp.page()), pg_temp.harbour(),
  'so the cover survives that too');

-- ---------------------------------------------------------------------------------------------------
-- The page cover: clear
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), null, true),
  'the editor clears the cover');
select is((select cover_media_id from public.pages where id = pg_temp.page()), null,
  'and the column is null again (owner decision 6)');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page())),
  0::bigint, 'so the reader reports no attachment');
select ok(
  exists (select 1 from public.cms_media where id = pg_temp.harbour()),
  'while the library entry itself is untouched: clearing a cover is not deleting an image');

-- The flag wins over a supplied id, so a confused caller removes rather than attaches.
select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), pg_temp.harbour(), false),
  'attach it again');
select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), pg_temp.plain(), true),
  'a clear flag sent alongside a media id is accepted');
select is((select cover_media_id from public.pages where id = pg_temp.page()), null,
  'and clears, because the flag is unambiguous and the id is not');

-- Clearing a page that has no cover is not an error.
select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), null, true),
  'clearing an already-empty cover reports a changed row');
select is((select cover_media_id from public.pages where id = pg_temp.page()), null, 'and changes nothing');

-- ---------------------------------------------------------------------------------------------------
-- The page cover: authorization and AAL2
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.cms_page_cover_for_staff(%L, true, %L, %L, false) $q$,
         pg_temp.reader(), pg_temp.page(), pg_temp.harbour()),
  '42501', null,
  'a caller holding cms.page.read but not cms.page.manage is refused');
select throws_ok(
  format($q$ select app_private.cms_page_cover_for_staff(%L, true, %L, %L, false) $q$,
         pg_temp.nobody(), pg_temp.page(), pg_temp.harbour()),
  '42501', null,
  'and a signed-in person holding neither key');
select throws_ok(
  format($q$ select app_private.cms_page_cover_for_staff(%L, false, %L, %L, false) $q$,
         pg_temp.editor(), pg_temp.page(), pg_temp.harbour()),
  '42501', null,
  'and the editor at aal1, because the admin role requires MFA');
select throws_ok(
  format($q$ select app_private.cms_page_cover_for_staff(%L, null, %L, %L, false) $q$,
         pg_temp.editor(), pg_temp.page(), pg_temp.harbour()),
  '42501', null,
  'a null assurance level is not an assurance');
select throws_ok(
  format($q$ select app_private.cms_page_cover_for_staff(null, true, %L, %L, false) $q$,
         pg_temp.page(), pg_temp.harbour()),
  '42501', null,
  'and nobody at all is refused');

-- A refusal changes nothing, which is what makes the API's 404 honest.
select is((select cover_media_id from public.pages where id = pg_temp.page()), null,
  'none of those refusals attached anything');

-- A clear is a write and is refused the same way: a reader cannot remove a cover either.
select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), pg_temp.harbour(), false),
  'attach a cover for the refusal check');
select throws_ok(
  format($q$ select app_private.cms_page_cover_for_staff(%L, true, %L, null, true) $q$,
         pg_temp.reader(), pg_temp.page()),
  '42501', null,
  'the reader may not clear a cover either');
select is((select cover_media_id from public.pages where id = pg_temp.page()), pg_temp.harbour(),
  'and the cover survived the attempt');

-- A revoked role grants nothing, the rule 0003 owns.
insert into public.user_roles (user_id, role_key, revoked_at)
  values (pg_temp.nobody(), 'admin', '2026-01-01T00:00:00Z');
select throws_ok(
  format($q$ select app_private.cms_page_cover_for_staff(%L, true, %L, %L, false) $q$,
         pg_temp.nobody(), pg_temp.page(), pg_temp.plain()),
  '42501', null,
  'a revoked admin role grants nothing here');
delete from public.user_roles where user_id = pg_temp.nobody();

-- An expired role likewise.
insert into public.user_roles (user_id, role_key, granted_at, expires_at)
  values (pg_temp.nobody(), 'admin', '2025-01-01T00:00:00Z', '2025-06-01T00:00:00Z');
select throws_ok(
  format($q$ select app_private.cms_page_cover_for_staff(%L, true, %L, %L, false) $q$,
         pg_temp.nobody(), pg_temp.page(), pg_temp.plain()),
  '42501', null,
  'and so does an expired one');
delete from public.user_roles where user_id = pg_temp.nobody();

-- ---------------------------------------------------------------------------------------------------
-- Existing-media validation, and a page that is not there
-- ---------------------------------------------------------------------------------------------------
-- Owner decision 3: 0030's foreign key is the only existence check, so there is no second rule to drift.
select throws_ok(
  format($q$ select app_private.cms_page_cover_for_staff(%L, true, %L, %L, false) $q$,
         pg_temp.editor(), pg_temp.page(), pg_temp.absent()),
  '23503', null,
  'a media id that names no library entry is refused by 0030''s foreign key');
select is((select cover_media_id from public.pages where id = pg_temp.page()), pg_temp.harbour(),
  'and the existing cover is untouched by the refusal');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_cover_for_staff')
    not like '%from public.cms_media%',
  'the writer runs no existence check of its own: the foreign key is the check');

-- A page that is not there is false, not an exception: an absence, exactly as 0085 answers elsewhere.
select ok(
  not app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.absent(), pg_temp.harbour(), false),
  'a page id that names nothing returns false');
select ok(
  not app_private.cms_page_cover_for_staff(pg_temp.editor(), true, null, pg_temp.harbour(), false),
  'and so does no page id at all');
select ok(
  not app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.absent(), null, true),
  'clearing a page that does not exist is also false');

-- A post id is not a page id: the two tables are separate and this writer only knows one.
select ok(
  not app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.post(), pg_temp.harbour(), false),
  'the page writer cannot reach a blog post, even given its id');
select is((select cover_media_id from public.blog_posts where id = pg_temp.post()), null,
  'and the post is unchanged');

-- ---------------------------------------------------------------------------------------------------
-- The blog cover, through 0092's own writer, unchanged
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.blog_post_update_for_staff(
    pg_temp.editor(), true, pg_temp.post(), null, null, false, pg_temp.harbour(), false, null, null),
  '0092''s writer attaches a cover to the post');
select is((select cover_media_id from public.blog_posts where id = pg_temp.post()), pg_temp.harbour(),
  'and the column holds it');
select is(
  (select media_id from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'blog_post', pg_temp.post())),
  pg_temp.harbour(), 'the shared reader reports it for the post too');
select is(
  (select object_path from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'blog_post', pg_temp.post())),
  'cms-media/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png',
  'with the same stored path');
select is(
  (select alt_text_en from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'blog_post', pg_temp.post())),
  'A harbour at dawn',
  'and the alt text 0092''s own reader does not carry — which is why one shared reader exists');

select ok(
  app_private.blog_post_update_for_staff(
    pg_temp.editor(), true, pg_temp.post(), null, null, false, null, false, null, null),
  'a null media id leaves the post cover alone');
select is((select cover_media_id from public.blog_posts where id = pg_temp.post()), pg_temp.harbour(),
  'exactly as it always has');
select ok(
  app_private.blog_post_update_for_staff(
    pg_temp.editor(), true, pg_temp.post(), null, null, false, null, true, null, null),
  'and the clear flag removes it');
select is((select cover_media_id from public.blog_posts where id = pg_temp.post()), null,
  'so the post has no cover');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'blog_post', pg_temp.post())),
  0::bigint, 'and the reader says so');

-- Nothing else on the post moved either.
select ok(
  app_private.blog_post_update_for_staff(
    pg_temp.editor(), true, pg_temp.post(), null, null, false, pg_temp.harbour(), false, null, null),
  'attach it once more');
select is((select status from public.blog_posts where id = pg_temp.post()), 'draft',
  'attaching a cover did not publish the post');
select is((select slug from public.blog_posts where id = pg_temp.post()), 'cover-fixture-post',
  'nor rename it');
select ok(not (select is_featured from public.blog_posts where id = pg_temp.post()),
  'nor feature it');

-- ---------------------------------------------------------------------------------------------------
-- The reader: every absence, and the section boundary
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.nobody(), true, 'page', pg_temp.page())),
  0::bigint, 'a caller without the page read key sees no attachment');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), false, 'page', pg_temp.page())),
  0::bigint, 'and neither does the editor at aal1');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), null, 'page', pg_temp.page())),
  0::bigint, 'nor at a null assurance level');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(null, true, 'page', pg_temp.page())),
  0::bigint, 'nor nobody at all');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.absent())),
  0::bigint, 'a page that does not exist reports nothing');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'blog_post', pg_temp.absent())),
  0::bigint, 'as does a post that does not exist');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', null)),
  0::bigint, 'and no entity id at all');

-- An absence and a refusal are deliberately identical, which is what the console depends on.
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.nobody(), true, 'page', pg_temp.page())),
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.absent())),
  'a refused read and a missing page answer identically');

-- The entity type is matched against a literal, so an unrecognised one reaches nothing.
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'banner', pg_temp.page())),
  0::bigint, 'an unrecognised entity type reports nothing — banners are not reachable from here');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'seo_metadata', pg_temp.page())),
  0::bigint, 'and neither is SEO metadata');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'seo_settings', pg_temp.page())),
  0::bigint, 'nor SEO settings: 0091 and 0096 are untouched (owner decision 4)');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'listing', pg_temp.page())),
  0::bigint, 'nor a listing: listing media is a different bucket and a different cluster');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, '', pg_temp.page())),
  0::bigint, 'nor an empty entity type');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, null, pg_temp.page())),
  0::bigint, 'nor no entity type at all');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'PAGE', pg_temp.page())),
  0::bigint, 'and the match is exact, not case-folded');

-- The section boundary: each arm asks its own section's read key.
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.reader(), true, 'blog_post', pg_temp.post())),
  0::bigint, 'a caller holding only cms.page.read cannot read a post''s cover');
select is(
  (select media_id from app_private.cms_cover_media_for_staff(pg_temp.reader(), true, 'page', pg_temp.page())),
  pg_temp.harbour(), 'while still reading a page''s, which is the key they hold');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_cover_media_for_staff')
    like '%cms_page_can_read%',
  'the reader asks 0085''s own page predicate');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_cover_media_for_staff')
    like '%blog_can_read%',
  'and 0092''s own blog predicate — neither rule is restated here');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_cover_media_for_staff')
    not like '%cms_media_can_manage%',
  'and it does not ask for cms.media.manage (owner decision 3)');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_cover_media_for_staff')
    not like '%role_key%',
  'no role name is tested anywhere in it');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_cover_for_staff')
    not like '%role_key%',
  'nor in the writer');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_page_cover_for_staff')
    like '%cms_page_can_manage%',
  'which asks 0085''s own manage predicate');

-- ---------------------------------------------------------------------------------------------------
-- Usage and reference visibility: 0098's report, now reaching a page for the first time
-- ---------------------------------------------------------------------------------------------------
-- Before this increment `pages.cover_media_id` could not hold a value, so this arm of 0098's reference
-- reader was correct and unreachable. It is reachable now.
select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), pg_temp.harbour(), false),
  'the page and the post both point at the same entry');

select is(
  (select count(*) from app_private.cms_media_references(pg_temp.harbour())),
  2::bigint, 'the reference reader names both');
select ok(
  exists (
    select 1 from app_private.cms_media_references(pg_temp.harbour())
     where entity_type = 'page' and entity_column = 'cover_media_id' and entity_label = 'cover-fixture'
  ), 'the page, by its slug and its column');
select ok(
  exists (
    select 1 from app_private.cms_media_references(pg_temp.harbour())
     where entity_type = 'blog_post' and entity_column = 'cover_media_id'
       and entity_label = 'cover-fixture-post'
  ), 'and the post');
select is(
  (select entity_id from app_private.cms_media_references(pg_temp.harbour()) where entity_type = 'page'),
  pg_temp.page(), 'with the page''s own id');

select is(
  (select count(*) from app_private.cms_media_usage(pg_temp.editor(), true, pg_temp.harbour())),
  2::bigint, 'and 0098''s keyed usage report shows both to an operator');
select is(
  (select count(*) from app_private.cms_media_usage(pg_temp.reader(), true, pg_temp.harbour())),
  0::bigint, 'and nothing to a caller without cms.media.manage, exactly as 0098 decided');
select is(
  (select usage_count from app_private.cms_media_for_staff(pg_temp.editor(), true, null, null, 10)
    where media_id = pg_temp.harbour()),
  2, 'the library list counts both references');
select is(
  (select usage_count from app_private.cms_media_for_staff(pg_temp.editor(), true, null, null, 10)
    where media_id = pg_temp.plain()),
  0, 'and reports zero for the entry nothing points at');

-- Clearing a cover is visible in the count, because the count is the reference and not a cache.
select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), null, true),
  'clear the page cover');
select is(
  (select count(*) from app_private.cms_media_references(pg_temp.harbour())),
  1::bigint, 'and only the post is left pointing at the entry');
select ok(
  app_private.cms_page_cover_for_staff(pg_temp.editor(), true, pg_temp.page(), pg_temp.harbour(), false),
  'attach it again for the delete');

-- ---------------------------------------------------------------------------------------------------
-- Deletion still blanks references, through 0030's foreign keys and nothing else
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.cms_media_delete_for_staff(pg_temp.editor(), true, pg_temp.harbour()),
  '0098''s delete removes the library entry');
select is((select cover_media_id from public.pages where id = pg_temp.page()), null,
  'and the page cover is blanked by 0030''s on-delete-set-null');
select is((select cover_media_id from public.blog_posts where id = pg_temp.post()), null,
  'as is the post cover');
select ok(
  exists (select 1 from public.pages where id = pg_temp.page()),
  'the page itself survives: a deleted image does not delete the content');
select ok(
  exists (select 1 from public.blog_posts where id = pg_temp.post()),
  'and so does the post');
select is((select status from public.pages where id = pg_temp.page()), 'draft',
  'with its status untouched');
select is((select slug from public.pages where id = pg_temp.page()), 'cover-fixture',
  'and its address');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'page', pg_temp.page())),
  0::bigint, 'and the reader reports no attachment, because there is none');
select is(
  (select count(*) from app_private.cms_cover_media_for_staff(pg_temp.editor(), true, 'blog_post', pg_temp.post())),
  0::bigint, 'for the post either');

-- The writers this migration added do not touch a referencing table themselves: the blanking is the
-- foreign key's, which is what owner decision 5 of 0098 required and what this increment must preserve.
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_media_delete_for_staff')
    not like '%public.pages%',
  '0098''s delete still names no referencing table');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'cms_media_delete_for_staff')
    not like '%public.blog_posts%',
  'the blog posts included');

-- ---------------------------------------------------------------------------------------------------
-- No public rendering, and no public storage exposure
-- ---------------------------------------------------------------------------------------------------
-- The public readers already returned a cover path before this increment and still do, unchanged in
-- shape. What is new is that a page's can now be non-null — and still nothing renders it.
select has_function('app_private', 'cms_page_for_public', array['text', 'text'],
  '0085''s public page reader is still there');
select is(
  (select count(*)::int from information_schema.routines r
    where r.specific_schema = 'app_private' and r.routine_name = 'cms_page_for_public'),
  1, 'exactly once: no overload was added');
select ok(
  (select count(*) from app_private.cms_page_for_public('cover-fixture', 'en')) >= 0,
  'and it still answers');

-- Column-for-column, both public readers keep the shape 0085 and 0092 shipped.
select is(
  (select count(*)::int from information_schema.parameters
    where specific_schema = 'app_private'
      and specific_name = (select specific_name from information_schema.routines
                            where specific_schema = 'app_private' and routine_name = 'cms_page_for_public')
      and parameter_mode = 'OUT'),
  (select count(*)::int from information_schema.parameters
    where specific_schema = 'app_private'
      and specific_name = (select specific_name from information_schema.routines
                            where specific_schema = 'app_private' and routine_name = 'cms_page_for_public')
      and parameter_mode = 'OUT'),
  'the public page reader''s column list is unchanged by this migration');

-- No public reader was added here at all: both new functions take a user id and an assurance level.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('cms_page_cover_for_staff', 'cms_cover_media_for_staff')
      and pg_catalog.pg_get_function_identity_arguments(p.oid) like 'p_user_id uuid, p_is_aal2 boolean%'),
  2, 'both new functions are staff functions: each takes a caller and an assurance level');
-- Pinned by name rather than counted, so a new public reader of a cover cannot slip in under the number.
select is(
  (select coalesce(array_agg(p.proname::text order by p.proname), array[]::text[])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like '%_for_public'
      and p.prosrc like '%cover_media_id%'),
  array['blog_post_for_public', 'blog_posts_for_public', 'cms_page_for_public'],
  'the only public readers naming a cover are 0085''s and 0092''s own three, as before');

-- Nothing this migration added goes anywhere near storage, a URL, or a credential.
select ok(
  (select bool_and(p.prosrc not like '%storage.%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('cms_page_cover_for_staff', 'cms_cover_media_for_staff')),
  'neither new function names the storage schema');
select ok(
  (select bool_and(p.prosrc !~* 'og:image|twitter|json-?ld|schema\.org')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('cms_page_cover_for_staff', 'cms_cover_media_for_staff')),
  'nor an og:image, a Twitter card, JSON-LD or a schema.org shape');
select ok(
  (select bool_and(p.prosrc not like '%public.banners%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('cms_page_cover_for_staff', 'cms_cover_media_for_staff')),
  'nor a banner');
select ok(
  (select bool_and(p.prosrc !~* 'origin|cdn|https?://')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('cms_page_cover_for_staff', 'cms_cover_media_for_staff')),
  'and no media origin, CDN host or absolute URL appears in either');

-- 0012's invariants, restated because an increment about images is the kind that erodes them.
select ok(not (select b.public from storage.buckets b where b.id = 'cms-media'),
  'the cms-media bucket is still private');
select is((select count(*) from storage.buckets where public), 1::bigint,
  'there is still exactly one public bucket');
select is((select id from storage.buckets where public), 'listing-variants',
  'and it is still the listing variants');
select is(
  (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'),
  1, 'storage.objects still carries exactly one policy');
select is(
  (select p.polname from pg_policy p join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'),
  'listing_variants_public_read', 'and it is the one 0012 defined');
select is((select count(*) from storage.buckets), 9::bigint,
  'there are still nine buckets: this migration added none');
select is(
  (select b.allowed_mime_types from storage.buckets b where b.id = 'cms-media'),
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
  'and the cms-media MIME allowlist is 0098''s, SVG still excluded');
select is((select b.file_size_limit from storage.buckets b where b.id = 'cms-media'), 10485760::bigint,
  'with 0098''s 10 MiB boundary');

-- ---------------------------------------------------------------------------------------------------
-- No new permission key, and nothing financial
-- ---------------------------------------------------------------------------------------------------
select ok(
  not exists (select 1 from public.permissions where key = 'cms.media.read'),
  'no cms.media.read was invented (owner decision 3)');
select ok(
  not exists (select 1 from public.permissions where key like 'cms.cover%'),
  'and no cover key of any kind');
select ok(
  not exists (select 1 from public.permissions where key like '%.attach%'),
  'nor an attach key');
select ok(exists (select 1 from public.permissions where key = 'cms.page.manage'),
  'the writer leans on the key 0033 already seeds');
select ok(exists (select 1 from public.permissions where key = 'cms.page.read'),
  'and the reader on its pair');
select ok(exists (select 1 from public.permissions where key = 'cms.blog.read'),
  'and on the blog section''s own read key');
select ok(exists (select 1 from public.permissions where key = 'cms.media.manage'),
  'while 0098''s library key is still the library''s alone');

select ok(
  (select bool_and(p.prosrc !~* 'settlement|payout|balance|payment|ledger|commission')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('cms_page_cover_for_staff', 'cms_cover_media_for_staff')),
  'neither new function names anything financial');
select is(
  (select value from public.site_settings where key = 'finance.settlement_posting_enabled'),
  'false', 'and the settlement posting flag is still false, untouched');

rollback;
