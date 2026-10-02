-- 0086 — The public SEO readers: robots body, sitemap counts, and the five per-kind enumerations.
--
-- What is proven here, in order: every reader exists with a pinned search path and is granted to app_system
-- and to nobody else; `robots.txt` answers from the default locale's row alone and answers nothing at all
-- when nothing is authored; and the sitemap enumerations draw the exact line the specification draws —
-- **purchasable** rather than merely public, so a sold, expired or archived listing stays viewable at its own
-- address and is excluded from here. Then: a hidden seller takes their listings out with them, a deactivated
-- ancestor takes a whole category branch out, a page that is unpublished, not indexable or written in no
-- language is absent, a page written in one language is listed for that language only, and the counts agree
-- with the rows the enumerations actually return.
--
-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(79);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'public_robots_body', 'the robots body reader exists');
select has_function('app_private', 'public_sitemap_counts', 'the counts reader exists');
select has_function('app_private', 'public_sitemap_pages', array['integer', 'integer'], 'the pages reader exists');
select has_function('app_private', 'public_sitemap_listings', array['integer', 'integer'], 'the products reader exists');
select has_function('app_private', 'public_sitemap_services', array['integer', 'integer'], 'the services reader exists');
select has_function('app_private', 'public_sitemap_categories', array['integer', 'integer'], 'the categories reader exists');
select has_function('app_private', 'public_sitemap_sellers', array['integer', 'integer'], 'the sellers reader exists');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname = 'public_robots_body' or p.proname like 'public_sitemap%')
      and p.prosecdef),
  7, 'all seven are security definer');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname = 'public_robots_body' or p.proname like 'public_sitemap%')
      and p.proconfig @> array['search_path=pg_catalog, public']),
  7, 'all seven pin search_path to pg_catalog, public');

