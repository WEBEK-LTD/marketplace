-- 0086 — Reading what `robots.txt` and the sitemaps need (public SEO delivery).
--
-- The public web owes crawlers two documents the specification's route map names and nobody has built:
-- `robots.ts` and `sitemap.ts` with `sitemaps/[type]/[page]` under it. D6 approves "locale-aware metadata and
-- sitemap"; the metadata half is built, this is the other half. Both documents are assembled in the web app,
-- and everything they state about the catalogue comes from here.
--
-- **No table of 0030 is changed, and no new table is created.** `seo_settings` has existed since 0030 with no
-- reader anywhere; this migration gives it one. Nothing is written.
--
-- ---------------------------------------------------------------------------------------------------
-- What belongs in a sitemap, and why none of it is decided here
-- ---------------------------------------------------------------------------------------------------
-- The specification states the rule per entity state, so these readers compose the predicates that already
-- express it rather than restating them:
--
--   `public.listing_status_is_purchasable(status)`  approved, active  — "in sitemaps and search"
--   `public.listing_status_is_public(status)`       also sold, expired, archived — publicly *viewable*, and
--                                                   every one of those three is "excluded from sitemaps"
--   `public.is_seller_publicly_visible(user_id)`    the seller's profile is active
--   `app_private.public_category_visible(id)`       active, and so is every ancestor
--   `public.cms_content_is_public(status, at)`      published, and the moment has arrived
--
-- So the sitemap predicate for a listing or a service is *purchasable* and not merely public: that is the
-- exact line the specification draws between "in sitemaps and search" and "excluded from sitemaps", and it
-- is why these readers call the purchasable helper and not the public one.
--
-- **`seo_metadata.robots_directives` is deliberately not read.** It exists in 0030 and has no reader
-- anywhere, no page honours it, and the admin console that would author it is not built. A sitemap that
-- excluded an address the page itself still advertises as indexable would be worse than one that does not
-- look: the two surfaces would disagree and nothing in the specification says which wins. State rules decide
-- here, and `pages.is_indexable` is read because the page metadata already honours it, so those two agree.
--
-- ---------------------------------------------------------------------------------------------------
-- Paging
-- ---------------------------------------------------------------------------------------------------
-- These readers page by limit and offset rather than by an opaque keyset cursor, which is the one place in
-- this repository that happens, and the route shape is the reason: the specification names
-- `sitemaps/[type]/[page]`, and a sitemap index has to address its children by number. Every set is ordered
-- by a unique key (`slug` is unique in each of the four tables), so a numbered page is stable and an entry
-- cannot be served twice or skipped while the page size holds.
--
-- ---------------------------------------------------------------------------------------------------
-- Locales
-- ---------------------------------------------------------------------------------------------------
-- A listing, service, category and seller profile is reachable in both locales whatever language its content
-- is in: the resolvers that decide their visibility take no locale, and the surfaces fall back. A CMS static
-- page is different — it is absent in a locale it has no translation for and cannot fall back to — so the page
-- reader returns the locales that actually resolve, and the sitemap builds alternates from that rather than
-- claiming an address that answers 404.

