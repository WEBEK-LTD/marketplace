-- 0097 — The blog in the sitemap: the sixth kind and the reader behind it.
--
-- What is proven here, in order: the counts function still answers exactly what it answered for each of its five
-- existing kinds, which is the regression this increment most has to not be; the blog arm counts the posts the
-- reader returns and no others; a post is listed only when it is published **and** indexable, so the sitemap and the
-- post's own head never disagree (owner decision 4); a post is listed for a locale only when that locale actually
-- resolves, checked **against `blog_post_for_public` itself** rather than against a restatement of its rule, so no
-- address that would answer 404 is ever advertised (owner decision 5); paging by slug is stable and total; no
-- taxonomy entry exists and nothing reads a blog category or tag (owner decision 6); `seo_metadata` stays unread for
-- `blog_post` (owner decision 7); and nothing financial, promotional or media-related is touched.
--
-- Also proven: 0086's other readers are not redefined — including that `public_sitemap_pages` still resolves its
-- fallback through `locales.is_default`, which this increment deliberately did **not** tidy into a literal.

-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(94);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'public_sitemap_counts', array[]::text[], 'the counts function exists');
select has_function('app_private', 'public_sitemap_blog_posts', array['integer', 'integer'],
  'the blog reader exists');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_sitemap_blog_posts' and p.prosecdef),
  1, 'the blog reader is security definer');
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_sitemap_blog_posts'
      and p.proconfig @> array['search_path=pg_catalog, public']),
  1, 'and pins search_path to pg_catalog, public');
select is(
  (select p.provolatile::text
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_sitemap_blog_posts'),
  's', 'and is stable, because it only reads');

select is((select count(*)::int from public.audit_attribution_problems()), 0,
  '0097 adds no audit attribution problem');

select matches(pg_get_function_result(p.oid), 'locales text\[\]',
  'the blog reader reports which locales a post resolves in (owner decision 5)')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'public_sitemap_blog_posts';

-- Owner decision 6: a category and a tag are filters on the index, not addresses.
select hasnt_function('app_private', 'public_sitemap_blog_categories', 'no blog category sitemap reader was added');
select hasnt_function('app_private', 'public_sitemap_blog_tags', 'no blog tag sitemap reader was added');
select hasnt_function('app_private', 'public_sitemap_routes', 'the fixed routes stay in the web app''s own code');

-- ---------------------------------------------------------------------------------------------------
-- 0086's other readers are not redefined
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'public_robots_body', array[]::text[], '0086''s robots reader is untouched');
select has_function('app_private', 'public_sitemap_pages', array['integer', 'integer'],
  'and its page reader');
select has_function('app_private', 'public_sitemap_listings', array['integer', 'integer'],
  'and its listing reader');
select has_function('app_private', 'public_sitemap_services', array['integer', 'integer'],
  'and its service reader');
select has_function('app_private', 'public_sitemap_categories', array['integer', 'integer'],
  'and its category reader');
select has_function('app_private', 'public_sitemap_sellers', array['integer', 'integer'],
  'and its seller reader');

-- The page reader resolves its fallback through the default locale. This increment matched the blog *resolver's*
-- literal instead, and deliberately did not tidy this one to match — asserted so neither drifts into the other.
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_sitemap_pages') ~ 'is_default',
  'the page reader still resolves its fallback through locales.is_default');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_sitemap_blog_posts') !~ 'is_default',
  'while the blog reader matches blog_post_for_public''s own literal fallback instead');
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'blog_post_for_public') ~ '''en''',
  'which is the literal that resolver actually uses');

-- ---------------------------------------------------------------------------------------------------
-- What this increment must not do
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'public_sitemap%'
      and (p.prosrc ~* 'promotion' or p.prosrc ~* 'placement' or p.prosrc ~* 'wallet'
           or p.prosrc ~* 'ranking' or p.prosrc ~* 'popularity')),
  0, 'no sitemap function mentions a promotion, a placement, a wallet, a ranking or a popularity signal');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'public_sitemap%'
      and (p.prosrc ~* 'ledger' or p.prosrc ~* 'payout' or p.prosrc ~* 'settlement'
           or p.prosrc ~* 'seller_balances' or p.prosrc ~* 'payment' or p.prosrc ~* 'finance\.')),
  0, 'and none touches a financial table or names a finance setting');

