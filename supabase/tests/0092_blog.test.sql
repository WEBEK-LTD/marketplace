-- 0092 — The blog: the named readers and writers.
--
-- What is proven here, in order: the two permission predicates apply 0003's requires_mfa rule; the public
-- post reader answers with exactly one of three kinds and treats every non-public state as absence; the slug
-- history produces a `moved` answer and 0030's permanence rule still forbids a second post from taking a
-- retired slug; the locale fallback returns real text and reports which language it returned; the index is
-- newest-published-first and `is_featured` does not reorder it; the taxonomy filters are comparisons, so a
-- deactivated or unknown slug is an empty page rather than an error; the staff surfaces return nothing at all
-- to a caller without the read key; every writer refuses a caller without the manage key with 42501; a post
-- cannot be published before it is written, nor stripped of its last locale while published; the featured
-- flag is cleared by a state that cannot own it; and both owner decisions for this increment hold — the blog
-- is absent from the sitemap contract, and `seo_metadata` does not override a blog post.

-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(330);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'blog_can_read', array['uuid', 'boolean'], 'the read predicate exists');
select has_function('app_private', 'blog_can_manage', array['uuid', 'boolean'], 'the manage predicate exists');
select has_function('app_private', 'blog_post_for_public', array['text', 'text'], 'the public post reader exists');
select has_function('app_private', 'blog_posts_for_public',
  array['text', 'text', 'text', 'integer', 'timestamptz', 'uuid'], 'the public index exists');
select has_function('app_private', 'blog_taxonomy_for_public', array['text'], 'the public taxonomy exists');
select has_function('app_private', 'blog_posts_for_staff',
  array['uuid', 'boolean', 'integer', 'text', 'text', 'uuid', 'timestamptz', 'uuid'], 'the staff list exists');
select has_function('app_private', 'blog_post_for_staff', array['uuid', 'boolean', 'uuid'],
  'the staff detail exists');
select has_function('app_private', 'blog_post_translations_for_staff', array['uuid', 'boolean', 'uuid'],
  'the staff translation reader exists');
select has_function('app_private', 'blog_categories_for_staff', array['uuid', 'boolean'],
  'the staff category reader exists');
select has_function('app_private', 'blog_tags_for_staff', array['uuid', 'boolean'],
  'the staff tag reader exists');
select has_function('app_private', 'blog_post_create_for_staff',
  array['uuid', 'boolean', 'text', 'uuid', 'boolean'], 'the create writer exists');
select has_function('app_private', 'blog_post_update_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'uuid', 'boolean', 'uuid', 'boolean', 'boolean', 'boolean'],
  'the update writer exists');
select has_function('app_private', 'blog_post_status_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'timestamptz'], 'the status writer exists');
select has_function('app_private', 'blog_post_translation_save_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'text', 'text', 'text', 'text'],
  'the translation writer exists');
select has_function('app_private', 'blog_post_translation_delete_for_staff',
  array['uuid', 'boolean', 'uuid', 'text'], 'the translation remover exists');
select has_function('app_private', 'blog_post_tags_set_for_staff', array['uuid', 'boolean', 'uuid', 'uuid[]'],
  'the tag writer exists');
select has_function('app_private', 'blog_category_save_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'text', 'text', 'text', 'integer', 'boolean'],
  'the category writer exists');
select has_function('app_private', 'blog_tag_save_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'text', 'boolean'], 'the tag taxonomy writer exists');

-- Every one is a definer function with a pinned search path, like everything else app_system may call.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'blog%' and p.prosecdef),
  18, 'all eighteen are security definer');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'blog%'
      and p.proconfig @> array['search_path=pg_catalog, public']),
  18, 'all eighteen pin search_path to pg_catalog, public');

-- No function from this migration announces itself to the audit actor channel, which 8-B owns.
select is((select count(*)::int from public.audit_attribution_problems()), 0,
  '0092 adds no audit attribution problem');

-- The three-answer contract is in the result type, so a caller cannot forget to branch on it.
select matches(pg_get_function_result(p.oid), 'kind text', 'the public reader returns a kind column')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'blog_post_for_public';

select matches(pg_get_function_result(p.oid), 'resolved_locale text',
  'the public reader reports which locale it returned')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'blog_post_for_public';

select matches(pg_get_function_result(p.oid), 'can_manage boolean',
  'the staff detail reports the manage capability')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'blog_post_for_staff';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select ok(has_function_privilege('app_system', p.oid, 'execute'),
    format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname like 'blog%'
 order by p.proname;

select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
    format('%s may not execute %s', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_worker')) as r(rolname)
 where n.nspname = 'app_private' and p.proname like 'blog%'
 order by r.rolname, p.proname;

-- ---------------------------------------------------------------------------------------------------
-- Nothing in 0030 was changed
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'blog_categories', 'the category table is untouched');
select has_table('public', 'blog_tags', 'the tag table is untouched');
select has_table('public', 'blog_posts', 'the post table is untouched');
select has_table('public', 'blog_post_slug_history', 'the slug history is untouched');
select has_table('public', 'blog_post_translations', 'the translation table is untouched');
select has_table('public', 'blog_post_tags', 'the post-tag table is untouched');
select has_function('public', 'cms_content_is_public', array['text', 'timestamptz'],
  '0030''s publication rule is untouched');
select has_function('app_private', 'publish_due_content', array[]::text[],
  '0030''s scheduled publisher is untouched, and already moves blog posts');
select ok(
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'blog_posts' and not t.tgisinternal) >= 5,
  '0030''s five blog_posts triggers are still installed');

-- ---------------------------------------------------------------------------------------------------
-- Owner decision A — the blog's sitemap entry was 0092's to defer and 0097's to add
-- ---------------------------------------------------------------------------------------------------
-- 0092 took no sitemap entry for the blog and said so: *"Sitemap inclusion for the blog is a separate future
-- increment."* **0097 is that increment**, by owner decision, so the guard that 0092 did not quietly take one is
-- replaced by the guard that 0097 took exactly one and nothing more.
--
-- What is asserted now: the blog has **one** kind, named `blog_post`; the five kinds 0086 declared are all still
-- there; and no second blog kind appeared with it — owner decision 6 keeps a blog category and a blog tag as
-- filters on the index rather than addresses of their own. 0097's own suite proves each of 0086's five still
-- answers exactly what it answered.
select is(
  (select count(*)::int from app_private.public_sitemap_counts()),
  6, 'the sitemap declares six kinds: 0086''s five, and the blog');
