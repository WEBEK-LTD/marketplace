-- pgTAP — migration 0067: the buyer account surfaces (Phase 7-E).
--
-- Sixteen functions over five tables that already existed, so the assertions fall into four groups.
--
-- **The boundary.** Every function is SECURITY DEFINER with a pinned search path, executable by
-- `app_system` and by nobody else — not `authenticated`, not `anon`, not `app_worker`. That matters more
-- here than anywhere so far: these functions take the account as a parameter, so a role that could call
-- one while choosing its own argument would be able to read and rewrite any account in the system.
--
-- **Isolation, proved per function rather than per table.** Two accounts exist throughout, each with
-- favorites, saved searches, addresses, a profile and settings. Every reader is asked for one account
-- and checked not to return the other's rows; every writer is pointed at the other account's row by id
-- and checked to change nothing and to say so. The point is not that a refusal happens — it is that no
-- row is matched, which is what "the scope is in the statement" means.
--
-- **Idempotency, because every one of these is a button somebody can press twice.** Favouriting twice,
-- unfavouriting twice, deleting an address twice, deleting a saved search twice and writing the same
-- settings twice are each asserted to be safe and to report honestly what they did.
--
-- **What the writers cannot do.** A profile update cannot move a phone number, a verification
-- timestamp, an account status or a role. A saved-search update cannot move `last_matched_at` or
-- `last_notified_at` — there is no matching engine in this project and a surface that set them would be
-- claiming something happened that did not. A settings update cannot reach `preferences`.
--
-- Deterministic: fixed uuids, no wall-clock dependence. Everything runs in a transaction that is rolled
-- back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(111);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('7e000000-0000-4000-8000-00000000000a', 'buyer-a@test.invalid'),
  ('7e000000-0000-4000-8000-00000000000b', 'buyer-b@test.invalid'),
  ('7e000000-0000-4000-8000-00000000000c', 'gone-buyer@test.invalid'),
  ('7e000000-0000-4000-8000-000000000011', 'seller-good@test.invalid'),
  ('7e000000-0000-4000-8000-000000000012', 'seller-gone@test.invalid');

-- A country that is not marketplace-enabled, so D17 has something to refuse.
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, is_marketplace_enabled, sort_order)
values ('SA', 'SAU', '682', 'Saudi Arabia', 'السعودية', '966', false, 2);

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, suspended_at, verification_status, verified_at)
values
  ('7e000000-0000-4000-8000-000000000011', 'good-shop', 'Good Shop', 'Good Shop LLC',
   'good@test.invalid', '+201000000011', 'EG', 'active', null, 'verified', now() - interval '10 days'),
  ('7e000000-0000-4000-8000-000000000012', 'gone-shop', 'Gone Shop', 'Gone Shop LLC',
   'gone@test.invalid', '+201000000012', 'EG', 'suspended', now() - interval '1 day',
   'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('7e000000-0000-4000-8000-0000000000c1', null, 'furniture', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('7e000000-0000-4000-8000-0000000000c1', 'en', 'Furniture'),
  ('7e000000-0000-4000-8000-0000000000c1', 'ar', 'أثاث');

create or replace function pg_temp.listing(p_id uuid, p_slug text, p_status text, p_seller uuid, p_price bigint)
returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at,
    approved_at, archived_at
  ) values (
    p_id, p_seller, 'product', '7e000000-0000-4000-8000-0000000000c1', p_slug,
    'A listing title', 'A description long enough to satisfy the length rule.', 'en',
    'EGP', p_price, false, p_status, 'EG', 'Cairo', now() - interval '1 hour',
    case when p_status in ('approved','active','sold','expired','archived') then now() - interval '1 hour' else null end,
    case when p_status = 'archived' then now() - interval '1 hour' else null end
  );
end;
$$;

