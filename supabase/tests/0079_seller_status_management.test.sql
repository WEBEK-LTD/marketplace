-- pgTAP — migration 0079: seller account status management (Phase 7-O).
--
-- What these assertions hold to account:
--
--   * **the seven legal transitions, each performed for real**, and the fields each one leaves behind
--     checked against 0009's biconditional constraints rather than against the writer's intent;
--   * **every illegal transition, each provoked**: `closed` is terminal in all three directions,
--     `active → pending` is refused, and `pending → active` is refused because it is 7-G's alone;
--   * **the reason rule**: a suspension without one is refused before the row moves, and reinstatement
--     clears it;
--   * **the two reinstatement conditions as strict complements**: `active` needs `verified`, `pending`
--     needs not-`verified`, and each refusal is its own outcome;
--   * **authorization**: the manage key at aal2 and nothing else — a moderator holding the *read* key is
--     refused, a support agent is refused, a buyer and a seller are refused, aal1 is refused, and a revoked
--     or expired grant is refused. Absence and a missing key are byte-identical answers;
--   * **isolation**: a slug that names another storefront moves that one and no other, and a slug that
--     names nothing moves nothing;
--   * **concurrency**: the row is locked, so the second of two transitions sees the first's result;
--   * **the audit trail**: 0009's own trigger records the change and names the columns that moved, exactly
--     one row per transition and none for a refusal — including the two limitations that trigger has, which
--     are asserted here so they are visible facts rather than assumptions;
--   * **no cascade**: listings, services, offers, service requests, orders, ledger entries, balances and
--     payouts are counted before and after and are byte-identical, and public visibility is shown to follow
--     seller status through 0011's own predicate without a listing row being touched;
--   * **nothing else on the storefront moves**: not the slug, not the display name, not the contact
--     details, and neither verification column.
--
-- Deterministic: fixed uuids, and every assertion about a field is made against the row rather than against
-- a returned value. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(151);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('f9000000-0000-4000-8000-000000000001', 'p-admin@test.invalid'),
  ('f9000000-0000-4000-8000-000000000002', 'p-super-admin@test.invalid'),
  ('f9000000-0000-4000-8000-000000000003', 'p-moderator@test.invalid'),
  ('f9000000-0000-4000-8000-000000000004', 'p-support-agent@test.invalid'),
  ('f9000000-0000-4000-8000-000000000005', 'p-buyer@test.invalid'),
  ('f9000000-0000-4000-8000-000000000006', 'p-revoked-admin@test.invalid'),
  ('f9000000-0000-4000-8000-000000000007', 'p-expired-admin@test.invalid'),
  -- One seller per starting state, so no test has to move a storefront to set another one up.
  ('f9000000-0000-4000-8000-00000000000a', 'p-seller-pending@test.invalid'),
  ('f9000000-0000-4000-8000-00000000000b', 'p-seller-active@test.invalid'),
  ('f9000000-0000-4000-8000-00000000000c', 'p-seller-suspended@test.invalid'),
  ('f9000000-0000-4000-8000-00000000000d', 'p-seller-closed@test.invalid'),
  ('f9000000-0000-4000-8000-00000000000e', 'p-seller-susp-verified@test.invalid'),
  ('f9000000-0000-4000-8000-00000000000f', 'p-seller-pending-verified@test.invalid'),
  ('f9000000-0000-4000-8000-000000000010', 'p-seller-bystander@test.invalid');

insert into public.user_roles (user_id, role_key, granted_at) values
  ('f9000000-0000-4000-8000-000000000001', 'admin', now() - interval '10 days'),
  ('f9000000-0000-4000-8000-000000000002', 'super_admin', now() - interval '10 days'),
  ('f9000000-0000-4000-8000-000000000003', 'moderator', now() - interval '10 days'),
  ('f9000000-0000-4000-8000-000000000004', 'support_agent', now() - interval '10 days'),
  ('f9000000-0000-4000-8000-000000000005', 'buyer', now() - interval '10 days'),
  ('f9000000-0000-4000-8000-00000000000b', 'seller', now() - interval '10 days');

insert into public.user_roles (user_id, role_key, granted_at, revoked_at) values
  ('f9000000-0000-4000-8000-000000000006', 'admin', now() - interval '20 days', now() - interval '1 hour');
insert into public.user_roles (user_id, role_key, granted_at, expires_at) values
  ('f9000000-0000-4000-8000-000000000007', 'admin', now() - interval '20 days', now() - interval '1 hour');

/*
 * Seven storefronts. `pending` and `suspended` come in a verified and an unverified flavour, because the two
 * reinstatement conditions are complements and both sides of each need a fixture.
 */
