-- pgTAP — migration 0051: public search (Phase 4-F, V1).
--
-- Search is the surface where a visibility mistake is hardest to notice: a draft listing does not look
-- wrong in a result list, it just should not be there. So most of this file is about absence — what the
-- reader must never return — and the rest about the two properties the page depends on, a mixed result
-- set that keeps each surface's card fields, and an order stable enough to paginate through.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(48);

-- Fixtures ------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('b0000000-0000-4000-8000-000000000001', 'active@test.invalid'),
  ('b0000000-0000-4000-8000-000000000002', 'suspended@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, suspended_at, verification_status, verified_at)
values
  ('b0000000-0000-4000-8000-000000000001', 'good-shop', 'Good Shop', 'Good Shop LLC',
   'good@test.invalid', '+201000000001', 'EG', 'active', null, 'verified', now() - interval '10 days'),
  ('b0000000-0000-4000-8000-000000000002', 'gone-shop', 'Gone Shop', 'Gone Shop LLC',
   'gone@test.invalid', '+201000000002', 'EG', 'suspended', now() - interval '1 day',
   'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c1000000-0000-4000-8000-000000000001', null, 'furniture', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('c1000000-0000-4000-8000-000000000001', 'en', 'Furniture');

insert into public.tags (id, slug, name_en, name_ar) values
  ('f1000000-0000-4000-8000-000000000001', 'handmade', 'Handmade', 'صناعة يدوية');

/** One listing of either type, with the title and description the case needs. */
create or replace function pg_temp.listing(
  p_id uuid, p_slug text, p_type text, p_status text, p_seller uuid, p_price bigint,
  p_title text, p_description text, p_language text, p_created timestamptz
) returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at,
    approved_at, sold_at, archived_at, deleted_at
  ) values (
    p_id, p_seller, p_type, 'c1000000-0000-4000-8000-000000000001', p_slug,
    p_title, p_description, p_language,
    'EGP', p_price, false, p_status, 'EG', 'Cairo', p_created,
    case when p_status in ('approved','active','sold','expired','archived') then p_created else null end,
    case when p_status = 'sold' then p_created else null end,
    case when p_status = 'archived' then p_created else null end,
    case when p_status = 'deleted' then p_created else null end
  );
end;
$$;

-- Findable: a product and a service of the active seller, both mentioning "walnut".
select pg_temp.listing('11110000-0000-4000-8000-000000000001', 'walnut-table', 'product', 'active',
  'b0000000-0000-4000-8000-000000000001', 250000,
  'Walnut dining table', 'A solid walnut table seating six people.', 'en', now() - interval '1 hour');

select pg_temp.listing('22220000-0000-4000-8000-000000000001', 'walnut-restoration', 'service', 'active',
  'b0000000-0000-4000-8000-000000000001', 150000,
  'Walnut furniture restoration', 'We restore walnut furniture to its original finish.', 'en',
  now() - interval '2 hours');
insert into public.listing_service_details
  (listing_id, pricing_model, delivery_days, revisions_included, requires_brief, scope)
values ('22220000-0000-4000-8000-000000000001', 'fixed', 14::smallint, 1::smallint, false,
        'Collection, restoration and return.');

-- Findable only by a word in the description, never the title.
select pg_temp.listing('11110000-0000-4000-8000-000000000002', 'oak-shelf', 'product', 'approved',
  'b0000000-0000-4000-8000-000000000001', 50000,
  'Oak shelf', 'Finished with beeswax and entirely handmade.', 'en', now() - interval '3 hours');

-- Arabic content, findable through the Arabic configuration.
select pg_temp.listing('11110000-0000-4000-8000-000000000003', 'arabic-chair', 'product', 'active',
  'b0000000-0000-4000-8000-000000000001', 80000,
  'كرسي خشبي', 'كرسي مصنوع من خشب الجوز.', 'ar', now() - interval '4 hours');

-- Every state that must never be found, each mentioning "walnut" so only visibility can exclude them.
select pg_temp.listing('11110000-0000-4000-8000-000000000004', 'draft-walnut', 'product', 'draft',
  'b0000000-0000-4000-8000-000000000001', 10000, 'Draft walnut desk', 'A walnut desk.', 'en', now() - interval '5 hours');
select pg_temp.listing('11110000-0000-4000-8000-000000000005', 'pending-walnut', 'product', 'pending_review',
  'b0000000-0000-4000-8000-000000000001', 10000, 'Pending walnut stool', 'A walnut stool.', 'en', now() - interval '6 hours');
select pg_temp.listing('11110000-0000-4000-8000-000000000006', 'rejected-walnut', 'product', 'rejected',
  'b0000000-0000-4000-8000-000000000001', 10000, 'Rejected walnut bench', 'A walnut bench.', 'en', now() - interval '7 hours');
select pg_temp.listing('11110000-0000-4000-8000-000000000007', 'sold-walnut', 'product', 'sold',
  'b0000000-0000-4000-8000-000000000001', 10000, 'Sold walnut chest', 'A walnut chest.', 'en', now() - interval '8 hours');
select pg_temp.listing('11110000-0000-4000-8000-000000000008', 'archived-walnut', 'product', 'archived',
  'b0000000-0000-4000-8000-000000000001', 10000, 'Archived walnut rack', 'A walnut rack.', 'en', now() - interval '9 hours');
select pg_temp.listing('11110000-0000-4000-8000-000000000009', 'deleted-walnut', 'product', 'deleted',
  'b0000000-0000-4000-8000-000000000001', 10000, 'Deleted walnut crate', 'A walnut crate.', 'en', now() - interval '10 hours');
select pg_temp.listing('1111000a-0000-4000-8000-000000000001', 'suspended-walnut', 'product', 'active',
  'b0000000-0000-4000-8000-000000000002', 10000, 'Hidden walnut cabinet', 'A walnut cabinet.', 'en', now() - interval '11 hours');
select pg_temp.listing('2222000a-0000-4000-8000-000000000001', 'suspended-walnut-service', 'service', 'active',
  'b0000000-0000-4000-8000-000000000002', 10000, 'Hidden walnut service', 'Walnut care.', 'en', now() - interval '12 hours');

insert into public.listing_tags (listing_id, tag_id) values
  ('11110000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------------------------------
-- Boundary
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'public_search',
  array['text','text','integer','timestamptz','uuid'], 'app_private.public_search exists');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_search'
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'it is SECURITY DEFINER with the pinned search_path');