-- Owner decision 7: `seo_metadata` stays unread for a post.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'public_sitemap%' and p.prosrc ~ 'seo_metadata'),
  0, 'no sitemap function reads seo_metadata (owner decision 7)');

-- Owner decision 6, as a property of the code and not only of the output.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_sitemap_blog_posts'
      and (p.prosrc ~ 'blog_categories' or p.prosrc ~ 'blog_tags' or p.prosrc ~ 'blog_post_tags')),
  0, 'the blog reader reads no category and no tag (owner decision 6)');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_sitemap_blog_posts'
      and (p.prosrc ~* 'cms_media' or p.prosrc ~* 'https?://' or p.prosrc ~* 'origin')),
  0, 'and builds no URL, reads no media row and names no origin');

select has_table('public', 'banners', 'the banners table is still untouched');
-- Narrowed in 0098, which gave `cms_media_references` the job of reporting every CMS row that points at one media
-- entry — and two of those six columns are `banners.media_id` and `banners.media_ar_id` (0098's owner decision 5).
-- The invariant is unchanged and is now **pinned rather than counted**: that one read-only reference reader is the
-- only function permitted to name the table, so nothing composes, serves or publishes a banner.
select is(
  (select coalesce(array_agg(p.proname::text order by p.proname), array[]::text[])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc ~ 'public\.banners'),
  array['cms_media_references'],
  'the only function naming public.banners is 0098''s reference reader, so no banner is served');

-- ---------------------------------------------------------------------------------------------------
-- Nothing in 0030 or 0092 was changed
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'blog_posts', 'the blog table is untouched');
select col_default_is('public', 'blog_posts', 'is_indexable', 'true',
  '0030''s indexable-by-default is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'blog_posts_status_allowed'),
  '0030''s status rule is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'blog_posts_published_has_time'),
  'and its published-has-a-time rule');
select ok(
  exists (select 1 from pg_class where relname = 'blog_posts_slug'),
  '0030''s unique slug index is still installed, which is what makes paging by slug total');
select has_function('public', 'cms_content_is_public', array['text', 'timestamptz'],
  '0030''s publication rule is untouched');
select has_function('app_private', 'blog_post_for_public', array['text', 'text'],
  '0092''s public post resolver is untouched');

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select ok(has_function_privilege('app_system', p.oid, 'execute'),
    format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname in ('public_sitemap_counts', 'public_sitemap_blog_posts')
 order by p.proname;

select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
    format('%s may not execute %s', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_worker')) as r(rolname)
 where n.nspname = 'app_private' and p.proname in ('public_sitemap_counts', 'public_sitemap_blog_posts')
 order by r.rolname, p.proname;

-- ---------------------------------------------------------------------------------------------------
-- The five existing kinds answer exactly what they answered before
-- ---------------------------------------------------------------------------------------------------
-- An empty database is the state the counts function ships into, so every kind reports zero and the blog's new arm
-- does not disturb that. The arm order is asserted too: the sitemap index iterates the contract's own list and a
-- reordering here would silently renumber nothing, but a *missing* kind would stop the index naming it.
select is((select count(*)::int from app_private.public_sitemap_counts()), 6,
  'six kinds are reported, one per kind the sitemap index can name');
select is(
  (select array_agg(entry_type order by entry_type) from app_private.public_sitemap_counts()),
  array['blog_post', 'category', 'listing', 'page', 'seller', 'service'],
  'and they are exactly the six expected kinds');
select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'page'), 0::bigint,
  'with no CMS page authored, the page count is zero');
select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'listing'), 0::bigint,
  'the listing count is zero');
select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'service'), 0::bigint,
  'the service count is zero');
-- **The counts function agrees with the reader**, which is what this line was always for: a sitemap whose
-- index promises a number the pages do not deliver is a broken sitemap. It said "zero" while the database
-- had no categories in it; 0111 seeded a real property catalogue, and zero was never the point.
select is(
  (select entry_count from app_private.public_sitemap_counts() where entry_type = 'category'),
  (select count(*) from app_private.public_sitemap_categories(1000000, 0)),
  'the category count is the number of categories the reader will serve');