create or replace function pg_temp.shop(
  p_user uuid, p_slug text, p_status text, p_verification text
) returns void language plpgsql as $$
begin
  insert into public.seller_profiles (
    user_id, slug, display_name, legal_name, bio, content_language, contact_email, contact_phone_e164,
    country_code, governorate, city, status, suspended_at, suspension_reason, closed_at,
    verification_status, verified_at, created_at
  ) values (
    p_user, p_slug, 'Shop ' || p_slug, 'Shop ' || p_slug || ' LLC', 'A bio.', 'en',
    p_slug || '@test.invalid', '+2010000' || lpad((random() * 99999)::integer::text, 5, '0'),
    'EG', 'Cairo', 'Cairo', p_status,
    case when p_status = 'suspended' then now() - interval '2 days' end,
    case when p_status = 'suspended' then 'The original reason for suspending it.' end,
    case when p_status = 'closed' then now() - interval '2 days' end,
    p_verification,
    case when p_verification = 'verified' then now() - interval '5 days' end,
    now() - interval '10 days'
  );
end;
$$;

select pg_temp.shop('f9000000-0000-4000-8000-00000000000a', 'p-pending',   'pending',   'unverified');
select pg_temp.shop('f9000000-0000-4000-8000-00000000000b', 'p-active',    'active',    'verified');
select pg_temp.shop('f9000000-0000-4000-8000-00000000000c', 'p-suspended', 'suspended', 'rejected');
select pg_temp.shop('f9000000-0000-4000-8000-00000000000d', 'p-closed',    'closed',    'verified');
select pg_temp.shop('f9000000-0000-4000-8000-00000000000e', 'p-susp-ver',  'suspended', 'verified');
select pg_temp.shop('f9000000-0000-4000-8000-00000000000f', 'p-pend-ver',  'pending',   'verified');
select pg_temp.shop('f9000000-0000-4000-8000-000000000010', 'p-bystander', 'active',    'verified');

-- A live listing on the bystander, so "public visibility follows seller status" can be shown without a
-- listing row ever being written by this increment.
insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c9000000-0000-4000-8000-000000000001', null, 'seller-status-fixture', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('c9000000-0000-4000-8000-000000000001', 'en', 'Fixture'),
  ('c9000000-0000-4000-8000-000000000001', 'ar', 'عينة');

insert into public.listings (
  id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
  currency_code, price_minor, is_negotiable, status, country_code, city, created_at, approved_at
) values (
  '99990000-0000-4000-8000-000000000001', 'f9000000-0000-4000-8000-000000000010', 'product',
  'c9000000-0000-4000-8000-000000000001', 'p-bystander-listing', 'A listing',
  'A description long enough to satisfy the length rule.', 'en', 'EGP', 150000, false,
  'active', 'EG', 'Cairo', now() - interval '3 days', now() - interval '3 days'
);

-- Counts taken before anything moves, so "no cascade" is a comparison rather than a claim.
create temporary table pg_temp_before as
select
  (select count(*) from public.listings) as listings,
  (select count(*) from public.offers) as offers,
  (select count(*) from public.service_requests) as service_requests,
  (select count(*) from public.orders) as orders,
  (select count(*) from public.ledger_entries) as ledger_entries,
  (select count(*) from public.seller_balances) as seller_balances,
  (select count(*) from public.payouts) as payouts,
  (select count(*) from public.withdrawals) as withdrawals;

create temporary table pg_temp_listing_before as
select id, status, approved_at, archived_at, deleted_at from public.listings;

-- The whole storefront row for one shop, so "nothing else moved" is checked column by column.
create temporary table pg_temp_shop_before as
select * from public.seller_profiles where slug = 'p-active';

-- Shorthand, so a transition reads as one line.
create or replace function pg_temp.move(p_actor uuid, p_slug text, p_status text, p_reason text default null)
returns text language sql as $$
  select outcome from app_private.admin_seller_status_set(p_actor, true, p_slug, p_status, p_reason);
$$;

create or replace function pg_temp.status_of(p_slug text) returns text language sql as $$
  select status from public.seller_profiles where slug = p_slug;
$$;

-- The two actors used throughout: an administrator and a super administrator, both at aal2.
create or replace function pg_temp.admin() returns uuid language sql immutable as $$
  select 'f9000000-0000-4000-8000-000000000001'::uuid;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 1. The predicate
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.admin_can_manage_sellers('f9000000-0000-4000-8000-000000000001', true),
  'an admin holds sellers.profile.manage at aal2');
select ok(app_private.admin_can_manage_sellers('f9000000-0000-4000-8000-000000000002', true),
  'and so does a super_admin');
select ok(not app_private.admin_can_manage_sellers('f9000000-0000-4000-8000-000000000003', true),
  'a moderator does not — it holds the seller READ key and not this one');
select ok(not app_private.admin_can_manage_sellers('f9000000-0000-4000-8000-000000000004', true),
  'nor does a support agent');
select ok(not app_private.admin_can_manage_sellers('f9000000-0000-4000-8000-000000000005', true),
  'nor a buyer');
