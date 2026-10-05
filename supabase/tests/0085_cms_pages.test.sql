-- 0085 — CMS static pages: the named readers and writers.
--
-- What is proven here, in order: the two permission predicates apply 0003's requires_mfa rule; the public
-- reader answers with exactly one of three kinds and treats every non-public state as absence; the slug
-- history produces a `moved` answer and never an ambiguous one; the locale fallback returns real text and
-- reports which language it returned; the staff surfaces return nothing at all to a caller without the read
-- key; every writer refuses a caller without the manage key with 42501; a page cannot be published before it
-- is written, nor stripped of its last locale while published; and every function is granted to app_system
-- and to nobody else.

-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(200);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'cms_page_can_read', array['uuid', 'boolean'], 'the read predicate exists');
select has_function('app_private', 'cms_page_can_manage', array['uuid', 'boolean'], 'the manage predicate exists');
select has_function('app_private', 'cms_page_for_public', array['text', 'text'], 'the public reader exists');
select has_function('app_private', 'cms_pages_for_public', array['text'], 'the public index exists');
select has_function('app_private', 'cms_pages_for_staff',
  array['uuid', 'boolean', 'integer', 'text', 'timestamptz', 'uuid'], 'the staff list exists');
select has_function('app_private', 'cms_page_for_staff', array['uuid', 'boolean', 'uuid'], 'the staff detail exists');
select has_function('app_private', 'cms_page_translations_for_staff', array['uuid', 'boolean', 'uuid'],
  'the staff translation reader exists');
select has_function('app_private', 'cms_page_create_for_staff',
  array['uuid', 'boolean', 'text', 'text', 'text', 'integer', 'boolean'], 'the create writer exists');
select has_function('app_private', 'cms_page_update_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'text', 'integer', 'boolean'], 'the update writer exists');
select has_function('app_private', 'cms_page_status_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'timestamptz'], 'the status writer exists');
select has_function('app_private', 'cms_page_translation_save_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'text', 'text', 'text', 'text'], 'the translation writer exists');
select has_function('app_private', 'cms_page_translation_delete_for_staff',
  array['uuid', 'boolean', 'uuid', 'text'], 'the translation remover exists');

-- Every one is a definer function with a pinned search path, like everything else app_system may call.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'cms_page%' and p.prosecdef),
  13, 'all thirteen are security definer: 0099''s page cover writer is the thirteenth');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'cms_page%'
      and p.proconfig @> array['search_path=pg_catalog, public']),
  13, 'all thirteen pin search_path to pg_catalog, public');

-- The three-answer contract is in the result type, so a caller cannot forget to branch on it.
select matches(pg_get_function_result(p.oid), 'kind text', 'the public reader returns a kind column')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'cms_page_for_public';

select matches(pg_get_function_result(p.oid), 'resolved_locale text',
  'the public reader reports which locale it returned')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'cms_page_for_public';

select matches(pg_get_function_result(p.oid), 'can_manage boolean',
  'the staff detail reports the manage capability')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'cms_page_for_staff';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select ok(has_function_privilege('app_system', p.oid, 'execute'),
    format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname like 'cms_page%'
 order by p.proname;

select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
    format('%s may not execute %s', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_worker')) as r(rolname)
 where n.nspname = 'app_private' and p.proname like 'cms_page%'
 order by r.rolname, p.proname;

-- ---------------------------------------------------------------------------------------------------
-- Nothing in 0030 was changed
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'pages', 'the pages table is untouched');
select has_table('public', 'page_translations', 'the translations table is untouched');
select has_table('public', 'page_slug_history', 'the slug history is untouched');
select has_function('public', 'cms_content_is_public', array['text', 'timestamptz'],
  '0030''s publication rule is untouched');
select ok(
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'pages' and not t.tgisinternal) >= 5,
  '0030''s five page triggers are still installed');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- An author who holds both keys through the admin role (0033 grants both to admin and super_admin, and both
-- roles require MFA), and a signed-in person who holds neither.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'cms-author@example.test'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'cms-nobody@example.test');
insert into public.user_roles (user_id, role_key) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'admin');

create function pg_temp.author() returns uuid language sql immutable as
  $f$ select 'aaaaaaaa-0000-4000-8000-000000000001'::uuid $f$;