-- Read-only: nothing here may write, so every one is declared stable rather than volatile.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname = 'public_robots_body' or p.proname like 'public_sitemap%')
      and p.provolatile = 's'),
  7, 'all seven are stable, so none of them can write');

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- app_system only. A crawler-facing document is still assembled by the web app through the API, and the
-- worker has no part in it.
select ok(
  has_function_privilege('app_system', p.oid, 'execute'),
  format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and (p.proname = 'public_robots_body' or p.proname like 'public_sitemap%');

select ok(
  not has_function_privilege('app_worker', p.oid, 'execute'),
  format('app_worker may not execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and (p.proname = 'public_robots_body' or p.proname like 'public_sitemap%');

select ok(
  not has_function_privilege('public', p.oid, 'execute'),
  format('public may not execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and (p.proname = 'public_robots_body' or p.proname like 'public_sitemap%');

-- ---------------------------------------------------------------------------------------------------
-- The robots body
-- ---------------------------------------------------------------------------------------------------
-- Nothing authored yet. No row, rather than an empty string that a caller would have to tell apart from
-- authored-but-blank.
select is_empty(
  'select * from app_private.public_robots_body()',
  'with nothing authored, the robots reader answers no row at all');

-- A row for the non-default locale must not answer: robots.txt is one document at the root of an origin.
insert into public.seo_settings (locale_code, site_name, robots_txt_body)
  values ('ar', 'السوق', 'User-agent: *' || chr(10) || 'Disallow: /ar/secret');

select is_empty(
  'select * from app_private.public_robots_body()',
  'a row for a non-default locale does not answer');

insert into public.seo_settings (locale_code, site_name, robots_txt_body)
  values ('en', 'Marketplace', 'User-agent: *' || chr(10) || 'Disallow: /dashboard');

select is(
  (select robots_txt_body from app_private.public_robots_body()),
  'User-agent: *' || chr(10) || 'Disallow: /dashboard',
  'the default locale''s body is the one that answers');

select is(
  (select locale_code from app_private.public_robots_body()),
  'en', 'and it says which locale it came from');

select is(
  (select count(*)::int from app_private.public_robots_body()),
  1, 'exactly one row, whatever else is stored');

-- Authored-but-blank is the same as unauthored: a body of spaces is not a directive.
update public.seo_settings set robots_txt_body = '   ' where locale_code = 'en';
select is(
  (select robots_txt_body from app_private.public_robots_body()),
  null, 'a blank body comes back null rather than as whitespace');

update public.seo_settings set robots_txt_body = null where locale_code = 'en';
select is(
  (select robots_txt_body from app_private.public_robots_body()),
  null, 'an absent body comes back null while the row itself still answers');

update public.seo_settings
   set robots_txt_body = 'User-agent: *' || chr(10) || 'Disallow: /dashboard'
 where locale_code = 'en';

-- ---------------------------------------------------------------------------------------------------
-- Fixtures: one visible seller, one hidden one, a category tree, and listings in every state
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('b0000000-0000-4000-8000-00000000ab01', 'visible-seller@test.invalid'),
  ('b0000000-0000-4000-8000-00000000ab02', 'hidden-seller@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, suspended_at, verification_status, verified_at)
values
  ('b0000000-0000-4000-8000-00000000ab01', 'open-shop', 'Open Shop', 'Open Shop LLC',
   'open@test.invalid', '+201000000011', 'EG', 'active', null, 'verified', now() - interval '10 days'),
  ('b0000000-0000-4000-8000-00000000ab02', 'shut-shop', 'Shut Shop', 'Shut Shop LLC',
   'shut@test.invalid', '+201000000012', 'EG', 'suspended', now() - interval '1 day',
   'verified', now() - interval '10 days');

-- A live branch, and a live child under a deactivated parent.
insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c1000000-0000-4000-8000-00000000ab01', null, 'aa-furniture', true, 1),
  ('c1000000-0000-4000-8000-00000000ab02', 'c1000000-0000-4000-8000-00000000ab01', 'ab-chairs', true, 2),
  ('c1000000-0000-4000-8000-00000000ab03', null, 'ac-retired', false, 3),
  ('c1000000-0000-4000-8000-00000000ab04', 'c1000000-0000-4000-8000-00000000ab03', 'ad-orphan', true, 4);
insert into public.category_translations (category_id, locale_code, name) values
  ('c1000000-0000-4000-8000-00000000ab01', 'en', 'Furniture'),
  ('c1000000-0000-4000-8000-00000000ab02', 'en', 'Chairs'),
  ('c1000000-0000-4000-8000-00000000ab03', 'en', 'Retired'),
  ('c1000000-0000-4000-8000-00000000ab04', 'en', 'Orphan');

/** One listing. Every column but type, slug, status and seller is the same across the set. */
create or replace function pg_temp.seed_listing(
  p_id uuid, p_type text, p_slug text, p_status text, p_seller uuid
) returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city,
    approved_at, sold_at, archived_at, deleted_at
  ) values (
    p_id, p_seller, p_type, 'c1000000-0000-4000-8000-00000000ab01', p_slug,
    'A listing title', 'A description long enough to satisfy the length rule.', 'en',
    'EGP', 250000, false, p_status, 'EG', 'Cairo',
    case when p_status in ('approved','active','sold','expired','archived') then now() else null end,
    case when p_status = 'sold' then now() else null end,
    case when p_status = 'archived' then now() else null end,
    case when p_status = 'deleted' then now() else null end
  );
end;
$$;

-- Products: two that belong in a sitemap, five that do not, and one behind a hidden seller.
select pg_temp.seed_listing('11110000-0000-4000-8000-00000000ab01', 'product', 'pa-active', 'active', 'b0000000-0000-4000-8000-00000000ab01');
select pg_temp.seed_listing('11110000-0000-4000-8000-00000000ab02', 'product', 'pb-approved', 'approved', 'b0000000-0000-4000-8000-00000000ab01');
select pg_temp.seed_listing('11110000-0000-4000-8000-00000000ab03', 'product', 'pc-sold', 'sold', 'b0000000-0000-4000-8000-00000000ab01');
select pg_temp.seed_listing('11110000-0000-4000-8000-00000000ab04', 'product', 'pd-expired', 'expired', 'b0000000-0000-4000-8000-00000000ab01');
select pg_temp.seed_listing('11110000-0000-4000-8000-00000000ab05', 'product', 'pe-archived', 'archived', 'b0000000-0000-4000-8000-00000000ab01');
select pg_temp.seed_listing('11110000-0000-4000-8000-00000000ab06', 'product', 'pf-draft', 'draft', 'b0000000-0000-4000-8000-00000000ab01');
select pg_temp.seed_listing('11110000-0000-4000-8000-00000000ab07', 'product', 'pg-rejected', 'rejected', 'b0000000-0000-4000-8000-00000000ab01');
select pg_temp.seed_listing('11110000-0000-4000-8000-00000000ab08', 'product', 'ph-hidden', 'active', 'b0000000-0000-4000-8000-00000000ab02');

-- Services: the same rule, over the same table.
select pg_temp.seed_listing('11110000-0000-4000-8000-00000000ac01', 'service', 'sa-active', 'active', 'b0000000-0000-4000-8000-00000000ab01');
select pg_temp.seed_listing('11110000-0000-4000-8000-00000000ac02', 'service', 'sb-sold', 'sold', 'b0000000-0000-4000-8000-00000000ab01');
select pg_temp.seed_listing('11110000-0000-4000-8000-00000000ac03', 'service', 'sc-hidden', 'active', 'b0000000-0000-4000-8000-00000000ab02');

-- ---------------------------------------------------------------------------------------------------
-- Products: purchasable, and nothing else
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  'select slug from app_private.public_sitemap_listings(100, 0)',
  array['pa-active', 'pb-approved'],
  'only approved and active products are listed');

select is(
  (select count(*)::int from app_private.public_sitemap_listings(100, 0) where slug = 'pc-sold'),
  0, 'a sold product is excluded even though its page stays public');

select is(
  (select count(*)::int from app_private.public_sitemap_listings(100, 0) where slug = 'pd-expired'),
  0, 'an expired product is excluded even though its page stays public');

select is(
  (select count(*)::int from app_private.public_sitemap_listings(100, 0) where slug = 'pe-archived'),
  0, 'an archived product is excluded even though its page may stay public');

select is(
  (select count(*)::int from app_private.public_sitemap_listings(100, 0) where slug in ('pf-draft', 'pg-rejected')),
  0, 'a draft or rejected product was never public and is not listed');

select is(
  (select count(*)::int from app_private.public_sitemap_listings(100, 0) where slug = 'ph-hidden'),
  0, 'an active product of a suspended seller is not listed');

select is(
  (select count(*)::int from app_private.public_sitemap_listings(100, 0) where slug like 's%'),
  0, 'the product reader returns no services');

-- The distinction this test exists for, stated as the two helpers themselves state it.
select ok(
  public.listing_status_is_public('sold') and not public.listing_status_is_purchasable('sold'),
  'sold is publicly viewable and not purchasable, which is the line the sitemap draws');

select ok(
  (select count(*) from public.listings
    where public.listing_status_is_public(status) and listing_type_code = 'product'
      and seller_user_id = 'b0000000-0000-4000-8000-00000000ab01')
  > (select count(*) from app_private.public_sitemap_listings(100, 0)),
  'more products are publicly viewable than are listed in a sitemap');

-- ---------------------------------------------------------------------------------------------------
-- Services
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  'select slug from app_private.public_sitemap_services(100, 0)',
  array['sa-active'],
  'only purchasable services of a visible seller are listed');

select is(
  (select count(*)::int from app_private.public_sitemap_services(100, 0) where slug like 'p%'),
  0, 'the service reader returns no products');

-- ---------------------------------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  'select slug from app_private.public_sitemap_categories(100, 0)',
  array['aa-furniture', 'ab-chairs'],
  'active categories with active ancestors are listed');

select is(
  (select count(*)::int from app_private.public_sitemap_categories(100, 0) where slug = 'ac-retired'),
  0, 'a deactivated category is not listed');

select is(
  (select count(*)::int from app_private.public_sitemap_categories(100, 0) where slug = 'ad-orphan'),
  0, 'an active category under a deactivated parent is not listed either');

-- ---------------------------------------------------------------------------------------------------
-- Sellers
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  'select slug from app_private.public_sitemap_sellers(100, 0)',
  array['open-shop'],
  'only publicly visible seller profiles are listed');

select is(
  (select count(*)::int from app_private.public_sitemap_sellers(100, 0) where slug = 'shut-shop'),
  0, 'a suspended seller profile is not listed');

-- ---------------------------------------------------------------------------------------------------
-- CMS static pages
-- ---------------------------------------------------------------------------------------------------
insert into public.pages (id, slug, page_key, template, status, published_at, is_indexable, sort_order) values
  ('d1000000-0000-4000-8000-00000000ab01', 'terms', 'terms', 'legal', 'published', now() - interval '1 day', true, 1),
  ('d1000000-0000-4000-8000-00000000ab02', 'privacy', 'privacy', 'legal', 'published', now() - interval '1 day', true, 2),
  ('d1000000-0000-4000-8000-00000000ab03', 'cookies', null, 'legal', 'published', now() - interval '1 day', true, 3),
  ('d1000000-0000-4000-8000-00000000ab04', 'about', null, 'standard', 'published', now() - interval '1 day', false, 4),
  ('d1000000-0000-4000-8000-00000000ab05', 'contact', null, 'standard', 'draft', null, true, 5),
  ('d1000000-0000-4000-8000-00000000ab06', 'faq', null, 'standard', 'published', now() + interval '7 days', true, 6),
  ('d1000000-0000-4000-8000-00000000ab07', 'help', null, 'standard', 'published', now() - interval '1 day', true, 7);

insert into public.page_translations (page_id, locale_code, title, body) values
  -- Written in both languages.
  ('d1000000-0000-4000-8000-00000000ab01', 'en', 'Terms of Service', 'The English terms.'),
  ('d1000000-0000-4000-8000-00000000ab01', 'ar', 'شروط الخدمة', 'الشروط بالعربية.'),
  -- English only. Arabic falls back to it, so both addresses answer.
  ('d1000000-0000-4000-8000-00000000ab02', 'en', 'Privacy', 'The English privacy notice.'),
  -- Arabic only. English cannot fall back to Arabic, so only the Arabic address answers.
  ('d1000000-0000-4000-8000-00000000ab03', 'ar', 'ملفات تعريف الارتباط', 'النص بالعربية.'),
  -- Published but marked not indexable.
  ('d1000000-0000-4000-8000-00000000ab04', 'en', 'About', 'About us.'),
  -- Draft, and scheduled for later.
  ('d1000000-0000-4000-8000-00000000ab05', 'en', 'Contact', 'Contact us.'),
  ('d1000000-0000-4000-8000-00000000ab06', 'en', 'Questions', 'Answers.');
  -- `help` is published and indexable and deliberately has no translation at all.

select set_eq(
  'select slug from app_private.public_sitemap_pages(100, 0)',
  array['cookies', 'privacy', 'terms'],
  'only published, indexable, written pages are listed');

select is(
  (select locales from app_private.public_sitemap_pages(100, 0) where slug = 'terms'),
  array['en', 'ar'],
  'a page written in both languages is listed for both, in locale sort order');

select is(
  (select locales from app_private.public_sitemap_pages(100, 0) where slug = 'privacy'),
  array['en', 'ar'],
  'a page written in English alone still answers in Arabic, because Arabic falls back to it');

select is(
  (select locales from app_private.public_sitemap_pages(100, 0) where slug = 'cookies'),
  array['ar'],
  'a page written in Arabic alone is listed for Arabic only: the English address answers 404');

select is(
  (select count(*)::int from app_private.public_sitemap_pages(100, 0) where slug = 'about'),
  0, 'a page the administrator marked not indexable is not listed');

select is(
  (select count(*)::int from app_private.public_sitemap_pages(100, 0) where slug = 'contact'),
  0, 'a draft page is not listed');

select is(
  (select count(*)::int from app_private.public_sitemap_pages(100, 0) where slug = 'faq'),
  0, 'a page whose publication moment has not arrived is not listed');

select is(
  (select count(*)::int from app_private.public_sitemap_pages(100, 0) where slug = 'help'),
  0, 'a published page written in no language at all is not listed');

-- ---------------------------------------------------------------------------------------------------
-- The counts agree with the rows
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  'select entry_type from app_private.public_sitemap_counts()',
  array['page', 'listing', 'service', 'category', 'seller'],
  'the counts name every kind of address, and no others');