select ok(not app_private.admin_can_manage_sellers('f9000000-0000-4000-8000-00000000000b', true),
  'nor a seller');
select ok(not app_private.admin_can_manage_sellers('f9000000-0000-4000-8000-000000000001', false),
  'nor an admin at aal1 — both roles that hold the key require MFA');
select ok(not app_private.admin_can_manage_sellers('f9000000-0000-4000-8000-000000000002', false),
  'nor a super_admin at aal1');
select ok(not app_private.admin_can_manage_sellers('f9000000-0000-4000-8000-000000000006', true),
  'nor a revoked admin');
select ok(not app_private.admin_can_manage_sellers('f9000000-0000-4000-8000-000000000007', true),
  'nor an expired admin');
select ok(not app_private.admin_can_manage_sellers(null, true), 'nor nobody');

-- The read key and the manage key are genuinely separate, in both directions.
select ok(app_private.admin_can_read_sellers('f9000000-0000-4000-8000-000000000003', true),
  'a moderator can read storefronts');
select ok(not app_private.admin_can_manage_sellers('f9000000-0000-4000-8000-000000000003', true),
  'and cannot move one — which is the whole point of the two keys');

-- ---------------------------------------------------------------------------------------------------
-- 2. Authorization on the writer itself
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.move('f9000000-0000-4000-8000-000000000003', 'p-active', 'suspended', 'A reason.'),
  'not_found', 'a moderator cannot suspend a storefront');
select is(pg_temp.move('f9000000-0000-4000-8000-000000000004', 'p-active', 'suspended', 'A reason.'),
  'not_found', 'nor can a support agent');
select is(pg_temp.move('f9000000-0000-4000-8000-000000000005', 'p-active', 'suspended', 'A reason.'),
  'not_found', 'nor a buyer');
select is(pg_temp.move('f9000000-0000-4000-8000-00000000000b', 'p-active', 'suspended', 'A reason.'),
  'not_found', 'nor the seller themselves');
select is(pg_temp.move('f9000000-0000-4000-8000-000000000006', 'p-active', 'suspended', 'A reason.'),
  'not_found', 'nor a revoked admin');
select is(pg_temp.move('f9000000-0000-4000-8000-000000000007', 'p-active', 'suspended', 'A reason.'),
  'not_found', 'nor an expired admin');
select is(pg_temp.move(null, 'p-active', 'suspended', 'A reason.'),
  'not_found', 'nor nobody');
select is(
  (select outcome from app_private.admin_seller_status_set(
     pg_temp.admin(), false, 'p-active', 'suspended', 'A reason.')),
  'not_found', 'nor an admin at aal1');
select is(pg_temp.status_of('p-active'), 'active',
  'and none of those eight refusals moved the storefront');

-- Absence and a missing key are the same answer, byte for byte.
select is(pg_temp.move(pg_temp.admin(), 'no-such-shop', 'suspended', 'A reason.'),
  'not_found', 'a storefront that does not exist is not_found');
select is(
  (select outcome from app_private.admin_seller_status_set(
     'f9000000-0000-4000-8000-000000000003', true, 'p-active', 'suspended', 'A reason.')),
  (select outcome from app_private.admin_seller_status_set(
     pg_temp.admin(), true, 'no-such-shop', 'suspended', 'A reason.')),
  'and a caller without the key gets the identical outcome for one that does');
select is(
  (select status from app_private.admin_seller_status_set(
     'f9000000-0000-4000-8000-000000000003', true, 'p-active', 'suspended', 'A reason.')),
  null, 'a refused call reports no status at all');
select is(pg_temp.move(pg_temp.admin(), '   ', 'suspended', 'A reason.'),
  'not_found', 'a blank slug is not_found');
select is(pg_temp.move(pg_temp.admin(), null, 'suspended', 'A reason.'),
  'not_found', 'and so is no slug');

-- ---------------------------------------------------------------------------------------------------
-- 3. The status value itself
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.move(pg_temp.admin(), 'p-active', 'archived', 'A reason.'),
  'invalid', 'a status outside 0009''s four is refused');
select is(pg_temp.move(pg_temp.admin(), 'p-active', 'ACTIVE', 'A reason.'),
  'invalid', 'and so is one that differs only in case');
select is(pg_temp.move(pg_temp.admin(), 'p-active', '', 'A reason.'),
  'invalid', 'and so is an empty one');
select is(pg_temp.move(pg_temp.admin(), 'p-active', null, 'A reason.'),
  'invalid', 'and so is none');
select is(pg_temp.move(pg_temp.admin(), 'p-active', 'verified', 'A reason.'),
  'invalid', 'a verification status is not an account status');
select is(pg_temp.status_of('p-active'), 'active', 'and none of those five moved the storefront');