create function pg_temp.nobody() returns uuid language sql immutable as
  $f$ select 'aaaaaaaa-0000-4000-8000-000000000002'::uuid $f$;

-- ---------------------------------------------------------------------------------------------------
-- The permission predicates
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.cms_page_can_read(pg_temp.author(), true), 'the author may read at aal2');
select ok(app_private.cms_page_can_manage(pg_temp.author(), true), 'the author may manage at aal2');
-- The admin role requires MFA, so 0003's own rule withholds both keys at aal1. Nothing here re-implements
-- that rule; the predicate passes the assurance level in and the rule decides.
select ok(not app_private.cms_page_can_read(pg_temp.author(), false), 'the author reads nothing at aal1');
select ok(not app_private.cms_page_can_manage(pg_temp.author(), false), 'the author manages nothing at aal1');
select ok(not app_private.cms_page_can_read(pg_temp.nobody(), true), 'a person without the role may not read');
select ok(not app_private.cms_page_can_manage(pg_temp.nobody(), true), 'a person without the role may not manage');
select ok(not app_private.cms_page_can_read(null, true), 'a null account holds nothing');
select ok(not app_private.cms_page_can_manage(null, true), 'a null account manages nothing');

-- A revoked role grants nothing, which is the user_roles rule rather than this function's.
insert into public.user_roles (user_id, role_key, revoked_at)
values (pg_temp.nobody(), 'super_admin', now());
select ok(not app_private.cms_page_can_read(pg_temp.nobody(), true), 'a revoked role grants no read');
delete from public.user_roles where user_id = pg_temp.nobody();

-- ---------------------------------------------------------------------------------------------------
-- Creating and writing
-- ---------------------------------------------------------------------------------------------------
select lives_ok(
  $q$ select app_private.cms_page_create_for_staff(pg_temp.author(), true, 'terms', 'terms', 'legal', 10, true) $q$,
  'the author creates a page');

-- The identifier is captured once, not looked up by slug: this page is renamed further down, and a helper
-- that resolved a slug would silently start returning null at that point and every later assertion would be
-- testing a page that does not exist.
create temporary table page_ids as select id from public.pages where slug = 'terms';
create function pg_temp.terms() returns uuid language sql stable as
  $f$ select id from page_ids $f$;

select is((select status from public.pages where id = pg_temp.terms()), 'draft', 'a new page is a draft');
select is((select created_by from public.pages where id = pg_temp.terms()), pg_temp.author(),
  'the creating actor is recorded on the row');
select is((select updated_by from public.pages where id = pg_temp.terms()), pg_temp.author(),
  'the creating actor is also the last editor');
select is((select template from public.pages where id = pg_temp.terms()), 'legal', 'the template is recorded');
select is((select page_key from public.pages where id = pg_temp.terms()), 'terms', 'the page key is recorded');

-- Every writer refuses the unauthorized caller with 42501, and none of them is the exception.
select throws_ok(
  $q$ select app_private.cms_page_create_for_staff(pg_temp.nobody(), true, 'sneaky') $q$,
  '42501', null, 'create refuses a caller without the manage key');
select throws_ok(
  $q$ select app_private.cms_page_update_for_staff(pg_temp.nobody(), true, pg_temp.terms(), 'sneaky', null, null, null, null) $q$,
  '42501', null, 'update refuses a caller without the manage key');
select throws_ok(
  $q$ select app_private.cms_page_status_for_staff(pg_temp.nobody(), true, pg_temp.terms(), 'published') $q$,
  '42501', null, 'the status writer refuses a caller without the manage key');
select throws_ok(
  $q$ select app_private.cms_page_translation_save_for_staff(pg_temp.nobody(), true, pg_temp.terms(), 'en', 'T', 'B') $q$,
  '42501', null, 'the translation writer refuses a caller without the manage key');
select throws_ok(
  $q$ select app_private.cms_page_translation_delete_for_staff(pg_temp.nobody(), true, pg_temp.terms(), 'en') $q$,
  '42501', null, 'the translation remover refuses a caller without the manage key');
-- The author at aal1 is refused for the same reason: the key is not held at that assurance level.
select throws_ok(
  $q$ select app_private.cms_page_create_for_staff(pg_temp.author(), false, 'at-aal1') $q$,
  '42501', null, 'the author is refused at aal1');
