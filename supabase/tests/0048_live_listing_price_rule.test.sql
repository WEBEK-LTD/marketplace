-- pgTAP — migration 0048: the live-listing price rule (Phase 4-C follow-up).
--
-- The rule spans two tables, so it is enforced by a constraint trigger deferred to COMMIT rather than by
-- a CHECK. That makes the interesting assertions transactional ones: what a transaction may do in the
-- middle, and what it may not be allowed to finish with.
--
-- Each case runs inside a savepoint, so a rejection is caught and rolled back to it and the file carries
-- on. `release savepoint` is what forces a deferred constraint trigger to fire for the work inside it,
-- which is how a deferred rule can be tested at all without ending the enclosing transaction.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(37);

-- Fixtures ------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('b0000000-0000-4000-8000-000000000001', 'seller@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, verification_status, verified_at)
values
  ('b0000000-0000-4000-8000-000000000001', 'good-shop', 'Good Shop', 'Good Shop LLC',
   'seller@test.invalid', '+201000000001', 'EG', 'active', 'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c1000000-0000-4000-8000-000000000001', null, 'design', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('c1000000-0000-4000-8000-000000000001', 'en', 'Design');

/**
 * One listing, in whatever type, status and price the case needs. Returns nothing: the cases are about
 * whether the write is allowed to commit, not about what it produces.
 */
create or replace function pg_temp.listing(
  p_id uuid, p_slug text, p_type text, p_status text, p_price bigint
) returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at,
    approved_at, sold_at, archived_at, deleted_at
  ) values (
    p_id, 'b0000000-0000-4000-8000-000000000001', p_type, 'c1000000-0000-4000-8000-000000000001',
    p_slug, 'A title', 'A description long enough to satisfy the length rule.', 'en',
    'EGP', p_price, false, p_status, 'EG', 'Cairo', now(),
    case when p_status in ('approved','active','sold','expired','archived') then now() else null end,
    case when p_status = 'sold' then now() else null end,
    case when p_status = 'archived' then now() else null end,
    case when p_status = 'deleted' then now() else null end
  );
end;
$$;

create or replace function pg_temp.details(p_id uuid, p_model text, p_days smallint)
returns void language plpgsql as $$
begin
  insert into public.listing_service_details (listing_id, pricing_model, delivery_days)
  values (p_id, p_model, p_days);
end;
$$;

/**
 * Runs `p_sql` and reports whether the result was allowed to *stand*.
 *
 * A deferred constraint trigger does not fire when the statement runs; it fires at COMMIT. This whole
 * file is one transaction that is rolled back, so the commit never comes — `set constraints all
 * immediate` is what brings it forward, firing every deferred event queued so far and raising if the
 * rule is broken. That is precisely the check a real COMMIT would make.
 *
 * The PL/pgSQL block is an implicit subtransaction: on an exception its statements are undone, along
 * with the `set constraints` made inside it, so a rejected case leaves nothing behind and the file
 * carries on. On success the mode is put back to deferred, so the next case starts as a real
 * transaction would.
 */
create or replace function pg_temp.commits_ok(p_sql text) returns boolean language plpgsql as $$
begin
  begin
    execute p_sql;
    set constraints all immediate;
    set constraints all deferred;
    return true;
  exception when others then
    return false;
  end;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- The old constraint is gone and the new machinery is in place
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from pg_constraint where conname = 'listings_live_needs_price'),
  0::bigint,
  'the single-table CHECK from 0011 has been superseded');

select has_function('app_private', 'live_listing_price_is_valid', array['uuid'],
  'the rule is a named function');
select has_function('app_private', 'enforce_live_listing_price', array[]::text[],
  'the trigger function exists');

select is(
  (select count(*) from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
    where t.tgname in ('listings_live_price_rule', 'listing_service_details_live_price_rule')
      and c.relname in ('listings', 'listing_service_details')
      and t.tgconstraint <> 0
      and t.tgdeferrable
      and t.tginitdeferred),
  2::bigint,
  'both tables carry a deferrable, initially deferred constraint trigger');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('live_listing_price_is_valid', 'enforce_live_listing_price')
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'both are SECURITY DEFINER with the pinned search_path');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('live_listing_price_is_valid', 'enforce_live_listing_price')
      and has_function_privilege('public', p.oid, 'execute')),
  0::bigint,
  'neither is executable by public');

-- ---------------------------------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------------------------------
select ok(
  pg_temp.commits_ok($$select pg_temp.listing('11110000-0000-4000-8000-000000000001', 'p-priced', 'product', 'active', 250000)$$),
  'an active product with a price is allowed');

select ok(
  not pg_temp.commits_ok($$select pg_temp.listing('11110000-0000-4000-8000-000000000002', 'p-null', 'product', 'active', null)$$),
  'an active product with no price is rejected');