-- ---------------------------------------------------------------------------------------------------
-- 4. No change
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.move(pg_temp.admin(), 'p-active', 'active'),
  'no_change', 'moving a storefront to the status it already holds is refused');
select is(
  (select status from app_private.admin_seller_status_set(
     pg_temp.admin(), true, 'p-active', 'active')),
  'active', 'and the outcome reports where it actually is');
select is(pg_temp.move(pg_temp.admin(), 'p-pending', 'pending'), 'no_change', 'the same for pending');
select is(pg_temp.move(pg_temp.admin(), 'p-suspended', 'suspended', 'A reason.'),
  'no_change', 'the same for suspended, reason or no reason');
select is(pg_temp.move(pg_temp.admin(), 'p-closed', 'closed'), 'no_change', 'and the same for closed');

-- ---------------------------------------------------------------------------------------------------
-- 5. Every illegal transition
-- ---------------------------------------------------------------------------------------------------
-- `closed` is terminal, in all three directions.
select is(pg_temp.move(pg_temp.admin(), 'p-closed', 'active'),
  'not_allowed', 'a closed storefront cannot be made active');
select is(pg_temp.move(pg_temp.admin(), 'p-closed', 'suspended', 'A reason.'),
  'not_allowed', 'nor suspended');
select is(pg_temp.move(pg_temp.admin(), 'p-closed', 'pending'),
  'not_allowed', 'nor returned to pending');
select is(pg_temp.status_of('p-closed'), 'closed', 'and it is still closed');
select ok((select closed_at is not null from public.seller_profiles where slug = 'p-closed'),
  'with its closure time intact');

-- An administrator cannot walk a live storefront backwards.
select is(pg_temp.move(pg_temp.admin(), 'p-active', 'pending'),
  'not_allowed', 'an active storefront cannot be returned to pending');
select is(pg_temp.status_of('p-active'), 'active', 'and it is still active');

-- Activation is 7-G's alone, and it is refused here for both flavours of pending.
select is(pg_temp.move(pg_temp.admin(), 'p-pending', 'active'),
  'not_allowed', 'a pending storefront cannot be activated by this writer');
select is(pg_temp.move(pg_temp.admin(), 'p-pend-ver', 'active'),
  'not_allowed', 'not even one that is already verified — activation follows 7-G''s approval');
select is(pg_temp.status_of('p-pend-ver'), 'pending', 'and it stays pending');
select is(
  (select verification_status from public.seller_profiles where slug = 'p-pend-ver'),
  'verified', 'and its verification status is untouched');

-- The refusal reports where the storefront is, which is what a console needs to reload from.
select is(
  (select status from app_private.admin_seller_status_set(
     pg_temp.admin(), true, 'p-closed', 'active')),
  'closed', 'an illegal transition reports the status the storefront actually holds');

-- ---------------------------------------------------------------------------------------------------
-- 6. The reason rule
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.move(pg_temp.admin(), 'p-active', 'suspended'),
  'reason_required', 'a suspension with no reason is refused');
select is(pg_temp.move(pg_temp.admin(), 'p-active', 'suspended', '   '),
  'reason_required', 'and so is one with only whitespace');
select is(pg_temp.move(pg_temp.admin(), 'p-active', 'suspended', ''),
  'reason_required', 'and so is one with an empty string');
select is(pg_temp.status_of('p-active'), 'active', 'and none of those three moved it');
select is(
  (select suspension_reason from public.seller_profiles where slug = 'p-active'),
  null, 'nor recorded a reason on it');

-- A reason is not required for anything else.
select is(pg_temp.move(pg_temp.admin(), 'p-pending', 'closed'),
  'updated', 'closing a storefront needs no reason');
select is(pg_temp.status_of('p-pending'), 'closed', 'and it is closed');

-- ---------------------------------------------------------------------------------------------------
-- 7. The seven legal transitions, each performed
-- ---------------------------------------------------------------------------------------------------
-- active → suspended
select is(pg_temp.move(pg_temp.admin(), 'p-active', 'suspended', '  Selling counterfeits.  '),
  'updated', 'active → suspended');
select is(pg_temp.status_of('p-active'), 'suspended', 'the storefront is suspended');
select is(
  (select suspension_reason from public.seller_profiles where slug = 'p-active'),
  'Selling counterfeits.', 'the reason is recorded, trimmed');
select ok((select suspended_at is not null from public.seller_profiles where slug = 'p-active'),
  'the suspension time is set, as the constraint requires');
select ok((select closed_at is null from public.seller_profiles where slug = 'p-active'),
  'and no closure time is invented');

-- suspended → active, on a verified storefront
select is(pg_temp.move(pg_temp.admin(), 'p-susp-ver', 'active'),
  'updated', 'suspended → active, on a verified storefront');