select is(
  (select array_agg(entry_type order by entry_type) from app_private.public_sitemap_counts()
    where entry_type like '%blog%'),
  array['blog_post'],
  'exactly one of them names the blog, and it is the post (owner decision 6)');
select is(
  (select array_agg(entry_type order by entry_type) from app_private.public_sitemap_counts()),
  array['blog_post', 'category', 'listing', 'page', 'seller', 'service'],
  'and the five kinds 0086 declared are all still declared');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- An author who holds both keys through the admin role (0033 grants both to admin and super_admin, and both
-- roles require MFA), and a signed-in person who holds neither.
insert into auth.users (id, email) values
  ('aabb0000-0000-4000-8000-000000000001', 'blog-author@example.test'),
  ('aabb0000-0000-4000-8000-000000000002', 'blog-nobody@example.test');
insert into public.user_roles (user_id, role_key) values
  ('aabb0000-0000-4000-8000-000000000001', 'admin');

create function pg_temp.author() returns uuid language sql immutable as
  $f$ select 'aabb0000-0000-4000-8000-000000000001'::uuid $f$;
create function pg_temp.nobody() returns uuid language sql immutable as
  $f$ select 'aabb0000-0000-4000-8000-000000000002'::uuid $f$;

insert into public.cms_media (id, object_path, mime_type, byte_size) values
  ('aabb0000-0000-4000-8000-0000000000c1', 'cms-media/blog/cover.png', 'image/png', 2048);

-- ---------------------------------------------------------------------------------------------------
-- The permission predicates
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.blog_can_read(pg_temp.author(), true), 'the author may read at aal2');
select ok(app_private.blog_can_manage(pg_temp.author(), true), 'the author may manage at aal2');
-- The admin role requires MFA, so 0003's own rule withholds both keys at aal1. Nothing here re-implements
-- that rule; the predicate passes the assurance level in and the rule decides.
select ok(not app_private.blog_can_read(pg_temp.author(), false), 'the author reads nothing at aal1');
select ok(not app_private.blog_can_manage(pg_temp.author(), false), 'the author manages nothing at aal1');
select ok(not app_private.blog_can_read(pg_temp.nobody(), true), 'a person without the role may not read');
select ok(not app_private.blog_can_manage(pg_temp.nobody(), true), 'a person without the role may not manage');
select ok(not app_private.blog_can_read(null, true), 'a null account holds nothing');
select ok(not app_private.blog_can_manage(null, true), 'a null account manages nothing');

-- A revoked role grants nothing, which is the user_roles rule rather than this function's.
insert into public.user_roles (user_id, role_key, revoked_at)
values (pg_temp.nobody(), 'super_admin', now());
select ok(not app_private.blog_can_read(pg_temp.nobody(), true), 'a revoked role grants no read');
delete from public.user_roles where user_id = pg_temp.nobody();

-- ---------------------------------------------------------------------------------------------------
-- The taxonomy writers
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.blog_category_save_for_staff(%L, true, null, 'news', 'News') $q$, pg_temp.nobody()),
  '42501', null, 'a caller without the manage key cannot save a category');
select throws_ok(
  format($q$ select app_private.blog_tag_save_for_staff(%L, true, null, 'tips', 'Tips') $q$, pg_temp.nobody()),
  '42501', null, 'a caller without the manage key cannot save a tag');

create temporary table fixture_ids as
select
  app_private.blog_category_save_for_staff(
    pg_temp.author(), true, null, 'news', 'News', 'أخبار', 'Marketplace news', null, 10, true) as news_id,
  app_private.blog_category_save_for_staff(
    pg_temp.author(), true, null, 'guides', 'Guides', null, null, null, 20, true) as guides_id,
  app_private.blog_category_save_for_staff(
    pg_temp.author(), true, null, 'retired', 'Retired', null, null, null, 30, false) as retired_id,
  app_private.blog_tag_save_for_staff(pg_temp.author(), true, null, 'shipping', 'Shipping', 'الشحن', true)
    as shipping_id,
  app_private.blog_tag_save_for_staff(pg_temp.author(), true, null, 'pricing', 'Pricing', null, true)
    as pricing_id,
  app_private.blog_tag_save_for_staff(pg_temp.author(), true, null, 'stale', 'Stale', null, false)
    as stale_id;

create function pg_temp.news() returns uuid language sql stable as $f$ select news_id from fixture_ids $f$;
create function pg_temp.guides() returns uuid language sql stable as $f$ select guides_id from fixture_ids $f$;
create function pg_temp.retired() returns uuid language sql stable as $f$ select retired_id from fixture_ids $f$;
create function pg_temp.shipping() returns uuid language sql stable as
  $f$ select shipping_id from fixture_ids $f$;
create function pg_temp.pricing() returns uuid language sql stable as $f$ select pricing_id from fixture_ids $f$;
create function pg_temp.stale() returns uuid language sql stable as $f$ select stale_id from fixture_ids $f$;

select isnt(pg_temp.news(), null, 'saving a new category returns its identifier');
select is((select name_ar from public.blog_categories where id = pg_temp.news()), 'أخبار',
  'the Arabic name is stored as written');
select is((select name_ar from public.blog_categories where id = pg_temp.guides()), null,
  'an absent Arabic name is stored as null, which D7 allows');
select is((select is_active from public.blog_categories where id = pg_temp.retired()), false,
  'a category can be created deactivated');

-- Replacing by id updates in place and returns the same identifier.
select is(
  app_private.blog_category_save_for_staff(pg_temp.author(), true, pg_temp.guides(), null, 'Guides & Howtos'),
  pg_temp.guides(), 'saving an existing category returns the same identifier');
select is((select name_en from public.blog_categories where id = pg_temp.guides()), 'Guides & Howtos',
  'the English name was replaced');
select is((select sort_order from public.blog_categories where id = pg_temp.guides()), 20,
  'a null sort order left the stored one alone');