-- ---------------------------------------------------------------------------------------------------
-- 1. The robots body
-- ---------------------------------------------------------------------------------------------------
-- `seo_settings` is keyed by locale, while `robots.txt` is one document at the root of an origin. The default
-- locale's row is the one that answers, because that is the site's own default and `locales.is_default` is
-- unique. Zero rows is a normal answer, not a failure: nothing has been authored, and the web app then serves
-- a minimal correct document rather than inventing directives.
create or replace function app_private.public_robots_body()
returns table (
  locale_code text,
  robots_txt_body text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.locale_code, nullif(btrim(coalesce(s.robots_txt_body, '')), '')
    from public.seo_settings s
    join public.locales l on l.code = s.locale_code
   where l.is_default
   limit 1;
$$;

comment on function app_private.public_robots_body() is
  'The authored robots.txt body for the default locale, or no row when none is authored. Read-only; nothing here is private — the whole point of the column is to be served to crawlers.';

-- ---------------------------------------------------------------------------------------------------
-- 2. How many addresses of each kind there are
-- ---------------------------------------------------------------------------------------------------
-- What the sitemap index needs: one row per kind, with the number of entries that kind would produce, so the
-- index can name exactly the child sitemaps that exist. A kind with nothing in it still reports zero rather
-- than disappearing, so the caller never has to guess whether a kind is empty or unknown.
--
-- The counts are of *entries*, which for a page means the page and not its locales: a page produces one entry
-- carrying its alternates, which is what keeps a numbered page stable while alternates vary.
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
  'How many sitemap entries each kind of address would produce, so the sitemap index can name exactly the child sitemaps that exist. An empty kind reports zero rather than being absent.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The CMS static pages
-- ---------------------------------------------------------------------------------------------------
-- One row per page, with the locales in which that page actually resolves. A published page nobody has
-- written in any locale is absent, for the same reason it is absent by slug: there is nothing to name it
-- with. A page written only in Arabic resolves in Arabic alone — the public reader falls back to the default
-- locale and cannot fall the other way — so it is listed for Arabic only and the English address, which
-- answers 404, is never advertised.
--
-- `is_indexable` is the administrator's own decision and the page metadata already honours it, so a page
-- marked not indexable is absent here too and the two surfaces say the same thing.
create or replace function app_private.public_sitemap_pages(
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
    select p.id, p.slug, p.updated_at
      from public.pages p
     where public.cms_content_is_public(p.status, p.published_at)
       and p.is_indexable
  ), resolved as (
    select pb.id,
           pb.slug,
           pb.updated_at,
           array_agg(l.code order by l.sort_order, l.code) as locales
      from published pb
      join public.locales l on l.is_active
     where exists (
             select 1
               from public.page_translations t
              where t.page_id = pb.id
                and t.locale_code in (l.code, (select d.code from public.locales d where d.is_default))
           )
     group by pb.id, pb.slug, pb.updated_at
  )
  select r.slug, r.updated_at, r.locales
    from resolved r
   order by r.slug
   limit greatest(coalesce(p_limit, 1), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function app_private.public_sitemap_pages(integer, integer) is
  'One page of CMS static page addresses, each with the locales it actually resolves in, ordered by slug. A page that is not published, not indexable or written in no locale is absent.';

-- ---------------------------------------------------------------------------------------------------
-- 4. Products and services
-- ---------------------------------------------------------------------------------------------------
-- Two surfaces over one table and one slug namespace (0011, 0047), so they are two readers over the same
-- predicate with the type as the only difference. Purchasable, and the seller publicly visible: a sold,
-- expired or archived listing stays viewable at its address and is excluded from here, which is the whole
-- distinction between the two status helpers.
create or replace function app_private.public_sitemap_listings(
  p_limit integer,
  p_offset integer
) returns table (
  slug text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select l.slug, l.updated_at
    from public.listings l
   where l.listing_type_code = 'product'
     and public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
   order by l.slug
   limit greatest(coalesce(p_limit, 1), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function app_private.public_sitemap_listings(integer, integer) is
  'One page of product addresses for the sitemap: purchasable listings of a publicly visible seller, ordered by slug. Sold, expired and archived listings are excluded even though their pages stay public.';

create or replace function app_private.public_sitemap_services(
  p_limit integer,
  p_offset integer
) returns table (
  slug text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select l.slug, l.updated_at
    from public.listings l
   where l.listing_type_code = 'service'
     and public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
   order by l.slug
   limit greatest(coalesce(p_limit, 1), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function app_private.public_sitemap_services(integer, integer) is
  'One page of service addresses for the sitemap, under the same rule as products and over the same table, separated only by listing type.';

-- ---------------------------------------------------------------------------------------------------
-- 5. Category landing pages
-- ---------------------------------------------------------------------------------------------------
-- Active, with every ancestor active: 0049's rule, called rather than restated. A category deactivated above
-- a live one takes the whole branch out of the sitemap, which is the same answer its landing page gives.
create or replace function app_private.public_sitemap_categories(
  p_limit integer,
  p_offset integer
) returns table (
  slug text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select c.slug, c.updated_at
    from public.categories c
   where app_private.public_category_visible(c.id)
   order by c.slug
   limit greatest(coalesce(p_limit, 1), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function app_private.public_sitemap_categories(integer, integer) is
  'One page of category landing addresses: active categories whose every ancestor is active, ordered by slug.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Seller profiles
-- ---------------------------------------------------------------------------------------------------
-- The same predicate the profile page itself resolves through. A seller whose storefront is not publicly
-- visible is absent, so the sitemap never advertises a profile that answers "unavailable".
create or replace function app_private.public_sitemap_sellers(
  p_limit integer,
  p_offset integer
) returns table (
  slug text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.slug, s.updated_at
    from public.seller_profiles s
   where public.is_seller_publicly_visible(s.user_id)
   order by s.slug
   limit greatest(coalesce(p_limit, 1), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function app_private.public_sitemap_sellers(integer, integer) is
  'One page of seller profile addresses: profiles the public may see, ordered by slug.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.public_robots_body() from public;
revoke execute on function app_private.public_sitemap_counts() from public;
revoke execute on function app_private.public_sitemap_pages(integer, integer) from public;
revoke execute on function app_private.public_sitemap_listings(integer, integer) from public;
revoke execute on function app_private.public_sitemap_services(integer, integer) from public;
revoke execute on function app_private.public_sitemap_categories(integer, integer) from public;
revoke execute on function app_private.public_sitemap_sellers(integer, integer) from public;

-- `app_system` only. The worker builds no documents and serves no crawler; it reacts to the revalidation
-- events 0030's announce triggers already publish, and that needs no reader here.
grant execute on function app_private.public_robots_body() to app_system;
grant execute on function app_private.public_sitemap_counts() to app_system;
grant execute on function app_private.public_sitemap_pages(integer, integer) to app_system;
grant execute on function app_private.public_sitemap_listings(integer, integer) to app_system;
grant execute on function app_private.public_sitemap_services(integer, integer) to app_system;
grant execute on function app_private.public_sitemap_categories(integer, integer) to app_system;
grant execute on function app_private.public_sitemap_sellers(integer, integer) to app_system;

select app_private.assert_security_contract();