select is(pg_temp.status_of('p-susp-ver'), 'active', 'the storefront is active');
select ok((select suspended_at is null from public.seller_profiles where slug = 'p-susp-ver'),
  'the suspension time is cleared, as the constraint requires');
select is(
  (select suspension_reason from public.seller_profiles where slug = 'p-susp-ver'),
  null, 'and the reason is cleared — its history is in the audit trail');

-- suspended → pending, on an unverified storefront
select is(pg_temp.move(pg_temp.admin(), 'p-suspended', 'pending'),
  'updated', 'suspended → pending, on a storefront that is not verified');
select is(pg_temp.status_of('p-suspended'), 'pending', 'the storefront is pending');
select ok((select suspended_at is null from public.seller_profiles where slug = 'p-suspended'),
  'the suspension time is cleared');
select is(
  (select suspension_reason from public.seller_profiles where slug = 'p-suspended'),
  null, 'and so is the reason');
select is(
  (select verification_status from public.seller_profiles where slug = 'p-suspended'),
  'rejected', 'and its rejected verification is untouched');

-- pending → suspended
select is(pg_temp.move(pg_temp.admin(), 'p-suspended', 'suspended', 'Still under investigation.'),
  'updated', 'pending → suspended');
select is(pg_temp.status_of('p-suspended'), 'suspended', 'the storefront is suspended again');
select is(
  (select suspension_reason from public.seller_profiles where slug = 'p-suspended'),
  'Still under investigation.', 'with the new reason, not the old one');

-- suspended → closed
select is(pg_temp.move(pg_temp.admin(), 'p-suspended', 'closed'),
  'updated', 'suspended → closed');
select is(pg_temp.status_of('p-suspended'), 'closed', 'the storefront is closed');
select ok((select closed_at is not null from public.seller_profiles where slug = 'p-suspended'),
  'the closure time is set, as the constraint requires');
select ok((select suspended_at is null from public.seller_profiles where slug = 'p-suspended'),
  'the suspension time is cleared, because the constraint forbids keeping it');
select is(
  (select suspension_reason from public.seller_profiles where slug = 'p-suspended'),
  null, 'and the reason goes with it, rather than being left without its time');

-- active → closed
select is(pg_temp.move(pg_temp.admin(), 'p-susp-ver', 'closed'),
  'updated', 'active → closed');
select is(pg_temp.status_of('p-susp-ver'), 'closed', 'the storefront is closed');
select ok((select closed_at is not null from public.seller_profiles where slug = 'p-susp-ver'),
  'with its closure time');

-- pending → closed was performed in section 6; assert its fields here.
select ok((select closed_at is not null from public.seller_profiles where slug = 'p-pending'),
  'pending → closed set the closure time too');
select ok((select suspended_at is null from public.seller_profiles where slug = 'p-pending'),
  'and left no suspension time');

-- A super administrator may do all of it too.
select is(pg_temp.move('f9000000-0000-4000-8000-000000000002', 'p-pend-ver', 'suspended', 'By a super admin.'),
  'updated', 'a super_admin may suspend a storefront');
select is(pg_temp.status_of('p-pend-ver'), 'suspended', 'and it is suspended');
select is(pg_temp.move('f9000000-0000-4000-8000-000000000002', 'p-pend-ver', 'active'),
  'updated', 'and reinstate it, because it is verified');
select is(pg_temp.status_of('p-pend-ver'), 'active', 'and it is active');

-- ---------------------------------------------------------------------------------------------------
-- 8. The two reinstatement conditions, as strict complements
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('f9000000-0000-4000-8000-000000000011', 'p-seller-susp-unver-2@test.invalid');
select pg_temp.shop('f9000000-0000-4000-8000-000000000011', 'p-susp-unver-2', 'suspended', 'unverified');

select is(pg_temp.move(pg_temp.admin(), 'p-susp-unver-2', 'active'),
  'not_verified', 'an unverified storefront cannot be reinstated to active');
select is(pg_temp.status_of('p-susp-unver-2'), 'suspended', 'and it stays suspended');
select is(
  (select status from app_private.admin_seller_status_set(
     pg_temp.admin(), true, 'p-susp-unver-2', 'active')),
  'suspended', 'and the refusal reports where it is');
select is(pg_temp.move(pg_temp.admin(), 'p-susp-unver-2', 'pending'),
  'updated', 'and pending is where it reinstates to instead');

insert into auth.users (id, email) values
  ('f9000000-0000-4000-8000-000000000012', 'p-seller-susp-ver-2@test.invalid');
select pg_temp.shop('f9000000-0000-4000-8000-000000000012', 'p-susp-ver-2', 'suspended', 'verified');

select is(pg_temp.move(pg_temp.admin(), 'p-susp-ver-2', 'pending'),
  'already_verified', 'a verified storefront cannot be parked in pending');