select is(
  (select entry_count from app_private.public_sitemap_counts() where entry_type = 'page'),
  (select count(*) from app_private.public_sitemap_pages(1000, 0)),
  'the page count matches the pages the reader returns');

select is(
  (select entry_count from app_private.public_sitemap_counts() where entry_type = 'listing'),
  (select count(*) from app_private.public_sitemap_listings(1000, 0)),
  'the product count matches the products the reader returns');

select is(
  (select entry_count from app_private.public_sitemap_counts() where entry_type = 'service'),
  (select count(*) from app_private.public_sitemap_services(1000, 0)),
  'the service count matches the services the reader returns');

select is(
  (select entry_count from app_private.public_sitemap_counts() where entry_type = 'category'),
  (select count(*) from app_private.public_sitemap_categories(1000, 0)),
  'the category count matches the categories the reader returns');

select is(
  (select entry_count from app_private.public_sitemap_counts() where entry_type = 'seller'),
  (select count(*) from app_private.public_sitemap_sellers(1000, 0)),
  'the seller count matches the sellers the reader returns');

-- ---------------------------------------------------------------------------------------------------
-- Paging
-- ---------------------------------------------------------------------------------------------------
-- Ordered by a unique key, so a numbered page is stable: pages do not overlap and nothing is skipped.
select is(
  (select slug from app_private.public_sitemap_categories(1, 0)),
  'aa-furniture', 'the first page of one is the first row in slug order');