-- Omitting an argument on the replace path must leave the stored value alone. A parameter default is
-- substituted before the body runs, so a default of 0 or true here would silently reset a category's order
-- and reactivate it every time somebody corrected its name.
select is((select is_active from public.blog_categories where id = pg_temp.retired()), false,
  'and a null is_active left the deactivated category deactivated');
select lives_ok(
  format($q$ select app_private.blog_category_save_for_staff(%L, true, %L, null, 'Retired, renamed') $q$,
    pg_temp.author(), pg_temp.retired()),
  'renaming a deactivated category');
select is((select is_active from public.blog_categories where id = pg_temp.retired()), false,
  'does not reactivate it');
select is((select sort_order from public.blog_categories where id = pg_temp.retired()), 30,
  'nor move it in the order');
select lives_ok(
  format($q$ select app_private.blog_tag_save_for_staff(%L, true, %L, null, 'Stale, renamed') $q$,
    pg_temp.author(), pg_temp.stale()),
  'renaming a deactivated tag');
select is((select is_active from public.blog_tags where id = pg_temp.stale()), false,
  'does not reactivate it either');

select is(
  app_private.blog_category_save_for_staff(
    pg_temp.author(), true, 'aabb0000-0000-4000-8000-00000000dead', null, 'Nothing'),
  null, 'saving a category that does not exist returns null rather than creating one');
select is(
  app_private.blog_tag_save_for_staff(
    pg_temp.author(), true, 'aabb0000-0000-4000-8000-00000000dead', null, 'Nothing'),
  null, 'saving a tag that does not exist returns null rather than creating one');

-- 0030's own constraints, not restated by the writer.
select throws_ok(
  format($q$ select app_private.blog_category_save_for_staff(%L, true, null, 'Not A Slug', 'Bad') $q$,
    pg_temp.author()),
  '23514', null, 'the category slug format is 0030''s constraint and raises there');
select throws_ok(
  format($q$ select app_private.blog_tag_save_for_staff(%L, true, null, 'tips', %L) $q$,
    pg_temp.author(), repeat('x', 61)),
  '23514', null, 'the tag name length is 0030''s constraint and raises there');
select throws_ok(
  format($q$ select app_private.blog_category_save_for_staff(%L, true, null, 'news', 'Duplicate') $q$,
    pg_temp.author()),
  '23505', null, 'a duplicate category slug raises 0030''s unique index');

-- ---------------------------------------------------------------------------------------------------
-- Creating a post
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.blog_post_create_for_staff(%L, true, 'a-post') $q$, pg_temp.nobody()),
  '42501', null, 'a caller without the manage key cannot create a post');
select throws_ok(
  format($q$ select app_private.blog_post_create_for_staff(%L, false, 'a-post') $q$, pg_temp.author()),
  '42501', null, 'the author cannot create a post at aal1');

create temporary table post_ids as
select
  app_private.blog_post_create_for_staff(pg_temp.author(), true, 'first-post', pg_temp.news(), true) as first_id,
  app_private.blog_post_create_for_staff(pg_temp.author(), true, 'second-post', pg_temp.news(), true)
    as second_id,
  app_private.blog_post_create_for_staff(pg_temp.author(), true, 'draft-post', pg_temp.guides(), true)
    as draft_id,
  app_private.blog_post_create_for_staff(pg_temp.author(), true, 'hidden-post', null, false) as hidden_id;

create function pg_temp.first() returns uuid language sql stable as $f$ select first_id from post_ids $f$;
create function pg_temp.second() returns uuid language sql stable as $f$ select second_id from post_ids $f$;
create function pg_temp.draft() returns uuid language sql stable as $f$ select draft_id from post_ids $f$;
create function pg_temp.hidden() returns uuid language sql stable as $f$ select hidden_id from post_ids $f$;

select is((select status from public.blog_posts where id = pg_temp.first()), 'draft',
  'a new post is a draft');
select is((select is_featured from public.blog_posts where id = pg_temp.first()), false,
  'a new post is never featured');
select is((select author_user_id from public.blog_posts where id = pg_temp.first()), pg_temp.author(),
  'the creating staff member is the byline');
select is((select created_by from public.blog_posts where id = pg_temp.first()), pg_temp.author(),
  'the creating staff member is recorded in created_by');
select is((select updated_by from public.blog_posts where id = pg_temp.first()), pg_temp.author(),
  'and in updated_by');
select is((select published_at from public.blog_posts where id = pg_temp.first()), null,
  'a draft has no publication moment');
select throws_ok(
  format($q$ select app_private.blog_post_create_for_staff(%L, true, 'first-post') $q$, pg_temp.author()),
  '23505', null, 'a duplicate post slug raises 0030''s unique index');

-- ---------------------------------------------------------------------------------------------------
-- Publication requires text, in either direction
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.blog_post_status_for_staff(%L, true, %L, 'published') $q$,
    pg_temp.author(), pg_temp.first()),
  '23001', null, 'a post cannot be published before it has been written');
select throws_ok(
  format($q$ select app_private.blog_post_status_for_staff(%L, true, %L, 'scheduled', now() + interval '1 day') $q$,
    pg_temp.author(), pg_temp.first()),
  '23001', null, 'nor scheduled');
select throws_ok(
  format($q$ select app_private.blog_post_translation_save_for_staff(%L, true, %L, 'en', 'T', 'B') $q$,
    pg_temp.nobody(), pg_temp.first()),
  '42501', null, 'a caller without the manage key cannot write a translation');

select ok(
  app_private.blog_post_translation_save_for_staff(
    pg_temp.author(), true, pg_temp.first(), 'en', 'The First Post', 'English body.', 'A short excerpt.',
    'First Post | Meta', 'The meta description of the first post.'),
  'the author writes the English text');
select ok(
  app_private.blog_post_translation_save_for_staff(
    pg_temp.author(), true, pg_temp.first(), 'ar', 'المقال الأول', 'نص عربي.'),
  'and the Arabic text');
select ok(
  not app_private.blog_post_translation_save_for_staff(
    pg_temp.author(), true, 'aabb0000-0000-4000-8000-00000000dead', 'en', 'T', 'B'),
  'writing a translation for a post that does not exist answers false rather than raising');

