-- pgTAP — migration 0050: the public seller profile reader (Phase 4-E).
--
-- One seller has two different kinds of visibility, and this file is mostly about keeping them apart. A
-- suspended seller has a public page that says "unavailable", and their listings are still not public.
-- Confusing the two rules in either direction is the failure this suite exists to catch: a 404 on a
-- suspended seller's profile, or a suspended seller's listings reappearing in the catalogue.
--
-- The other half is refusal. Pending, closed and unknown sellers must be one answer with no field of the
-- seller in it, so that asking for a slug cannot tell anyone that a seller exists but is not yet approved.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(41);

-- Fixtures ------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('b0000000-0000-4000-8000-000000000001', 'active@test.invalid'),
  ('b0000000-0000-4000-8000-000000000002', 'suspended@test.invalid'),
  ('b0000000-0000-4000-8000-000000000003', 'pending@test.invalid'),
  ('b0000000-0000-4000-8000-000000000004', 'closed@test.invalid'),
  ('b0000000-0000-4000-8000-000000000005', 'bare@test.invalid');

-- `seller_profiles_active_needs_verification` means an active seller is always verified; a suspended one
-- keeps whatever it had, and carries its suspension time.
insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, bio, content_language, city, governorate, country_code,
   contact_email, contact_phone_e164, status, suspended_at, suspension_reason, closed_at,
   verification_status, verified_at)
values
  ('b0000000-0000-4000-8000-000000000001', 'good-shop', 'Good Shop', 'Good Shop LLC',
   'We restore mid-century furniture.', 'en', 'Cairo', 'Cairo', 'EG',
   'good@test.invalid', '+201000000001', 'active', null, null, null, 'verified', now() - interval '10 days'),
  ('b0000000-0000-4000-8000-000000000002', 'gone-shop', 'Gone Shop', 'Gone Shop LLC',
   'نصنع الأثاث يدويًا.', 'ar', 'Alexandria', 'Alexandria', 'EG',
   'gone@test.invalid', '+201000000002', 'suspended', now() - interval '1 day', 'Repeated policy breaches',
   null, 'verified', now() - interval '20 days'),
  ('b0000000-0000-4000-8000-000000000003', 'waiting-shop', 'Waiting Shop', null, 'Not approved yet.', 'en',
   'Giza', 'Giza', 'EG', 'waiting@test.invalid', '+201000000003', 'pending', null, null, null,
   'pending', null),
  ('b0000000-0000-4000-8000-000000000004', 'left-shop', 'Left Shop', null, 'We have closed.', 'en',
   'Luxor', 'Luxor', 'EG', 'left@test.invalid', '+201000000004', 'closed', null, null,
   now() - interval '5 days', 'verified', now() - interval '30 days'),
  -- An active seller with nothing optional filled in: the page still has to render.
  ('b0000000-0000-4000-8000-000000000005', 'bare-shop', 'Bare Shop', null, null, null, null, null, 'EG',
   null, null, 'active', null, null, null, 'verified', now() - interval '3 days');

-- ---------------------------------------------------------------------------------------------------
-- Boundary
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'public_seller_by_slug', array['text'],
  'app_private.public_seller_by_slug exists');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'public_seller_by_slug'
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'it is SECURITY DEFINER with the pinned search_path');

select ok(
  not has_function_privilege('public', 'app_private.public_seller_by_slug(text)', 'execute'),
  'it is not executable by public');
select ok(
  has_function_privilege('app_system', 'app_private.public_seller_by_slug(text)', 'execute'),
  'app_system may read a seller profile');
select ok(
  not has_function_privilege('anon', 'app_private.public_seller_by_slug(text)', 'execute'),
  'anon may not read a seller profile');
select ok(
  not has_function_privilege('authenticated', 'app_private.public_seller_by_slug(text)', 'execute'),
  'authenticated may not read a seller profile either');

-- ---------------------------------------------------------------------------------------------------
-- The declared projection
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select a.name from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral unnest(p.proargnames, p.proargmodes) as a(name, mode)
     where n.nspname = 'app_private' and p.proname = 'public_seller_by_slug' and a.mode = 't'$$,
  $$values ('outcome'), ('availability'), ('slug'), ('display_name'), ('bio'), ('content_language'),
           ('city')$$,
  'the reader declares the approved projection and nothing else');

select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral unnest(coalesce(p.proargnames, array[]::text[])) as col(name)
    where n.nspname = 'app_private' and p.proname = 'public_seller_by_slug'
      and col.name in ('user_id', 'legal_name', 'contact_email', 'contact_phone_e164',
                       'verification_status', 'verified_at', 'status', 'suspended_at',
                       'suspension_reason', 'closed_at', 'country_code', 'governorate',
                       'created_at', 'updated_at', 'logo_object_path', 'banner_object_path')),
  0::bigint,
  'no private, contact, verification, status or media column is declared');

-- ---------------------------------------------------------------------------------------------------
-- An active seller
-- ---------------------------------------------------------------------------------------------------
select is((select outcome from app_private.public_seller_by_slug('good-shop')), 'found',
  'an active seller resolves');
select is((select availability from app_private.public_seller_by_slug('good-shop')), 'available',
  'and is available');
select is((select slug from app_private.public_seller_by_slug('good-shop')), 'good-shop',
  'the slug comes back');
select is((select display_name from app_private.public_seller_by_slug('good-shop')), 'Good Shop',
  'the display name comes back');
select is((select bio from app_private.public_seller_by_slug('good-shop')), 'We restore mid-century furniture.',
  'the bio comes back');
