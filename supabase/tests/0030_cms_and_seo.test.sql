-- pgTAP — migration 0030: CMS content and its publication lifecycle, bilingual translations, the page
-- and post slug histories, SEO metadata and the canonical rule, the redirect map, navigation, and the
-- boundary that keeps a draft out of every public read.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(71);

-- Fixtures ------------------------------------------------------------------------------------------
-- Locales `en` and `ar` are seeded reference data in 0033; this test uses them as they are.
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTS', '963', 'T', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZZ', 'ZZZ', '999', 'Enabled', 'Enabled', '999', 'XTS', true);

insert into auth.users (id, email) values
  ('dddddddd-4444-4444-8444-444444444444', 'editor@example.test');
insert into public.categories (id, slug) values ('11111111-aaaa-4aaa-8aaa-111111111111', 'electronics');

-- Schema ---------------------------------------------------------------------------------------------
select has_table('public', 'pages', 'the pages table exists');
select has_table('public', 'blog_posts', 'the blog posts table exists');
select has_table('public', 'seo_metadata', 'the SEO metadata table exists');
select has_table('public', 'redirects', 'the redirect map exists');
select has_column('public', 'pages', 'is_indexable', 'a page says whether it may be indexed');
select has_column('public', 'seo_metadata', 'canonical_path', 'metadata carries a canonical path, not a URL');

-- The new bucket is private and the 0012 contract still holds --------------------------------------------
select is((select count(*) from public.storage_bucket_problems()), 0::bigint,
  'the CMS bucket is described by the contract, so the storage guard still passes');
select ok(not (select public from storage.buckets where id = 'cms-media'),
  'and the CMS bucket is private: images are served by signed URL, never listed publicly');
select is(
  (select count(*) from storage.buckets where public and id <> 'listing-variants'),
  0::bigint,
  'the approved public bucket is still the only public bucket'
);

-- Publication lifecycle ------------------------------------------------------------------------------------
insert into public.pages (id, slug, page_key, template, created_by)
values ('11111111-cccc-4ccc-8ccc-111111111111', 'about', 'about', 'standard',
        'dddddddd-4444-4444-8444-444444444444');

select is((select status from public.pages), 'draft', 'a page starts as a draft');
select ok(
  not public.cms_content_is_public((select status from public.pages), (select published_at from public.pages)),
  'and a draft is not public'
);
select is((select count(*) from public.outbox_events where aggregate_type = 'page'), 0::bigint,
  'creating a draft announces nothing, because nothing a visitor sees changed');

select throws_ok(
  $$insert into public.pages (slug, status) values ('scheduled-no-time', 'scheduled')$$,
  '23514',
  null,
  'a scheduled page without a moment is refused'
);
select throws_ok(
  $$insert into public.pages (slug, status, published_at) values ('bad-slug--', 'draft', null)$$,
  '23514',
  null,
  'and a slug that is not a slug is refused'
);

update public.pages set status = 'published' where slug = 'about';
select ok((select published_at is not null from public.pages), 'publishing stamps the moment');
select ok(
  public.cms_content_is_public((select status from public.pages), (select published_at from public.pages)),
  'and the page becomes public'
);
select is(
  (select event_type from public.outbox_events where aggregate_type = 'page'),
  'page.visibility_changed',
  'publication is announced through the existing outbox, in the same transaction (C11)'
);
select is(
  (select payload ->> 'is_public' from public.outbox_events where aggregate_type = 'page'),
  'true',
  'and the event says what the public state became'
);

update public.pages set template = 'legal' where slug = 'about';
select is(
  (select count(*) from public.outbox_events where aggregate_type = 'page'),
  1::bigint,
  'an edit that changes nothing a visitor can see announces nothing'
);

select throws_ok(
  $$update public.pages set status = 'scheduled', scheduled_for = now() + interval '1 day' where slug = 'about'$$,
  '23514',
  null,
  'a published page cannot go back to scheduled'
);

-- Scheduled content stays private until its moment, and the cron function moves it ------------------------
insert into public.pages (id, slug, status, scheduled_for)
values ('22222222-cccc-4ccc-8ccc-222222222222', 'launch', 'scheduled', now() - interval '1 hour');
select ok(
  not public.cms_content_is_public(
    (select status from public.pages where slug = 'launch'),
    (select published_at from public.pages where slug = 'launch')),
  'a scheduled page is not public, however near its moment is'
);
select is(app_private.publish_due_content(), 1, 'the scheduled publisher moves exactly the due row');
select is((select status from public.pages where slug = 'launch'), 'published',
  'and the due page is now published');