select is(
  (select slug from app_private.public_sitemap_categories(1, 1)),
  'ab-chairs', 'the second page of one is the second row');

select is_empty(
  'select * from app_private.public_sitemap_categories(1, 2)',
  'a page past the end is empty rather than an error');

select is(
  (select count(*)::int from app_private.public_sitemap_pages(2, 0)),
  2, 'a limit is honoured');

select set_eq(
  'select slug from app_private.public_sitemap_pages(2, 0) union all select slug from app_private.public_sitemap_pages(2, 2)',
  array['cookies', 'privacy', 'terms'],
  'two pages of two cover the set exactly once between them');

-- A nonsensical limit or offset is clamped rather than refused: a crawler is not a form to validate.
select is(
  (select count(*)::int from app_private.public_sitemap_categories(0, 0)),
  1, 'a limit of zero is clamped to one');

select is(
  (select count(*)::int from app_private.public_sitemap_categories(-5, 0)),
  1, 'a negative limit is clamped to one');

select is(
  (select slug from app_private.public_sitemap_categories(1, -5)),
  'aa-furniture', 'a negative offset is clamped to the beginning');

select is(
  (select count(*)::int from app_private.public_sitemap_categories(null, null)),
  1, 'a null limit is clamped to one and a null offset to the beginning');

-- ---------------------------------------------------------------------------------------------------
-- Nothing here writes
-- ---------------------------------------------------------------------------------------------------
-- The readers are declared stable, which the shape section asserts. This is the other half: not one of them
-- names a table this increment is not allowed to touch, and none of them names a money-moving writer.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname = 'public_robots_body' or p.proname like 'public_sitemap%')
      and (p.prosrc ~* '(insert|update|delete)\s' )),
  0, 'no reader contains a write statement');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname = 'public_robots_body' or p.proname like 'public_sitemap%')
      and (p.prosrc ~* 'settle_payout|transition_withdrawal|reconcile_settlement|ledger|payout|withdrawal')),
  0, 'no reader names a financial function or table');

select * from finish();
rollback;