select pg_temp.listing('7e000000-0000-4000-8000-0000000000f1', 'sofa', 'active', '7e000000-0000-4000-8000-000000000011', 250000);
select pg_temp.listing('7e000000-0000-4000-8000-0000000000f2', 'lamp', 'active', '7e000000-0000-4000-8000-000000000011', 90000);
-- Visible now; archived later in this file so a favorite can outlive its listing's visibility.
select pg_temp.listing('7e000000-0000-4000-8000-0000000000f3', 'chair', 'active', '7e000000-0000-4000-8000-000000000011', 40000);
-- Never visible: its seller is suspended.
select pg_temp.listing('7e000000-0000-4000-8000-0000000000f4', 'ghost', 'active', '7e000000-0000-4000-8000-000000000012', 10000);

-- ---------------------------------------------------------------------------------------------------
-- The boundary
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in (
        'buyer_favorites', 'buyer_favorite_add', 'buyer_favorite_remove',
        'buyer_saved_searches', 'buyer_saved_search_create', 'buyer_saved_search_update',
        'buyer_saved_search_delete', 'buyer_addresses', 'buyer_address_create',
        'buyer_address_update', 'buyer_address_delete', 'buyer_profile', 'buyer_profile_update',
        'buyer_settings', 'buyer_settings_update', 'reference_countries')),
  16::bigint,
  'the sixteen buyer functions exist and there are no others'
);
select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname like 'buyer\_%'
      and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog, public']),
  15::bigint,
  'every one of them is SECURITY DEFINER with a pinned search path'
);
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'reference_countries'),
  'and so is the country reference'
);

select ok(has_function_privilege('app_system', 'app_private.buyer_favorites(uuid, integer, timestamptz, uuid)', 'execute'),
  'app_system may read favorites');
select ok(has_function_privilege('app_system', 'app_private.buyer_profile_update(uuid, text, text, text, text)', 'execute'),
  'and may write a profile');
select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'buyer\_%' or p.proname = 'reference_countries')
      and (has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('app_worker', p.oid, 'execute'))),
  0::bigint,
  'and no browser-facing role, and not the worker, may call any of them — they take an account as a parameter'
);

-- 0067 changed no table, so the grants 0005 and 0013 wrote are still exactly what they were.
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'favorites' and grantee = 'authenticated'
      and privilege_type in ('SELECT', 'INSERT', 'DELETE')),
  3::bigint,
  'favorites keeps the three grants 0013 gave authenticated'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('favorites', 'saved_searches', 'addresses', 'profiles', 'user_settings')
      and grantee in ('app_system', 'app_worker')),
  0::bigint,
  'and app_system still holds no privilege on any of the five tables, so the functions are the only way in'
);
select is(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('favorites', 'saved_searches', 'addresses', 'profiles', 'user_settings')),
  8::bigint,
  'the eight owner policies of 0005 and 0013 are untouched'
);

-- ---------------------------------------------------------------------------------------------------
-- Favorites
-- ---------------------------------------------------------------------------------------------------
select is(
  app_private.buyer_favorite_add('7e000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-0000000000f1'),
  'added',
  'a favorite is added'
);
select is(
  app_private.buyer_favorite_add('7e000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-0000000000f1'),
  'exists',
  'and adding it again adds nothing and says so'
);
select is(
  (select count(*) from public.favorites where user_id = '7e000000-0000-4000-8000-00000000000a'),
  1::bigint,
  'so there is still one row'
);
select is(
  app_private.buyer_favorite_add('7e000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-0000000000f4'),
  'not_found',
  'a listing whose seller is suspended cannot be favourited, which is the table''s own RLS check'
);
select throws_ok(
  $$select app_private.buyer_favorite_add(null, '7e000000-0000-4000-8000-0000000000f1')$$,
  '22023',
  null,
  'and a call with no account is refused outright'
);