select is((select meta_title from public.blog_post_translations
            where blog_post_id = pg_temp.first() and locale_code = 'en'), 'First Post | Meta',
  'the meta title is stored on the translation, which decision B makes the only source of the head');
select is((select meta_title from public.blog_post_translations
            where blog_post_id = pg_temp.first() and locale_code = 'ar'), null,
  'an omitted meta title is stored as null rather than as an empty string');
select throws_ok(
  format($q$ select app_private.blog_post_translation_save_for_staff(%L, true, %L, 'en', 'T', 'B', null, %L) $q$,
    pg_temp.author(), pg_temp.first(), repeat('x', 71)),
  '23514', null, 'the meta title length is 0030''s constraint and raises there');
select throws_ok(
  format($q$ select app_private.blog_post_translation_save_for_staff(%L, true, %L, 'en', '', 'B') $q$,
    pg_temp.author(), pg_temp.first()),
  '23514', null, 'an empty title raises 0030''s constraint');

select lives_ok(
  format($q$ select app_private.blog_post_status_for_staff(%L, true, %L, 'published') $q$,
    pg_temp.author(), pg_temp.first()),
  'a written post can be published');
select ok((select published_at is not null from public.blog_posts where id = pg_temp.first()),
  '0030''s trigger set the publication moment, not this writer');

-- ---------------------------------------------------------------------------------------------------
-- The public post reader
-- ---------------------------------------------------------------------------------------------------
select is((select kind from app_private.blog_post_for_public('first-post', 'en')), 'post',
  'a published post is served');
select is((select title from app_private.blog_post_for_public('first-post', 'en')), 'The First Post',
  'with the requested locale''s title');
select is((select resolved_locale from app_private.blog_post_for_public('first-post', 'en')), 'en',
  'and reports which locale that was');
select is((select title from app_private.blog_post_for_public('first-post', 'ar')), 'المقال الأول',
  'the Arabic request gets the Arabic text');
select is((select resolved_locale from app_private.blog_post_for_public('first-post', 'ar')), 'ar',
  'and says so');
select is((select category_slug from app_private.blog_post_for_public('first-post', 'en')), 'news',
  'the category slug comes with the post');
select is((select category_name from app_private.blog_post_for_public('first-post', 'en')), 'News',
  'named in English for an English request');
select is((select category_name from app_private.blog_post_for_public('first-post', 'ar')), 'أخبار',
  'and in Arabic for an Arabic one');
select is((select meta_description from app_private.blog_post_for_public('first-post', 'en')),
  'The meta description of the first post.',
  'the post''s own meta description is what the head will use');
select is((select cover_object_path from app_private.blog_post_for_public('first-post', 'en')), null,
  'a post with no cover reports none');

-- An unknown locale is a representation question, not an error: the default locale answers.
select is((select resolved_locale from app_private.blog_post_for_public('first-post', 'xx')), 'en',
  'an unrecognised locale falls back to the default');
select is((select resolved_locale from app_private.blog_post_for_public('first-post', '')), 'en',
  'and so does an empty one');

-- Tags: two arrays built in one pass, so the pairing cannot drift.
select ok(
  app_private.blog_post_tags_set_for_staff(
    pg_temp.author(), true, pg_temp.first(), array[pg_temp.shipping(), pg_temp.pricing()]),
  'the author sets the post''s tags');
select is((select tag_slugs from app_private.blog_post_for_public('first-post', 'en')),
  array['pricing', 'shipping'], 'the public post carries its tag slugs, ordered');
select is((select tag_names from app_private.blog_post_for_public('first-post', 'en')),
  array['Pricing', 'Shipping'], 'and their English names in the same order');
select is((select tag_names from app_private.blog_post_for_public('first-post', 'ar')),
  array['Pricing', 'الشحن'],
  'an Arabic request gets the Arabic name where there is one and the English where there is not');

-- A deactivated tag is not served, though the row stays.
select ok(
  app_private.blog_post_tags_set_for_staff(
    pg_temp.author(), true, pg_temp.first(), array[pg_temp.shipping(), pg_temp.pricing(), pg_temp.stale()]),
  'a deactivated tag can still be attached');
select is((select tag_slugs from app_private.blog_post_for_public('first-post', 'en')),
  array['pricing', 'shipping'], 'but it is not served to the public');
select is(
  (select count(*)::int from public.blog_post_tags where blog_post_id = pg_temp.first()),
  3, 'all three rows are stored, so reactivating the tag restores it');

select throws_ok(
  format($q$ select app_private.blog_post_tags_set_for_staff(%L, true, %L, array['aabb0000-0000-4000-8000-00000000dead'::uuid]) $q$,
    pg_temp.author(), pg_temp.first()),
  '23503', null, 'an unknown tag raises 0030''s foreign key rather than being silently dropped');
select ok(
  app_private.blog_post_tags_set_for_staff(
    pg_temp.author(), true, pg_temp.first(), array[pg_temp.shipping(), pg_temp.shipping()]),
  'a duplicate in the argument is harmless');
select is(
  (select count(*)::int from public.blog_post_tags where blog_post_id = pg_temp.first()),
  1, 'and the set is exactly what was sent');
select ok(
  not app_private.blog_post_tags_set_for_staff(
    pg_temp.author(), true, 'aabb0000-0000-4000-8000-00000000dead', array[]::uuid[]),
  'setting tags on a post that does not exist answers false');
select throws_ok(
  format($q$ select app_private.blog_post_tags_set_for_staff(%L, true, %L, array[]::uuid[]) $q$,
    pg_temp.nobody(), pg_temp.first()),
  '42501', null, 'a caller without the manage key cannot set tags');

-- Every non-public state is absence, and they are indistinguishable from a slug that never existed.
select is((select kind from app_private.blog_post_for_public('draft-post', 'en')), 'not_found',
  'a draft is absence');
select is((select kind from app_private.blog_post_for_public('never-existed', 'en')), 'not_found',
  'and so is a slug that never existed');
select is((select post_id from app_private.blog_post_for_public('draft-post', 'en')), null,
  'absence carries no identifier');

select lives_ok(
  format($q$ select app_private.blog_post_translation_save_for_staff(%L, true, %L, 'en', 'Second', 'Body.') $q$,
    pg_temp.author(), pg_temp.second()),
  'the second post is written');
