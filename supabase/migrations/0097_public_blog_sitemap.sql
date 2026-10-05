-- 0097 — The blog in the sitemap: the one kind 0092 left out, and the count that names it.
--
-- 0092 built the blog and recorded this gap in its own header, in as many words: *"**The blog does not enter the
-- sitemap.** `app_private.public_sitemap_counts()` declares exactly five kinds — page, listing, service, category,
-- seller — and it is not touched here. Sitemap inclusion for the blog is a separate future increment."* This is that
-- increment.
--
-- **No table, column, constraint, index, trigger or policy is created or changed, and no new table exists after it.**
-- The blog schema is 0030's and stays 0030's; the blog's readers and writers are 0092's and stay 0092's.
--
-- **Two functions are touched and no others.** `public_sitemap_counts()` gains a sixth arm, and
-- `public_sitemap_blog_posts(integer, integer)` is new. The five existing arms of the counts function are reproduced
-- **character for character** — this migration replaces the function because PostgreSQL has no way to add one arm to
-- a `union all`, not because any existing kind changes, and the pgTAP suite asserts each of the five still answers
-- exactly what it answered before. Nothing else in 0086 is redefined: the robots reader, the four other entry
-- readers and the page reader are untouched.
--
-- ---------------------------------------------------------------------------------------------------
-- THE OWNER DECISIONS THIS MIGRATION ENFORCES
-- ---------------------------------------------------------------------------------------------------
--
-- **Decision 4 — only published, indexable posts.** The reader requires `public.cms_content_is_public(status,
-- published_at)`, which is 0030's own publication rule and the very predicate `blog_post_for_public` resolves
-- through, **and** `is_indexable`. So a draft, a scheduled post whose moment has not come, an archived post and a
-- post whose administrator marked it not indexable are all absent — and the sitemap says the same thing about every
-- post that the post's own page says, because both read the same column. That alignment is the point of the
-- decision: a sitemap advertising an address whose own head says `noindex` is a sitemap arguing with itself.
--
-- **Decision 5 — a locale is listed only when it actually resolves.** `blog_post_for_public` answers a locale when a
-- translation exists in that locale *or* in English, and 404s otherwise. So a post written only in Arabic answers at
-- `/ar/blog/<slug>` and **404s at `/blog/<slug>`**, exactly as a CMS static page does, and this reader returns the
-- locales on that same rule. Nothing advertises an address that would answer 404.
--
--   The English fallback is spelled as the literal `'en'` here, and that is deliberate rather than careless.
--   `blog_post_for_public` falls back to the literal `'en'` (`t.locale_code in (wanted, 'en')`), not to
--   `locales.is_default`. A sitemap has to describe what the address *does*, so this reader matches the resolver it
--   describes rather than a tidier rule the resolver does not follow. Were the two written differently and the
--   platform's default locale ever changed, this function would start advertising addresses that answer 404 — which
--   is the one thing decision 5 forbids. The page reader in 0086 uses the default-locale subquery for its own
--   surface and is left exactly as it is; this is not a change to it.
--
-- **Decision 6 — no taxonomy entries.** A blog category and a blog tag are **filters on the index**
-- (`/blog?category=…`, `/blog?tag=…`) and not addresses of their own: the public web has two blog routes, the index
-- and the post. So there is no taxonomy kind here, no taxonomy count, and nothing in this file reads
-- `blog_categories` or `blog_tags` at all. The index itself is a fixed landing route the web app holds in code, so
-- it is not counted here either.
--
-- **Decision 7 — `seo_metadata` stays unread for `blog_post`.** Nothing here touches `seo_metadata`. 0091 left
-- `blog_post` an allowed entity type with no public reader and 0092 left it that way; neither is reopened or
-- widened, and a post's head still comes from its own `blog_post_translations.meta_title` and `.meta_description`.
--
-- ---------------------------------------------------------------------------------------------------
-- WHY THE COUNT IS EXPRESSED THE WAY IT IS
-- ---------------------------------------------------------------------------------------------------
--
-- The new arm counts the posts **this reader would return**, which means it asks the same "does at least one active
-- locale resolve" question rather than the looser "has any translation at all". The sitemap index turns a count into
-- a number of child documents, so a count larger than the reader's own answer would have the index name a child that
-- comes back short or empty — the exact failure the index's design note says it exists to avoid.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS NOT HERE
-- ---------------------------------------------------------------------------------------------------
--
-- No permission predicate and no writer: a sitemap is public by definition, these are read-only functions with no
-- caller identity, and nothing in this increment authors anything. No banner, no media origin, no signed URL, no
-- Twitter metadata, no JSON-LD, no site-wide metadata default, no email template, no locale administration. No
-- function here reads a promotion, a placement, a ranking, a wallet, a ledger, a payout, a payment, a settlement or
-- any `finance.*` setting.

