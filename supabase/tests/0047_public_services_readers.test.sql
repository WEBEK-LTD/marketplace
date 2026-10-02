-- pgTAP — migration 0047: the public service readers and the listing/service split (Phase 4-C).
--
-- Services and products share one table and one slug namespace but now have two public surfaces. What
-- these assertions hold to account is the split itself: that each list admits only its own kind, that a
-- slug asked of the wrong surface is redirected rather than answered or denied, and that the service
-- projection carries the approved fields and nothing else.
--
-- The Phase 4-B regression is checked here too, because it is the same change: a product must still
-- reach `/listings`, and a service must no longer be able to.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(73);

-- Fixtures ------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('b0000000-0000-4000-8000-000000000001', 'active-seller@test.invalid'),
  ('b0000000-0000-4000-8000-000000000002', 'suspended-seller@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, suspended_at, verification_status, verified_at)
values
  ('b0000000-0000-4000-8000-000000000001', 'good-shop', 'Good Shop', 'Good Shop LLC',
   'seller@test.invalid', '+201000000001', 'EG', 'active', null, 'verified', now() - interval '10 days'),
  ('b0000000-0000-4000-8000-000000000002', 'gone-shop', 'Gone Shop', 'Gone Shop LLC',
   'gone@test.invalid', '+201000000002', 'EG', 'suspended', now() - interval '1 day',
   'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c1000000-0000-4000-8000-000000000001', null, 'design', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('c1000000-0000-4000-8000-000000000001', 'en', 'Design'),
  ('c1000000-0000-4000-8000-000000000001', 'ar', 'تصميم');

insert into public.attribute_definitions (id, key, data_type, unit, name_en, name_ar) values
  ('d1000000-0000-4000-8000-000000000001', 'turnaround', 'number', 'h', 'Turnaround', 'مدة التنفيذ');

insert into public.tags (id, slug, name_en, name_ar) values
  ('f1000000-0000-4000-8000-000000000001', 'remote', 'Remote', 'عن بُعد');

/** One listing of either type. */
create or replace function pg_temp.listing(
  p_id uuid, p_slug text, p_type text, p_status text, p_seller uuid, p_price bigint, p_created timestamptz
) returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at,
    approved_at, sold_at, archived_at, deleted_at
  ) values (
    p_id, p_seller, p_type, 'c1000000-0000-4000-8000-000000000001', p_slug,
    'A listing title', 'A description long enough to satisfy the length rule.', 'en',
    'EGP', p_price, false, p_status, 'EG', 'Cairo', p_created,
    case when p_status in ('approved','active','sold','expired','archived') then p_created else null end,
    case when p_status = 'sold' then p_created else null end,
    case when p_status = 'archived' then p_created else null end,
    case when p_status = 'deleted' then p_created else null end
  );
end;
$$;

/** The service-specific half of a service listing. */
create or replace function pg_temp.service_details(
  p_id uuid, p_model text, p_days smallint, p_revisions smallint, p_brief boolean, p_scope text
) returns void language plpgsql as $$
begin
  insert into public.listing_service_details
    (listing_id, pricing_model, delivery_days, revisions_included, requires_brief, scope)
  values (p_id, p_model, p_days, p_revisions, p_brief, p_scope);
end;
$$;

-- Services of the visible seller, newest first.
select pg_temp.listing('22220000-0000-4000-8000-000000000001', 'logo-design', 'service', 'active',
  'b0000000-0000-4000-8000-000000000001', 150000, now() - interval '1 hour');
select pg_temp.service_details('22220000-0000-4000-8000-000000000001', 'fixed', 5::smallint, 2::smallint,
  true, 'Three concepts, two rounds of revision, final files in SVG and PNG.');

-- A custom-priced service. It carries a price because `listings_live_needs_price` (0011) forbids a
-- live listing without one; the null-price projection is covered below through `closed-quote`, which is
-- archived and therefore allowed to have none. The live-and-priceless combination the owner described is
-- not representable in this schema, and is reported rather than worked around.
select pg_temp.listing('22220000-0000-4000-8000-000000000002', 'brand-audit', 'service', 'approved',
  'b0000000-0000-4000-8000-000000000001', 300000, now() - interval '2 hours');
select pg_temp.service_details('22220000-0000-4000-8000-000000000002', 'custom', null, 0::smallint,
  true, 'Scoped after a short brief.');

-- Archived, custom-priced and with no amount at all: the only shape in which a public service page can
-- currently reach "Contact for price".
select pg_temp.listing('22220000-0000-4000-8000-000000000008', 'closed-quote', 'service', 'archived',
  'b0000000-0000-4000-8000-000000000001', null, now() - interval '8 hours');
select pg_temp.service_details('22220000-0000-4000-8000-000000000008', 'custom', null, 0::smallint,
  false, 'Priced per engagement.');

select pg_temp.listing('22220000-0000-4000-8000-000000000003', 'old-site-build', 'service', 'sold',
  'b0000000-0000-4000-8000-000000000001', 900000, now() - interval '3 hours');
select pg_temp.service_details('22220000-0000-4000-8000-000000000003', 'fixed', 30::smallint, 1::smallint,
  false, 'A five-page marketing site.');

select pg_temp.listing('22220000-0000-4000-8000-000000000004', 'draft-service', 'service', 'draft',
  'b0000000-0000-4000-8000-000000000001', 10000, now() - interval '4 hours');
select pg_temp.listing('22220000-0000-4000-8000-000000000005', 'rejected-service', 'service', 'rejected',
  'b0000000-0000-4000-8000-000000000001', 10000, now() - interval '5 hours');
select pg_temp.listing('22220000-0000-4000-8000-000000000006', 'hidden-service', 'service', 'active',
  'b0000000-0000-4000-8000-000000000002', 10000, now() - interval '6 hours');
select pg_temp.service_details('22220000-0000-4000-8000-000000000006', 'fixed', 3::smallint, 0::smallint,
  false, 'Never publicly visible: the seller is suspended.');

-- A service with no details row at all, to prove the left join rather than an invented default.
select pg_temp.listing('22220000-0000-4000-8000-000000000007', 'bare-service', 'service', 'active',
  'b0000000-0000-4000-8000-000000000001', 5000, now() - interval '7 hours');

-- Products, which must stay on the listing surface.
select pg_temp.listing('11110000-0000-4000-8000-000000000001', 'sofa', 'product', 'active',
  'b0000000-0000-4000-8000-000000000001', 250000, now() - interval '90 minutes');

insert into public.listing_attribute_values (listing_id, attribute_definition_id, value_number) values
  ('22220000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 48);
insert into public.listing_tags (listing_id, tag_id) values
  ('22220000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001');

insert into public.listing_slug_history (listing_id, slug) values
  ('22220000-0000-4000-8000-000000000001', 'old-logo-design'),
  ('11110000-0000-4000-8000-000000000001', 'old-sofa'),
  ('22220000-0000-4000-8000-000000000005', 'old-rejected-service');

-- ---------------------------------------------------------------------------------------------------
-- Boundary
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'public_services', array['integer','timestamptz','uuid'],
  'app_private.public_services exists');
select has_function('app_private', 'public_service_by_slug', array['text','text'],
  'app_private.public_service_by_slug exists');
select has_function('app_private', 'public_listing_resolve', array['text'],
  'app_private.public_listing_resolve exists');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('public_services', 'public_service_by_slug', 'public_listing_resolve',
                        'public_listing_attributes', 'public_listing_tags')
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'every new reader is SECURITY DEFINER with the pinned search_path');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('public_services', 'public_service_by_slug', 'public_listing_resolve',
                        'public_listing_attributes', 'public_listing_tags')
      and has_function_privilege('public', p.oid, 'execute')),
  0::bigint,
  'no new reader is executable by public');