select ok(
  not pg_temp.commits_ok($$select pg_temp.listing('11110000-0000-4000-8000-000000000003', 'p-approved-null', 'product', 'approved', null)$$),
  'an approved product with no price is rejected');

select ok(
  pg_temp.commits_ok($$select pg_temp.listing('11110000-0000-4000-8000-000000000004', 'p-draft-null', 'product', 'draft', null)$$),
  'a draft product with no price is allowed, as before');

select ok(
  pg_temp.commits_ok($$select pg_temp.listing('11110000-0000-4000-8000-000000000005', 'p-sold-null', 'product', 'sold', null)$$),
  'a sold product with no price is allowed, as before');

-- ---------------------------------------------------------------------------------------------------
-- Fixed-price services — the invariant that must not be weakened
-- ---------------------------------------------------------------------------------------------------
select ok(
  pg_temp.commits_ok($$
    select pg_temp.listing('22220000-0000-4000-8000-000000000001', 's-fixed-priced', 'service', 'active', 150000);
    select pg_temp.details('22220000-0000-4000-8000-000000000001', 'fixed', 5::smallint);
  $$),
  'an active fixed-price service with a price is allowed');

select ok(
  not pg_temp.commits_ok($$
    select pg_temp.listing('22220000-0000-4000-8000-000000000002', 's-fixed-null', 'service', 'active', null);
    select pg_temp.details('22220000-0000-4000-8000-000000000002', 'fixed', 5::smallint);
  $$),
  'an active fixed-price service with no price is rejected');

select ok(
  not pg_temp.commits_ok($$
    select pg_temp.listing('22220000-0000-4000-8000-000000000003', 's-fixed-null-2', 'service', 'approved', null);
    select pg_temp.details('22220000-0000-4000-8000-000000000003', 'fixed', 5::smallint);
  $$),
  'an approved fixed-price service with no price is rejected too');

-- ---------------------------------------------------------------------------------------------------
-- Custom-priced services — the case this migration exists for
-- ---------------------------------------------------------------------------------------------------
select ok(
  pg_temp.commits_ok($$
    select pg_temp.listing('22220000-0000-4000-8000-000000000004', 's-custom-null', 'service', 'active', null);
    select pg_temp.details('22220000-0000-4000-8000-000000000004', 'custom', null::smallint);
  $$),
  'an ACTIVE custom-priced service with NO price is allowed');

select ok(
  pg_temp.commits_ok($$
    select pg_temp.listing('22220000-0000-4000-8000-000000000005', 's-custom-approved', 'service', 'approved', null);
    select pg_temp.details('22220000-0000-4000-8000-000000000005', 'custom', null::smallint);
  $$),
  'an approved custom-priced service with no price is allowed');

select ok(
  pg_temp.commits_ok($$
    select pg_temp.listing('22220000-0000-4000-8000-000000000006', 's-custom-priced', 'service', 'active', 300000);
    select pg_temp.details('22220000-0000-4000-8000-000000000006', 'custom', null::smallint);
  $$),
  'an active custom-priced service may still carry a starting price');

select ok(
  pg_temp.commits_ok($$
    select pg_temp.listing('22220000-0000-4000-8000-000000000007', 's-custom-sold', 'service', 'sold', null);
    select pg_temp.details('22220000-0000-4000-8000-000000000007', 'custom', null::smallint);
  $$),
  'a sold custom-priced service with no price is allowed');

select ok(
  pg_temp.commits_ok($$
    select pg_temp.listing('22220000-0000-4000-8000-000000000008', 's-custom-archived', 'service', 'archived', null);
    select pg_temp.details('22220000-0000-4000-8000-000000000008', 'custom', null::smallint);
  $$),
  'an archived custom-priced service with no price is allowed');

-- ---------------------------------------------------------------------------------------------------
-- Write order must not matter
-- ---------------------------------------------------------------------------------------------------
-- The whole reason the trigger is deferred: neither table can be required to come first.
select ok(
  pg_temp.commits_ok($$
    select pg_temp.listing('22220000-0000-4000-8000-000000000009', 's-order-a', 'service', 'active', null);
    select pg_temp.details('22220000-0000-4000-8000-000000000009', 'custom', null::smallint);
  $$),
  'listing first, then details: allowed');

select ok(
  not pg_temp.commits_ok($$
    select pg_temp.details('2222000a-0000-4000-8000-000000000001', 'custom', null::smallint);
  $$),
  'details for a listing that does not exist are refused by the foreign key, as always');

-- ---------------------------------------------------------------------------------------------------
-- A service with no details row states no pricing model, so it is not custom
-- ---------------------------------------------------------------------------------------------------
select ok(
  not pg_temp.commits_ok($$
    select pg_temp.listing('2222000b-0000-4000-8000-000000000001', 's-bare-null', 'service', 'active', null);
  $$),
  'an active service with no details row and no price is rejected: absence is not a declaration');