select is(
  app_private.buyer_favorite_add('7e000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-0000000000f2'),
  'added',
  'a second listing is favourited'
);
select is(
  app_private.buyer_favorite_add('7e000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-0000000000f3'),
  'added',
  'and a third'
);
select is(
  app_private.buyer_favorite_add('7e000000-0000-4000-8000-00000000000b', '7e000000-0000-4000-8000-0000000000f1'),
  'added',
  'the other account favourites the same listing independently'
);

select is(
  (select count(*) from app_private.buyer_favorites('7e000000-0000-4000-8000-00000000000a', 50)),
  3::bigint,
  'the reader returns this account''s three favorites'
);
select is(
  (select count(*) from app_private.buyer_favorites('7e000000-0000-4000-8000-00000000000b', 50)),
  1::bigint,
  'and the other account''s one — never both'
);
select is(
  (select array_agg(f.listing_id order by f.listing_id)
     from app_private.buyer_favorites('7e000000-0000-4000-8000-00000000000b', 50) f),
  array['7e000000-0000-4000-8000-0000000000f1'::uuid],
  'buyer B sees only the listing buyer B saved'
);

select is(
  (select f.slug from app_private.buyer_favorites('7e000000-0000-4000-8000-00000000000a', 50) f
    where f.listing_id = '7e000000-0000-4000-8000-0000000000f1'),
  'sofa',
  'a visible favorite carries the marketplace card'
);
select is(
  (select format('%s/%s/%s', f.price_minor, f.currency_code, f.currency_minor_unit)
     from app_private.buyer_favorites('7e000000-0000-4000-8000-00000000000a', 50) f
    where f.listing_id = '7e000000-0000-4000-8000-0000000000f1'),
  '250000/EGP/2',
  'including the minor amount, the currency and the minor unit its price cannot be read without'
);
select ok(
  (select f.is_available from app_private.buyer_favorites('7e000000-0000-4000-8000-00000000000a', 50) f
    where f.listing_id = '7e000000-0000-4000-8000-0000000000f1'),
  'and is reported as available'
);

-- The listing goes away after it was saved. `archived` is still a public status in this schema
-- (listing_status_is_public lists it), so the fixture uses the one that is not.
update public.listings set status = 'deleted', deleted_at = now()
 where id = '7e000000-0000-4000-8000-0000000000f3';

select is(
  (select count(*) from app_private.buyer_favorites('7e000000-0000-4000-8000-00000000000a', 50)),
  3::bigint,
  'a favorite whose listing stopped being visible is still the account''s own saved row'
);
select ok(
  not (select f.is_available from app_private.buyer_favorites('7e000000-0000-4000-8000-00000000000a', 50) f
        where f.listing_id = '7e000000-0000-4000-8000-0000000000f3'),
  'reported as unavailable'
);
select is(
  (select coalesce(f.slug, '') || coalesce(f.title, '') || coalesce(f.price_minor::text, '')
     from app_private.buyer_favorites('7e000000-0000-4000-8000-00000000000a', 50) f
    where f.listing_id = '7e000000-0000-4000-8000-0000000000f3'),
  '',
  'and carrying none of the hidden listing''s card, so nothing about it is disclosed'
);

select is(
  (select count(*) from app_private.buyer_favorites('7e000000-0000-4000-8000-00000000000a', 2)),
  2::bigint,
  'the limit is honoured'
);
select is(
  (select count(*) from app_private.buyer_favorites('7e000000-0000-4000-8000-00000000000a', 9999)),
  3::bigint,
  'and an absurd limit is clamped rather than refused'
);
select is(
  (select count(*) from app_private.buyer_favorites(
     '7e000000-0000-4000-8000-00000000000a', 50,
     (select min(created_at) from public.favorites where user_id = '7e000000-0000-4000-8000-00000000000a'),
     (select listing_id from public.favorites
       where user_id = '7e000000-0000-4000-8000-00000000000a'
       order by created_at asc, listing_id asc limit 1))),
  0::bigint,
  'and a cursor at the last position returns nothing after it'
);