select is((select content_language from app_private.public_seller_by_slug('good-shop')), 'en',
  'the bio carries the language it was written in');
select is((select city from app_private.public_seller_by_slug('good-shop')), 'Cairo',
  'the city comes back');

-- ---------------------------------------------------------------------------------------------------
-- An active seller with nothing optional filled in
-- ---------------------------------------------------------------------------------------------------
select is((select outcome from app_private.public_seller_by_slug('bare-shop')), 'found',
  'an active seller with no bio and no city still resolves');
select is((select availability from app_private.public_seller_by_slug('bare-shop')), 'available',
  'and is available');
select is((select bio from app_private.public_seller_by_slug('bare-shop')), null::text,
  'the missing bio is null rather than an empty string');
select is((select content_language from app_private.public_seller_by_slug('bare-shop')), null::text,
  'and there is no language for a bio that does not exist');
select is((select city from app_private.public_seller_by_slug('bare-shop')), null::text,
  'the missing city is null');
select is((select display_name from app_private.public_seller_by_slug('bare-shop')), 'Bare Shop',
  'the display name is always there: the schema requires it');

-- ---------------------------------------------------------------------------------------------------
-- A suspended seller — a page that exists and says so
-- ---------------------------------------------------------------------------------------------------
select is((select outcome from app_private.public_seller_by_slug('gone-shop')), 'found',
  'a suspended seller still has a public page');
select is((select availability from app_private.public_seller_by_slug('gone-shop')), 'unavailable',
  'and it is marked unavailable');
select is((select display_name from app_private.public_seller_by_slug('gone-shop')), 'Gone Shop',
  'the page still names the seller');
select is((select content_language from app_private.public_seller_by_slug('gone-shop')), 'ar',
  'an Arabic bio is still marked Arabic on a suspended profile');

select is(
  (select count(*) from app_private.public_seller_by_slug('gone-shop') s
    where s.bio like '%policy%' or s.display_name like '%policy%' or s.city like '%policy%'),
  0::bigint,
  'the suspension reason never reaches the projection');

-- The two rules stay apart: a suspended seller has a profile page and no public listings.
select ok(
  not public.is_seller_publicly_visible('b0000000-0000-4000-8000-000000000002'),
  'a suspended seller is still not listing-visible: the listing rule is untouched');
select ok(
  public.is_seller_publicly_visible('b0000000-0000-4000-8000-000000000001'),
  'and an active seller still is');
select ok(
  not public.is_seller_publicly_visible('b0000000-0000-4000-8000-000000000003'),
  'a pending seller is not listing-visible');
select ok(
  not public.is_seller_publicly_visible('b0000000-0000-4000-8000-000000000004'),
  'a closed seller is not listing-visible');

-- ---------------------------------------------------------------------------------------------------
-- Sellers the public may not see at all
-- ---------------------------------------------------------------------------------------------------
select is((select outcome from app_private.public_seller_by_slug('waiting-shop')), 'not_found',
  'a pending seller is not found');
select is((select outcome from app_private.public_seller_by_slug('left-shop')), 'not_found',
  'a closed seller is not found');
select is((select outcome from app_private.public_seller_by_slug('no-such-shop')), 'not_found',
  'a slug that names nothing is not found');

-- The three must be one answer, not three answers sharing a status code.
select is(
  (select count(distinct (outcome, availability, slug, display_name, bio, content_language, city))
     from app_private.public_seller_by_slug('waiting-shop')
    union all
   select count(distinct (outcome, availability, slug, display_name, bio, content_language, city))
     from app_private.public_seller_by_slug('left-shop')
   limit 1),
  1::bigint,
  'each refusal is a single row');

select is(
  (select row(slug, display_name, bio, content_language, city)::text
     from app_private.public_seller_by_slug('waiting-shop')),
  (select row(slug, display_name, bio, content_language, city)::text
     from app_private.public_seller_by_slug('left-shop')),
  'a pending seller and a closed seller are byte-for-byte the same answer');

select is(
  (select row(slug, display_name, bio, content_language, city)::text
     from app_private.public_seller_by_slug('waiting-shop')),
  (select row(slug, display_name, bio, content_language, city)::text
     from app_private.public_seller_by_slug('no-such-shop')),
  'and so is a seller that never existed');

select is(
  (select count(*) from app_private.public_seller_by_slug('waiting-shop') s
    where s.slug is not null or s.display_name is not null or s.bio is not null
       or s.content_language is not null or s.city is not null),
  0::bigint,
  'a refusal carries no field of the seller it refused');

select is(
  (select count(*) from app_private.public_seller_by_slug('left-shop') s
    where s.slug is not null or s.display_name is not null or s.bio is not null),
  0::bigint,
  'including the closed one, whose name a caller must not learn');

-- ---------------------------------------------------------------------------------------------------
-- Nothing private is reachable through any answer
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.seller_profiles p
     cross join lateral app_private.public_seller_by_slug(p.slug) s
    where s.bio is not null
      and (s.bio like '%LLC%' or s.bio like '%@test.invalid%' or s.bio like '%+2010%')),
  0::bigint,
  'no legal name, e-mail address or phone number appears in any returned field');

select is(
  (select count(*) from app_private.public_seller_by_slug('good-shop') s
    where s.slug = 'good-shop' and s.city = 'Cairo'),
  1::bigint,
  'the city is the only location field returned: no governorate, no country');

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
select lives_ok(
  $$select app_private.assert_security_contract()$$,
  'the security contract still passes with the new reader in place');

select finish();
rollback;