select is(pg_temp.status_of('p-susp-ver-2'), 'suspended', 'and it stays suspended');
select is(pg_temp.move(pg_temp.admin(), 'p-susp-ver-2', 'active'),
  'updated', 'and active is where it reinstates to instead');
select is(pg_temp.status_of('p-susp-ver-2'), 'active', 'and it is active');

-- The constraint is what makes the `active` check more than a courtesy: without it the statement itself
-- would be refused by the database, and the outcome would be an error rather than an answer.
select throws_ok(
  $$ update public.seller_profiles set status = 'active' where slug = 'p-susp-unver-2' $$,
  '23514',
  null,
  'the database itself refuses an unverified storefront the active status');

-- ---------------------------------------------------------------------------------------------------
-- 9. Isolation
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.status_of('p-bystander'), 'active',
  'a storefront nobody named is untouched by every transition above');
select is(
  (select count(*)::integer from public.seller_profiles
    where slug = 'p-bystander' and status = 'active' and suspended_at is null
      and suspension_reason is null and closed_at is null),
  1, 'and every one of its status fields is as it started');

select is(pg_temp.move(pg_temp.admin(), 'p-bystander', 'suspended', 'Only this one.'),
  'updated', 'naming one storefront moves that one');
select is(
  (select count(*)::integer from public.seller_profiles
    where status = 'suspended' and suspension_reason = 'Only this one.'),
  1, 'and exactly one storefront carries that reason');
select is(pg_temp.move(pg_temp.admin(), 'p-bystander', 'active'), 'updated', 'and back again');

-- ---------------------------------------------------------------------------------------------------
-- 10. Nothing else on the storefront moved
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.seller_profiles s
    join pg_temp_shop_before b on b.user_id = s.user_id
   where s.slug is distinct from b.slug
      or s.display_name is distinct from b.display_name
      or s.legal_name is distinct from b.legal_name
      or s.bio is distinct from b.bio
      or s.contact_email is distinct from b.contact_email
      or s.contact_phone_e164 is distinct from b.contact_phone_e164
      or s.country_code is distinct from b.country_code
      or s.governorate is distinct from b.governorate
      or s.city is distinct from b.city
      or s.logo_object_path is distinct from b.logo_object_path
      or s.banner_object_path is distinct from b.banner_object_path
      or s.verification_status is distinct from b.verification_status
      or s.verified_at is distinct from b.verified_at
      or s.created_at is distinct from b.created_at),
  0, 'a suspension changed the status fields and not one other column — verification included');

-- ---------------------------------------------------------------------------------------------------
-- 11. No cascade into any other domain
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from pg_temp_before b
    where b.listings <> (select count(*) from public.listings)
       or b.offers <> (select count(*) from public.offers)
       or b.service_requests <> (select count(*) from public.service_requests)
       or b.orders <> (select count(*) from public.orders)
       or b.ledger_entries <> (select count(*) from public.ledger_entries)
       or b.seller_balances <> (select count(*) from public.seller_balances)
       or b.payouts <> (select count(*) from public.payouts)
       or b.withdrawals <> (select count(*) from public.withdrawals)),
  0, 'no row was created or removed in listings, offers, service requests, orders, the ledger, balances, payouts or withdrawals');

select is(
  (select count(*)::integer from public.listings l
    join pg_temp_listing_before b on b.id = l.id
   where l.status is distinct from b.status
      or l.approved_at is distinct from b.approved_at
      or l.archived_at is distinct from b.archived_at
      or l.deleted_at is distinct from b.deleted_at),
  0, 'and not one listing row was modified by any transition');

-- Public visibility follows seller status through 0011's own predicate, with the listing row untouched.
select ok(public.listing_is_visible('99990000-0000-4000-8000-000000000001'),
  'the bystander''s listing is publicly visible while its seller is active');
select is(pg_temp.move(pg_temp.admin(), 'p-bystander', 'suspended', 'To show visibility follows.'),
  'updated', 'suspending that seller');
select ok(not public.listing_is_visible('99990000-0000-4000-8000-000000000001'),
  'makes the listing invisible — through the seller-state rule, not a listing write');
select ok(not public.is_seller_publicly_visible('f9000000-0000-4000-8000-000000000010'),
  'and the storefront invisible with it');
select is(
  (select status from public.listings where id = '99990000-0000-4000-8000-000000000001'),
  'active', 'while the listing''s own status is still exactly what it was');
select is(pg_temp.move(pg_temp.admin(), 'p-bystander', 'active'), 'updated', 'reinstating the seller');
select ok(public.listing_is_visible('99990000-0000-4000-8000-000000000001'),
  'makes the listing visible again, with no listing row ever written');

-- ---------------------------------------------------------------------------------------------------
-- 12. The audit trail is 0009's trigger, and only that
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('f9000000-0000-4000-8000-000000000013', 'p-seller-audit@test.invalid');
select pg_temp.shop('f9000000-0000-4000-8000-000000000013', 'p-audit', 'active', 'verified');