select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'seller'), 0::bigint,
  'the seller count is zero');
select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'blog_post'), 0::bigint,
  'and so is the blog count, with no post authored');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- One post for every rule the reader has to apply, and one CMS page so the page kind is proven still to work rather
-- than only proven to be zero.
insert into auth.users (id, email) values ('ab100000-0000-4000-8000-000000000001', 'blogger@example.test');

insert into public.blog_posts (id, slug, status, is_indexable, published_at, scheduled_for, archived_at) values
  ('ab200000-0000-4000-8000-000000000001', 'both-languages', 'published', true,  '2026-05-01T10:00:00Z', null, null),
  ('ab200000-0000-4000-8000-000000000002', 'arabic-only',    'published', true,  '2026-05-01T10:00:00Z', null, null),
  ('ab200000-0000-4000-8000-000000000003', 'english-only',   'published', true,  '2026-05-02T10:00:00Z', null, null),
  ('ab200000-0000-4000-8000-000000000004', 'not-indexable',  'published', false, '2026-05-01T10:00:00Z', null, null),
  ('ab200000-0000-4000-8000-000000000005', 'still-a-draft',  'draft',     true,  null, null, null),
  ('ab200000-0000-4000-8000-000000000006', 'due-later',      'scheduled', true,  null, '2099-01-01T00:00:00Z', null),
  ('ab200000-0000-4000-8000-000000000007', 'retired',        'archived',  true,  '2026-01-01T10:00:00Z', null, '2026-04-01T10:00:00Z'),
  ('ab200000-0000-4000-8000-000000000008', 'no-translation', 'published', true,  '2026-05-01T10:00:00Z', null, null);

insert into public.blog_post_translations (blog_post_id, locale_code, title, body) values
  ('ab200000-0000-4000-8000-000000000001', 'en', 'Both', 'Body.'),
  ('ab200000-0000-4000-8000-000000000001', 'ar', 'كلاهما', 'النص.'),
  ('ab200000-0000-4000-8000-000000000002', 'ar', 'عربي فقط', 'النص.'),
  ('ab200000-0000-4000-8000-000000000003', 'en', 'English only', 'Body.'),
  ('ab200000-0000-4000-8000-000000000004', 'en', 'Hidden', 'Body.'),
  ('ab200000-0000-4000-8000-000000000005', 'en', 'Draft', 'Body.'),
  ('ab200000-0000-4000-8000-000000000006', 'en', 'Later', 'Body.'),
  ('ab200000-0000-4000-8000-000000000007', 'en', 'Retired', 'Body.');

insert into public.pages (id, slug, status, published_at, template, is_indexable) values
  ('ab300000-0000-4000-8000-000000000001', 'about', 'published', '2026-05-01T10:00:00Z', 'standard', true);
insert into public.page_translations (page_id, locale_code, title, body) values
  ('ab300000-0000-4000-8000-000000000001', 'en', 'About us', 'The body.');

-- ---------------------------------------------------------------------------------------------------
-- Owner decision 4 — published and indexable, and nothing else
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_agg(slug order by slug) from app_private.public_sitemap_blog_posts(100, 0)),
  array['arabic-only', 'both-languages', 'english-only'],
  'only the published, indexable, written posts are listed');

select ok(
  not exists (select 1 from app_private.public_sitemap_blog_posts(100, 0) where slug = 'not-indexable'),
  'a post the administrator marked not indexable is absent (owner decision 4)');
select ok(
  not exists (select 1 from app_private.public_sitemap_blog_posts(100, 0) where slug = 'still-a-draft'),
  'a draft is absent');
select ok(
  not exists (select 1 from app_private.public_sitemap_blog_posts(100, 0) where slug = 'due-later'),
  'a scheduled post whose moment has not come is absent');
select ok(
  not exists (select 1 from app_private.public_sitemap_blog_posts(100, 0) where slug = 'retired'),
  'an archived post is absent');