select is((select count(*)::int from public.pages where slug in ('sneaky', 'at-aal1')), 0,
  'no refused write left a row behind');

-- ---------------------------------------------------------------------------------------------------
-- An unwritten page cannot go live
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  $q$ select app_private.cms_page_status_for_staff(pg_temp.author(), true, pg_temp.terms(), 'published') $q$,
  '23001', null, 'a page with no locale cannot be published');
select throws_ok(
  $q$ select app_private.cms_page_status_for_staff(pg_temp.author(), true, pg_temp.terms(), 'scheduled', now() + interval '1 day') $q$,
  '23001', null, 'a page with no locale cannot be scheduled');
select is((select status from public.pages where id = pg_temp.terms()), 'draft',
  'the refused transition left the page a draft');

-- A draft is not public, and a draft slug is absence rather than a different answer.
select is((select kind from app_private.cms_page_for_public('terms', 'en')), 'not_found',
  'a draft page is absent from the public reader');

-- ---------------------------------------------------------------------------------------------------
-- Writing and publishing
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.cms_page_translation_save_for_staff(
    pg_temp.author(), true, pg_temp.terms(), 'en',
    'Terms of Service', 'The English body.', 'A short excerpt.', 'Terms', 'Our terms of service.'),
  'the author writes the English locale');

select is((select title from public.page_translations where page_id = pg_temp.terms() and locale_code = 'en'),
  'Terms of Service', 'the title is stored');
select is((select meta_description from public.page_translations where page_id = pg_temp.terms() and locale_code = 'en'),
  'Our terms of service.', 'the meta description is stored');

-- An empty optional becomes null rather than an empty string, so a page never carries a blank meta tag.
select ok(
  app_private.cms_page_translation_save_for_staff(
    pg_temp.author(), true, pg_temp.terms(), 'en', 'Terms of Service', 'The English body.', '   ', '  ', '  '),
  'the author rewrites the English locale');
select is((select excerpt from public.page_translations where page_id = pg_temp.terms() and locale_code = 'en'),
  null::text, 'a blank excerpt is stored as null');
select is((select meta_title from public.page_translations where page_id = pg_temp.terms() and locale_code = 'en'),
  null::text, 'a blank meta title is stored as null');

-- Saving the same locale twice replaces it rather than failing or duplicating.
select is((select count(*)::int from public.page_translations where page_id = pg_temp.terms()), 1,
  'saving twice leaves one row per locale');

select ok(app_private.cms_page_status_for_staff(pg_temp.author(), true, pg_temp.terms(), 'published'),
  'the written page is published');
select isnt((select published_at from public.pages where id = pg_temp.terms()), null::timestamptz,
  '0030''s trigger set the publication moment');

-- ---------------------------------------------------------------------------------------------------
-- The public reader
-- ---------------------------------------------------------------------------------------------------
select is((select kind from app_private.cms_page_for_public('terms', 'en')), 'page',
  'a published page is public');
select is((select title from app_private.cms_page_for_public('terms', 'en')), 'Terms of Service',
  'the public reader returns the title');
select is((select resolved_locale from app_private.cms_page_for_public('terms', 'en')), 'en',
  'the requested locale is reported when it exists');
select is((select body from app_private.cms_page_for_public('terms', 'en')), 'The English body.',
  'the public reader returns the body');
select is((select is_indexable from app_private.cms_page_for_public('terms', 'en')), true,
  'indexability is reported');
select is((select count(*)::int from app_private.cms_page_for_public('terms', 'en')), 1,
  'the public reader answers with exactly one row');

-- The fallback: Arabic is untranslated, so the English text comes back and says so.
select is((select resolved_locale from app_private.cms_page_for_public('terms', 'ar')), 'en',
  'an untranslated locale falls back to the default and reports it');
select is((select title from app_private.cms_page_for_public('terms', 'ar')), 'Terms of Service',
  'the fallback returns real text rather than an empty page');

-- Once Arabic exists it is preferred over the fallback.
select ok(
  app_private.cms_page_translation_save_for_staff(
    pg_temp.author(), true, pg_temp.terms(), 'ar', 'شروط الخدمة', 'النص العربي.'),
  'the author writes the Arabic locale');