update public.pages set status = 'archived' where slug = 'launch';
select ok(
  not public.cms_content_is_public(
    (select status from public.pages where slug = 'launch'),
    (select published_at from public.pages where slug = 'launch')),
  'an archived page stops being public even though it keeps its publication date'
);

-- Slug history and the redirect it guarantees -------------------------------------------------------------
update public.pages set slug = 'about-us' where slug = 'about';
select is((select slug from public.page_slug_history), 'about',
  'renaming a page keeps the old slug for its 301');
select throws_ok(
  $$update public.page_slug_history set slug = 'edited'$$,
  '23001',
  null,
  'and slug history is append-only'
);
select throws_ok(
  $$insert into public.pages (slug) values ('about')$$,
  '23505',
  null,
  'a retired slug can never be taken over by another page'
);

-- Bilingual content, with nothing generated ---------------------------------------------------------------
insert into public.page_translations (page_id, locale_code, title, body, meta_title)
values ('11111111-cccc-4ccc-8ccc-111111111111', 'en', 'About us', 'We run a marketplace.', 'About us'),
       ('11111111-cccc-4ccc-8ccc-111111111111', 'ar', 'من نحن', 'نحن ندير سوقًا إلكترونية.', 'من نحن');
select is((select count(*) from public.page_translations), 2::bigint,
  'a page carries one row per locale someone actually wrote');
select ok(
  (select search_vector is not null and search_vector <> ''::tsvector
     from public.page_translations where locale_code = 'en'),
  'the English text is searchable through the existing PostgreSQL search foundation'
);
select ok(
  (select search_vector is not null and search_vector <> ''::tsvector
     from public.page_translations where locale_code = 'ar'),
  'and the Arabic text is indexed with the Arabic configuration, not translated'
);
select is(
  (select count(*) from public.page_translations where locale_code not in ('en', 'ar')),
  0::bigint,
  'no locale gains a row it was never given: nothing is machine translated (D7)'
);
select throws_ok(
  $$insert into public.page_translations (page_id, locale_code, title, body)
    values ('11111111-cccc-4ccc-8ccc-111111111111', 'zz', 'Ghost', 'Ghost')$$,
  '23503',
  null,
  'and a translation can only exist for a locale the platform knows'
);

-- Blog ------------------------------------------------------------------------------------------------------
insert into public.blog_categories (id, slug, name_en, name_ar)
values ('33333333-cccc-4ccc-8ccc-333333333333', 'guides', 'Guides', 'أدلة');
insert into public.blog_posts (id, slug, blog_category_id, author_user_id)
values ('44444444-cccc-4ccc-8ccc-444444444444', 'how-to-sell', '33333333-cccc-4ccc-8ccc-333333333333',
        'dddddddd-4444-4444-8444-444444444444');
select throws_ok(
  $$update public.blog_posts set is_featured = true where slug = 'how-to-sell'$$,
  '23514',
  null,
  'an unpublished post cannot be featured'
);
update public.blog_posts set status = 'published' where slug = 'how-to-sell';
select is(
  (select event_type from public.outbox_events where aggregate_type = 'blog_post'),
  'blog_post.visibility_changed',
  'a post announces its publication the same way a page does'
);
update public.blog_posts set slug = 'how-to-sell-online' where slug = 'how-to-sell';
select is((select slug from public.blog_post_slug_history), 'how-to-sell',
  'and a renamed post keeps its old slug for the 301 too');

-- Canonical handling and URL-injection safety ----------------------------------------------------------------
insert into public.seo_metadata (entity_type, entity_id, locale_code, canonical_path, meta_title)
values ('page', '11111111-cccc-4ccc-8ccc-111111111111', 'en', '/about-us', 'About us');
select is((select canonical_path from public.seo_metadata), '/about-us',
  'a canonical is stored as a path on this site');