select ok(
  has_function_privilege('app_system', 'app_private.public_services(integer,timestamptz,uuid)', 'execute'),
  'app_system may read the service list');
select ok(
  has_function_privilege('app_system', 'app_private.public_service_by_slug(text,text)', 'execute'),
  'app_system may read a service by slug');
select ok(
  not has_function_privilege('anon', 'app_private.public_services(integer,timestamptz,uuid)', 'execute'),
  'anon may not read the service list');
select ok(
  not has_function_privilege('anon', 'app_private.public_service_by_slug(text,text)', 'execute'),
  'anon may not read a service by slug');

-- ---------------------------------------------------------------------------------------------------
-- The declared projection — what the functions can return at all
-- ---------------------------------------------------------------------------------------------------
-- `information_schema.columns` does not list OUT parameters, so the declaration is read from pg_proc.
select set_eq(
  $$select a.name from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral unnest(p.proargnames, p.proargmodes) as a(name, mode)
     where n.nspname = 'app_private' and p.proname = 'public_services' and a.mode = 't'$$,
  $$values ('id'), ('slug'), ('title'), ('city'), ('price_minor'), ('currency_code'),
           ('currency_minor_unit'), ('pricing_model'), ('delivery_days'), ('revisions_included'),
           ('created_at')$$,
  'the service list declares the approved card columns and nothing else');