select is((select resolved_locale from app_private.cms_page_for_public('terms', 'ar')), 'ar',
  'the requested locale wins once it exists');
select is((select title from app_private.cms_page_for_public('terms', 'ar')), 'شروط الخدمة',
  'the Arabic title comes back');
select is((select resolved_locale from app_private.cms_page_for_public('terms', 'en')), 'en',
  'the English answer is unchanged by the Arabic one');

-- An unrecognised locale is a representation question, not an error: it resolves to the default.
select is((select resolved_locale from app_private.cms_page_for_public('terms', 'xx')), 'en',
  'an unknown locale resolves to the default');
select is((select resolved_locale from app_private.cms_page_for_public('terms', null)), 'en',
  'a null locale resolves to the default');
select is((select resolved_locale from app_private.cms_page_for_public('terms', '  ')), 'en',
  'a blank locale resolves to the default');

-- Absence, for a slug nobody ever used.
select is((select kind from app_private.cms_page_for_public('never-existed', 'en')), 'not_found',
  'an unknown slug is absence');
select is((select page_id from app_private.cms_page_for_public('never-existed', 'en')), null::uuid,
  'absence carries no identifier');

-- ---------------------------------------------------------------------------------------------------
-- The slug moved
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.cms_page_update_for_staff(
    pg_temp.author(), true, pg_temp.terms(), 'terms-of-service', null, null, null, null),
  'the author renames the page');
select is((select count(*)::int from public.page_slug_history where slug = 'terms'), 1,
  '0030''s slug trigger kept the previous slug');
select is((select kind from app_private.cms_page_for_public('terms', 'en')), 'moved',
  'the previous slug reports that it moved');
select is((select slug from app_private.cms_page_for_public('terms', 'en')), 'terms-of-service',
  'the moved answer carries the current slug');
select is((select title from app_private.cms_page_for_public('terms', 'en')), null::text,
  'the moved answer carries no content: it is a redirect, not a page');
select is((select kind from app_private.cms_page_for_public('terms-of-service', 'en')), 'page',
  'the new slug serves the page');

-- 0030 forbids another page from taking a historical slug, so the moved answer can never be ambiguous.
select throws_ok(
  $q$ select app_private.cms_page_create_for_staff(pg_temp.author(), true, 'terms') $q$,
  '23505', null, 'a historical slug cannot be taken over by a new page');

-- A renamed page that is then unpublished stops redirecting: the history row is still there, but the page it
-- points at is no longer public, so there is nothing to redirect to.
select ok(app_private.cms_page_status_for_staff(pg_temp.author(), true, pg_temp.terms(), 'draft'),
  'the page is returned to draft');
select is((select kind from app_private.cms_page_for_public('terms', 'en')), 'not_found',
  'the previous slug of an unpublished page is absence, not a redirect');
select is((select kind from app_private.cms_page_for_public('terms-of-service', 'en')), 'not_found',
  'an unpublished page is absent under its current slug too');
select ok(app_private.cms_page_status_for_staff(pg_temp.author(), true, pg_temp.terms(), 'published'),
  'the page is published again');

-- ---------------------------------------------------------------------------------------------------
-- A published page keeps at least one locale
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.cms_page_translation_delete_for_staff(pg_temp.author(), true, pg_temp.terms(), 'ar'),
  'one of two locales may be removed from a published page');
select throws_ok(
  $q$ select app_private.cms_page_translation_delete_for_staff(pg_temp.author(), true, pg_temp.terms(), 'en') $q$,
  '23001', null, 'the last locale of a published page may not be removed');
select is((select count(*)::int from public.page_translations where page_id = pg_temp.terms()), 1,
  'the refused removal left the locale in place');

-- A draft may be emptied completely: nothing public depends on it.
select ok(app_private.cms_page_status_for_staff(pg_temp.author(), true, pg_temp.terms(), 'draft'),
  'the page returns to draft');
select ok(app_private.cms_page_translation_delete_for_staff(pg_temp.author(), true, pg_temp.terms(), 'en'),
  'a draft may be emptied');
select is((select count(*)::int from public.page_translations where page_id = pg_temp.terms()), 0,
  'the draft has no locales left');
select ok(
  app_private.cms_page_translation_save_for_staff(pg_temp.author(), true, pg_temp.terms(), 'en', 'Terms', 'Body.'),
  'and may be written again');
