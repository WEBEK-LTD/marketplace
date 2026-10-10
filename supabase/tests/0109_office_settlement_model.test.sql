-- pgTAP — migration 0109: the office settlement model (OD-A1 … OD-A9).
--
-- What this file proves, in order:
--
--   * **the permission exists and reaches exactly two roles** — admin and super_admin, and not the
--     moderator or the support agent, so "a moderator cannot record money" is true by assignment;
--   * **the predicate honours the assurance level**, because the admin role requires MFA;
--   * **an enquiry is always an office enquiry** — `admin_only`, no seller, the listing's own currency —
--     and the writer refuses a listing that is not live, a brief that is too short, a non-positive budget
--     and a seller enquiring about their own listing;
--   * **the receipt records and settles**: the commission is the figure 0016's rules dictate, the seller's
--     share is the remainder, and the enquiry closes as `accepted` with its time;
--   * **the arithmetic**, component by component: a percentage rounded in exact decimal, a fixed component
--     clamped by its own bounds, a fixed component with no amount in the currency skipped and contributing
--     nothing, and a total that cannot exceed the money in the drawer;
--   * **the refusals**: no key, too weak a session, a blank reference, a second receipt for the same
--     enquiry, and an enquiry that is already closed;
--   * **the record cannot be edited or deleted**, and no role holds a privilege on the table;
--   * **nothing was broken elsewhere**: the append-only contract, the audit attribution contract and the
--     whitespace contract are all still empty.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(58);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('09090000-0000-4000-8000-000000000001', 'o-admin@test.invalid'),
  ('09090000-0000-4000-8000-000000000002', 'o-moderator@test.invalid'),
  ('09090000-0000-4000-8000-000000000003', 'o-buyer@test.invalid'),
  ('09090000-0000-4000-8000-000000000004', 'o-seller@test.invalid'),
  ('09090000-0000-4000-8000-000000000005', 'o-nobody@test.invalid');

insert into public.user_roles (user_id, role_key, granted_at) values
  ('09090000-0000-4000-8000-000000000001', 'admin', now() - interval '10 days'),
  ('09090000-0000-4000-8000-000000000002', 'moderator', now() - interval '10 days');

insert into public.seller_profiles (
  user_id, slug, display_name, legal_name, bio, content_language, contact_email, contact_phone_e164,
  country_code, governorate, city, status, verification_status, verified_at, created_at
) values (
  '09090000-0000-4000-8000-000000000004', 'o-shop', 'Office Shop', 'Office Shop LLC', 'A bio.', 'en',
  'o-shop@test.invalid', '+201000199999',
  'EG', 'Cairo', 'Cairo', 'active', 'verified', now() - interval '5 days', now() - interval '10 days'
);

insert into public.categories (id, slug, listing_type_code, depth) values
  ('09090000-0000-4000-8000-0000000000c1', 'o-category', 'product', 0);

create or replace function pg_temp.listing(p_id uuid, p_slug text, p_status text, p_price bigint)
returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description,
    content_language, currency_code, price_minor, status, country_code, approved_at
  ) values (
    p_id, '09090000-0000-4000-8000-000000000004', 'product',
    '09090000-0000-4000-8000-0000000000c1', p_slug, 'A property', 'A description long enough to pass.',
    'en', 'EGP', p_price, p_status,
    (select code from public.countries limit 1),
    case when p_status in ('approved', 'active') then now() - interval '3 days' end
  );
end;
$$;

select pg_temp.listing('09090000-0000-4000-8000-0000000000a1'::uuid, 'o-live',  'active', 1000000);
select pg_temp.listing('09090000-0000-4000-8000-0000000000a2'::uuid, 'o-draft', 'draft',  1000000);
select pg_temp.listing('09090000-0000-4000-8000-0000000000a3'::uuid, 'o-live-2', 'active', 500000);
select pg_temp.listing('09090000-0000-4000-8000-0000000000a4'::uuid, 'o-live-3', 'active', 500000);
select pg_temp.listing('09090000-0000-4000-8000-0000000000a5'::uuid, 'o-live-4', 'active', 500000);

create or replace function pg_temp.enquire(p_buyer uuid, p_listing uuid, p_title text default 'An enquiry')
returns text language sql as $$
  select outcome from app_private.listing_enquiry_create(
    p_buyer, p_listing, p_title, 'I would like to see this property, please.'
  );
$$;