select set_eq(
  $$select a.name from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral unnest(p.proargnames, p.proargmodes) as a(name, mode)
     where n.nspname = 'app_private' and p.proname = 'public_service_by_slug' and a.mode = 't'$$,
  $$values ('outcome'), ('canonical_slug'), ('canonical_type'), ('id'), ('slug'), ('title'),
           ('description'), ('content_language'), ('city'), ('price_minor'), ('currency_code'),
           ('currency_minor_unit'), ('pricing_model'), ('delivery_days'), ('revisions_included'),
           ('requires_brief'), ('scope'), ('availability'), ('category'), ('seller'), ('attributes'),
           ('tags')$$,
  'the service detail declares the approved projection and nothing else');

-- The fields the owner named as never public are not among the declared columns of either reader.
select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral unnest(coalesce(p.proargnames, array[]::text[])) as col(name)
    where n.nspname = 'app_private'
      and p.proname in ('public_services', 'public_service_by_slug')
      and col.name in ('seller_user_id', 'legal_name', 'contact_email', 'contact_phone_e164',
                       'verification_status', 'view_count', 'location', 'status', 'deleted_at',
                       'approved_at', 'rejection_reason')),
  0::bigint,
  'no private or lifecycle column is declared by any service reader');

-- ---------------------------------------------------------------------------------------------------
-- Which services the list admits
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select slug from app_private.public_services(50, null, null)$$,
  $$values ('logo-design'), ('brand-audit'), ('bare-service')$$,
  'the service list shows purchasable services of visible sellers, and only those');

select is(
  (select count(*) from app_private.public_services(50, null, null) s
    where s.slug in ('old-site-build', 'draft-service', 'rejected-service', 'hidden-service')),
  0::bigint,
  'sold, draft, rejected and suspended-seller services are all absent from the list');

select is(
  (select count(*) from app_private.public_services(50, null, null) s where s.slug = 'sofa'),
  0::bigint,
  'a product never appears on the service list');

-- ---------------------------------------------------------------------------------------------------
-- The Phase 4-B regression: the listing surface is products only
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select slug from app_private.public_listings(50, null, null)$$,
  $$values ('sofa')$$,
  'the listing list still shows the product');

select is(
  (select count(*) from app_private.public_listings(50, null, null) l
    where l.slug in ('logo-design', 'brand-audit', 'bare-service')),
  0::bigint,
  'no service appears on the listing list any more');

select is(
  (select count(*) from app_private.public_listings(50, null, null) l where l.listing_type_code = 'service'),
  0::bigint,
  'the listing list carries no service-typed row at all');

-- ---------------------------------------------------------------------------------------------------
-- Ordering, limit and the cursor
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_agg(t.slug) from (select slug from app_private.public_services(50, null, null)) t),
  array['logo-design', 'brand-audit', 'bare-service'],
  'services come back newest first');

select is(
  (select count(*) from app_private.public_services(2, null, null)),
  2::bigint,
  'the limit is honoured');

select is(
  (select count(*) from app_private.public_services(0, null, null)),
  0::bigint,
  'a limit of zero returns nothing rather than everything');

select is(
  (select array_agg(t.slug) from (
     select s.slug from app_private.public_services(
       50,
       (select c.created_at from app_private.public_services(50, null, null) c where c.slug = 'logo-design'),
       (select c.id from app_private.public_services(50, null, null) c where c.slug = 'logo-design')
     ) s) t),
  array['brand-audit', 'bare-service'],
  'a cursor continues strictly after the row it names, with no repeat and no gap');

select lives_ok(
  $$select * from app_private.public_services(20, now() - interval '100 years', '00000000-0000-4000-8000-000000000000')$$,
  'a cursor past the end of the catalogue is an empty page, not an error');