select ok(app_private.cms_page_status_for_staff(pg_temp.author(), true, pg_temp.terms(), 'published'),
  'and published again');

-- Removing a locale that is not there is false, not an error.
select ok(not app_private.cms_page_translation_delete_for_staff(pg_temp.author(), true, pg_temp.terms(), 'ar'),
  'removing an absent locale answers false');

-- A page that does not exist answers false rather than raising, so a stale console tab gets a 404.
select ok(
  not app_private.cms_page_update_for_staff(
    pg_temp.author(), true, 'bbbbbbbb-0000-4000-8000-00000000000b', 'x', null, null, null, null),
  'updating a page that does not exist answers false');
select ok(
  not app_private.cms_page_translation_save_for_staff(
    pg_temp.author(), true, 'bbbbbbbb-0000-4000-8000-00000000000b', 'en', 'T', 'B'),
  'writing a locale of a page that does not exist answers false');
select ok(
  not app_private.cms_page_translation_delete_for_staff(
    pg_temp.author(), true, 'bbbbbbbb-0000-4000-8000-00000000000b', 'en'),
  'removing a locale of a page that does not exist answers false');

-- ---------------------------------------------------------------------------------------------------
-- The status writer does not change anything else, and the update writer does not change the status
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.cms_page_update_for_staff(
    pg_temp.author(), true, pg_temp.terms(), null, null, 'help', 42, false),
  'the author changes the template, order and indexability');
select is((select status from public.pages where id = pg_temp.terms()), 'published',
  'an update left the status alone');
select is((select template from public.pages where id = pg_temp.terms()), 'help', 'the template changed');
select is((select sort_order from public.pages where id = pg_temp.terms()), 42, 'the sort order changed');
select is((select is_indexable from public.pages where id = pg_temp.terms()), false, 'indexability changed');
select is((select slug from public.pages where id = pg_temp.terms()), 'terms-of-service',
  'a null slug left the address alone');
select is((select is_indexable from app_private.cms_page_for_public('terms-of-service', 'en')), false,
  'the public reader reports the page as not indexable');

-- An empty page key clears it; a null one leaves it.
select ok(
  app_private.cms_page_update_for_staff(pg_temp.author(), true, pg_temp.terms(), null, '', null, null, null),
  'the author clears the page key');
select is((select page_key from public.pages where id = pg_temp.terms()), null::text, 'the page key is cleared');

-- ---------------------------------------------------------------------------------------------------
-- The staff surfaces
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.cms_pages_for_staff(pg_temp.author(), true, 25)), 1,
  'the author sees the page in the authoring list');
select is((select count(*)::int from app_private.cms_pages_for_staff(pg_temp.nobody(), true, 25)), 0,
  'a caller without the read key sees no pages');
select is((select count(*)::int from app_private.cms_pages_for_staff(pg_temp.author(), false, 25)), 0,
  'the author sees no pages at aal1');
select is((select count(*)::int from app_private.cms_page_for_staff(pg_temp.nobody(), true, pg_temp.terms())), 0,
  'a caller without the read key gets no detail');
select is((select count(*)::int from app_private.cms_page_translations_for_staff(pg_temp.nobody(), true, pg_temp.terms())), 0,
  'a caller without the read key gets no translations');

select is((select can_manage from app_private.cms_page_for_staff(pg_temp.author(), true, pg_temp.terms())), true,
  'the detail reports that this caller may manage the page');
select is((select previous_slugs from app_private.cms_page_for_staff(pg_temp.author(), true, pg_temp.terms())),
  array['terms']::text[], 'the detail lists the previous slug');
select is((select translated_locales from app_private.cms_pages_for_staff(pg_temp.author(), true, 25)),
  array['en']::text[], 'the list reports which locales exist');

-- The status filter compares a parameter, so an unmatched value is an empty page rather than an error.
select is((select count(*)::int from app_private.cms_pages_for_staff(pg_temp.author(), true, 25, 'published')), 1,
  'the status filter matches');
select is((select count(*)::int from app_private.cms_pages_for_staff(pg_temp.author(), true, 25, 'draft')), 0,
  'the status filter excludes');
select is((select count(*)::int from app_private.cms_pages_for_staff(pg_temp.author(), true, 25, 'not-a-status')), 0,
  'an unknown status matches nothing rather than failing');