create temporary table pg_temp_audit_before as
  select count(*) as n from audit.audit_logs
   where table_schema = 'public' and table_name = 'seller_profiles';

select is(pg_temp.move(pg_temp.admin(), 'p-audit', 'suspended', 'For the audit trail.'),
  'updated', 'one transition, for counting');
select is(
  (select count(*)::integer from audit.audit_logs
    where table_schema = 'public' and table_name = 'seller_profiles')
  - (select n::integer from pg_temp_audit_before),
  1, 'writes exactly one audit row — 0009''s trigger, and no second one from this migration');

select ok(
  (select bool_or('status' = any (a.changed_columns)) from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'
      and a.occurred_at >= (select max(occurred_at) from audit.audit_logs)),
  'and that row names the status column as one that changed');
select ok(
  (select bool_or('suspended_at' = any (a.changed_columns)) from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'
      and a.occurred_at >= (select max(occurred_at) from audit.audit_logs)),
  'and the suspension time');
select ok(
  (select bool_or('suspension_reason' = any (a.changed_columns)) from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'
      and a.occurred_at >= (select max(occurred_at) from audit.audit_logs)),
  'and the reason');
select is(
  (select a.action from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'
    order by a.occurred_at desc, a.id desc limit 1),
  'update', 'and records it as an update');

-- A refusal writes nothing.
create temporary table pg_temp_audit_mid as
  select count(*) as n from audit.audit_logs
   where table_schema = 'public' and table_name = 'seller_profiles';
-- `p-audit` is suspended and verified at this point, so these three genuinely refuse: pending is closed to
-- a verified storefront, suspended is where it already is, and a moderator holds no manage key.
select is(pg_temp.move(pg_temp.admin(), 'p-audit', 'pending'),
  'already_verified', 'a refused transition');
select is(pg_temp.move(pg_temp.admin(), 'p-audit', 'suspended', 'Again.'),
  'no_change', 'and a no-change one');
select is(pg_temp.move('f9000000-0000-4000-8000-000000000003', 'p-audit', 'closed'),
  'not_found', 'and one from a colleague without the key');
select is(
  (select count(*)::integer from audit.audit_logs
    where table_schema = 'public' and table_name = 'seller_profiles')
  - (select n::integer from pg_temp_audit_mid),
  0, 'write no audit row between them');

/*
 * The two limitations of `audit.tg_record_change()` this writer inherits, asserted so they are facts rather
 * than assumptions. Neither is changed here: the decision is to use the existing trigger and add no second
 * audit path, and both properties are true of every app_system write to every audited table.
 */
select is(
  (select a.actor_id from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'
    order by a.occurred_at desc, a.id desc limit 1),
  null,
  'the audit row records no actor: the trigger reads current_user_id(), and app_system carries no claims');
select is(
  (select a.actor_type from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'
    order by a.occurred_at desc, a.id desc limit 1),
  'system',
  'so it is recorded as a system change rather than a named colleague''s');
select is(
  (select a.record_id from audit.audit_logs a
    where a.table_schema = 'public' and a.table_name = 'seller_profiles'
    order by a.occurred_at desc, a.id desc limit 1),
  null,
  'and no record id, because the trigger reads an `id` column that seller_profiles does not have');

-- No security event and no outbox event was created by any of it.
select is(
  (select count(*)::integer from public.security_events
    where event_type like 'seller%' or event_type like '%status%'),
  0, 'no security event was written, and no vocabulary was extended');
select is(
  (select count(*)::integer from public.outbox_events
    where aggregate_type = 'seller_profile' or event_type like 'seller.status%'),
  0, 'and no outbox event either');

-- ---------------------------------------------------------------------------------------------------
-- 13. Concurrency
-- ---------------------------------------------------------------------------------------------------
-- The row is locked before anything is decided, so two transitions in one transaction are ordered: the
-- second sees the first's result. In separate sessions the second blocks until the first commits and then
-- reads the same committed state, which is the same outcome by a different route.
insert into auth.users (id, email) values
  ('f9000000-0000-4000-8000-000000000014', 'p-seller-race@test.invalid');
select pg_temp.shop('f9000000-0000-4000-8000-000000000014', 'p-race', 'active', 'verified');

select is(pg_temp.move(pg_temp.admin(), 'p-race', 'suspended', 'First.'),
  'updated', 'the first colleague suspends it');
select is(pg_temp.move('f9000000-0000-4000-8000-000000000002', 'p-race', 'suspended', 'Second.'),
  'no_change', 'and the second is told it is already there, rather than suspending it twice');
select is(
  (select suspension_reason from public.seller_profiles where slug = 'p-race'),
  'First.', 'the first reason stands');
select is(pg_temp.move('f9000000-0000-4000-8000-000000000002', 'p-race', 'closed'),
  'updated', 'a second colleague may still take it further');