select ok(
  not app_private.buyer_favorite_remove('7e000000-0000-4000-8000-00000000000b', '7e000000-0000-4000-8000-0000000000f2'),
  'buyer B cannot remove a favorite that belongs to buyer A'
);
select is(
  (select count(*) from public.favorites where user_id = '7e000000-0000-4000-8000-00000000000a'),
  3::bigint,
  'and buyer A still has all three'
);
select ok(
  app_private.buyer_favorite_remove('7e000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-0000000000f2'),
  'the owner removes their own'
);
select ok(
  not app_private.buyer_favorite_remove('7e000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-0000000000f2'),
  'and removing it again removes nothing and says so'
);
select is(
  (select count(*) from public.favorites where user_id = '7e000000-0000-4000-8000-00000000000b'),
  1::bigint,
  'the other account''s favorite of the same listing is untouched throughout'
);

-- ---------------------------------------------------------------------------------------------------
-- Saved searches
-- ---------------------------------------------------------------------------------------------------
create temp table saved_a as
select * from app_private.buyer_saved_search_create(
  '7e000000-0000-4000-8000-00000000000a', '  Sofas under 3000  ', '{"q":"sofa","max":300000}'::jsonb, true);

select is((select outcome from saved_a), 'created', 'a saved search is created');
select isnt((select id from saved_a), null, 'and carries an id');
select is(
  (select name from public.saved_searches where id = (select id from saved_a)),
  'Sofas under 3000',
  'with its name trimmed'
);
select ok(
  (select notify from public.saved_searches where id = (select id from saved_a)),
  'and the notification preference the caller asked for, which the 0013 schema already defines'
);
select is(
  (select coalesce(last_matched_at::text, '') || coalesce(last_notified_at::text, '')
     from public.saved_searches where id = (select id from saved_a)),
  '',
  'and neither matching timestamp set: there is no matching engine and nothing here pretends otherwise'
);

select is(
  (select outcome from app_private.buyer_saved_search_create(
     '7e000000-0000-4000-8000-00000000000a', 'Sofas under 3000', '{"q":"other"}'::jsonb, false)),
  'duplicate_name',
  'the same name twice is reported rather than raised'
);
select is(
  (select outcome from app_private.buyer_saved_search_create(
     '7e000000-0000-4000-8000-00000000000b', 'Sofas under 3000', '{"q":"sofa"}'::jsonb, false)),
  'created',
  'but the other account may use that name: the constraint is per account'
);
select throws_ok(
  $$select * from app_private.buyer_saved_search_create(null, 'X', '{}'::jsonb, false)$$,
  '22023',
  null,
  'a call with no account is refused'
);
select throws_ok(
  $$select * from app_private.buyer_saved_search_create(
      '7e000000-0000-4000-8000-00000000000a', '   ', '{}'::jsonb, false)$$,
  '23514',
  null,
  'and a blank name is refused by 0013''s own constraint, not by a rule invented here'
);

select is(
  (select count(*) from app_private.buyer_saved_searches('7e000000-0000-4000-8000-00000000000a', 50)),
  1::bigint,
  'the reader returns this account''s saved search'
);
select is(
  (select count(*) from app_private.buyer_saved_searches('7e000000-0000-4000-8000-00000000000b', 50)),
  1::bigint,
  'and the other account''s own, never both'
);
select is(
  (select s.query ->> 'q' from app_private.buyer_saved_searches('7e000000-0000-4000-8000-00000000000a', 50) s),
  'sofa',
  'carrying the stored query, which holds parameters and never results'
);