-- The limit is clamped to at least one, and a null limit takes the default rather than returning nothing.
select is((select count(*)::int from app_private.cms_pages_for_staff(pg_temp.author(), true, 0)), 1,
  'a zero limit is clamped to one row');
select is((select count(*)::int from app_private.cms_pages_for_staff(pg_temp.author(), true, null)), 1,
  'a null limit takes the default');

-- ---------------------------------------------------------------------------------------------------
-- Ordering and the cursor
-- ---------------------------------------------------------------------------------------------------
-- Two more pages, written and published, so the order and the cursor have something to walk. `updated_at` is
-- set by 0030's own trigger from `now()`, which is transaction-stable, so these three rows share a timestamp
-- and the identifier is what breaks the tie — which is exactly the case the cursor's second column exists for.
select lives_ok(
  $q$ select app_private.cms_page_create_for_staff(pg_temp.author(), true, 'privacy') $q$, 'a second page');
select lives_ok(
  $q$ select app_private.cms_page_create_for_staff(pg_temp.author(), true, 'cookies') $q$, 'a third page');

select is((select count(*)::int from app_private.cms_pages_for_staff(pg_temp.author(), true, 25)), 3,
  'all three pages are listed');
select is((select count(*)::int from app_private.cms_pages_for_staff(pg_temp.author(), true, 2)), 2,
  'the limit bounds the page');

-- Walking with the cursor returns the rest and never repeats a row.
create temporary table walk as
  select page_id, updated_at from app_private.cms_pages_for_staff(pg_temp.author(), true, 2);
select is(
  (select count(*)::int from app_private.cms_pages_for_staff(
     pg_temp.author(), true, 25,
     null,
     (select updated_at from walk order by updated_at, page_id limit 1),
     (select page_id from walk order by updated_at, page_id limit 1))),
  1, 'the cursor returns the one row after the second');

select is(
  (select count(*)::int from app_private.cms_pages_for_staff(pg_temp.author(), true, 25, null, now() + interval '1 day', gen_random_uuid())),
  3, 'a cursor in the future returns everything, because the order is descending');

-- A half-supplied cursor is ignored rather than silently dropping rows.
select is((select count(*)::int from app_private.cms_pages_for_staff(pg_temp.author(), true, 25, null, now(), null)), 3,
  'a cursor with no identifier is ignored');
select is((select count(*)::int from app_private.cms_pages_for_staff(pg_temp.author(), true, 25, null, null, gen_random_uuid())), 3,
  'a cursor with no timestamp is ignored');

-- ---------------------------------------------------------------------------------------------------
-- The public index
-- ---------------------------------------------------------------------------------------------------
-- Only the written, published page appears: the two new drafts are absent, and so would a published page with
-- no translation be.
select is((select count(*)::int from app_private.cms_pages_for_public('en')), 1,
  'only the published, written page is in the public index');
select is((select slug from app_private.cms_pages_for_public('en')), 'terms-of-service',
  'the public index names the page by its current slug');
select is((select title from app_private.cms_pages_for_public('en')), 'Terms',
  'the public index carries the title');
select is((select count(*)::int from app_private.cms_pages_for_public('ar')), 1,
  'the public index falls back for an untranslated locale');

-- A page published with no translation at all is absent from both public surfaces: there is nothing to
-- render and nothing to name it with. The status writer refuses to create that state, so it is reached here
-- by writing the row directly — which is what makes it worth asserting.
update public.pages set status = 'published', published_at = now()
 where slug = 'privacy';
select is((select kind from app_private.cms_page_for_public('privacy', 'en')), 'not_found',
  'a published page with no locale is absent by slug');
select is((select count(*)::int from app_private.cms_pages_for_public('en')), 1,
  'and absent from the public index');

-- A publication moment in the future is not yet public, which is 0030's rule rather than this reader's.
update public.pages set published_at = now() + interval '1 day' where slug = 'terms-of-service';
select is((select kind from app_private.cms_page_for_public('terms-of-service', 'en')), 'not_found',
  'a page whose publication moment has not arrived is absent');
select is((select count(*)::int from app_private.cms_pages_for_public('en')), 0,
  'and absent from the public index');

select * from finish();
rollback;