-- ---------------------------------------------------------------------------------------------------
-- The service card's own fields
-- ---------------------------------------------------------------------------------------------------
select is(
  (select s.pricing_model from app_private.public_services(50, null, null) s where s.slug = 'logo-design'),
  'fixed',
  'a fixed-price service says so on the card');
select is(
  (select s.delivery_days from app_private.public_services(50, null, null) s where s.slug = 'logo-design'),
  5::smallint,
  'the delivery time is on the card');
select is(
  (select s.revisions_included from app_private.public_services(50, null, null) s where s.slug = 'logo-design'),
  2::smallint,
  'the revisions included are on the card');
select is(
  (select s.currency_minor_unit from app_private.public_services(50, null, null) s where s.slug = 'logo-design'),
  2::smallint,
  'the currency minor unit travels with the price');

select is(
  (select price_minor from app_private.public_service_by_slug('closed-quote')),
  null::bigint,
  'a service with no amount projects a null price, which is what "Contact for price" renders from');
select is(
  (select pricing_model from app_private.public_service_by_slug('closed-quote')),
  'custom',
  'and still says how it is priced');
select is(
  (select s.pricing_model from app_private.public_services(50, null, null) s where s.slug = 'brand-audit'),
  'custom',
  'a custom-priced service is still listed, and says how it is priced');
select is(
  (select s.delivery_days from app_private.public_services(50, null, null) s where s.slug = 'brand-audit'),
  null::smallint,
  'a custom-priced service may state no delivery time');

select is(
  (select s.pricing_model from app_private.public_services(50, null, null) s where s.slug = 'bare-service'),
  null::text,
  'a service with no details row states no pricing model rather than an invented one');

-- ---------------------------------------------------------------------------------------------------
-- The detail reader
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.public_service_by_slug('logo-design')),
  'found',
  'a live service resolves');
select is(
  (select availability from app_private.public_service_by_slug('logo-design')),
  'available',
  'a purchasable service is available');
select is(
  (select availability from app_private.public_service_by_slug('old-site-build')),
  'no_longer_available',
  'a sold service keeps its page and is marked no longer available');
select is(
  (select outcome from app_private.public_service_by_slug('old-site-build')),
  'found',
  'a sold service is still found, not hidden');

select is(
  (select scope from app_private.public_service_by_slug('logo-design')),
  'Three concepts, two rounds of revision, final files in SVG and PNG.',
  'the scope is part of the detail projection');
select is(
  (select requires_brief from app_private.public_service_by_slug('logo-design')),
  true,
  'the brief requirement is part of the detail projection');
select is(
  (select delivery_days from app_private.public_service_by_slug('logo-design')),
  5::smallint,
  'the delivery time is part of the detail projection');
select is(
  (select revisions_included from app_private.public_service_by_slug('logo-design')),
  2::smallint,
  'the revisions included are part of the detail projection');

select is(
  (select seller from app_private.public_service_by_slug('logo-design')),
  jsonb_build_object('slug', 'good-shop', 'displayName', 'Good Shop'),
  'the seller projection is the display name and the slug, and nothing else');

select is(
  (select category ->> 'name' from app_private.public_service_by_slug('logo-design', 'ar')),
  'تصميم',
  'the category name follows the locale asked for');
select is(
  (select category ->> 'name' from app_private.public_service_by_slug('logo-design', 'en')),
  'Design',
  'and the English name in English');

select is(
  (select a ->> 'label' from app_private.public_service_by_slug('logo-design', 'ar'),
        jsonb_array_elements(attributes) a where a ->> 'key' = 'turnaround'),
  'مدة التنفيذ',
  'attribute labels are localized on the service surface too');
select is(
  (select a ->> 'text' from app_private.public_service_by_slug('logo-design'),
        jsonb_array_elements(attributes) a where a ->> 'key' = 'turnaround'),
  '48',
  'a whole-number attribute keeps its digits');
select is(
  (select t ->> 'name' from app_private.public_service_by_slug('logo-design'),
        jsonb_array_elements(tags) t),
  'Remote',
  'tags reach the service detail');

-- ---------------------------------------------------------------------------------------------------
-- Non-public states
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.public_service_by_slug('draft-service')),
  'not_found',
  'a draft service is not found');
select is(
  (select outcome from app_private.public_service_by_slug('rejected-service')),
  'not_found',
  'a rejected service is not found');