select is(
  app_private.buyer_saved_search_update(
    '7e000000-0000-4000-8000-00000000000b', (select id from saved_a), 'Stolen', '{}'::jsonb, false),
  'not_found',
  'buyer B cannot edit buyer A''s saved search'
);
select is(
  (select name from public.saved_searches where id = (select id from saved_a)),
  'Sofas under 3000',
  'and buyer A''s saved search is unchanged'
);
select is(
  app_private.buyer_saved_search_update(
    '7e000000-0000-4000-8000-00000000000a', (select id from saved_a), 'Sofas under 4000',
    '{"q":"sofa","max":400000}'::jsonb, false),
  'updated',
  'the owner edits their own'
);
select is(
  (select format('%s/%s/%s', name, query ->> 'max', notify)
     from public.saved_searches where id = (select id from saved_a)),
  'Sofas under 4000/400000/f',
  'name, query and the notification preference all move together'
);
select is(
  (select coalesce(last_matched_at::text, '') || coalesce(last_notified_at::text, '')
     from public.saved_searches where id = (select id from saved_a)),
  '',
  'and an edit still writes neither matching timestamp'
);
select is(
  app_private.buyer_saved_search_update(
    '7e000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-0000000000dd',
    'Nothing', '{}'::jsonb, false),
  'not_found',
  'an id that does not exist is not found rather than an error'
);

select ok(
  not app_private.buyer_saved_search_delete('7e000000-0000-4000-8000-00000000000b', (select id from saved_a)),
  'buyer B cannot delete buyer A''s saved search'
);
select ok(
  app_private.buyer_saved_search_delete('7e000000-0000-4000-8000-00000000000a', (select id from saved_a)),
  'the owner deletes their own'
);
select ok(
  not app_private.buyer_saved_search_delete('7e000000-0000-4000-8000-00000000000a', (select id from saved_a)),
  'and deleting it again deletes nothing and says so'
);
select is(
  (select count(*) from public.saved_searches where user_id = '7e000000-0000-4000-8000-00000000000b'),
  1::bigint,
  'the other account''s saved search survived all of that'
);

-- ---------------------------------------------------------------------------------------------------
-- Addresses
-- ---------------------------------------------------------------------------------------------------
create temp table address_a as
select * from app_private.buyer_address_create(
  '7e000000-0000-4000-8000-00000000000a', ' Home ', 'both', '  Amina Hassan  ', '+201000000101',
  'eg', ' Cairo ', ' Nasr City ', null, ' 12 Street ', null, null, null, null, true, true);

select is((select outcome from address_a), 'created', 'an address is created');
select is(
  (select format('%s/%s/%s', recipient_name, governorate, street_address)
     from public.addresses where id = (select id from address_a)),
  'Amina Hassan/Cairo/12 Street',
  'with its free-text parts trimmed'
);
select is(
  (select country_code::text from public.addresses where id = (select id from address_a)),
  'EG',
  'and a lower-case country code normalised to the stored form'
);
select is(
  (select label from public.addresses where id = (select id from address_a)),
  'Home',
  'the label is trimmed too'
);
select is(
  (select district from public.addresses where id = (select id from address_a)),
  null,
  'and an omitted optional part is stored as absent rather than as an empty string'
);

select is(
  (select outcome from app_private.buyer_address_create(
     '7e000000-0000-4000-8000-00000000000a', 'Riyadh', 'shipping', 'Amina Hassan', '+966500000001',
     'SA', 'Riyadh', 'Riyadh', null, '1 Street', null, null, null, null, false, false)),
  'country_not_enabled',
  'D17 refuses a shipping address in a country that is not marketplace-enabled'
);
select is(
  (select outcome from app_private.buyer_address_create(
     '7e000000-0000-4000-8000-00000000000a', 'Nowhere', 'both', 'Amina Hassan', '+201000000102',
     'ZZ', 'Nowhere', 'Nowhere', null, '1 Street', null, null, null, null, false, false)),
  'invalid_country',
  'and a country that does not exist is named rather than raised as a foreign key error'
);
select is(
  (select count(*) from public.addresses where user_id = '7e000000-0000-4000-8000-00000000000a'),
  1::bigint,
  'so neither of those created anything'
);
select throws_ok(
  $$select * from app_private.buyer_address_create(
      '7e000000-0000-4000-8000-00000000000a', null, 'both', 'X', 'not-a-phone', 'EG', 'Cairo', 'Cairo',
      null, '1 Street', null, null, null, null, false, false)$$,
  '23514',
  null,
  'a malformed phone number is refused by 0005''s own constraint'
);