select ok(
  pg_temp.commits_ok($$
    select pg_temp.listing('2222000b-0000-4000-8000-000000000002', 's-bare-priced', 'service', 'active', 5000);
  $$),
  'an active service with no details row but a price is allowed');

-- ---------------------------------------------------------------------------------------------------
-- Transitions into the live states
-- ---------------------------------------------------------------------------------------------------
select pg_temp.listing('33330000-0000-4000-8000-000000000001', 't-draft-product', 'product', 'draft', null);
select ok(
  not pg_temp.commits_ok($$
    update public.listings set status = 'active', approved_at = now()
     where id = '33330000-0000-4000-8000-000000000001';
  $$),
  'publishing a priceless product is rejected at the transition');

select ok(
  pg_temp.commits_ok($$
    update public.listings set status = 'active', approved_at = now(), price_minor = 1000
     where id = '33330000-0000-4000-8000-000000000001';
  $$),
  'publishing it with a price in the same transaction is allowed');

select pg_temp.listing('33330000-0000-4000-8000-000000000002', 't-draft-service', 'service', 'draft', null);
select pg_temp.details('33330000-0000-4000-8000-000000000002', 'custom', null::smallint);
select ok(
  pg_temp.commits_ok($$
    update public.listings set status = 'active', approved_at = now()
     where id = '33330000-0000-4000-8000-000000000002';
  $$),
  'publishing a priceless custom-priced service is allowed');

select pg_temp.listing('33330000-0000-4000-8000-000000000003', 't-draft-fixed', 'service', 'pending_review', null);
select pg_temp.details('33330000-0000-4000-8000-000000000003', 'fixed', 5::smallint);
select ok(
  not pg_temp.commits_ok($$
    update public.listings set status = 'approved', approved_at = now()
     where id = '33330000-0000-4000-8000-000000000003';
  $$),
  'approving a priceless fixed-price service out of pending review is rejected');

-- ---------------------------------------------------------------------------------------------------
-- Changing the pricing model while live
-- ---------------------------------------------------------------------------------------------------
select pg_temp.listing('44440000-0000-4000-8000-000000000001', 'm-fixed-live', 'service', 'active', 150000);
select pg_temp.details('44440000-0000-4000-8000-000000000001', 'fixed', 5::smallint);

select ok(
  pg_temp.commits_ok($$
    update public.listing_service_details set pricing_model = 'custom', delivery_days = null
     where listing_id = '44440000-0000-4000-8000-000000000001';
    update public.listings set price_minor = null
     where id = '44440000-0000-4000-8000-000000000001';
  $$),
  'fixed -> custom while live may drop the price, inside one transaction');

-- That transaction committed, so this service is now live, custom and priceless.
select is(
  (select price_minor from public.listings where id = '44440000-0000-4000-8000-000000000001'),
  null::bigint,
  'and the committed state really is a live service with no price');

select ok(
  not pg_temp.commits_ok($$
    update public.listing_service_details set pricing_model = 'fixed'
     where listing_id = '44440000-0000-4000-8000-000000000001';
  $$),
  'custom -> fixed while live and priceless is rejected');

select ok(
  pg_temp.commits_ok($$
    update public.listing_service_details set pricing_model = 'fixed', delivery_days = 5
     where listing_id = '44440000-0000-4000-8000-000000000001';
    update public.listings set price_minor = 200000
     where id = '44440000-0000-4000-8000-000000000001';
  $$),
  'custom -> fixed together with a price, in one transaction, is allowed');

-- Removing the details row entirely takes the `custom` declaration with it.
select pg_temp.listing('44440000-0000-4000-8000-000000000002', 'm-custom-live', 'service', 'active', null);
select pg_temp.details('44440000-0000-4000-8000-000000000002', 'custom', null::smallint);
select ok(
  not pg_temp.commits_ok($$
    delete from public.listing_service_details where listing_id = '44440000-0000-4000-8000-000000000002';
  $$),
  'deleting the details row of a live priceless service is rejected');

-- ---------------------------------------------------------------------------------------------------
-- The readers now surface what the schema can finally hold
-- ---------------------------------------------------------------------------------------------------
-- The point of the whole change: a live custom-priced service reaches the public surface with a null
-- price, which is what "Contact for price" renders from.
select is(
  (select s.price_minor from app_private.public_services(50, null, null) s where s.slug = 's-custom-null'),
  null::bigint,
  'the service list carries a live custom-priced service with no amount');
select is(
  (select s.pricing_model from app_private.public_services(50, null, null) s where s.slug = 's-custom-null'),
  'custom',
  'and says how it is priced');
select is(
  (select outcome from app_private.public_service_by_slug('s-custom-null')),
  'found',
  'and its detail page resolves');
select is(
  (select availability from app_private.public_service_by_slug('s-custom-null')),
  'available',
  'as an available service, not a no-longer-available one');

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
select lives_ok(
  $$select app_private.assert_security_contract()$$,
  'the security contract still passes with the new functions and triggers in place');

select finish();
rollback;