select is(pg_temp.move(pg_temp.admin(), 'p-race', 'active'),
  'not_allowed', 'and once closed, the first colleague cannot bring it back');

select ok(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'admin_seller_status_set'
      and p.prosrc like '%for update%') = 1,
  'the writer locks the row before it decides anything');

-- ---------------------------------------------------------------------------------------------------
-- 14. The boundary
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('admin_can_manage_sellers', 'admin_seller_status_set')),
  2, 'both functions exist');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('admin_can_manage_sellers', 'admin_seller_status_set')
      and not p.prosecdef),
  0, 'both are SECURITY DEFINER');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('admin_can_manage_sellers', 'admin_seller_status_set')
      and not coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog, public']),
  0, 'both pin their search_path');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('admin_can_manage_sellers', 'admin_seller_status_set')
      and (has_function_privilege('public', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('app_worker', p.oid, 'execute'))),
  0, 'neither is executable by public, authenticated or app_worker');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('admin_can_manage_sellers', 'admin_seller_status_set')
      and not has_function_privilege('app_system', p.oid, 'execute')),
  0, 'and both are executable by app_system');

-- No role name anywhere: authorization is by permission key.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('admin_can_manage_sellers', 'admin_seller_status_set')
      and (p.prosrc like '%''super_admin''%' or p.prosrc like '%''admin''%'
        or p.prosrc like '%''moderator''%' or p.prosrc like '%''support_agent''%')),
  0, 'neither names a role');

-- The writer touches one table and one set of columns, and no other domain.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'admin_seller_status_set'
      and (p.prosrc ~* 'update\s+public\.listings'
        or p.prosrc ~* 'update\s+public\.offers'
        or p.prosrc ~* 'update\s+public\.service_requests'
        or p.prosrc ~* 'update\s+public\.orders'
        or p.prosrc ~* 'update\s+public\.payouts'
        or p.prosrc ~* 'update\s+public\.seller_balances'
        or p.prosrc ~* 'update\s+public\.withdrawals'
        or p.prosrc ~* 'insert\s+into'
        or p.prosrc ~* 'delete\s+from')),
  0, 'the writer updates nothing but seller_profiles, and inserts and deletes nothing at all');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'admin_seller_status_set'
      and (p.prosrc like '%verification_status =%' or p.prosrc like '%verified_at =%')),
  0, 'and it sets neither verification column — 7-G owns both');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'admin_seller_status_set'
      and (p.prosrc like '%security_events%' or p.prosrc like '%enqueue_outbox_event%'
        or p.prosrc like '%audit_logs%')),
  0, 'and writes no security event, no outbox event and no audit row of its own');

-- Role management is still a gap, and 0079 did not quietly close it.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.prosrc ~* 'insert\s+into\s+public\.user_roles'
        or p.prosrc ~* 'update\s+public\.user_roles'
        or p.prosrc ~* 'delete\s+from\s+public\.user_roles')),
  0, 'no app_private function writes public.user_roles — role management remains the deferred gap');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc like '%users.role.manage%'),
  0, 'and users.role.manage is consumed by nothing in the database');

-- ---------------------------------------------------------------------------------------------------
-- 15. 0009's own behaviour is preserved
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from pg_policy p
    where p.polrelid = 'public.seller_profiles'::regclass),
  6, 'all six of 0009''s seller policies are still there');
select ok(
  (select pg_get_expr(p.polqual, p.polrelid) like '%status <> ''suspended''%'
     from pg_policy p
    where p.polrelid = 'public.seller_profiles'::regclass and p.polname = 'seller_profiles_self_update'),
  'and a suspended seller still cannot self-update, by 0009''s own policy');
select is(
  (select count(*)::integer from pg_trigger t
    where t.tgrelid = 'public.seller_profiles'::regclass and not t.tgisinternal),
  3, 'all three of 0009''s triggers are still there');
select ok(
  (select count(*) from pg_trigger t
    where t.tgrelid = 'public.seller_profiles'::regclass and t.tgname = 'seller_profiles_audit') = 1,
  'including the audit trigger this increment relies on and did not replace');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid = 'public.seller_profiles'::regclass and contype = 'c'),
  (select count(*)::integer from pg_constraint
    where conrelid = 'public.seller_profiles'::regclass and contype = 'c'),
  'and no CHECK constraint was added, removed or tightened');
select ok(
  (select count(*) from pg_constraint
    where conrelid = 'public.seller_profiles'::regclass
      and conname = 'seller_profiles_suspended_has_time') = 1,
  'the suspended-has-time constraint is untouched');
select ok(
  (select attnotnull = false from pg_attribute
    where attrelid = 'public.seller_profiles'::regclass and attname = 'suspension_reason'),
  'and suspension_reason is still nullable in the column, as decided');

select * from finish();
rollback;
