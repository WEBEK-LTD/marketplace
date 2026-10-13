-- pgTAP — migration 0112: the static pages' first content.
--
-- The migration is content, so this file asserts what makes content usable rather than what makes a schema
-- correct — the schema behind it is 0030's and is proved by 0030's own suite:
--
--   * every address the route map fixes has a page, and every page is published, because an address that
--     answers "not written yet" is the state this migration exists to end;
--   * every page is written in **both** languages, because D6 makes the public site bilingual and a page in
--     one language serves the other language the default locale's text — which is the fallback for a
--     translation gap, not something to create on purpose;
--   * no page claims a fact the office has not supplied: the commission rates, the address, the company name
--     and the governing law are placeholders in both languages, and this file counts them, so nobody can
--     quietly replace a placeholder with an invention and nobody can ship having forgotten one;
--   * nothing in any body promises an online payment, which is the one claim this platform must never make
--     (OD-A1) and the one a generic template would make on every page;
--   * every body is plain text, because `cms-page-view.tsx` renders it as plain text and a body containing
--     markup would be shown as its own angle brackets.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(16);

-- ---------------------------------------------------------------------------------------------------
-- 1. Coverage: every fixed address, published, in both languages
-- ---------------------------------------------------------------------------------------------------
-- The list is the specification's route map, restated here rather than read from anywhere: a test that
-- derived the expected set from the same place the migration did could not catch a missing page.
create temporary table expected_slug (slug text primary key) on commit drop;
insert into expected_slug (slug) values
  ('about'), ('accessibility'), ('buyer-terms'), ('cancellation-policy'), ('commission'),
  ('commission-policy'), ('content-policy'), ('contact'), ('cookies'), ('faq'), ('fraud-prevention'),
  ('help'), ('intellectual-property'), ('privacy'), ('prohibited-items'), ('refund-policy'), ('safety'),
  ('seller-guidelines'), ('seller-policy'), ('seller-terms'), ('terms'), ('verification');

select is(
  (select count(*)::integer from expected_slug e
   where not exists (select 1 from public.pages p where p.slug = e.slug)),
  0, 'every address the route map fixes has a page');

select is(
  (select count(*)::integer from expected_slug e
   join public.pages p on p.slug = e.slug
   where p.status <> 'published' or p.published_at is null),
  0, 'and every one of them is published: a draft nobody can see is the state this migration ends');

select is(
  (select count(*)::integer from expected_slug e
   join public.pages p on p.slug = e.slug
   where (select count(*) from public.page_translations t
          where t.page_id = p.id and t.locale_code in ('en', 'ar')) <> 2),
  0, 'and written in both languages, so neither half of the audience is served a fallback');

select is(
  (select count(*)::integer from expected_slug e
   join public.pages p on p.slug = e.slug
   where p.page_key is null),
  0, 'each carries a page key, which is how the console addresses a page whose slug may change');

select is(
  (select count(*)::integer from public.pages p
   where p.template not in ('standard', 'legal', 'help', 'landing')),
  0, 'and a template the schema allows');

-- ---------------------------------------------------------------------------------------------------
-- 2. The content is real content
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.page_translations t
   join public.pages p on p.id = t.page_id
   join expected_slug e on e.slug = p.slug
   where length(btrim(t.body, E' \t\r\n')) < 200),
  0, 'no page is a stub: every body is a page of prose rather than a sentence of apology');

select is(
  (select count(*)::integer from public.page_translations t
   join public.pages p on p.id = t.page_id
   join expected_slug e on e.slug = p.slug
   where t.excerpt is null or length(btrim(t.excerpt, E' \t\r\n')) = 0),
  0, 'every page has a one-line summary, which is also its meta description');

select is(
  (select count(*)::integer from public.page_translations t
   join public.pages p on p.id = t.page_id
   join expected_slug e on e.slug = p.slug
   where t.meta_description is null),
  0, 'and that summary is carried into the metadata rather than left to a site-wide default');

-- Plain text. `cms-page-view.tsx` escapes every character and splits on blank lines, so a body containing
-- markup is a body that displays its own tags.
select is(
  (select count(*)::integer from public.page_translations t
   join public.pages p on p.id = t.page_id
   join expected_slug e on e.slug = p.slug
   where t.body ~ '<[a-zA-Z/!]' or t.body ~ '(^|\n)\s*#{1,6}\s' or t.body ~ '\*\*'),
  0, 'no body contains markup: the column is rendered as plain text and would show the tags');

select is(
  (select count(*)::integer from public.page_translations t
   join public.pages p on p.id = t.page_id
   join expected_slug e on e.slug = p.slug
   where t.body ~ E'\n\n\n'),
  0, 'and none has a run of blank lines, which the paragraph splitter would read as nothing at all');

-- ---------------------------------------------------------------------------------------------------
-- 3. Nothing is invented, and the placeholders are counted
-- ---------------------------------------------------------------------------------------------------
-- The pages that need a fact only the office has carry a bracketed placeholder. Counting them is what stops
-- two opposite mistakes: a placeholder quietly replaced by a plausible invention, and a page shipped with a
-- placeholder nobody noticed. Both are caught by the same number moving.
select is(
  (select count(distinct p.slug)::integer
   from public.page_translations t
   join public.pages p on p.id = t.page_id
   where t.locale_code = 'en' and t.body like '%[the office to complete]%'),
  10, 'ten English pages wait on a fact only the office has');

select is(
  (select count(distinct p.slug)::integer
   from public.page_translations t
   join public.pages p on p.id = t.page_id
   where t.locale_code = 'ar' and t.body like '%[يستكملها المكتب]%'),
  10, 'and the same ten in Arabic: a placeholder in one language only is a half-written page');

select is(
  (select count(*)::integer
   from public.page_translations t
   join public.pages p on p.id = t.page_id
   where t.locale_code = 'en' and t.body like '%[the office to complete]%'
     and p.slug not in ('about', 'contact', 'commission', 'commission-policy', 'terms', 'buyer-terms',
                        'seller-terms', 'privacy', 'refund-policy', 'intellectual-property')),
  0, 'and they are the ten pages that genuinely need one, not a placeholder left in by accident');

-- The one claim this platform must never make. Every payment happens at the office (OD-A1), so a page that
-- offered to take one online would be contradicting the product on the product's own site.
select is(
  (select count(*)::integer from public.page_translations t
   join public.pages p on p.id = t.page_id
   join expected_slug e on e.slug = p.slug
   where t.body ~* '(pay|payment)[^.]{0,40}(online|on this (web)?site|by card|credit card)'
     and t.body !~* 'no (online )?payment|never|not take|there is no payment'),
  0, 'no page offers an online payment, which this platform does not have and must not imply');

-- ---------------------------------------------------------------------------------------------------
-- 4. The migration did not reach past its own rows
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.pages where created_by is not null or updated_by is not null),
  0, 'a seeded page has no author, which is honest: nobody in the console wrote it');

select is(
  (select count(*)::integer from public.page_slug_history),
  0, 'and no slug history was created: nothing was renamed, these are first insertions');

select finish();
rollback;