select ok(
  not has_function_privilege('public', 'app_private.public_search(text,text,integer,timestamptz,uuid)', 'execute'),
  'it is not executable by public');
select ok(
  has_function_privilege('app_system', 'app_private.public_search(text,text,integer,timestamptz,uuid)', 'execute'),
  'app_system may search');
select ok(
  not has_function_privilege('anon', 'app_private.public_search(text,text,integer,timestamptz,uuid)', 'execute'),
  'anon may not search');
select ok(
  not has_function_privilege('authenticated', 'app_private.public_search(text,text,integer,timestamptz,uuid)', 'execute'),
  'authenticated may not search directly either');

-- ---------------------------------------------------------------------------------------------------
-- The declared projection
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select a.name from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral unnest(p.proargnames, p.proargmodes) as a(name, mode)
     where n.nspname = 'app_private' and p.proname = 'public_search' and a.mode = 't'$$,
  $$values ('result_type'), ('id'), ('slug'), ('title'), ('city'), ('price_minor'), ('currency_code'),
           ('currency_minor_unit'), ('is_negotiable'), ('listing_type_code'), ('pricing_model'),
           ('delivery_days'), ('revisions_included'), ('created_at')$$,
  'the reader declares the two card projections and nothing else');

select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral unnest(coalesce(p.proargnames, array[]::text[])) as col(name)
    where n.nspname = 'app_private' and p.proname = 'public_search'
      and col.name in ('seller_user_id', 'status', 'description', 'location', 'view_count',
                       'contact_email', 'contact_phone_e164', 'legal_name', 'rank', 'score')),
  0::bigint,
  'no private, lifecycle, location or ranking column is declared');

-- ---------------------------------------------------------------------------------------------------
-- What search finds
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select slug from app_private.public_search('walnut', 'en', 50, null, null)$$,
  $$values ('walnut-table'), ('walnut-restoration')$$,
  'a query matches public products and services, and only those');