select lives_ok(
  format($q$ select app_private.blog_post_status_for_staff(%L, true, %L, 'scheduled', now() + interval '1 day') $q$,
    pg_temp.author(), pg_temp.second()),
  'and scheduled for tomorrow');
select is((select kind from app_private.blog_post_for_public('second-post', 'en')), 'not_found',
  'a scheduled post is absence until its moment arrives');
select lives_ok(
  format($q$ select app_private.blog_post_status_for_staff(%L, true, %L, 'published') $q$,
    pg_temp.author(), pg_temp.second()),
  'publishing it now');
select is((select kind from app_private.blog_post_for_public('second-post', 'en')), 'post',
  'and it is served');
select is((select scheduled_for from public.blog_posts where id = pg_temp.second()), null,
  'the schedule it no longer has was cleared');

select lives_ok(
  format($q$ select app_private.blog_post_status_for_staff(%L, true, %L, 'archived') $q$,
    pg_temp.author(), pg_temp.second()),
  'archiving it');
select is((select kind from app_private.blog_post_for_public('second-post', 'en')), 'not_found',
  'an archived post is absence');
select ok((select archived_at is not null from public.blog_posts where id = pg_temp.second()),
  '0030''s trigger set the archive moment');

-- A published post whose publication moment is in the future is not public either, which is the predicate's
-- own rule rather than a status check.
update public.blog_posts set published_at = now() + interval '1 hour' where id = pg_temp.first();
select is((select kind from app_private.blog_post_for_public('first-post', 'en')), 'not_found',
  'a future publication moment is absence, which is cms_content_is_public''s own rule');
update public.blog_posts set published_at = now() - interval '1 hour' where id = pg_temp.first();
select is((select kind from app_private.blog_post_for_public('first-post', 'en')), 'post',
  'and a past one is not');

-- A published post nobody has written is absence rather than an empty page.
select lives_ok(
  format($q$ update public.blog_posts set status = 'published', published_at = now() where id = %L $q$,
    pg_temp.hidden()),
  'a post is published behind the writer''s back, which only a fixture can do');
select is((select kind from app_private.blog_post_for_public('hidden-post', 'en')), 'not_found',
  'a published post with no translation at all is absence, not an empty page');

-- ---------------------------------------------------------------------------------------------------
-- The slug history and its permanence
-- ---------------------------------------------------------------------------------------------------
select lives_ok(
  format($q$ select app_private.blog_post_update_for_staff(%L, true, %L, 'first-post-renamed', null, false, null, false, null, null) $q$,
    pg_temp.author(), pg_temp.first()),
  'the first post is renamed');
select is((select slug from public.blog_posts where id = pg_temp.first()), 'first-post-renamed',
  'the new slug is stored');
select is((select kind from app_private.blog_post_for_public('first-post', 'en')), 'moved',
  'the old slug now answers moved');
select is((select slug from app_private.blog_post_for_public('first-post', 'en')), 'first-post-renamed',
  'and names where it moved to');
select is((select kind from app_private.blog_post_for_public('first-post-renamed', 'en')), 'post',
  'the new slug serves the post');
select is((select post_id from app_private.blog_post_for_public('first-post', 'en')), null,
  'a moved answer carries no post, so a caller must redirect rather than render');

-- 0030's rule, not this migration's: a retired slug can never be taken by another post, so the `moved`
-- answer is never ambiguous.
select throws_ok(
  format($q$ select app_private.blog_post_create_for_staff(%L, true, 'first-post') $q$, pg_temp.author()),
  '23505', null, 'another post cannot take a retired slug');
select throws_ok(
  format($q$ select app_private.blog_post_update_for_staff(%L, true, %L, 'first-post', null, false, null, false, null, null) $q$,
    pg_temp.author(), pg_temp.draft()),
  '23505', null, 'nor can an existing post be renamed onto one');

-- An archived post's retired slug is not a public redirect: the destination is not public either.
select lives_ok(
  format($q$ select app_private.blog_post_update_for_staff(%L, true, %L, 'second-post-renamed', null, false, null, false, null, null) $q$,
    pg_temp.author(), pg_temp.second()),
  'the archived post is renamed too');
select is((select kind from app_private.blog_post_for_public('second-post', 'en')), 'not_found',
  'a retired slug whose post is archived is absence, not a redirect to a 404');

-- ---------------------------------------------------------------------------------------------------
-- The update writer
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.blog_post_update_for_staff(%L, true, %L, 'x', null, false, null, false, null, null) $q$,
    pg_temp.nobody(), pg_temp.first()),
  '42501', null, 'a caller without the manage key cannot update a post');
select ok(
  not app_private.blog_post_update_for_staff(
    pg_temp.author(), true, 'aabb0000-0000-4000-8000-00000000dead', 'x', null, false, null, false, null, null),
  'updating a post that does not exist answers false');

-- A null leaves a field alone; the explicit flag is what clears a nullable reference.
select lives_ok(
  format($q$ select app_private.blog_post_update_for_staff(%L, true, %L, null, %L, false, %L, false, null, null) $q$,
    pg_temp.author(), pg_temp.first(), pg_temp.guides(), 'aabb0000-0000-4000-8000-0000000000c1'),
  'the category and the cover are set');
select is((select blog_category_id from public.blog_posts where id = pg_temp.first()), pg_temp.guides(),
  'the category moved');
select is((select slug from public.blog_posts where id = pg_temp.first()), 'first-post-renamed',
  'and a null slug left the address alone');
select is((select cover_object_path from app_private.blog_post_for_public('first-post-renamed', 'en')),
  'cms-media/blog/cover.png', 'the cover is served with the post');
select lives_ok(
  format($q$ select app_private.blog_post_update_for_staff(%L, true, %L, null, null, true, null, true, null, null) $q$,
    pg_temp.author(), pg_temp.first()),
  'both references are cleared');
select is((select blog_category_id from public.blog_posts where id = pg_temp.first()), null,
  'the category was cleared by its own flag');
select is((select cover_media_id from public.blog_posts where id = pg_temp.first()), null,
  'and so was the cover');
select is((select category_slug from app_private.blog_post_for_public('first-post-renamed', 'en')), null,
  'an uncategorised post is still served');