select ok(
  not exists (select 1 from app_private.public_sitemap_blog_posts(100, 0) where slug = 'no-translation'),
  'and a published post nobody has written is absent, because there is nothing to name it with');

select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'blog_post'), 3::bigint,
  'the count is the number of posts the reader returns, so the index can never name a child that comes back short');
select is(
  (select count(*)::bigint from app_private.public_sitemap_blog_posts(1000, 0)),
  (select entry_count from app_private.public_sitemap_counts() where entry_type = 'blog_post'),
  'asserted as an equality rather than as two numbers that happen to match');

-- Unpublishing a post removes it from both at once.
update public.blog_posts set status = 'draft', published_at = null
 where slug = 'english-only';
select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'blog_post'), 2::bigint,
  'unpublishing a post drops it from the count');
select ok(
  not exists (select 1 from app_private.public_sitemap_blog_posts(100, 0) where slug = 'english-only'),
  'and from the entries');
update public.blog_posts set status = 'published', published_at = '2026-05-02T10:00:00Z'
 where slug = 'english-only';

-- Marking a post not indexable does the same, which is what keeps the sitemap and the head in step.
update public.blog_posts set is_indexable = false where slug = 'english-only';
select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'blog_post'), 2::bigint,
  'marking a post not indexable drops it from the count too (owner decision 4)');
select ok(
  not exists (select 1 from app_private.public_sitemap_blog_posts(100, 0) where slug = 'english-only'),
  'and from the entries, so the sitemap never advertises an address whose own head says noindex');
update public.blog_posts set is_indexable = true where slug = 'english-only';

-- ---------------------------------------------------------------------------------------------------
-- Owner decision 5 — a locale is listed only when it resolves
-- ---------------------------------------------------------------------------------------------------
select is(
  (select locales from app_private.public_sitemap_blog_posts(100, 0) where slug = 'both-languages'),
  array['en', 'ar'], 'a post written in both languages is listed for both');
select is(
  (select locales from app_private.public_sitemap_blog_posts(100, 0) where slug = 'arabic-only'),
  array['ar'], 'a post written only in Arabic is listed for Arabic alone');
select is(
  (select locales from app_private.public_sitemap_blog_posts(100, 0) where slug = 'english-only'),
  array['en', 'ar'],
  'while a post written only in English is listed for both, because the Arabic address falls back to it');

-- The assertion that makes the decision real: checked against the resolver, not against a restatement of its rule.
-- If these two ever disagree, a sitemap is advertising an address that answers 404.
select is(
  (select kind from app_private.blog_post_for_public('arabic-only', 'en')),
  'not_found', 'the English address of the Arabic-only post really does answer 404');
select ok(
  not ('en' = any (select unnest(locales) from app_private.public_sitemap_blog_posts(100, 0)
                    where slug = 'arabic-only')),
  'and the sitemap does not advertise it (owner decision 5)');
select is(
  (select kind from app_private.blog_post_for_public('arabic-only', 'ar')),
  'post', 'its Arabic address answers');
select ok(
  'ar' = any (select unnest(locales) from app_private.public_sitemap_blog_posts(100, 0)
               where slug = 'arabic-only'),
  'and the sitemap advertises that one');
select is(
  (select kind from app_private.blog_post_for_public('english-only', 'ar')),
  'post', 'the Arabic address of the English-only post answers by falling back');
select ok(
  'ar' = any (select unnest(locales) from app_private.public_sitemap_blog_posts(100, 0)
               where slug = 'english-only'),
  'so the sitemap advertises it, which a stricter rule would have wrongly withheld');

-- Every locale advertised for every listed post resolves. The whole of decision 5 in one assertion.
select is(
  (select count(*)::int
     from app_private.public_sitemap_blog_posts(1000, 0) e
     cross join lateral unnest(e.locales) as wanted(code)
     cross join lateral app_private.blog_post_for_public(e.slug, wanted.code) as r
    where r.kind <> 'post'),
  0, 'every locale this reader advertises resolves to a real post at that address');