select is(
  (select result_type from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug = 'walnut-table'),
  'listing',
  'a product is typed as a listing');
select is(
  (select result_type from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug = 'walnut-restoration'),
  'service',
  'a service is typed as a service');

select is(
  (select count(*) from app_private.public_search('walnut', 'en', 50, null, null)),
  2::bigint,
  'the result set is mixed: both surfaces in one answer');

select set_eq(
  $$select slug from app_private.public_search('beeswax', 'en', 50, null, null)$$,
  $$values ('oak-shelf')$$,
  'a word only in the description is found');

select set_eq(
  $$select slug from app_private.public_search('shelf', 'en', 50, null, null)$$,
  $$values ('oak-shelf')$$,
  'a word only in the title is found');

select is(
  (select count(*) from app_private.public_search('restoration', 'en', 50, null, null)),
  1::bigint,
  'a service is findable by its own words');

select is(
  (select count(*) from app_private.public_search('nothingmatchesthis', 'en', 50, null, null)),
  0::bigint,
  'a query that matches nothing is an empty result, not an error');

-- English stemming is the configuration's, not ours: "restore" and "restoration" share a stem.
select is(
  (select count(*) from app_private.public_search('restore', 'en', 50, null, null)),
  1::bigint,
  'the English configuration stems, so a related form still matches');

-- ---------------------------------------------------------------------------------------------------
-- Locale-aware search
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select slug from app_private.public_search('كرسي', 'ar', 50, null, null)$$,
  $$values ('arabic-chair')$$,
  'an Arabic query searches the Arabic vector');

-- The locale really does select a different vector, and stemming is where that shows. The English
-- configuration stems English ("seating" is stored as "seat"); the Arabic one does not, storing Latin
-- words unchanged. So a stemmed English query matches under `en` and misses under `ar`.
--
-- Worth stating, because it will surprise someone: an English word spelled exactly *is* still findable
-- under the Arabic configuration, since both configurations tokenise Latin script. The configurations
-- differ in how they stem, not in which alphabets they index.
select is(
  (select count(*) from app_private.public_search('seat', 'en', 50, null, null)),
  1::bigint,
  'the English configuration stems "seating" to "seat", so a search for "seat" finds it');
select is(
  (select count(*) from app_private.public_search('seat', 'ar', 50, null, null)),
  0::bigint,
  'the Arabic configuration does not stem English, so the same query misses: the locale picks the vector');

select is(
  (select count(*) from app_private.public_search('walnut', null, 50, null, null)),
  2::bigint,
  'no locale means English, the default');
select is(
  (select count(*) from app_private.public_search('walnut', 'de', 50, null, null)),
  2::bigint,
  'an unknown locale means English too: a locale is a representation choice, not a filter');
select is(
  (select count(*) from app_private.public_search('seat', 'AR', 50, null, null)),
  0::bigint,
  'the locale is matched case-insensitively: AR behaves exactly as ar');

-- ---------------------------------------------------------------------------------------------------
-- What search must never find
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug in ('draft-walnut', 'pending-walnut', 'rejected-walnut', 'deleted-walnut')),
  0::bigint,
  'draft, pending, rejected and deleted listings are never found');

select is(
  (select count(*) from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug in ('sold-walnut', 'archived-walnut')),
  0::bigint,
  'sold and archived listings keep their pages but leave active search, as the specification requires');

select is(
  (select count(*) from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug in ('suspended-walnut', 'suspended-walnut-service')),
  0::bigint,
  'nothing belonging to a suspended seller is found, product or service');

select is(
  (select count(*) from app_private.public_search('cabinet', 'en', 50, null, null)),
  0::bigint,
  'a suspended seller''s listing is unreachable even by a word only it contains');
select is(
  (select count(*) from app_private.public_search('crate', 'en', 50, null, null)),
  0::bigint,
  'and so is a deleted one');