-- ---------------------------------------------------------------------------------------------------
-- 1. How many entries each kind would produce
-- ---------------------------------------------------------------------------------------------------
-- The five existing arms are 0086's, unchanged. The sixth is the blog.
create or replace function app_private.public_sitemap_counts()
returns table (
  entry_type text,
  entry_count bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select 'page', count(*)
    from public.pages p
   where public.cms_content_is_public(p.status, p.published_at)
     and p.is_indexable
     and exists (select 1 from public.page_translations t where t.page_id = p.id)
  union all
  -- 0097. Published, indexable, and resolvable in at least one active locale — the same three questions the reader
  -- below asks, so the index can never name a child document that comes back short.
  select 'blog_post', count(*)
    from public.blog_posts b
   where public.cms_content_is_public(b.status, b.published_at)
     and b.is_indexable
     and exists (
           select 1
             from public.blog_post_translations t
             join public.locales l on l.is_active
            where t.blog_post_id = b.id
              and t.locale_code in (l.code, 'en')
         )
  union all
  select 'listing', count(*)
    from public.listings l
   where l.listing_type_code = 'product'
     and public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
  union all
  select 'service', count(*)
    from public.listings l
   where l.listing_type_code = 'service'
     and public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
  union all
  select 'category', count(*)
    from public.categories c
   where app_private.public_category_visible(c.id)
  union all
  select 'seller', count(*)
    from public.seller_profiles s
   where public.is_seller_publicly_visible(s.user_id);
$$;

comment on function app_private.public_sitemap_counts() is
  'How many sitemap entries each kind of address would produce, so the sitemap index can name exactly the child sitemaps that exist. An empty kind reports zero rather than being absent. Six kinds since 0097, when the blog gained the entry 0092 deliberately left out.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The blog posts
-- ---------------------------------------------------------------------------------------------------
-- One row per post, with the locales in which that post actually resolves — the same shape and the same reasoning as
-- `public_sitemap_pages`, because a post and a static page are the same kind of thing to a sitemap: authored content
-- at an address, published or not, indexable or not, written in one language or two.
--
-- Ordered by slug, which is unique (`blog_posts_slug`), so a numbered page is stable and no post can be served twice
-- or skipped while the page size holds.
create or replace function app_private.public_sitemap_blog_posts(
  p_limit integer,
  p_offset integer
) returns table (
  slug text,
  updated_at timestamptz,
  locales text[]
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with published as (
    select b.id, b.slug, b.updated_at
      from public.blog_posts b
     where public.cms_content_is_public(b.status, b.published_at)
       and b.is_indexable
  ), resolved as (
    select pb.id,
           pb.slug,
           pb.updated_at,
           array_agg(l.code order by l.sort_order, l.code) as locales
      from published pb
      join public.locales l on l.is_active
     where exists (
             -- The locale answers when the post is written in it, or in English, which is exactly what
             -- `blog_post_for_public` resolves through — literal and all. A post written only in Arabic therefore
             -- yields Arabic alone, and the English address that answers 404 is never advertised.
             select 1
               from public.blog_post_translations t
              where t.blog_post_id = pb.id
                and t.locale_code in (l.code, 'en')
           )
     group by pb.id, pb.slug, pb.updated_at
  )
  select r.slug, r.updated_at, r.locales
    from resolved r
   order by r.slug
   limit greatest(coalesce(p_limit, 1), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function app_private.public_sitemap_blog_posts(integer, integer) is
  'One page of blog post addresses, each with the locales it actually resolves in, ordered by slug. A post that is not published, not indexable or written in no language that resolves is absent, so this and the post''s own robots metadata always agree (0097, owner decisions 4 and 5).';

-- ---------------------------------------------------------------------------------------------------
-- 3. Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.public_sitemap_counts() from public, app_worker;
revoke execute on function app_private.public_sitemap_blog_posts(integer, integer) from public, app_worker;

-- `app_system` only, exactly as 0086 grants the other readers. The worker builds no sitemap.
grant execute on function app_private.public_sitemap_counts() to app_system;
grant execute on function app_private.public_sitemap_blog_posts(integer, integer) to app_system;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