-- And nothing that resolves is wrongly withheld, for the posts that are listed at all.
select is(
  (select count(*)::int
     from app_private.public_sitemap_blog_posts(1000, 0) e
     cross join (values ('en'), ('ar')) as all_locales(code)
     cross join lateral app_private.blog_post_for_public(e.slug, all_locales.code) as r
    where r.kind = 'post' and not (all_locales.code = any (e.locales))),
  0, 'and every locale that resolves for a listed post is advertised');

-- An inactive locale is not advertised, whatever is written in it.
insert into public.locales (code, name_en, name_native, direction, is_active, sort_order)
values ('fr', 'French', 'Français', 'ltr', false, 3);
insert into public.blog_post_translations (blog_post_id, locale_code, title, body) values
  ('ab200000-0000-4000-8000-000000000002', 'fr', 'Arabe seulement', 'Le corps.');
select is(
  (select locales from app_private.public_sitemap_blog_posts(100, 0) where slug = 'arabic-only'),
  array['ar'], 'a translation in an inactive locale advertises nothing');
select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'blog_post'), 3::bigint,
  'and does not change the count');
delete from public.blog_post_translations
 where blog_post_id = 'ab200000-0000-4000-8000-000000000002' and locale_code = 'fr';
delete from public.locales where code = 'fr';

-- ---------------------------------------------------------------------------------------------------
-- Paging
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_agg(slug order by slug) from app_private.public_sitemap_blog_posts(2, 0)),
  array['arabic-only', 'both-languages'], 'the first page carries the first two slugs in order');
select is(
  (select array_agg(slug) from app_private.public_sitemap_blog_posts(2, 2)),
  array['english-only'], 'the second carries the rest');
select is((select count(*)::int from app_private.public_sitemap_blog_posts(2, 10)), 0,
  'a page past the end is empty rather than an error');
select is((select count(*)::int from app_private.public_sitemap_blog_posts(null, null)), 1,
  'a null limit is one row rather than everything, exactly as the other readers treat it');
select is((select count(*)::int from app_private.public_sitemap_blog_posts(0, -5)), 1,
  'and a nonsense limit or offset is clamped rather than refused');
select is(
  (select count(distinct slug)::int from app_private.public_sitemap_blog_posts(1000, 0)),
  (select count(*)::int from app_private.public_sitemap_blog_posts(1000, 0)),
  'no post is served twice in one page, because the slug is unique');

-- ---------------------------------------------------------------------------------------------------
-- The other kinds still work, not merely still report zero
-- ---------------------------------------------------------------------------------------------------
select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'page'), 1::bigint,
  'the page kind still counts a published, indexable, written page');
select is(
  (select array_agg(slug) from app_private.public_sitemap_pages(100, 0)),
  array['about'], 'and its reader still returns it');
select is(
  (select locales from app_private.public_sitemap_pages(100, 0) where slug = 'about'),
  array['en', 'ar'], 'with the locales 0086 already resolved for it, unchanged');
select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'listing'), 0::bigint,
  'and the listing count is still what it was');
select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'service'), 0::bigint,
  'and the service count');
select is(
  (select entry_count from app_private.public_sitemap_counts() where entry_type = 'category'),
  (select count(*) from app_private.public_sitemap_categories(1000000, 0)),
  'and the category count still matches its reader');
select is((select entry_count from app_private.public_sitemap_counts() where entry_type = 'seller'), 0::bigint,
  'and the seller count');

-- A blog post must never leak into another kind's answer.
select ok(
  not exists (select 1 from app_private.public_sitemap_pages(1000, 0) where slug like '%languages%'),
  'a blog post is not a CMS page');
select is((select count(*)::int from app_private.public_sitemap_listings(1000, 0)), 0,
  'and not a listing');
-- The claim is that a blog post does not leak into another entry type, so it is asserted about the post
-- rather than about the emptiness of the table it must not appear in.
select ok(
  not exists (select 1 from app_private.public_sitemap_categories(1000000, 0) where slug like '%languages%'),
  'and not a category');
select is((select count(*)::int from app_private.public_sitemap_sellers(1000, 0)), 0,
  'and not a seller');

-- ---------------------------------------------------------------------------------------------------
-- The robots document is not this increment's business
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.public_robots_body()), 0,
  '0096''s robots answer is unchanged: nothing authored is still no row');

select * from finish();
rollback;