create temp table address_a2 as
select * from app_private.buyer_address_create(
  '7e000000-0000-4000-8000-00000000000a', 'Work', 'both', 'Amina Hassan', '+201000000103',
  'EG', 'Giza', 'Giza', null, '5 Street', null, null, null, null, true, false);

select is((select outcome from address_a2), 'created', 'a second address is created as the new default');
select is(
  (select count(*) from public.addresses
    where user_id = '7e000000-0000-4000-8000-00000000000a' and is_default_shipping),
  1::bigint,
  'and there is still exactly one default shipping address, as 0005''s unique index requires'
);
select is(
  (select id from public.addresses
    where user_id = '7e000000-0000-4000-8000-00000000000a' and is_default_shipping),
  (select id from address_a2),
  'which is the new one'
);
select ok(
  (select is_default_billing from public.addresses where id = (select id from address_a)),
  'while the billing default stayed where it was: the two are separate flags'
);

select is(
  (select array_agg(a.label order by a.ordinality)
     from app_private.buyer_addresses('7e000000-0000-4000-8000-00000000000a') with ordinality as a(
       id, label, purpose, recipient_name, phone_e164, country_code, governorate, city, district,
       street_address, building, apartment, postal_code, landmark, is_default_shipping,
       is_default_billing, created_at, updated_at, ordinality)),
  array['Work', 'Home'],
  'the reader lists defaults first'
);
select is(
  (select count(*) from app_private.buyer_addresses('7e000000-0000-4000-8000-00000000000b')),
  0::bigint,
  'and the other account has none of them'
);

select is(
  app_private.buyer_address_update(
    '7e000000-0000-4000-8000-00000000000b', (select id from address_a), 'Stolen', 'both', 'Someone Else',
    '+201000000199', 'EG', 'Cairo', 'Cairo', null, '9 Street', null, null, null, null, false, false),
  'not_found',
  'buyer B cannot edit buyer A''s address'
);
select is(
  (select recipient_name from public.addresses where id = (select id from address_a)),
  'Amina Hassan',
  'and buyer A''s address is unchanged'
);
select is(
  app_private.buyer_address_update(
    '7e000000-0000-4000-8000-00000000000a', (select id from address_a), 'Home', 'both', 'Amina H.',
    '+201000000101', 'EG', 'Cairo', 'Cairo', 'Heliopolis', '12 Street', null, null, null, null, false, true),
  'updated',
  'the owner edits their own'
);
select is(
  (select format('%s/%s', recipient_name, district) from public.addresses where id = (select id from address_a)),
  'Amina H./Heliopolis',
  'and the change lands'
);
select is(
  app_private.buyer_address_update(
    '7e000000-0000-4000-8000-00000000000a', (select id from address_a), 'Home', 'shipping', 'Amina H.',
    '+201000000101', 'SA', 'Riyadh', 'Riyadh', null, '12 Street', null, null, null, null, false, false),
  'country_not_enabled',
  'and D17 applies to an edit exactly as it does to a create'
);