-- The set search admits is exactly the union of the two browse surfaces, by construction.
select set_eq(
  $$select slug from app_private.public_search('walnut', 'en', 50, null, null)
    union select slug from app_private.public_search('beeswax', 'en', 50, null, null)
    union select slug from app_private.public_search('كرسي', 'ar', 50, null, null)$$,
  $$select slug from app_private.public_listings(50, null, null)
    union select slug from app_private.public_services(50, null, null)$$,
  'everything findable is on a browse surface, and everything on one is findable');

-- ---------------------------------------------------------------------------------------------------
-- Ordering, limit and the cursor
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_agg(t.slug) from (select slug from app_private.public_search('walnut', 'en', 50, null, null)) t),
  array['walnut-table', 'walnut-restoration'],
  'results come back newest first — the provisional V1 order');

select is(
  (select count(*) from app_private.public_search('walnut', 'en', 1, null, null)),
  1::bigint,
  'the limit is honoured');
select is(
  (select count(*) from app_private.public_search('walnut', 'en', 0, null, null)),
  0::bigint,
  'a limit of zero returns nothing rather than everything');
select is(
  (select count(*) from app_private.public_search('walnut', 'en', null, null, null)),
  2::bigint,
  'a null limit falls back to the default rather than returning nothing');

select is(
  (select array_agg(t.slug) from (
     select s.slug from app_private.public_search(
       'walnut', 'en', 50,
       (select c.created_at from app_private.public_search('walnut', 'en', 50, null, null) c
         where c.slug = 'walnut-table'),
       (select c.id from app_private.public_search('walnut', 'en', 50, null, null) c
         where c.slug = 'walnut-table')
     ) s) t),
  array['walnut-restoration'],
  'a cursor continues strictly after the row it names, with no repeat and no gap');

select is(
  (select count(*) from app_private.public_search(
     'walnut', 'en', 50, now() - interval '100 years', '00000000-0000-4000-8000-000000000000')),
  0::bigint,
  'a cursor past the end of the results is an empty page');

select lives_ok(
  $$select * from app_private.public_search('walnut', 'en', 50, null, '00000000-0000-4000-8000-000000000000')$$,
  'a cursor id with no timestamp is ignored rather than an error');

-- ---------------------------------------------------------------------------------------------------
-- The card fields each surface carries
-- ---------------------------------------------------------------------------------------------------
select is(
  (select is_negotiable from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug = 'walnut-table'),
  false,
  'a listing result carries its negotiability');
select is(
  (select listing_type_code from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug = 'walnut-table'),
  'product',
  'a listing result carries its type code');
select is(
  (select pricing_model from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug = 'walnut-table'),
  null::text,
  'and no service field');

select is(
  (select pricing_model from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug = 'walnut-restoration'),
  'fixed',
  'a service result carries its pricing model');
select is(
  (select delivery_days from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug = 'walnut-restoration'),
  14::smallint,
  'a service result carries its delivery time');
select is(
  (select revisions_included from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug = 'walnut-restoration'),
  1::smallint,
  'a service result carries its revisions');
select is(
  (select is_negotiable from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug = 'walnut-restoration'),
  null::boolean,
  'and no listing field');
select is(
  (select listing_type_code from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug = 'walnut-restoration'),
  null::text,
  'including the type code, which the service card does not carry');

select is(
  (select currency_minor_unit from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.slug = 'walnut-table'),
  2::smallint,
  'the currency minor unit travels with every price');

-- ---------------------------------------------------------------------------------------------------
-- Nothing else reaches a result
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.public_search('walnut', 'en', 50, null, null) s
    where s.title like '%LLC%' or s.slug like '%@test.invalid%' or s.city like '%+2010%'),
  0::bigint,
  'no legal name, e-mail address or phone number appears in any returned field');

-- ---------------------------------------------------------------------------------------------------
-- No ranking, no promotions
-- ---------------------------------------------------------------------------------------------------
-- Phase 9 owns ranking. The function must not be reading promotion settings behind anyone's back.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_search'
      and (p.prosrc like '%promotion%' or p.prosrc like '%ts_rank%' or p.prosrc like '%similarity%')),
  0::bigint,
  'the search function reads no promotion setting and computes no rank');

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
select lives_ok(
  $$select app_private.assert_security_contract()$$,
  'the security contract still passes with the search reader in place');

select finish();
rollback;