-- An update cannot change the status, which is what keeps a rename from publishing anything.
select is((select status from public.blog_posts where id = pg_temp.draft()), 'draft',
  'the draft post is still a draft after every update above');

-- ---------------------------------------------------------------------------------------------------
-- The featured flag belongs to the published state
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.blog_post_update_for_staff(%L, true, %L, null, null, false, null, false, null, true) $q$,
    pg_temp.author(), pg_temp.draft()),
  '23514', null, 'a draft cannot be featured, which is 0030''s own constraint');
select lives_ok(
  format($q$ select app_private.blog_post_update_for_staff(%L, true, %L, null, null, false, null, false, null, true) $q$,
    pg_temp.author(), pg_temp.first()),
  'a published post can be featured');
select is((select is_featured from public.blog_posts where id = pg_temp.first()), true,
  'and the flag is stored');
select is((select is_featured from app_private.blog_post_for_public('first-post-renamed', 'en')), true,
  'the public post reports it');
-- Leaving the published state clears it rather than colliding with the constraint — the same mechanical
-- clearing the pages writer does with `scheduled_for`.
select lives_ok(
  format($q$ select app_private.blog_post_status_for_staff(%L, true, %L, 'draft') $q$,
    pg_temp.author(), pg_temp.first()),
  'a featured post can be unpublished without a second call');
select is((select is_featured from public.blog_posts where id = pg_temp.first()), false,
  'and the featured flag a draft cannot own was cleared');
select lives_ok(
  format($q$ select app_private.blog_post_status_for_staff(%L, true, %L, 'published') $q$,
    pg_temp.author(), pg_temp.first()),
  'and it can go back');
select is((select is_featured from public.blog_posts where id = pg_temp.first()), false,
  'returning to published does not restore a flag nobody set again');

select throws_ok(
  format($q$ select app_private.blog_post_status_for_staff(%L, true, %L, 'nonsense') $q$,
    pg_temp.author(), pg_temp.first()),
  '23514', null, 'an unknown status raises 0030''s own constraint');
select throws_ok(
  format($q$ select app_private.blog_post_status_for_staff(%L, true, %L, 'published') $q$,
    pg_temp.nobody(), pg_temp.first()),
  '42501', null, 'a caller without the manage key cannot change a status');
select ok(
  not app_private.blog_post_status_for_staff(
    pg_temp.author(), true, 'aabb0000-0000-4000-8000-00000000dead', 'draft'),
  'changing the status of a post that does not exist answers false');

-- ---------------------------------------------------------------------------------------------------
-- The public index
-- ---------------------------------------------------------------------------------------------------
-- Three published posts with distinct moments, so the order is unambiguous.
select lives_ok(
  format($q$ select app_private.blog_post_translation_save_for_staff(%L, true, %L, 'en', 'Third', 'Body.') $q$,
    pg_temp.author(), pg_temp.draft()),
  'the third post is written');
select lives_ok(
  format($q$ select app_private.blog_post_status_for_staff(%L, true, %L, 'published') $q$,
    pg_temp.author(), pg_temp.draft()),
  'and published');
update public.blog_posts set published_at = now() - interval '3 days' where id = pg_temp.first();
update public.blog_posts set published_at = now() - interval '1 day' where id = pg_temp.draft();
select lives_ok(
  format($q$ select app_private.blog_post_update_for_staff(%L, true, %L, null, %L, false, null, false, null, null) $q$,
    pg_temp.author(), pg_temp.draft(), pg_temp.news()),
  'the third post is filed under news');

select is((select count(*)::int from app_private.blog_posts_for_public('en')), 2,
  'the index holds exactly the two public posts');
select is(
  (select array_agg(slug order by published_at desc) from app_private.blog_posts_for_public('en')),
  array['draft-post', 'first-post-renamed'], 'newest published first');
select is((select title from app_private.blog_posts_for_public('en') where slug = 'draft-post'), 'Third',
  'each entry carries its own title');
select is((select excerpt from app_private.blog_posts_for_public('en') where slug = 'first-post-renamed'),
  'A short excerpt.', 'and its excerpt, where one was written');
select is((select excerpt from app_private.blog_posts_for_public('en') where slug = 'draft-post'), null,
  'while a post written without one reports none');

-- `is_featured` is reported and does not reorder anything.
select lives_ok(
  format($q$ select app_private.blog_post_update_for_staff(%L, true, %L, null, null, false, null, false, null, true) $q$,
    pg_temp.author(), pg_temp.first()),
  'the older post is featured');
select is(
  (select slug from app_private.blog_posts_for_public('en') limit 1),
  'draft-post', 'featuring a post does not move it to the top: the order is still newest first');
select is((select is_featured from app_private.blog_posts_for_public('en') where slug = 'first-post-renamed'),
  true, 'but the flag is reported so a surface can mark it');

-- Filters are comparisons against an active row.
select is((select count(*)::int from app_private.blog_posts_for_public('en', 'news')), 1,
  'the category filter narrows the index');
select is((select slug from app_private.blog_posts_for_public('en', 'news')), 'draft-post',
  'to the posts in that category');
select is((select count(*)::int from app_private.blog_posts_for_public('en', 'guides')), 0,
  'a category with no public posts is an empty page');
select is((select count(*)::int from app_private.blog_posts_for_public('en', 'retired')), 0,
  'a deactivated category yields an empty page rather than an error');
select is((select count(*)::int from app_private.blog_posts_for_public('en', 'never-existed')), 0,
  'and so does a category that never existed');

select lives_ok(
  format($q$ select app_private.blog_post_tags_set_for_staff(%L, true, %L, array[%L::uuid]) $q$,
    pg_temp.author(), pg_temp.draft(), pg_temp.pricing()),
  'the third post is tagged');
select is((select count(*)::int from app_private.blog_posts_for_public('en', null, 'pricing')), 1,
  'the tag filter narrows the index');
select is((select slug from app_private.blog_posts_for_public('en', null, 'pricing')), 'draft-post',
  'to the posts carrying that tag');
select is((select count(*)::int from app_private.blog_posts_for_public('en', null, 'stale')), 0,
  'a deactivated tag yields an empty page');
select is((select count(*)::int from app_private.blog_posts_for_public('en', 'guides', 'pricing')), 0,
  'the two filters are an intersection, not a union');