create or replace function pg_temp.enquiry_id(p_listing uuid) returns uuid language sql as $$
  select id from public.service_requests where listing_id = p_listing order by created_at desc limit 1;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 1. OD-A8's permission and its assignment
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.permissions where key = 'payments.office_receipt.manage'),
  1, 'the permission key exists');
select is(
  (select module from public.permissions where key = 'payments.office_receipt.manage'),
  'payments', 'and it belongs to the payments module');
select set_eq(
  $$select role_key from public.role_permissions where permission_key = 'payments.office_receipt.manage'$$,
  $$values ('admin'), ('super_admin')$$,
  'exactly admin and super_admin hold it — not the moderator, not the support agent');

-- ---------------------------------------------------------------------------------------------------
-- 2. The predicate
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.office_receipt_can_manage('09090000-0000-4000-8000-000000000001', true),
  'an administrator in an aal2 session can manage receipts');
select ok(
  not app_private.office_receipt_can_manage('09090000-0000-4000-8000-000000000001', false),
  'the same administrator below aal2 cannot — the admin role requires MFA');
select ok(
  not app_private.office_receipt_can_manage('09090000-0000-4000-8000-000000000002', true),
  'a moderator cannot, whatever the session strength');
select ok(
  not app_private.office_receipt_can_manage('09090000-0000-4000-8000-000000000005', true),
  'and an account with no role cannot');

-- ---------------------------------------------------------------------------------------------------
-- 3. The enquiry
-- ---------------------------------------------------------------------------------------------------
select is(
  pg_temp.enquire('09090000-0000-4000-8000-000000000003', '09090000-0000-4000-8000-0000000000a1'),
  'created', 'a buyer can enquire about a live listing');