select is(
  (select outcome from app_private.public_service_by_slug('hidden-service')),
  'not_found',
  'a service of a suspended seller is not found');
select is(
  (select outcome from app_private.public_service_by_slug('no-such-service')),
  'not_found',
  'a slug that names nothing is not found');
select is(
  (select outcome from app_private.public_service_by_slug('old-rejected-service')),
  'not_found',
  'a previous slug of a non-public service is not found, never a redirect that reveals it exists');

select is(
  (select count(*) from app_private.public_service_by_slug('draft-service') s
    where s.title is not null or s.scope is not null or s.seller is not null),
  0::bigint,
  'a not-found answer carries no field of the listing it refused');

-- ---------------------------------------------------------------------------------------------------
-- Historical slugs and the cross-surface redirect
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.public_service_by_slug('old-logo-design')),
  'moved',
  'a previous slug of a live service is a redirect');
select is(
  (select canonical_slug from app_private.public_service_by_slug('old-logo-design')),
  'logo-design',
  'and it names the current slug');
select is(
  (select canonical_type from app_private.public_service_by_slug('old-logo-design')),
  'service',
  'and says the service surface owns it');

select is(
  (select outcome from app_private.public_listing_by_slug('logo-design')),
  'moved',
  'a service asked for on the listing surface is a redirect, not a page');
select is(
  (select canonical_slug from app_private.public_listing_by_slug('logo-design')),
  'logo-design',
  'the redirect keeps the slug');
select is(
  (select canonical_type from app_private.public_listing_by_slug('logo-design')),
  'service',
  'and names the service surface as its home');
select is(
  (select count(*) from app_private.public_listing_by_slug('logo-design') l
    where l.title is not null or l.description is not null or l.seller is not null),
  0::bigint,
  'that redirect carries none of the service it points at');

select is(
  (select outcome from app_private.public_service_by_slug('sofa')),
  'moved',
  'a product asked for on the service surface is a redirect, not a page');
select is(
  (select canonical_type from app_private.public_service_by_slug('sofa')),
  'product',
  'and names the listing surface as its home');

select is(
  (select outcome from app_private.public_listing_by_slug('old-sofa')),
  'moved',
  'a previous product slug still redirects on the listing surface');
select is(
  (select canonical_type from app_private.public_listing_by_slug('old-sofa')),
  'product',
  'and still belongs to the listing surface');
select is(
  (select outcome from app_private.public_listing_by_slug('sofa')),
  'found',
  'the product itself still resolves on the listing surface');
select is(
  (select canonical_type from app_private.public_listing_by_slug('sofa')),
  'product',
  'and reports its own type');

select is(
  (select outcome from app_private.public_listing_by_slug('old-logo-design')),
  'moved',
  'a previous service slug asked on the listing surface is still a redirect');
select is(
  (select canonical_type from app_private.public_listing_by_slug('old-logo-design')),
  'service',
  'pointing at the service surface, so one slug never has two canonical URLs');

-- ---------------------------------------------------------------------------------------------------
-- The shared resolver
-- ---------------------------------------------------------------------------------------------------
select is(
  (select listing_type_code from app_private.public_listing_resolve('logo-design')),
  'service',
  'the resolver names the type of a current slug');
select is(
  (select outcome from app_private.public_listing_resolve('old-sofa')),
  'moved',
  'the resolver reports a previous slug as moved');
select is(
  (select canonical_slug from app_private.public_listing_resolve('old-sofa')),
  'sofa',
  'and names the current slug');
select is(
  (select outcome from app_private.public_listing_resolve('hidden-service')),
  'not_found',
  'the resolver refuses a listing of a suspended seller');
select is(
  (select listing_type_code from app_private.public_listing_resolve('hidden-service')),
  null::text,
  'and names no type for something it refused');

-- ---------------------------------------------------------------------------------------------------
-- Nothing private reaches a service answer
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.public_service_by_slug('logo-design') s
    where s.seller::text like '%Good Shop LLC%'
       or s.seller::text like '%seller@test.invalid%'
       or s.seller::text like '%+201000000001%'
       or s.seller::text like '%verified%'
       or s.seller::text like '%b0000000%'),
  0::bigint,
  'the legal name, contact details, verification status and seller id are absent from the projection');

select finish();
rollback;