-- The keyset cursor walks the same order the index is built for.
select is(
  (select count(*)::int from app_private.blog_posts_for_public('en', null, null, 1)),
  1, 'the limit is honoured');
select is(
  (select slug from app_private.blog_posts_for_public(
     'en', null, null, 10,
     (select published_at from public.blog_posts where id = pg_temp.draft()),
     pg_temp.draft())),
  'first-post-renamed', 'the cursor returns what follows it and never the row it names');
select is(
  (select count(*)::int from app_private.blog_posts_for_public(
     'en', null, null, 10,
     (select published_at from public.blog_posts where id = pg_temp.first()),
     pg_temp.first())),
  0, 'and the last row''s cursor ends the walk');
select is(
  (select count(*)::int from app_private.blog_posts_for_public('en', null, null, 0)),
  1, 'a limit of zero is raised to one rather than returning everything');

-- A public post with no translation at all is absent from the index for the same reason it is absent by slug.
select is((select count(*)::int from app_private.blog_posts_for_public('en') where slug = 'hidden-post'), 0,
  'a published post nobody has written is not in the index');

-- ---------------------------------------------------------------------------------------------------
-- The public taxonomy
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.blog_taxonomy_for_public('en') where entry_type = 'category'),
  2, 'only the active categories are offered');
select is(
  (select count(*)::int from app_private.blog_taxonomy_for_public('en') where entry_type = 'tag'),
  2, 'and only the active tags');
select is(
  (select post_count::int from app_private.blog_taxonomy_for_public('en')
    where entry_type = 'category' and slug = 'news'),
  1, 'a category counts the public posts under it');
select is(
  (select post_count::int from app_private.blog_taxonomy_for_public('en')
    where entry_type = 'category' and slug = 'guides'),
  0, 'a category with none reports zero rather than being absent');
select is(
  (select post_count::int from app_private.blog_taxonomy_for_public('en')
    where entry_type = 'tag' and slug = 'pricing'),
  1, 'a tag counts the public posts carrying it');
select is(
  (select name from app_private.blog_taxonomy_for_public('ar')
    where entry_type = 'category' and slug = 'news'),
  'أخبار', 'the taxonomy is named in the requested locale');
select is(
  (select name from app_private.blog_taxonomy_for_public('ar')
    where entry_type = 'category' and slug = 'guides'),
  'Guides & Howtos', 'and falls back to English where no Arabic name was written');
select is(
  (select array_agg(slug order by sort_order, slug) from app_private.blog_taxonomy_for_public('en')
    where entry_type = 'category'),
  array['news', 'guides'], 'categories carry their own sort order');

-- ---------------------------------------------------------------------------------------------------
-- Removing a translation
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.blog_post_translation_delete_for_staff(%L, true, %L, 'ar') $q$,
    pg_temp.nobody(), pg_temp.first()),
  '42501', null, 'a caller without the manage key cannot remove a translation');
select ok(
  not app_private.blog_post_translation_delete_for_staff(
    pg_temp.author(), true, 'aabb0000-0000-4000-8000-00000000dead', 'en'),
  'removing a translation from a post that does not exist answers false');
select ok(
  not app_private.blog_post_translation_delete_for_staff(pg_temp.author(), true, pg_temp.draft(), 'ar'),
  'removing a locale that was never there answers false rather than raising');
select ok(
  app_private.blog_post_translation_delete_for_staff(pg_temp.author(), true, pg_temp.first(), 'ar'),
  'the Arabic text of a two-locale post can be removed');
select is((select resolved_locale from app_private.blog_post_for_public('first-post-renamed', 'ar')), 'en',
  'and an Arabic request now falls back to the English text');
select throws_ok(
  format($q$ select app_private.blog_post_translation_delete_for_staff(%L, true, %L, 'en') $q$,
    pg_temp.author(), pg_temp.first()),
  '23001', null, 'a published post cannot be stripped of its last locale');
select is((select count(*)::int from public.blog_post_translations where blog_post_id = pg_temp.first()), 1,
  'so the text is still there');

-- A draft may be emptied, because no public URL depends on it.
select lives_ok(
  format($q$ select app_private.blog_post_status_for_staff(%L, true, %L, 'draft') $q$,
    pg_temp.author(), pg_temp.first()),
  'the post is returned to draft');
select ok(
  app_private.blog_post_translation_delete_for_staff(pg_temp.author(), true, pg_temp.first(), 'en'),
  'a draft can be emptied of its last locale');
select is((select count(*)::int from public.blog_post_translations where blog_post_id = pg_temp.first()), 0,
  'and it is');

-- ---------------------------------------------------------------------------------------------------
-- The staff surfaces
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.blog_posts_for_staff(pg_temp.nobody(), true, 50)), 0,
  'a caller without the read key sees no posts at all');
select is((select count(*)::int from app_private.blog_posts_for_staff(pg_temp.author(), false, 50)), 0,
  'and neither does the author at aal1');
select is((select count(*)::int from app_private.blog_posts_for_staff(pg_temp.author(), true, 50)), 4,
  'the author sees every post, whatever its state');
-- Two posts are published at this point: the written one and the one a fixture published behind the
-- writer's back. The staff list shows both, because an authoring list describes what is stored rather than
-- what the public can see.
select is(
  (select count(*)::int from app_private.blog_posts_for_staff(pg_temp.author(), true, 50, 'published')),
  2, 'the status filter narrows the list');
select is(
  (select array_agg(slug order by slug)
     from app_private.blog_posts_for_staff(pg_temp.author(), true, 50, 'published')),
  array['draft-post', 'hidden-post'],
  'including the published post with no text, which the public index omits');
select is(
  (select count(*)::int from app_private.blog_posts_for_staff(pg_temp.author(), true, 50, 'nonsense')),
  0, 'a status nobody uses is an empty list rather than an error');
select is(
  (select count(*)::int
     from app_private.blog_posts_for_staff(pg_temp.author(), true, 50, null, null, pg_temp.news())),
  2, 'the category filter narrows it too');
select is(
  (select array_agg(slug order by slug)
     from app_private.blog_posts_for_staff(pg_temp.author(), true, 50, null, null, pg_temp.news())),
  array['draft-post', 'second-post-renamed'],
  'to every post filed there, archived ones included');