select is(
  (select robots_directives from public.seo_metadata),
  array['index', 'follow'],
  'and a page is indexable and followable unless someone says otherwise'
);
select throws_ok(
  $$insert into public.seo_metadata (entity_type, entity_id, locale_code, canonical_path)
    values ('page', '22222222-cccc-4ccc-8ccc-222222222222', 'en', 'https://example.com/about')$$,
  '23514',
  null,
  'an absolute URL can never become a canonical'
);
select throws_ok(
  $$insert into public.seo_metadata (entity_type, entity_id, locale_code, canonical_path)
    values ('page', '22222222-cccc-4ccc-8ccc-222222222222', 'en', '//evil.example/about')$$,
  '23514',
  null,
  'nor can a protocol-relative one'
);
select throws_ok(
  $$insert into public.seo_metadata (entity_type, entity_id, route_path, locale_code)
    values ('page', '22222222-cccc-4ccc-8ccc-222222222222', '/about', 'en')$$,
  '23514',
  null,
  'metadata names either an entity or a route, never both'
);
select throws_ok(
  $$insert into public.seo_metadata (entity_type, locale_code, robots_directives)
    values ('route', 'en', array['index', 'noindex'])$$,
  '23514',
  null,
  'robots directives cannot contradict themselves'
);
select throws_ok(
  $$insert into public.seo_metadata (entity_type, route_path, locale_code, robots_directives)
    values ('route', '/search', 'en', array['follow-me-home'])$$,
  '23514',
  null,
  'and an invented directive is refused'
);
select lives_ok(
  $$insert into public.seo_metadata (entity_type, route_path, locale_code, robots_directives)
    values ('route', '/search', 'en', array['noindex', 'follow'])$$,
  'a static route may carry its own metadata'
);

-- Draft metadata never leaks through the public read -----------------------------------------------------------
insert into public.pages (id, slug) values ('55555555-cccc-4ccc-8ccc-555555555555', 'secret-launch');
insert into public.seo_metadata (entity_type, entity_id, locale_code, meta_title)
values ('page', '55555555-cccc-4ccc-8ccc-555555555555', 'en', 'Secret launch');
select ok(
  not public.seo_metadata_is_public('page', '55555555-cccc-4ccc-8ccc-555555555555'),
  'metadata about a draft page is not public'
);
select ok(
  public.seo_metadata_is_public('page', '11111111-cccc-4ccc-8ccc-111111111111'),
  'metadata about a published page is'
);
select ok(public.seo_metadata_is_public('route', null), 'and a static route is public by definition');
select ok(
  (select pg_get_expr(polqual, polrelid) like '%seo_metadata_is_public%'
     from pg_policy where polname = 'seo_metadata_public_read'),
  'the public metadata policy is the one that asks, so no query can bypass it'
);
select ok(
  (select pg_get_expr(polqual, polrelid) like '%cms_content_is_public%'
     from pg_policy where polname = 'pages_public_read'),
  'and the public page policy is the publication rule itself'
);

-- Redirects ------------------------------------------------------------------------------------------------------
insert into public.redirects (from_path, to_path) values ('/old', '/middle'), ('/middle', '/about-us');
select is((select to_path from public.resolve_redirect('/old')), '/about-us',
  'a redirect chain resolves to where it actually ends');
select is((select status_code from public.resolve_redirect('/old')), 301,
  'and carries the status code of the last hop');
select is((select count(*) from public.resolve_redirect('/nowhere')), 0::bigint,
  'an unknown path resolves to nothing');
update public.redirects set is_active = false where from_path = '/middle';
select is((select to_path from public.resolve_redirect('/old')), '/middle',
  'a disabled entry stops the chain rather than being followed');

insert into public.redirects (from_path, to_path) values ('/loop-a', '/loop-b'), ('/loop-b', '/loop-a');
select is((select count(*) from public.resolve_redirect('/loop-a')), 1::bigint,
  'a cycle terminates instead of spinning');

select throws_ok(
  $$insert into public.redirects (from_path, to_path) values ('/off', 'https://example.com/')$$,
  '23514',
  null,
  'a redirect can never send a visitor off the site'
);
select throws_ok(
  $$insert into public.redirects (from_path, to_path) values ('/self', '/self')$$,
  '23514',
  null,
  'nor point at itself'
);
select throws_ok(
  $$insert into public.redirects (from_path, to_path, status_code) values ('/teapot', '/tea', 418)$$,
  '23514',
  null,
  'and only the redirect status codes are allowed'
);
select ok(
  (select count(*) > 0 from public.outbox_events where event_type = 'redirect.map_changed'),
  'changing the map republishes it through the outbox, not through a second cache system'
);

-- Banners and navigation --------------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.banners (banner_key, placement, link_path)
    values ('spring', 'home_hero', 'https://example.com/spring')$$,
  '23514',
  null,
  'a banner cannot link off the site either'
);