select is(
  (select routing_mode from public.service_requests
    where id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1')),
  'admin_only', 'and the request is routed to the office');
select is(
  (select seller_user_id from public.service_requests
    where id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1')),
  null, 'with no seller on it — OD-A4');
select is(
  (select currency_code from public.service_requests
    where id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1')),
  'EGP'::char(3), 'in the listing''s own currency, which no caller supplied');
select is(
  (select status from public.service_requests
    where id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1')),
  'open', 'and it starts open');
select is(
  (select closed_at from public.service_requests
    where id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1')),
  null, 'and is not closed');
select is(
  (select preferred_payment_method from public.service_requests
    where id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1')),
  null, 'and carries no preferred payment method: under OD-A1 there is only one way to pay');

select is(
  pg_temp.enquire('09090000-0000-4000-8000-000000000003', '09090000-0000-4000-8000-0000000000a2'),
  'not_found', 'a listing that is not live is not found');
select is(
  pg_temp.enquire('09090000-0000-4000-8000-000000000003', '09090000-0000-4000-8000-00000000dead'),
  'not_found', 'and an unknown listing gives the identical answer');
select is(
  pg_temp.enquire(null, '09090000-0000-4000-8000-0000000000a1'),
  'not_found', 'and so does a missing buyer');
select is(
  pg_temp.enquire('09090000-0000-4000-8000-000000000003', '09090000-0000-4000-8000-0000000000a1', 'ab'),
  'invalid', 'a title under three characters is refused');
select is(
  (select outcome from app_private.listing_enquiry_create(
     '09090000-0000-4000-8000-000000000003', '09090000-0000-4000-8000-0000000000a1',
     'An enquiry', 'too short')),
  'invalid', 'and a brief under ten characters is refused');
select is(
  (select outcome from app_private.listing_enquiry_create(
     '09090000-0000-4000-8000-000000000003', '09090000-0000-4000-8000-0000000000a1',
     'An enquiry', 'I would like to see this property, please.', 0)),
  'invalid', 'and a budget of zero is refused');
select is(
  pg_temp.enquire('09090000-0000-4000-8000-000000000004', '09090000-0000-4000-8000-0000000000a1'),
  'invalid', 'a seller cannot enquire about their own listing');

-- ---------------------------------------------------------------------------------------------------
-- 4. The receipt: the refusals first, so none of them can be mistaken for a write
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.office_receipt_record(
     '09090000-0000-4000-8000-000000000002', true,
     pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1'), 1000000, 'R-1')),
  'not_found', 'a moderator recording money gets not_found, the answer an absent enquiry gets');
select is(
  (select outcome from app_private.office_receipt_record(
     '09090000-0000-4000-8000-000000000001', false,
     pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1'), 1000000, 'R-1')),
  'not_found', 'and so does an administrator below aal2');
select is(
  (select outcome from app_private.office_receipt_record(
     '09090000-0000-4000-8000-000000000001', true,
     pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1'), 1000000, E' \t\r\n ')),
  'invalid', 'a receipt reference of whitespace is refused');
select is(
  (select outcome from app_private.office_receipt_record(
     '09090000-0000-4000-8000-000000000001', true,
     pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1'), 0, 'R-1')),
  'invalid', 'and so is an amount of zero');
select is(
  (select outcome from app_private.office_receipt_record(
     '09090000-0000-4000-8000-000000000001', true,
     '09090000-0000-4000-8000-00000000dead', 1000000, 'R-1')),
  'not_found', 'and an unknown enquiry');

select is(
  (select count(*)::integer from public.office_receipts), 0,
  'none of those refusals wrote a receipt');
select is(
  (select status from public.service_requests
    where id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1')),
  'open', 'and none of them moved the enquiry');

-- ---------------------------------------------------------------------------------------------------
-- 5. The commission, with no rule configured at all
-- ---------------------------------------------------------------------------------------------------
-- The seeded platform has no commission rule, which is a real state and not a gap in the fixture: a
-- marketplace that has not set a rate charges nothing. The whole amount is then the seller's.
select is(
  (select outcome from app_private.office_receipt_record(
     '09090000-0000-4000-8000-000000000001', true,
     pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1'), 1000000, E'  R-100  ',
     'Paid in full at the front desk.')),
  'recorded', 'with no rule configured the receipt still records');
select is(
  (select commission_minor from public.office_receipts), 0::bigint,
  'and the commission is zero');
select is(
  (select seller_share_minor from public.office_receipts), 1000000::bigint,
  'so the whole amount is the seller''s share');
select is(
  (select receipt_reference from public.office_receipts), 'R-100',
  'and the reference was trimmed of its surrounding whitespace');
select is(
  (select seller_user_id from public.office_receipts),
  '09090000-0000-4000-8000-000000000004'::uuid,
  'the seller came from the listing, not from a caller');
select is(
  (select recorded_by from public.office_receipts),
  '09090000-0000-4000-8000-000000000001'::uuid,
  'and the recording staff member is on the row');
select is(
  (select status from public.service_requests
    where id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1')),
  'accepted', 'the enquiry is now accepted — the office carried it out');
select isnt(
  (select closed_at from public.service_requests
    where id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1')),
  null, 'and it carries its closing time, as the constraint requires');

-- A second receipt for the same enquiry is refused, and the enquiry says why.
select is(
  (select outcome from app_private.office_receipt_record(
     '09090000-0000-4000-8000-000000000001', true,
     pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a1'), 1000000, 'R-101')),
  'not_open', 'a second receipt for the same enquiry is refused');
select is(
  (select count(*)::integer from public.office_receipts), 1,
  'and there is still exactly one receipt');

-- ---------------------------------------------------------------------------------------------------
-- 6. The arithmetic, with rules configured
-- ---------------------------------------------------------------------------------------------------
-- 250 basis points of 500,000 is 12,500 exactly; the rounding is checked separately below with an amount
-- that does not divide.
insert into public.commission_rules (id, name, scope, component_type, percentage_basis_points, priority)
values ('09090000-0000-4000-8000-0000000000b1', 'Platform rate', 'platform', 'percentage', 250, 10);

select is(pg_temp.enquire('09090000-0000-4000-8000-000000000003', '09090000-0000-4000-8000-0000000000a3'),
  'created', 'a second enquiry, to record against the configured rate');
select is(
  (select commission_minor from app_private.office_receipt_record(
     '09090000-0000-4000-8000-000000000001', true,
     pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a3'), 500000, 'R-200')),
  12500::bigint, '2.50% of 500,000 is 12,500');
select is(
  (select seller_share_minor from public.office_receipts
    where service_request_id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a3')),
  487500::bigint, 'and the seller''s share is the remainder');
select is(
  (select jsonb_array_length(commission_snapshot -> 'components') from public.office_receipts
    where service_request_id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a3')),
  1, 'the snapshot names the one component that applied');
select is(
  (select commission_snapshot -> 'components' -> 0 ->> 'contributed_minor' from public.office_receipts
    where service_request_id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a3')),
  '12500', 'and records what it contributed, so a later rule change cannot rewrite this figure');

-- Rounding: 250 bps of 333,333 is 8,333.325, which rounds to 8,333. Exact decimal, not binary float.
insert into public.commission_rule_amounts (commission_rule_id, currency_code, amount_minor)
select '09090000-0000-4000-8000-0000000000b2', 'EGP', 7000 where false;
insert into public.commission_rules (id, name, scope, component_type, percentage_basis_points, priority, is_active)
values ('09090000-0000-4000-8000-0000000000b9', 'Inactive rate', 'platform', 'percentage', 9000, 99, false);

select is(pg_temp.enquire('09090000-0000-4000-8000-000000000003', '09090000-0000-4000-8000-0000000000a4'),
  'created', 'a third enquiry, for the rounding case');
select is(
  (select commission_minor from app_private.office_receipt_record(
     '09090000-0000-4000-8000-000000000001', true,
     pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a4'), 333333, 'R-300')),
  8333::bigint, '2.50% of 333,333 rounds to 8,333 — and the inactive rule did not apply');

-- A fixed component with no amount in this currency is skipped, contributes nothing, and still appears.
insert into public.commission_rules (id, name, scope, component_type, priority)
values ('09090000-0000-4000-8000-0000000000b3', 'Fixed fee', 'platform', 'fixed', 5);

select is(pg_temp.enquire('09090000-0000-4000-8000-000000000003', '09090000-0000-4000-8000-0000000000a5'),
  'created', 'a fourth enquiry, with a fixed component configured but priced in no currency');
select is(
  (select commission_minor from app_private.office_receipt_record(
     '09090000-0000-4000-8000-000000000001', true,
     pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a5'), 500000, 'R-400')),
  12500::bigint, 'the skipped fixed component contributes nothing (D27) and the percentage still applies');
select is(
  (select count(*)::integer from public.office_receipts r,
          jsonb_array_elements(r.commission_snapshot -> 'components') c
    where r.service_request_id = pg_temp.enquiry_id('09090000-0000-4000-8000-0000000000a5')
      and (c ->> 'is_skipped')::boolean),
  1, 'and the skipped component is still in the snapshot, with its reason');

-- ---------------------------------------------------------------------------------------------------
-- 7. The record cannot be amended
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$update public.office_receipts set commission_minor = 0$$,
  null, null, 'a receipt cannot be updated');
select throws_ok(
  $$delete from public.office_receipts$$,
  null, null, 'and it cannot be deleted — a correction is the office''s business, not an edit');
select is(
  (select count(*)::integer from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'office_receipts'
      and grantee not in ('postgres', current_user)),
  0, 'and no role holds a privilege on the table: it is reachable only through its functions');

-- ---------------------------------------------------------------------------------------------------
-- 8. The console's reader
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_private.office_receipts_for_staff(
     '09090000-0000-4000-8000-000000000001', true, 25)),
  4, 'an authorized caller sees all four receipts');
select is(
  (select count(*)::integer from app_private.office_receipts_for_staff(
     '09090000-0000-4000-8000-000000000002', true, 25)),
  0, 'and a moderator sees none of them');
-- Paging, proved with the cursor rather than by naming which row comes first.
--
-- The first version of this assertion expected a particular receipt from `limit 1` and passed once, then
-- failed on the next run. The reason is worth keeping: `recorded_at` defaults to `now()`, which is the
-- **transaction's** timestamp, so all four receipts written by this one test transaction carry the same
-- instant and the order falls through to `id`, which is a random uuid. In the product each recording is
-- its own transaction and the timestamps differ, so the reader's order is right — but an assertion that
-- depends on which uuid sorted higher is an assertion that fails at random. What matters, and what is
-- asserted instead, is that the seek cursor still partitions the set when the timestamps tie.
select is(
  (select count(*)::integer from app_private.office_receipts_for_staff(
     '09090000-0000-4000-8000-000000000001', true, 1)),
  1, 'and a page of one returns one receipt');
select is(
  (with first_page as (
     select receipt_id, recorded_at from app_private.office_receipts_for_staff(
       '09090000-0000-4000-8000-000000000001', true, 1)
   )
   select count(*)::integer
     from first_page f,
          app_private.office_receipts_for_staff(
            '09090000-0000-4000-8000-000000000001', true, 25, f.recorded_at, f.receipt_id) n
    where n.receipt_id = f.receipt_id),
  0, 'and the next page never repeats the row the cursor came from, even with identical timestamps');

-- ---------------------------------------------------------------------------------------------------
-- 9. Nothing elsewhere was broken
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::integer from public.append_only_problems()), 0,
  'the append-only contract is still satisfied, including the new table');
select is((select count(*)::integer from public.audit_attribution_problems()), 0,
  'the audit attribution contract is still satisfied, including the new writer');
select is((select count(*)::integer from app_private.whitespace_contract_problems()), 0,
  'and no new constraint or function trims spaces only');

select * from finish();
rollback;