select is(
  (select count(*)::int from app_private.blog_posts_for_staff(pg_temp.author(), true, 50, null, 'Third')),
  1, 'the search finds a post by its title');
select is(
  (select count(*)::int from app_private.blog_posts_for_staff(pg_temp.author(), true, 50, null, 'third')),
  1, 'case does not matter');
select is(
  (select count(*)::int from app_private.blog_posts_for_staff(pg_temp.author(), true, 50, null, 'hidden-post')),
  1, 'and a post with no text at all is still findable by its slug');
select is(
  (select count(*)::int from app_private.blog_posts_for_staff(pg_temp.author(), true, 50, null, '%')),
  0, 'a wildcard is matched literally, because the search is a substring and never a pattern');
select is(
  (select count(*)::int from app_private.blog_posts_for_staff(pg_temp.author(), true, 50, null, '_hird')),
  0, 'and so is a single-character wildcard');
select is(
  (select array_agg(slug order by updated_at desc, post_id desc)
     from app_private.blog_posts_for_staff(pg_temp.author(), true, 50)),
  (select array_agg(slug order by updated_at desc, id desc) from public.blog_posts),
  'the authoring list is ordered by the most recent edit');
select is(
  (select translated_locales from app_private.blog_posts_for_staff(pg_temp.author(), true, 50)
    where slug = 'draft-post'),
  array['en'], 'each row reports which locales exist');
select is(
  (select tag_count from app_private.blog_posts_for_staff(pg_temp.author(), true, 50)
    where slug = 'draft-post'),
  1, 'and how many tags it carries');

select is((select count(*)::int from app_private.blog_post_for_staff(pg_temp.nobody(), true, pg_temp.first())), 0,
  'a caller without the read key gets no detail');
select is(
  (select count(*)::int
     from app_private.blog_post_for_staff(
       pg_temp.author(), true, 'aabb0000-0000-4000-8000-00000000dead')),
  0, 'and a post that does not exist gets none either, so the two are indistinguishable');
select is((select can_manage from app_private.blog_post_for_staff(pg_temp.author(), true, pg_temp.first())),
  true, 'the detail reports the manage capability');
select is(
  (select previous_slugs from app_private.blog_post_for_staff(pg_temp.author(), true, pg_temp.first())),
  array['first-post'], 'and the post''s retired slugs');
select is(
  (select tag_ids from app_private.blog_post_for_staff(pg_temp.author(), true, pg_temp.draft())),
  array[pg_temp.pricing()], 'and its tags');
select is(
  (select author_user_id from app_private.blog_post_for_staff(pg_temp.author(), true, pg_temp.first())),
  pg_temp.author(), 'and its byline');

select is(
  (select count(*)::int
     from app_private.blog_post_translations_for_staff(pg_temp.nobody(), true, pg_temp.draft())),
  0, 'a caller without the read key sees no translations');
select is(
  (select count(*)::int
     from app_private.blog_post_translations_for_staff(pg_temp.author(), true, pg_temp.draft())),
  1, 'the author sees the post''s one locale');
select is(
  (select title from app_private.blog_post_translations_for_staff(pg_temp.author(), true, pg_temp.draft())),
  'Third', 'with its text');

select is((select count(*)::int from app_private.blog_categories_for_staff(pg_temp.nobody(), true)), 0,
  'a caller without the read key sees no categories');
select is((select count(*)::int from app_private.blog_categories_for_staff(pg_temp.author(), true)), 3,
  'the author sees every category, deactivated ones included');
-- The staff count is of every post in the category; the public one counts only what is visible. Both are
-- asserted because the difference is the whole reason the two functions exist.
select is(
  (select post_count::int from app_private.blog_categories_for_staff(pg_temp.author(), true) where slug = 'news'),
  2, 'with how many posts sit in it, published or not');
select is(
  (select post_count::int from app_private.blog_taxonomy_for_public('en')
    where entry_type = 'category' and slug = 'news'),
  1, 'while the public taxonomy counts only the one the public may see');
select is((select count(*)::int from app_private.blog_tags_for_staff(pg_temp.nobody(), true)), 0,
  'a caller without the read key sees no tags');
select is((select count(*)::int from app_private.blog_tags_for_staff(pg_temp.author(), true)), 3,
  'the author sees every tag, deactivated ones included');
select is(
  (select post_count::int from app_private.blog_tags_for_staff(pg_temp.author(), true) where slug = 'pricing'),
  1, 'with how many posts carry it');

-- ---------------------------------------------------------------------------------------------------
-- Owner decision B — seo_metadata does not override a blog post
-- ---------------------------------------------------------------------------------------------------
-- `blog_post` stays an allowed entity type, exactly as 0091 left it, and a stored row for one is simply not
-- read: the head comes from the post's own translation fields. A row is stored here on purpose, so the
-- assertion proves the reader withholds it rather than proving nothing was written.
select is(
  (select count(*)::int from pg_constraint
    where conname = 'seo_metadata_entity_type_allowed'),
  1, '0091''s allowed entity types are untouched');
select lives_ok(
  format($q$ insert into public.seo_metadata (entity_type, entity_id, locale_code, meta_title, canonical_path)
            values ('blog_post', %L, 'en', 'An override nobody reads', '/elsewhere') $q$, pg_temp.draft()),
  'a blog_post metadata row can still be stored, because the entity type is allowed');
select is(
  (select count(*)::int from app_private.public_seo_metadata_for_entity('blog_post', 'draft-post', 'en')),
  0, 'but the public metadata reader returns nothing for a blog post');
select is((select meta_title from app_private.blog_post_for_public('draft-post', 'en')), null,
  'and the post''s head comes from its own translation fields, which are null here');
select lives_ok(
  format($q$ select app_private.blog_post_translation_save_for_staff(%L, true, %L, 'en', 'Third', 'Body.', null, 'The post''s own meta title') $q$,
    pg_temp.author(), pg_temp.draft()),
  'writing the post''s own meta title');
select is((select meta_title from app_private.blog_post_for_public('draft-post', 'en')),
  'The post''s own meta title',
  'which is the one the head uses, never the stored override');

select * from finish();
rollback;