insert into public.navigation_menus (id, menu_key, label_en)
values ('66666666-cccc-4ccc-8ccc-666666666666', 'header', 'Header');
insert into public.navigation_menus (id, menu_key, label_en)
values ('77777777-cccc-4ccc-8ccc-777777777777', 'footer', 'Footer');
insert into public.navigation_items (id, menu_id, label_en, target_kind, category_id)
values ('88888888-cccc-4ccc-8ccc-888888888888', '66666666-cccc-4ccc-8ccc-666666666666',
        'Electronics', 'category', '11111111-aaaa-4aaa-8aaa-111111111111');
select is(
  (select category_id from public.navigation_items),
  '11111111-aaaa-4aaa-8aaa-111111111111'::uuid,
  'a menu entry points at the category by id rather than copying its name'
);
select throws_ok(
  $$insert into public.navigation_items (menu_id, label_en, target_kind, path)
    values ('66666666-cccc-4ccc-8ccc-666666666666', 'Wrong', 'category', '/electronics')$$,
  '23514',
  null,
  'and the target has to match the kind it claims'
);
select throws_ok(
  $$insert into public.navigation_items (menu_id, label_en, target_kind, path)
    values ('66666666-cccc-4ccc-8ccc-666666666666', 'Away', 'path', 'https://example.com')$$,
  '23514',
  null,
  'a path entry stays on this site'
);
select throws_ok(
  $$insert into public.navigation_items (menu_id, parent_id, label_en, target_kind, path)
    values ('77777777-cccc-4ccc-8ccc-777777777777', '88888888-cccc-4ccc-8ccc-888888888888',
            'Orphan', 'path', '/x')$$,
  '23514',
  null,
  'a child cannot sit in a different menu from its parent'
);
insert into public.navigation_items (id, menu_id, parent_id, label_en, target_kind, path)
values ('99999999-cccc-4ccc-8ccc-999999999999', '66666666-cccc-4ccc-8ccc-666666666666',
        '88888888-cccc-4ccc-8ccc-888888888888', 'Phones', 'path', '/category/phones');
select throws_ok(
  $$insert into public.navigation_items (menu_id, parent_id, label_en, target_kind, path)
    values ('66666666-cccc-4ccc-8ccc-666666666666', '99999999-cccc-4ccc-8ccc-999999999999',
            'Too deep', 'path', '/x')$$,
  '23514',
  null,
  'and a menu is two levels deep at most'
);

-- FAQs ----------------------------------------------------------------------------------------------------------------
insert into public.faqs (topic, question_en, answer_en) values ('buying', 'How do I pay?', 'At checkout.');
select ok(not (select is_published from public.faqs), 'an FAQ is unpublished until someone publishes it');

-- Authorization, RLS and grants ------------------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      and c.relname in ('cms_media', 'pages', 'page_translations', 'page_slug_history', 'blog_categories',
                        'blog_tags', 'blog_posts', 'blog_post_translations', 'blog_post_tags',
                        'blog_post_slug_history', 'faqs', 'homepage_sections', 'banners',
                        'navigation_menus', 'navigation_items', 'seo_settings', 'seo_metadata', 'redirects')),
  '',
  'every table this migration creates has row level security'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where grantee = 'anon'
      and table_name in ('pages', 'blog_posts', 'seo_metadata', 'redirects', 'cms_media', 'faqs')),
  0::bigint,
  'anon receives nothing here'
);
select is(
  (select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), '')
     from information_schema.role_table_grants
    where grantee = 'authenticated' and table_name = 'page_slug_history'),
  'INSERT,SELECT',
  'slug history can be appended and read, never rewritten'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where grantee in ('app_system', 'app_worker')
      and table_name in ('pages', 'blog_posts', 'seo_metadata', 'redirects')),
  0::bigint,
  'the service roles hold no table privileges: they act only through named functions'
);
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private')
      and p.prosecdef
      and p.proname in ('seo_metadata_is_public', 'resolve_redirect', 'publish_due_content')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                       where cfg = 'search_path=pg_catalog, public')),
  '',
  'every SECURITY DEFINER function this migration adds pins the established search_path'
);
select is(
  (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'pages'),
  3::bigint,
  'a page is readable publicly, readable by staff, and writable only by staff'
);
select ok(
  (select pg_get_expr(polwithcheck, polrelid) like '%is_aal2%'
     from pg_policy where polname = 'pages_admin_write'),
  'and writing CMS content needs a stepped-up staff session'
);

select * from finish();
rollback;