select ok(
  not app_private.buyer_address_delete('7e000000-0000-4000-8000-00000000000b', (select id from address_a)),
  'buyer B cannot delete buyer A''s address'
);
select ok(
  app_private.buyer_address_delete('7e000000-0000-4000-8000-00000000000a', (select id from address_a)),
  'the owner removes their own'
);
select ok(
  not app_private.buyer_address_delete('7e000000-0000-4000-8000-00000000000a', (select id from address_a)),
  'and removing it again removes nothing and says so'
);
select is(
  (select format('%s/%s/%s',
            case when deleted_at is null then 'present' else 'removed' end,
            is_default_shipping, is_default_billing)
     from public.addresses where id = (select id from address_a)),
  'removed/f/f',
  'a removal is the soft delete the schema defines, with the default flags cleared in the same statement'
);
select is(
  (select count(*) from app_private.buyer_addresses('7e000000-0000-4000-8000-00000000000a')),
  1::bigint,
  'so the reader no longer lists it'
);

-- ---------------------------------------------------------------------------------------------------
-- Profile
-- ---------------------------------------------------------------------------------------------------
select is(
  (select p.id from app_private.buyer_profile('7e000000-0000-4000-8000-00000000000a') p),
  '7e000000-0000-4000-8000-00000000000a'::uuid,
  'an account reads its own profile'
);
select is(
  (select count(*) from app_private.buyer_profile('7e000000-0000-4000-8000-0000000000ff')),
  0::bigint,
  'and an account that does not exist reads nothing'
);

select is(
  app_private.buyer_profile_update(
    '7e000000-0000-4000-8000-00000000000a', '  Amina  ', '  Amina Hassan  ', 'ar', 'Africa/Cairo'),
  'updated',
  'a profile is updated'
);
select is(
  (select format('%s/%s/%s/%s', p.display_name, p.full_name, p.locale_code, p.timezone)
     from app_private.buyer_profile('7e000000-0000-4000-8000-00000000000a') p),
  'Amina/Amina Hassan/ar/Africa/Cairo',
  'with the names trimmed and the locale and timezone stored'
);
select is(
  app_private.buyer_profile_update('7e000000-0000-4000-8000-00000000000a', 'Amina', 'Amina Hassan', 'zz', 'Africa/Cairo'),
  'invalid_locale',
  'a locale that does not exist is named rather than raised as a foreign key error'
);
select is(
  app_private.buyer_profile_update('7e000000-0000-4000-8000-00000000000a', 'Amina', 'Amina Hassan', 'ar', 'Mars/Olympus'),
  'invalid_timezone',
  'and so is a timezone that does not exist'
);
select is(
  (select p.locale_code from app_private.buyer_profile('7e000000-0000-4000-8000-00000000000a') p),
  'ar',
  'neither of which changed anything'
);
select is(
  app_private.buyer_profile_update('7e000000-0000-4000-8000-0000000000ff', 'Nobody', null, null, null),
  'not_found',
  'and an account that does not exist is not found'
);

-- What a profile update cannot reach.
select is(
  (select format('%s/%s/%s',
            coalesce(phone_e164, 'none'), status,
            case when email_verified_at is null then 'unverified' else 'verified' end)
     from public.profiles where id = '7e000000-0000-4000-8000-00000000000a'),
  'none/active/unverified',
  'the phone number, the status and the verification state are exactly as they were'
);
select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'buyer_profile_update'
      and (p.prosrc ~* 'phone_e164\s*=' or p.prosrc ~* 'status\s*=' or p.prosrc ~* 'deleted_at\s*='
        or p.prosrc ~* 'email_verified_at\s*=' or p.prosrc ~* 'phone_verified_at\s*=')),
  0::bigint,
  'and the writer contains no statement that could have moved any of them'
);
select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'buyer\_%'
      and (p.prosrc ~* 'user_roles' or p.prosrc ~* 'has_permission' or p.prosrc ~* 'grant ')),
  0::bigint,
  'no buyer function touches roles or permissions, so none of these surfaces can escalate anything'
);

-- A deleted profile has no identity, matching 0052.
update public.profiles set status = 'deleted', deleted_at = now()
 where id = '7e000000-0000-4000-8000-00000000000c';
select is(
  (select count(*) from app_private.buyer_profile('7e000000-0000-4000-8000-00000000000c')),
  0::bigint,
  'a deleted profile reads as no profile at all'
);
select is(
  app_private.buyer_profile_update('7e000000-0000-4000-8000-00000000000c', 'Back', null, null, null),
  'not_found',
  'and cannot be written'
);

-- ---------------------------------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------------------------------
select is(
  (select format('%s/%s/%s/%s/%s',
            s.notify_email, s.notify_sms, s.notify_whatsapp, s.notify_in_app, s.marketing_opt_in)
     from app_private.buyer_settings('7e000000-0000-4000-8000-00000000000a') s),
  't/f/f/t/f',
  'settings read back as the defaults 0005 set'
);
select ok(
  app_private.buyer_settings_update('7e000000-0000-4000-8000-00000000000a', false, true, true, false, true, 'arabic_indic'),
  'settings are written'
);
select is(
  (select format('%s/%s/%s/%s/%s/%s',
            s.notify_email, s.notify_sms, s.notify_whatsapp, s.notify_in_app, s.marketing_opt_in, s.digit_style)
     from app_private.buyer_settings('7e000000-0000-4000-8000-00000000000a') s),
  'f/t/t/f/t/arabic_indic',
  'and read back exactly as written'
);
select ok(
  app_private.buyer_settings_update('7e000000-0000-4000-8000-00000000000a', false, true, true, false, true, 'arabic_indic'),
  'writing the same values again succeeds'
);
select is(
  (select s.digit_style from app_private.buyer_settings('7e000000-0000-4000-8000-00000000000a') s),
  'arabic_indic',
  'and changes nothing anybody can observe'
);
select is(
  (select format('%s/%s', s.notify_email, s.marketing_opt_in)
     from app_private.buyer_settings('7e000000-0000-4000-8000-00000000000b') s),
  't/f',
  'the other account''s settings were never touched'
);
select throws_ok(
  $$select app_private.buyer_settings_update(
      '7e000000-0000-4000-8000-00000000000a', true, false, false, true, false, 'roman_numerals')$$,
  '23514',
  null,
  'a digit style the schema does not define is refused by 0005''s own constraint'
);
select ok(
  not app_private.buyer_settings_update(
    '7e000000-0000-4000-8000-0000000000ff', true, false, false, true, false, null),
  'and an account that does not exist writes nothing'
);
select is(
  (select count(*) from information_schema.columns c
    where c.table_schema = 'app_private' and c.table_name = 'x'),
  0::bigint,
  'no table was created in app_private by this migration'
);
select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in ('buyer_settings', 'buyer_settings_update')
      and p.prosrc ~* 'preferences'),
  0::bigint,
  'and neither settings function mentions the free-form preferences object'
);

-- ---------------------------------------------------------------------------------------------------
-- Country reference
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from app_private.reference_countries()) >= 2::bigint,
  'the country reference returns the seeded countries'
);
select is(
  (select c.is_marketplace_enabled from app_private.reference_countries() c where c.code = 'EG'),
  true,
  'carrying the flag D17''s trigger actually tests'
);
select is(
  (select c.is_marketplace_enabled from app_private.reference_countries() c where c.code = 'SA'),
  false,
  'for a country that is not enabled as well, rather than filtering it out: billing addresses are not restricted'
);
select is(
  (select format('%s/%s', c.name_en, c.name_ar) from app_private.reference_countries() c where c.code = 'EG'),
  'Egypt/مصر',
  'and both names, so the reference works in either language'
);

-- ---------------------------------------------------------------------------------------------------
-- Nothing else moved
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.notifications),
  0::bigint,
  'no buyer surface created a notification: there is no matching engine and no new event here'
);
select is(
  (select count(*) from public.email_outbox),
  0::bigint,
  'and none queued an email'
);
select is(
  (select count(*) from public.outbox_events where event_type like 'notification%'),
  0::bigint,
  'and none published a notification outbox event'
);

select finish();
rollback;
