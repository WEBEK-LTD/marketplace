-- pgTAP — migration 0078: seller, user and role reads, recovery review, the audit trail (Phase 7-O).
--
-- What these assertions hold to account:
--
--   * **six keys, six capabilities, and the isolation between them is the point.** 0033 hands the four
--     privileged roles different keys, and this increment leans on that rather than on role names. A
--     moderator reads storefronts and accounts but **not** roles, security events, recovery or audit; a
--     support agent reads accounts and reviews recovery but **not** storefronts, roles, security events or
--     audit; only an admin holds all six. Every one of those refusals is provoked against the real
--     function, not asserted from a catalogue.
--   * **every role that grants one of these keys is `requires_mfa`, so read is gated at aal2 too.** Each
--     of the nineteen functions is driven by the right person at `aal1`, by a revoked grant and by an
--     expired one, and each answers with nothing or with `not_found` — never a row, never an error that
--     says why.
--   * **the recovery workflow is 0028's, not this migration's.** The two-person rule is provoked by
--     having the reviewer try to approve their own review; the account holder is refused at all three
--     steps; an approval lands on `contact_verification` and **not** on `approved`, which is the status
--     nothing in this repository sets; and the hold is asserted against
--     `site_setting('security.recovery_hold_hours')` rather than against a number, so no parameter of any
--     function here can shorten it.
--   * **the trails are written once.** `account_recovery_approvals`, `security_events` and the outbox are
--     counted against the number of decisions made, so a duplicate write anywhere above would show here.
--   * **the audit reader returns no values.** Asserted on the result type: no `old_values`, no
--     `new_values`, no `actor_id`, no `request_ip`. And it writes nothing — the row count is taken before
--     and after a read.
--   * **no personal data crosses that these screens do not need.** Asserted on the result types: no
--     `legal_name`, `contact_email`, `contact_phone_e164`, `full_name`, `phone_e164`,
--     `avatar_object_path`, `object_path`, `claimed_contact_hash`, `request_ip` or `device_id` anywhere
--     among the nineteen.
--   * **the two capability gaps are asserted as facts.** No function in `app_private` writes
--     `public.user_roles`, and none sets `seller_profiles.status`. Those are the two writers this
--     increment reports rather than invents, and if somebody later adds one without an owner decision,
--     these two assertions are what fails.
--
-- Deterministic: fixed uuids, every ordering assertion ages its rows explicitly rather than relying on
-- `now()`, which is transaction-stable, and audit rows are placed inside the current month's partition
-- with `date_trunc`. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(306);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('f8000000-0000-4000-8000-000000000001', 'o-admin-one@test.invalid'),
  ('f8000000-0000-4000-8000-000000000002', 'o-admin-two@test.invalid'),
  ('f8000000-0000-4000-8000-000000000003', 'o-moderator@test.invalid'),
  ('f8000000-0000-4000-8000-000000000004', 'o-support-agent@test.invalid'),
  ('f8000000-0000-4000-8000-000000000005', 'o-buyer@test.invalid'),
  ('f8000000-0000-4000-8000-000000000006', 'o-seller@test.invalid'),
  ('f8000000-0000-4000-8000-000000000007', 'o-revoked-admin@test.invalid'),
  ('f8000000-0000-4000-8000-000000000008', 'o-expired-admin@test.invalid'),
  ('f8000000-0000-4000-8000-000000000009', 'o-locked-out@test.invalid'),
  ('f8000000-0000-4000-8000-00000000000a', 'o-deleted@test.invalid'),
  ('f8000000-0000-4000-8000-00000000000b', 'o-admin-three@test.invalid');

insert into public.user_roles (user_id, role_key, granted_at) values
  ('f8000000-0000-4000-8000-000000000001', 'admin', now() - interval '10 days'),
  ('f8000000-0000-4000-8000-000000000002', 'admin', now() - interval '10 days'),
  ('f8000000-0000-4000-8000-00000000000b', 'admin', now() - interval '10 days'),
  ('f8000000-0000-4000-8000-000000000003', 'moderator', now() - interval '10 days'),
  ('f8000000-0000-4000-8000-000000000004', 'support_agent', now() - interval '10 days'),
  ('f8000000-0000-4000-8000-000000000005', 'buyer', now() - interval '10 days'),
  ('f8000000-0000-4000-8000-000000000006', 'seller', now() - interval '10 days'),
  ('f8000000-0000-4000-8000-000000000009', 'buyer', now() - interval '10 days');

-- One revoked and one expired grant of the same role, so "held it once" never reads as "holds it".
insert into public.user_roles (user_id, role_key, granted_at, revoked_at) values
  ('f8000000-0000-4000-8000-000000000007', 'admin', now() - interval '20 days', now() - interval '1 hour');
insert into public.user_roles (user_id, role_key, granted_at, expires_at) values
  ('f8000000-0000-4000-8000-000000000008', 'admin', now() - interval '20 days', now() - interval '1 hour');

-- `auth.users` already created a profile row for each of the eleven accounts above by trigger, so this
-- sets the fields the reads are judged on rather than creating the rows — and gives every one of them a
-- distinct age, so "newest first" is a fact rather than a tie between rows the trigger stamped in the
-- same transaction.
insert into public.profiles (id, display_name, full_name, phone_e164, locale_code, timezone,
                             email_verified_at, phone_verified_at, created_at) values
  ('f8000000-0000-4000-8000-000000000001', 'Admin One',     'Admin One Legal',     '+201000000101', 'en', 'Africa/Cairo', now() - interval '20 days', null,                       now() - interval '20 days'),
  ('f8000000-0000-4000-8000-000000000002', 'Admin Two',     'Admin Two Legal',     '+201000000102', 'en', 'Africa/Cairo', now() - interval '19 days', null,                       now() - interval '19 days'),
  ('f8000000-0000-4000-8000-000000000003', 'Moderator',     'Moderator Legal',     '+201000000103', 'en', 'Africa/Cairo', now() - interval '18 days', null,                       now() - interval '18 days'),
  ('f8000000-0000-4000-8000-000000000004', 'Support Agent', 'Support Agent Legal', '+201000000104', 'en', 'Africa/Cairo', now() - interval '17 days', null,                       now() - interval '17 days'),
  ('f8000000-0000-4000-8000-000000000005', 'Buyer',         'Buyer Legal',         '+201000000105', 'ar', 'Africa/Cairo', now() - interval '16 days', now() - interval '16 days', now() - interval '16 days'),
  ('f8000000-0000-4000-8000-000000000006', 'Seller',        'Seller Legal',        '+201000000106', 'ar', 'Africa/Cairo', now() - interval '15 days', now() - interval '15 days', now() - interval '15 days'),
  ('f8000000-0000-4000-8000-000000000007', 'Revoked Admin', 'Revoked Admin Legal', '+201000000107', 'en', 'Africa/Cairo', now() - interval '14 days', null,                       now() - interval '14 days'),
  ('f8000000-0000-4000-8000-000000000008', 'Expired Admin', 'Expired Admin Legal', '+201000000108', 'en', 'Africa/Cairo', now() - interval '13 days', null,                       now() - interval '13 days'),
  ('f8000000-0000-4000-8000-000000000009', 'Locked Out',    'Locked Out Legal',    '+201000000109', 'en', 'Africa/Cairo', null,                       null,                       now() - interval '12 days'),
  ('f8000000-0000-4000-8000-00000000000b', 'Admin Three',   'Admin Three Legal',   '+201000000111', 'en', 'Africa/Cairo', now() - interval '11 days', null,                       now() - interval '11 days')
on conflict (id) do update set
  display_name = excluded.display_name, full_name = excluded.full_name,
  phone_e164 = excluded.phone_e164, locale_code = excluded.locale_code,
  timezone = excluded.timezone, email_verified_at = excluded.email_verified_at,
  phone_verified_at = excluded.phone_verified_at, created_at = excluded.created_at;

-- Deleted, and therefore absent from every user read below.
insert into public.profiles (id, display_name, status, created_at, deleted_at) values
  ('f8000000-0000-4000-8000-00000000000a', 'Gone', 'deleted', now() - interval '5 days', now() - interval '1 day')
on conflict (id) do update set
  display_name = excluded.display_name, status = excluded.status,
  created_at = excluded.created_at, deleted_at = excluded.deleted_at;

-- One suspended storefront and one active one, aged so the queue's order is a fact.
insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, bio, content_language, contact_email, contact_phone_e164,
   country_code, governorate, city, status, suspended_at, suspension_reason, verification_status,
   verified_at, created_at)
values
  ('f8000000-0000-4000-8000-000000000006', 'o-shop', 'Canary Shop', 'Canary Shop LLC',
   'We sell canaries.', 'en', 'shop@test.invalid', '+201000000078', 'EG', 'Cairo', 'Cairo',
   'active', null, null, 'verified', now() - interval '6 days', now() - interval '7 days'),
  -- The admin sells too, which is the only way `is_own_storefront` is reachable.
  ('f8000000-0000-4000-8000-000000000001', 'o-admin-shop', 'Admin Shop', 'Admin Shop LLC',
   null, 'en', 'adminshop@test.invalid', '+201000000079', 'EG', 'Giza', 'Giza',
   'suspended', now() - interval '2 days', 'Suspended for the fixture.', 'pending',
   null, now() - interval '9 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c8000000-0000-4000-8000-000000000001', null, 'admin-ops-fixture', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('c8000000-0000-4000-8000-000000000001', 'en', 'Fixture'),
  ('c8000000-0000-4000-8000-000000000001', 'ar', 'عينة');

create or replace function pg_temp.listing(
  p_id uuid, p_slug text, p_status text, p_seller uuid
) returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at, approved_at
  ) values (
    p_id, p_seller, 'product', 'c8000000-0000-4000-8000-000000000001', p_slug,
    'Canary ' || p_slug, 'A description long enough to satisfy the length rule.', 'en',
    'EGP', 150000, false, p_status, 'EG', 'Cairo', now() - interval '3 days',
    case when p_status in ('approved','active','sold','expired','archived','suspended')
         then now() - interval '3 days' end
  );
end;
$$;

-- The seller has three listings, two of them publicly visible.
select pg_temp.listing('88880000-0000-4000-8000-000000000001', 'o-live-one', 'active',
  'f8000000-0000-4000-8000-000000000006');
select pg_temp.listing('88880000-0000-4000-8000-000000000002', 'o-live-two', 'active',
  'f8000000-0000-4000-8000-000000000006');
select pg_temp.listing('88880000-0000-4000-8000-000000000003', 'o-waiting', 'pending_review',
  'f8000000-0000-4000-8000-000000000006');

-- Two open reports against that storefront, and one already closed, so the count is a real filter.
insert into public.reports (reporter_user_id, subject_type, subject_id, reason_code, status, created_at) values
  ('f8000000-0000-4000-8000-000000000005', 'seller', 'f8000000-0000-4000-8000-000000000006',
   'spam', 'open', now() - interval '2 days'),
  ('f8000000-0000-4000-8000-000000000009', 'seller', 'f8000000-0000-4000-8000-000000000006',
   'spam', 'triaged', now() - interval '2 days');
insert into public.reports (reporter_user_id, subject_type, subject_id, reason_code, status,
                            resolved_by, resolved_at, resolution_note, created_at) values
  ('f8000000-0000-4000-8000-000000000003', 'seller', 'f8000000-0000-4000-8000-000000000006',
   'spam', 'dismissed', 'f8000000-0000-4000-8000-000000000001', now() - interval '1 day',
   'Nothing to act on.', now() - interval '2 days');

-- Security events for one account, aged so "newest first" is a fact.
insert into public.security_events (user_id, event_type, details, device_id, request_ip, occurred_at) values
  ('f8000000-0000-4000-8000-000000000009', 'auth.login_failed',
   jsonb_build_object('attempt', 1), null, '198.51.100.7', now() - interval '3 hours'),
  ('f8000000-0000-4000-8000-000000000009', 'auth.login_failed',
   jsonb_build_object('attempt', 2), null, '198.51.100.7', now() - interval '2 hours'),
  ('f8000000-0000-4000-8000-000000000009', 'auth.mfa_challenge_failed',
   jsonb_build_object('attempt', 3), null, '198.51.100.7', now() - interval '1 hour'),
  -- Somebody else's, which must never appear in the first account's timeline.
  ('f8000000-0000-4000-8000-000000000005', 'auth.login_succeeded',
   '{}'::jsonb, null, '198.51.100.9', now() - interval '1 hour');

-- Audit rows, placed inside the current month's partition so the fixture does not depend on the date.
insert into audit.audit_logs
  (actor_id, actor_type, action, table_schema, table_name, record_id, changed_columns,
   old_values, new_values, request_id, request_ip, occurred_at)
values
  ('f8000000-0000-4000-8000-000000000001', 'user', 'update', 'public', 'listings',
   '88880000-0000-4000-8000-000000000001', array['status'],
   jsonb_build_object('status', 'pending_review', 'secret_token', '[redacted]'),
   jsonb_build_object('status', 'active', 'secret_token', '[redacted]'),
   'req-one', '198.51.100.1', date_trunc('month', now()) + interval '1 hour'),
  ('f8000000-0000-4000-8000-000000000002', 'user', 'update', 'public', 'listings',
   '88880000-0000-4000-8000-000000000002', array['status', 'price_minor'],
   jsonb_build_object('status', 'pending_review'), jsonb_build_object('status', 'active'),
   'req-two', '198.51.100.2', date_trunc('month', now()) + interval '2 hours'),
  ('f8000000-0000-4000-8000-000000000002', 'user', 'insert', 'public', 'seller_profiles',
   'f8000000-0000-4000-8000-000000000006', array['status'],
   null, jsonb_build_object('status', 'active'),
   'req-three', '198.51.100.3', date_trunc('month', now()) + interval '3 hours');

-- Four recovery requests, aged, covering every state the console meets.
insert into public.account_recovery_requests
  (id, user_id, claimed_contact_channel, claimed_contact_hash, status, request_ip, created_at)
values
  -- Submitted, matched an account.
  ('a8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000009',
   'email', digest('locked-out@test.invalid', 'sha256'), 'submitted', '198.51.100.4', now() - interval '5 days'),
  -- Submitted, matched nothing: it can never complete, and 0028 says so.
  ('a8000000-0000-4000-8000-000000000002', null,
   'phone', digest('+201000000999', 'sha256'), 'submitted', '198.51.100.5', now() - interval '4 days'),
  -- The reviewing admin's own account, which 0028 refuses at every step.
  ('a8000000-0000-4000-8000-000000000003', 'f8000000-0000-4000-8000-000000000001',
   'email', digest('o-admin-one@test.invalid', 'sha256'), 'submitted', '198.51.100.6', now() - interval '3 days'),
  -- One that will be carried all the way to completion.
  ('a8000000-0000-4000-8000-000000000004', 'f8000000-0000-4000-8000-000000000005',
   'email', digest('o-buyer@test.invalid', 'sha256'), 'submitted', '198.51.100.8', now() - interval '2 days');

insert into public.account_recovery_evidence
  (account_recovery_request_id, evidence_type, object_path, original_filename, content_type, byte_size,
   uploaded_at)
values
  ('a8000000-0000-4000-8000-000000000001', 'national_id', 'recovery-evidence/a8-1/id.jpg',
   'id.jpg', 'image/jpeg', 120000, now() - interval '5 days'),
  ('a8000000-0000-4000-8000-000000000001', 'selfie', 'recovery-evidence/a8-1/selfie.jpg',
   'selfie.jpg', 'image/jpeg', 90000, now() - interval '5 days' + interval '1 minute');

-- ---------------------------------------------------------------------------------------------------
-- 1. The six predicates, and the isolation between the keys
-- ---------------------------------------------------------------------------------------------------
-- An admin holds every one of the six.
select ok(app_private.admin_can_read_sellers('f8000000-0000-4000-8000-000000000001', true),
  'an admin holds sellers.profile.read at aal2');
select ok(app_private.admin_can_read_users('f8000000-0000-4000-8000-000000000001', true),
  'an admin holds users.profile.read at aal2');
select ok(app_private.admin_can_read_roles('f8000000-0000-4000-8000-000000000001', true),
  'an admin holds users.role.read at aal2');
select ok(app_private.admin_can_read_security('f8000000-0000-4000-8000-000000000001', true),
  'an admin holds users.security.read at aal2');
select ok(app_private.admin_can_review_recovery('f8000000-0000-4000-8000-000000000001', true),
  'an admin holds security.recovery.review at aal2');
select ok(app_private.admin_can_read_audit('f8000000-0000-4000-8000-000000000001', true),
  'an admin holds audit.read at aal2');

-- A moderator holds two of the six and is refused the other four. This is the whole reason the code
-- tests keys rather than role names.
select ok(app_private.admin_can_read_sellers('f8000000-0000-4000-8000-000000000003', true),
  'a moderator holds sellers.profile.read');
select ok(app_private.admin_can_read_users('f8000000-0000-4000-8000-000000000003', true),
  'a moderator holds users.profile.read');
select ok(not app_private.admin_can_read_roles('f8000000-0000-4000-8000-000000000003', true),
  'a moderator does not hold users.role.read');
select ok(not app_private.admin_can_read_security('f8000000-0000-4000-8000-000000000003', true),
  'a moderator does not hold users.security.read');
select ok(not app_private.admin_can_review_recovery('f8000000-0000-4000-8000-000000000003', true),
  'a moderator does not hold security.recovery.review');
select ok(not app_private.admin_can_read_audit('f8000000-0000-4000-8000-000000000003', true),
  'a moderator does not hold audit.read');

-- A support agent holds a different two, and reviewing recovery is one of them.
select ok(not app_private.admin_can_read_sellers('f8000000-0000-4000-8000-000000000004', true),
  'a support agent does not hold sellers.profile.read');
select ok(app_private.admin_can_read_users('f8000000-0000-4000-8000-000000000004', true),
  'a support agent holds users.profile.read');
select ok(not app_private.admin_can_read_roles('f8000000-0000-4000-8000-000000000004', true),
  'a support agent does not hold users.role.read');
select ok(not app_private.admin_can_read_security('f8000000-0000-4000-8000-000000000004', true),
  'a support agent does not hold users.security.read');
select ok(app_private.admin_can_review_recovery('f8000000-0000-4000-8000-000000000004', true),
  'a support agent holds security.recovery.review');
select ok(not app_private.admin_can_read_audit('f8000000-0000-4000-8000-000000000004', true),
  'a support agent does not hold audit.read');

-- Every privileged role that grants one of these keys requires MFA, so aal1 holds nothing.
select ok(not app_private.admin_can_read_sellers('f8000000-0000-4000-8000-000000000001', false),
  'an admin at aal1 holds no seller read');
select ok(not app_private.admin_can_read_users('f8000000-0000-4000-8000-000000000001', false),
  'an admin at aal1 holds no user read');
select ok(not app_private.admin_can_read_roles('f8000000-0000-4000-8000-000000000001', false),
  'an admin at aal1 holds no role read');
select ok(not app_private.admin_can_read_security('f8000000-0000-4000-8000-000000000001', false),
  'an admin at aal1 holds no security read');
select ok(not app_private.admin_can_review_recovery('f8000000-0000-4000-8000-000000000001', false),
  'an admin at aal1 cannot review recovery');
select ok(not app_private.admin_can_read_audit('f8000000-0000-4000-8000-000000000001', false),
  'an admin at aal1 holds no audit read');
select ok(not app_private.admin_can_read_users('f8000000-0000-4000-8000-000000000004', false),
  'a support agent at aal1 holds no user read');
select ok(not app_private.admin_can_review_recovery('f8000000-0000-4000-8000-000000000004', false),
  'a support agent at aal1 cannot review recovery');

-- A buyer and a seller hold none of them at any assurance level.
select ok(not app_private.admin_can_read_sellers('f8000000-0000-4000-8000-000000000005', true),
  'a buyer holds no seller read');
select ok(not app_private.admin_can_read_users('f8000000-0000-4000-8000-000000000005', true),
  'a buyer holds no user read');
select ok(not app_private.admin_can_read_roles('f8000000-0000-4000-8000-000000000005', true),
  'a buyer holds no role read');
select ok(not app_private.admin_can_read_audit('f8000000-0000-4000-8000-000000000005', true),
  'a buyer holds no audit read');
select ok(not app_private.admin_can_read_sellers('f8000000-0000-4000-8000-000000000006', true),
  'a seller holds no seller read — owning a storefront is not administering one');
select ok(not app_private.admin_can_review_recovery('f8000000-0000-4000-8000-000000000006', true),
  'a seller cannot review recovery');

-- Revoked and expired grants hold nothing, at aal2.
select ok(not app_private.admin_can_read_users('f8000000-0000-4000-8000-000000000007', true),
  'a revoked admin holds no user read');
select ok(not app_private.admin_can_read_audit('f8000000-0000-4000-8000-000000000007', true),
  'a revoked admin holds no audit read');
select ok(not app_private.admin_can_read_users('f8000000-0000-4000-8000-000000000008', true),
  'an expired admin holds no user read');
select ok(not app_private.admin_can_read_audit('f8000000-0000-4000-8000-000000000008', true),
  'an expired admin holds no audit read');

-- And nobody at all holds anything.
select ok(not app_private.admin_can_read_users(null, true), 'a null account holds no user read');
select ok(not app_private.admin_can_read_audit(null, true), 'a null account holds no audit read');
select ok(not app_private.admin_can_review_recovery(null, true), 'a null account cannot review recovery');

-- ---------------------------------------------------------------------------------------------------
-- 2. The seller page
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 20)),
  2, 'an admin reads both storefronts');

select is(
  (select array_agg(slug order by ord) from (
     select slug, ord from app_private.admin_seller_page(
       'f8000000-0000-4000-8000-000000000001', true, 20) with ordinality as t(
         slug, display_name, status, verification_status, country_code, city,
         listing_count, open_report_count, created_at, ord)) s),
  array['o-shop', 'o-admin-shop'],
  'the seller page is newest first');

select is(
  (select listing_count from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 20) where slug = 'o-shop'),
  3, 'the listing count is every listing, whatever its status');

select is(
  (select open_report_count from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 20) where slug = 'o-shop'),
  2, 'the open-report count counts open and triaged, and not a closed report');

select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 20, 'suspended')),
  1, 'the status filter narrows to the suspended storefront');
select is(
  (select slug from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 20, 'suspended')),
  'o-admin-shop', 'and it is the right one');
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 20, 'not_a_status')),
  0, 'an unknown status matches nothing rather than being interpolated into a predicate');
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 20, null, 'verified')),
  1, 'the verification filter narrows to the verified storefront');
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 20, null, 'not_a_status')),
  0, 'an unknown verification status matches nothing');

-- Paging is total and repeats nothing.
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 1)),
  1, 'a limit of one returns one storefront');
select is(
  (select slug from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 1, null, null,
     (select created_at from public.seller_profiles where slug = 'o-shop'), 'o-shop')),
  'o-admin-shop', 'the cursor continues after the first row, without repeating it');
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 20, null, null,
     (select created_at from public.seller_profiles where slug = 'o-admin-shop'), 'o-admin-shop')),
  0, 'the cursor past the last row returns nothing');
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 0)),
  1, 'a limit of zero is clamped up to one');
select ok(
  (select count(*) from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', true, 9999)) <= 51,
  'a limit of nine thousand is clamped to the page ceiling');

-- Who may read it.
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000003', true, 20)),
  2, 'a moderator reads storefronts');
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000004', true, 20)),
  0, 'a support agent reads no storefront');
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000005', true, 20)),
  0, 'a buyer reads no storefront');
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000006', true, 20)),
  0, 'a seller reads no storefront, not even their own');
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000001', false, 20)),
  0, 'an admin at aal1 reads no storefront');
select is(
  (select count(*)::integer from app_private.admin_seller_page(
     'f8000000-0000-4000-8000-000000000007', true, 20)),
  0, 'a revoked admin reads no storefront');
select is(
  (select count(*)::integer from app_private.admin_seller_page(null, true, 20)),
  0, 'nobody reads no storefront');

-- ---------------------------------------------------------------------------------------------------
-- 3. One seller
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'o-shop')),
  'found', 'an admin reads one storefront by slug');
select is(
  (select display_name from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'o-shop')),
  'Canary Shop', 'and gets its name');
select is(
  (select listing_count from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'o-shop')),
  3, 'the detail counts every listing');
select is(
  (select live_listing_count from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'o-shop')),
  2, 'and counts the publicly visible ones separately');
select ok(
  (select not is_own_storefront from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'o-shop')),
  'somebody else''s storefront is not the reader''s own');
select ok(
  (select is_own_storefront from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'o-admin-shop')),
  'and the reader''s own storefront says so');
select is(
  (select suspension_reason from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'o-admin-shop')),
  'Suspended for the fixture.', 'a suspension carries its reason');
select ok(
  (select suspended_at is not null from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'o-admin-shop')),
  'and the time it happened');
select is(
  (select verification_status from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'o-shop')),
  'verified', 'the verification status is reported, which 7-G owns and this does not change');

-- Absence, the wrong key and aal1 are one answer.
select is(
  (select outcome from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'no-such-shop')),
  'not_found', 'an unknown slug is not_found');
select is(
  (select outcome from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000004', true, 'o-shop')),
  'not_found', 'a support agent gets the same not_found for a storefront that exists');
select is(
  (select outcome from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000005', true, 'o-shop')),
  'not_found', 'and so does a buyer');
select is(
  (select outcome from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', false, 'o-shop')),
  'not_found', 'and so does an admin at aal1');
select is(
  (select display_name from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000004', true, 'o-shop')),
  null, 'a refused read carries no name');
select is(
  (select outcome from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', true, '   ')),
  'not_found', 'a blank slug is not_found');
select is(
  (select outcome from app_private.admin_seller_detail(
     'f8000000-0000-4000-8000-000000000001', true, null)),
  'not_found', 'and so is no slug at all');

-- ---------------------------------------------------------------------------------------------------
-- 4. The user page
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 20)),
  10, 'an admin reads all ten live accounts');
select is(
  (select count(*)::integer from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 20) where id = 'f8000000-0000-4000-8000-00000000000a'),
  0, 'a deleted account is absent');

select is(
  (select array_agg(display_name order by ord) from (
     select display_name, ord from app_private.admin_user_page(
       'f8000000-0000-4000-8000-000000000001', true, 20) with ordinality as t(
         id, display_name, status, locale_code, has_verified_email, has_verified_phone,
         is_staff, is_seller, is_self, created_at, ord)) s),
  array['Admin Three', 'Locked Out', 'Expired Admin', 'Revoked Admin', 'Seller',
        'Buyer', 'Support Agent', 'Moderator', 'Admin Two', 'Admin One'],
  'the user page is newest first');

select ok(
  (select is_staff from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 20)
    where id = 'f8000000-0000-4000-8000-000000000003'),
  'a moderator reads as staff');
select ok(
  (select not is_staff from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 20)
    where id = 'f8000000-0000-4000-8000-000000000005'),
  'a buyer does not');
select ok(
  (select is_seller from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 20)
    where id = 'f8000000-0000-4000-8000-000000000006'),
  'an account with a storefront reads as a seller');
select ok(
  (select not is_seller from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 20)
    where id = 'f8000000-0000-4000-8000-000000000005'),
  'and one without does not');
select ok(
  (select is_self from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 20)
    where id = 'f8000000-0000-4000-8000-000000000001'),
  'the reader''s own row says so');
select ok(
  (select has_verified_email and not has_verified_phone from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 20)
    where id = 'f8000000-0000-4000-8000-000000000001'),
  'a verified email and an unverified phone are reported as two booleans');
select ok(
  (select not has_verified_email and not has_verified_phone from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 20)
    where id = 'f8000000-0000-4000-8000-000000000009'),
  'and an account with neither says so');

select is(
  (select count(*)::integer from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 20, 'active')),
  10, 'the status filter admits the active accounts');
select is(
  (select count(*)::integer from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 20, 'not_a_status')),
  0, 'an unknown status matches nothing');
select is(
  (select count(*)::integer from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 1)),
  1, 'a limit of one returns one account');
select is(
  (select count(*)::integer from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 20, null,
     (select created_at from public.profiles where id = 'f8000000-0000-4000-8000-000000000009'),
     'f8000000-0000-4000-8000-000000000009')),
  8, 'the cursor continues past the second-newest account, without repeating it');
select is(
  (select count(*)::integer from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 0)),
  1, 'a limit of zero is clamped up to one');
select ok(
  (select count(*) from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', true, 9999)) <= 51,
  'and a huge one is clamped down');

select is(
  (select count(*)::integer from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000004', true, 20)),
  10, 'a support agent reads accounts — it holds users.profile.read');
select is(
  (select count(*)::integer from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000003', true, 20)),
  10, 'and so does a moderator');
select is(
  (select count(*)::integer from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000005', true, 20)),
  0, 'a buyer reads no account');
select is(
  (select count(*)::integer from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000001', false, 20)),
  0, 'an admin at aal1 reads no account');
select is(
  (select count(*)::integer from app_private.admin_user_page(
     'f8000000-0000-4000-8000-000000000008', true, 20)),
  0, 'an expired admin reads no account');

-- ---------------------------------------------------------------------------------------------------
-- 5. One user
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.admin_user_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000006')),
  'found', 'an admin reads one account');
select is(
  (select seller_slug from app_private.admin_user_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000006')),
  'o-shop', 'and reaches the storefront by slug rather than by account');
select ok(
  (select is_seller from app_private.admin_user_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000006')),
  'which is what makes it a seller');
select is(
  (select seller_slug from app_private.admin_user_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000005')),
  null, 'an account with no storefront has no slug');
select ok(
  (select is_self from app_private.admin_user_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000001')),
  'the reader''s own account says so');
select is(
  (select outcome from app_private.admin_user_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-00000000000a')),
  'not_found', 'a deleted account is not_found');
select is(
  (select outcome from app_private.admin_user_detail(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-0000000000ff')),
  'not_found', 'an account that never existed is not_found');
select is(
  (select outcome from app_private.admin_user_detail(
     'f8000000-0000-4000-8000-000000000005', true, 'f8000000-0000-4000-8000-000000000006')),
  'not_found', 'a buyer gets the same not_found for an account that exists');
select is(
  (select outcome from app_private.admin_user_detail(
     'f8000000-0000-4000-8000-000000000001', false, 'f8000000-0000-4000-8000-000000000006')),
  'not_found', 'and so does an admin at aal1');
select is(
  (select display_name from app_private.admin_user_detail(
     'f8000000-0000-4000-8000-000000000005', true, 'f8000000-0000-4000-8000-000000000006')),
  null, 'a refused read carries no name');

-- ---------------------------------------------------------------------------------------------------
-- 6. One account's roles — the read a moderator does not have
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000003')),
  1, 'an admin reads the moderator''s one grant');
select is(
  (select role_key from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000003')),
  'moderator', 'and it is the right role');
select ok(
  (select is_effective from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000003')),
  'a live grant is effective');
select ok(
  (select requires_mfa and is_admin_console from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000003')),
  'and carries the role''s own MFA and console flags');
select ok(
  (select permission_count from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000003')) > 0,
  'and says how many permissions it carries');

select ok(
  (select not is_effective from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000007')),
  'a revoked grant is reported and is not effective');
select ok(
  (select revoked_at is not null from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000007')),
  'and carries when it was revoked');
select ok(
  (select not is_effective from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000008')),
  'an expired grant is reported and is not effective');
select ok(
  (select expires_at is not null from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000008')),
  'and carries when it expired');

-- The isolation the brief asks to be proved: neither of the two roles that can read accounts can read
-- what roles those accounts hold.
select is(
  (select count(*)::integer from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000003', true, 'f8000000-0000-4000-8000-000000000005')),
  0, 'a moderator reads nobody''s roles');
select is(
  (select count(*)::integer from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000004', true, 'f8000000-0000-4000-8000-000000000005')),
  0, 'a support agent reads nobody''s roles');
select is(
  (select count(*)::integer from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000005', true, 'f8000000-0000-4000-8000-000000000005')),
  0, 'a buyer cannot even read their own');
select is(
  (select count(*)::integer from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000001', false, 'f8000000-0000-4000-8000-000000000003')),
  0, 'an admin at aal1 reads no roles');
select is(
  (select count(*)::integer from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000007', true, 'f8000000-0000-4000-8000-000000000003')),
  0, 'a revoked admin reads no roles');
select is(
  (select count(*)::integer from app_private.admin_user_roles(
     'f8000000-0000-4000-8000-000000000001', true, null)),
  0, 'no target account is no roles');

-- ---------------------------------------------------------------------------------------------------
-- 7. The role catalogue
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_private.admin_role_catalogue(
     'f8000000-0000-4000-8000-000000000001', true)),
  (select count(*)::integer from public.roles),
  'an admin reads the whole role catalogue');
select is(
  (select array_agg(role_key order by ord) from (
     select role_key, ord from app_private.admin_role_catalogue(
       'f8000000-0000-4000-8000-000000000001', true) with ordinality as t(
         role_key, name_en, name_ar, requires_mfa, is_admin_console, is_assignable,
         permission_count, holder_count, ord)) s),
  array['guest', 'buyer', 'seller', 'moderator', 'support_agent', 'admin', 'super_admin'],
  'in the catalogue''s own order, which this migration does not change');
select ok(
  (select requires_mfa and is_admin_console from app_private.admin_role_catalogue(
     'f8000000-0000-4000-8000-000000000001', true) where role_key = 'admin'),
  'admin requires MFA and opens the console');
select ok(
  (select not requires_mfa and not is_admin_console from app_private.admin_role_catalogue(
     'f8000000-0000-4000-8000-000000000001', true) where role_key = 'buyer'),
  'buyer does neither');
select is(
  (select holder_count from app_private.admin_role_catalogue(
     'f8000000-0000-4000-8000-000000000001', true) where role_key = 'admin'),
  3, 'the holder count counts effective grants only — the revoked and expired admins are not holders');
select is(
  (select holder_count from app_private.admin_role_catalogue(
     'f8000000-0000-4000-8000-000000000001', true) where role_key = 'moderator'),
  1, 'and counts the one moderator');
select ok(
  (select permission_count from app_private.admin_role_catalogue(
     'f8000000-0000-4000-8000-000000000001', true) where role_key = 'admin') > 0,
  'and each role says how many permissions it carries');

select is(
  (select count(*)::integer from app_private.admin_role_catalogue(
     'f8000000-0000-4000-8000-000000000003', true)),
  0, 'a moderator reads no role catalogue');
select is(
  (select count(*)::integer from app_private.admin_role_catalogue(
     'f8000000-0000-4000-8000-000000000004', true)),
  0, 'nor does a support agent');
select is(
  (select count(*)::integer from app_private.admin_role_catalogue(
     'f8000000-0000-4000-8000-000000000001', false)),
  0, 'nor an admin at aal1');
select is(
  (select count(*)::integer from app_private.admin_role_catalogue(null, true)),
  0, 'nor nobody');

-- ---------------------------------------------------------------------------------------------------
-- 8. One account's security timeline
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_private.admin_account_security_timeline(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000009', 20)),
  3, 'an admin reads that account''s three events');
select is(
  (select array_agg(event_type order by ord) from (
     select event_type, ord from app_private.admin_account_security_timeline(
       'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000009', 20)
       with ordinality as t(id, event_type, details, occurred_at, ord)) s),
  array['auth.mfa_challenge_failed', 'auth.login_failed', 'auth.login_failed'],
  'newest first');
select is(
  (select count(*)::integer from app_private.admin_account_security_timeline(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000009', 20)
    where event_type = 'auth.login_succeeded'),
  0, 'and never somebody else''s event');
select is(
  (select count(*)::integer from app_private.admin_account_security_timeline(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000009', 1)),
  1, 'the limit is honoured');
select is(
  (select count(*)::integer from app_private.admin_account_security_timeline(
     'f8000000-0000-4000-8000-000000000001', true, 'f8000000-0000-4000-8000-000000000009', 0)),
  1, 'a limit of zero is clamped up to one');

-- users.security.read is admin-only, so both console roles that can read the account itself are refused
-- its security timeline.
select is(
  (select count(*)::integer from app_private.admin_account_security_timeline(
     'f8000000-0000-4000-8000-000000000003', true, 'f8000000-0000-4000-8000-000000000009', 20)),
  0, 'a moderator reads no security timeline');
select is(
  (select count(*)::integer from app_private.admin_account_security_timeline(
     'f8000000-0000-4000-8000-000000000004', true, 'f8000000-0000-4000-8000-000000000009', 20)),
  0, 'nor does a support agent, though it can read the account');
select is(
  (select count(*)::integer from app_private.admin_account_security_timeline(
     'f8000000-0000-4000-8000-000000000009', true, 'f8000000-0000-4000-8000-000000000009', 20)),
  0, 'nor the account holder themselves through this reader');
select is(
  (select count(*)::integer from app_private.admin_account_security_timeline(
     'f8000000-0000-4000-8000-000000000001', false, 'f8000000-0000-4000-8000-000000000009', 20)),
  0, 'nor an admin at aal1');

-- ---------------------------------------------------------------------------------------------------
-- 9. The recovery queue
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20)),
  4, 'an admin reads the four requests');
select is(
  (select count(*)::integer from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000004', true, 20)),
  4, 'and so does a support agent — it holds security.recovery.review');
select is(
  (select count(*)::integer from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000003', true, 20)),
  0, 'a moderator reads no recovery request');
select is(
  (select count(*)::integer from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000005', true, 20)),
  0, 'nor does a buyer');
select is(
  (select count(*)::integer from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000009', true, 20)),
  0, 'nor the person whose account it is');
select is(
  (select count(*)::integer from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', false, 20)),
  0, 'nor an admin at aal1');

select is(
  (select array_agg(id::text order by ord) from (
     select id, ord from app_private.recovery_review_queue(
       'f8000000-0000-4000-8000-000000000001', true, 20) with ordinality as t(
         id, status, claimed_contact_channel, new_contact_channel, matched_an_account,
         is_own_request, is_the_reviewer, has_been_reviewed, contact_verified,
         evidence_count, expires_at, created_at, ord)) s),
  array['a8000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000002',
        'a8000000-0000-4000-8000-000000000003', 'a8000000-0000-4000-8000-000000000004'],
  'the queue is oldest first — people are waiting in it');

select is(
  (select claimed_contact_channel from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20) where id = 'a8000000-0000-4000-8000-000000000002'),
  'phone', 'the channel is reported');
select ok(
  (select matched_an_account from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20) where id = 'a8000000-0000-4000-8000-000000000001'),
  'a request that matched an account says so');
select ok(
  (select not matched_an_account from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20) where id = 'a8000000-0000-4000-8000-000000000002'),
  'and one that matched nothing says so, which is what makes it uncompletable');
select ok(
  (select is_own_request from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20) where id = 'a8000000-0000-4000-8000-000000000003'),
  'the reader''s own request is flagged before they try to act on it');
select ok(
  (select not is_own_request from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000002', true, 20) where id = 'a8000000-0000-4000-8000-000000000003'),
  'and is not flagged for anybody else');
select is(
  (select evidence_count from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20) where id = 'a8000000-0000-4000-8000-000000000001'),
  2, 'the evidence count is the number of documents supplied');
select is(
  (select evidence_count from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20) where id = 'a8000000-0000-4000-8000-000000000004'),
  0, 'and zero when none were');
select is(
  (select count(*)::integer from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20, 'submitted')),
  4, 'the status filter admits the submitted requests');
select is(
  (select count(*)::integer from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20, 'not_a_status')),
  0, 'an unknown status matches nothing');
select is(
  (select count(*)::integer from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20, null,
     (select created_at from public.account_recovery_requests where id = 'a8000000-0000-4000-8000-000000000001'),
     'a8000000-0000-4000-8000-000000000001')),
  3, 'the cursor continues after the oldest request');
select is(
  (select count(*)::integer from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 0)),
  1, 'a limit of zero is clamped up to one');

-- ---------------------------------------------------------------------------------------------------
-- 10. One recovery request, and its evidence
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.recovery_request_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000001')),
  'found', 'an admin reads one request');
select is(
  (select status from app_private.recovery_request_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000001')),
  'submitted', 'with its state');
select is(
  (select outcome from app_private.recovery_request_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-0000000000ff')),
  'not_found', 'a request that never existed is not_found');
select is(
  (select outcome from app_private.recovery_request_for_staff(
     'f8000000-0000-4000-8000-000000000003', true, 'a8000000-0000-4000-8000-000000000001')),
  'not_found', 'and a moderator gets the same answer for one that does');
select is(
  (select outcome from app_private.recovery_request_for_staff(
     'f8000000-0000-4000-8000-000000000009', true, 'a8000000-0000-4000-8000-000000000001')),
  'not_found', 'and so does the person whose account it is');
select is(
  (select outcome from app_private.recovery_request_for_staff(
     'f8000000-0000-4000-8000-000000000001', false, 'a8000000-0000-4000-8000-000000000001')),
  'not_found', 'and so does an admin at aal1');

select is(
  (select count(*)::integer from app_private.recovery_evidence_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000001')),
  2, 'an admin reads both documents');
select is(
  (select array_agg(evidence_type order by ord) from (
     select evidence_type, ord from app_private.recovery_evidence_for_staff(
       'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000001')
       with ordinality as t(id, evidence_type, original_filename, content_type, byte_size,
                            uploaded_at, ord)) s),
  array['national_id', 'selfie'], 'in the order they were supplied');
select is(
  (select original_filename from app_private.recovery_evidence_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000001')
    where evidence_type = 'national_id'),
  'id.jpg', 'with the file name a reviewer needs to know what it is');
select is(
  (select count(*)::integer from app_private.recovery_evidence_for_staff(
     'f8000000-0000-4000-8000-000000000003', true, 'a8000000-0000-4000-8000-000000000001')),
  0, 'a moderator reads no evidence');
select is(
  (select count(*)::integer from app_private.recovery_evidence_for_staff(
     'f8000000-0000-4000-8000-000000000001', false, 'a8000000-0000-4000-8000-000000000001')),
  0, 'nor an admin at aal1');

-- ---------------------------------------------------------------------------------------------------
-- 11. Recording the review
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.recovery_review_for_staff(
     'f8000000-0000-4000-8000-000000000003', true, 'a8000000-0000-4000-8000-000000000001', 'Checked.')),
  'not_found', 'a moderator cannot review a recovery request');
select is(
  (select outcome from app_private.recovery_review_for_staff(
     'f8000000-0000-4000-8000-000000000005', true, 'a8000000-0000-4000-8000-000000000001', 'Checked.')),
  'not_found', 'nor can a buyer');
select is(
  (select outcome from app_private.recovery_review_for_staff(
     'f8000000-0000-4000-8000-000000000001', false, 'a8000000-0000-4000-8000-000000000001', 'Checked.')),
  'not_found', 'nor an admin at aal1');
select is(
  (select outcome from app_private.recovery_review_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-0000000000ff', 'Checked.')),
  'not_found', 'and a request that never existed is not_found');
select is(
  (select status from public.account_recovery_requests where id = 'a8000000-0000-4000-8000-000000000001'),
  'submitted', 'none of those four refusals moved the request');

-- 0028 refuses the account holder, and the admin whose own account it is is exactly that person.
select is(
  (select outcome from app_private.recovery_review_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000003', 'Mine.')),
  'own_request', 'nobody reviews their own recovery, whatever key they hold');
select is(
  (select status from public.account_recovery_requests where id = 'a8000000-0000-4000-8000-000000000003'),
  'submitted', 'and that request did not move either');

select is(
  (select outcome from app_private.recovery_review_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000001', 'Documents check out.')),
  'reviewed', 'an admin records the review');
select is(
  (select status from app_private.recovery_review_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000001', 'Again.')),
  'under_review', 'and the writer reports the state it reached');
select is(
  (select reviewer_user_id from public.account_recovery_requests
    where id = 'a8000000-0000-4000-8000-000000000001'),
  'f8000000-0000-4000-8000-000000000001'::uuid,
  'the reviewer is fixed on the row, which is what the second approver is later checked against');
select is(
  (select review_note from public.account_recovery_requests
    where id = 'a8000000-0000-4000-8000-000000000001'),
  'Again.', 'and the note is kept');
select ok(
  (select has_been_reviewed from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20) where id = 'a8000000-0000-4000-8000-000000000001'),
  'the queue now reports it as reviewed');
select ok(
  (select is_the_reviewer from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20) where id = 'a8000000-0000-4000-8000-000000000001'),
  'and tells the reviewer that they are the reviewer');
select ok(
  (select not is_the_reviewer from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000002', true, 20) where id = 'a8000000-0000-4000-8000-000000000001'),
  'and tells a colleague that they are not');
select is(
  (select outcome from app_private.recovery_review_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000001', null)),
  'reviewed', 'a review with no note is still a review');
select is(
  (select review_note from public.account_recovery_requests
    where id = 'a8000000-0000-4000-8000-000000000001'),
  null, 'and clears the note rather than inventing one');

-- ---------------------------------------------------------------------------------------------------
-- 12. The decision, and the two-person rule
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000001', 'approved')),
  'needs_another_person',
  'the reviewer cannot approve their own review — the rule 0028 states twice');
select is(
  (select status from public.account_recovery_requests where id = 'a8000000-0000-4000-8000-000000000001'),
  'under_review', 'and the request did not move');
select is(
  (select count(*)::integer from public.account_recovery_approvals
    where account_recovery_request_id = 'a8000000-0000-4000-8000-000000000001'),
  0, 'and no approval was recorded');

select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-000000000002', true, 'a8000000-0000-4000-8000-000000000001', 'sideways')),
  'invalid', 'a decision that is neither approved nor rejected is refused');
select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-000000000002', true, 'a8000000-0000-4000-8000-000000000001', 'contact_verification')),
  'invalid', 'and so is naming the status the writer will move it to');
select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-000000000002', true, 'a8000000-0000-4000-8000-000000000001', null)),
  'invalid', 'and so is no decision at all');
select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-000000000002', true, 'a8000000-0000-4000-8000-000000000001', 'rejected', '   ')),
  'invalid', 'a rejection with a blank reason is refused');
select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-000000000002', true, 'a8000000-0000-4000-8000-000000000001', 'rejected')),
  'invalid', 'and so is one with no reason at all');
select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-000000000002', true, 'a8000000-0000-4000-8000-000000000004', 'approved')),
  'not_decidable', 'a request nobody has reviewed cannot be decided');
select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-000000000003', true, 'a8000000-0000-4000-8000-000000000001', 'approved')),
  'not_found', 'a moderator cannot decide anything');
select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-000000000002', false, 'a8000000-0000-4000-8000-000000000001', 'approved')),
  'not_found', 'nor an admin at aal1');
select is(
  (select status from public.account_recovery_requests where id = 'a8000000-0000-4000-8000-000000000001'),
  'under_review', 'and none of those refusals moved the request either');

-- A second person approves, and the request lands on contact_verification rather than on `approved`.
select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-000000000002', true, 'a8000000-0000-4000-8000-000000000001', 'approved', 'Satisfied.')),
  'decided', 'a second person approves it');
select is(
  (select status from public.account_recovery_requests where id = 'a8000000-0000-4000-8000-000000000001'),
  'contact_verification',
  'an approval moves the request to contact_verification — `approved` is a status nothing in this repository sets');
select is(
  (select approver_user_id from public.account_recovery_requests
    where id = 'a8000000-0000-4000-8000-000000000001'),
  'f8000000-0000-4000-8000-000000000002'::uuid, 'and records who approved it');
select is(
  (select count(*)::integer from public.account_recovery_approvals
    where account_recovery_request_id = 'a8000000-0000-4000-8000-000000000001'),
  1, 'exactly one approval row is written');
select is(
  (select decision from public.account_recovery_approvals
    where account_recovery_request_id = 'a8000000-0000-4000-8000-000000000001'),
  'approved', 'with the decision that was made');
select is(
  (select count(*)::integer from public.outbox_events
    where aggregate_id = 'a8000000-0000-4000-8000-000000000001'
      and event_type = 'account_recovery.approved'),
  1, 'and one outbox event, which this migration does not duplicate');
select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-00000000000b', true, 'a8000000-0000-4000-8000-000000000001', 'approved', 'Me too.')),
  'not_decidable', 'a third person cannot decide it again');
select is(
  (select count(*)::integer from public.account_recovery_approvals
    where account_recovery_request_id = 'a8000000-0000-4000-8000-000000000001'),
  1, 'and no second approval was recorded');

-- A rejection, on the request that matched no account.
select is(
  (select outcome from app_private.recovery_review_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000002', 'Nothing matches.')),
  'reviewed', 'the unmatched request is reviewed');
select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-000000000002', true, 'a8000000-0000-4000-8000-000000000002',
     'rejected', 'The evidence does not support the claim.')),
  'decided', 'and rejected by somebody else');
select is(
  (select status from public.account_recovery_requests where id = 'a8000000-0000-4000-8000-000000000002'),
  'rejected', 'the request is rejected');
select is(
  (select rejection_reason from public.account_recovery_requests
    where id = 'a8000000-0000-4000-8000-000000000002'),
  'The evidence does not support the claim.', 'with the reason it was given');
select ok(
  (select closed_at is not null from public.account_recovery_requests
    where id = 'a8000000-0000-4000-8000-000000000002'),
  'and it is closed');
select is(
  (select count(*)::integer from public.outbox_events
    where aggregate_id = 'a8000000-0000-4000-8000-000000000002'
      and event_type = 'account_recovery.rejected'),
  1, 'with one rejection event');
select is(
  (select outcome from app_private.recovery_review_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000002', 'Again?')),
  'not_reviewable', 'a closed request cannot be pulled back into review');

-- ---------------------------------------------------------------------------------------------------
-- 13. Completion, and the hold
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.recovery_complete_for_staff(
     'f8000000-0000-4000-8000-000000000002', true, 'a8000000-0000-4000-8000-000000000001')),
  'not_completable',
  'an approved request whose new contact was never verified cannot be completed');
select is(
  (select outcome from app_private.recovery_complete_for_staff(
     'f8000000-0000-4000-8000-000000000002', true, 'a8000000-0000-4000-8000-000000000002')),
  'not_completable', 'and neither can a rejected one');
select is(
  (select outcome from app_private.recovery_complete_for_staff(
     'f8000000-0000-4000-8000-000000000003', true, 'a8000000-0000-4000-8000-000000000001')),
  'not_found', 'a moderator cannot complete anything');
select is(
  (select outcome from app_private.recovery_complete_for_staff(
     'f8000000-0000-4000-8000-000000000002', false, 'a8000000-0000-4000-8000-000000000001')),
  'not_found', 'nor an admin at aal1');

-- The contact verification step is the requester's, through 0004's one-time codes. No function in 0078
-- calls it; the fixture performs it exactly as the requester's own flow would.
insert into app_private.otp_challenges
  (id, user_id, purpose, channel, destination_hash, code_hash, expires_at, consumed_at, created_at)
values
  ('08000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000009',
   'recovery', 'email', digest('new-contact@test.invalid', 'sha256'), digest('code', 'sha256'),
   now() + interval '1 hour', now() - interval '1 minute', now() - interval '10 minutes');

select is(
  app_private.verify_recovery_contact(
    'a8000000-0000-4000-8000-000000000001', '08000000-0000-4000-8000-000000000001',
    'email', digest('new-contact@test.invalid', 'sha256')),
  'verified', 'the requester verifies the new contact through 0004''s one-time code');
select ok(
  (select contact_verified from app_private.recovery_review_queue(
     'f8000000-0000-4000-8000-000000000001', true, 20) where id = 'a8000000-0000-4000-8000-000000000001'),
  'and the queue now reports it as verified');

select is(
  (select outcome from app_private.recovery_complete_for_staff(
     'f8000000-0000-4000-8000-000000000002', true, 'a8000000-0000-4000-8000-000000000001', false)),
  'completed', 'and now a colleague can complete it');
select is(
  (select status from public.account_recovery_requests where id = 'a8000000-0000-4000-8000-000000000001'),
  'completed', 'the request is completed');
select ok(
  (select sessions_revoked_at is not null from public.account_recovery_requests
    where id = 'a8000000-0000-4000-8000-000000000001'),
  'the account''s sessions are revoked, which is 0028''s effect and not this migration''s');
select is(
  (select mfa_reset_at from public.account_recovery_requests
    where id = 'a8000000-0000-4000-8000-000000000001'),
  null, 'and no MFA reset is recorded when none happened');

-- The hold is 0028's, computed from the site setting. Asserted against the setting rather than against a
-- number, so nothing in this increment can shorten it and no future change to the setting breaks this.
select is(
  (select hold_until from app_private.recovery_complete_for_staff(
     'f8000000-0000-4000-8000-00000000000b', true, 'a8000000-0000-4000-8000-000000000001')),
  null, 'a request already completed cannot be completed twice');
select is(
  (select outcome from app_private.recovery_complete_for_staff(
     'f8000000-0000-4000-8000-00000000000b', true, 'a8000000-0000-4000-8000-000000000001')),
  'not_completable', 'and says so');
select is(
  (select date_trunc('minute', r.hold_until) from public.account_recovery_requests r
    where r.id = 'a8000000-0000-4000-8000-000000000001'),
  (select date_trunc('minute', now() + make_interval(
     hours => (public.site_setting('security.recovery_hold_hours'))::integer))),
  'the hold is exactly the configured number of hours from completion');
select ok(
  (select r.hold_until > now() from public.account_recovery_requests r
    where r.id = 'a8000000-0000-4000-8000-000000000001'),
  'and it is in the future, so no parameter of this increment skipped it');
select ok(
  public.user_has_security_hold('f8000000-0000-4000-8000-000000000009', 'withdrawal'),
  'the account is under the withdrawal hold 0028 defines');
select ok(
  public.user_has_security_hold('f8000000-0000-4000-8000-000000000009', 'payout_details'),
  'and the payout-details hold');

select is(
  (select count(*)::integer from public.security_events
    where user_id = 'f8000000-0000-4000-8000-000000000009'
      and event_type = 'account_recovery.completed'),
  1, 'one security event is written, by 0028 and not by this migration');
select is(
  (select count(*)::integer from public.outbox_events
    where aggregate_id = 'a8000000-0000-4000-8000-000000000001'
      and event_type = 'account_recovery.completed'),
  1, 'and one outbox event');

-- The account holder is refused at completion too, by provoking it on their own request.
select is(
  (select outcome from app_private.recovery_review_for_staff(
     'f8000000-0000-4000-8000-000000000002', true, 'a8000000-0000-4000-8000-000000000003', 'Not mine.')),
  'reviewed', 'a colleague reviews the admin''s own request');
select is(
  (select outcome from app_private.recovery_decide_for_staff(
     'f8000000-0000-4000-8000-000000000001', true, 'a8000000-0000-4000-8000-000000000003', 'approved', 'Mine.')),
  'needs_another_person', 'and the account holder cannot approve it, though they are an admin');

-- ---------------------------------------------------------------------------------------------------
-- 14. The audit trail
-- ---------------------------------------------------------------------------------------------------
-- The fixtures above wrote to `seller_profiles`, `reports`, `categories` and
-- `account_recovery_requests`, every one of which 0006 audits — so the trail this reader returns is real
-- audited activity and not only the three rows planted for the filters. The assertions are written
-- against that rather than against a fixed total.
select ok(
  (select count(*) from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51)) >= 3,
  'an admin reads the audit trail');
select is(
  (select count(*)::integer from (
     select w.occurred_at, lag(w.occurred_at) over (order by w.ord) as prev from (
       select occurred_at, ord from app_private.admin_audit_page(
         'f8000000-0000-4000-8000-000000000001', true, 51) with ordinality as t(
           id, occurred_at, actor_type, is_own_action, action, table_schema, table_name,
           record_id, changed_columns, request_id, ord)) w) o
    where o.prev is not null and o.occurred_at > o.prev),
  0, 'and every row is at or before the one ahead of it — newest first, over the index 0006 built for it');

select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51, 'public', 'listings')),
  2, 'the table filter narrows to one table');
select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51, 'public', 'listings',
     '88880000-0000-4000-8000-000000000001')),
  1, 'and the record filter to one row within it');
select is(
  (select changed_columns from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51, 'public', 'listings',
     '88880000-0000-4000-8000-000000000002')),
  array['status', 'price_minor'], 'it reports which columns changed');
select is(
  (select action from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51, 'public', 'listings',
     '88880000-0000-4000-8000-000000000002')),
  'update', 'and what kind of change it was');
select ok(
  (select is_own_action from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51, 'public', 'listings',
     '88880000-0000-4000-8000-000000000001')),
  'the reader''s own action says so');
select ok(
  (select not is_own_action from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51, 'public', 'listings',
     '88880000-0000-4000-8000-000000000002')),
  'and a colleague''s does not — without naming the colleague');
select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51, 'public', 'no_such_table')),
  0, 'an unknown table matches nothing rather than being interpolated');
select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51, 'public', 'listings',
     'not-a-record')),
  0, 'and neither does an unknown record');

-- The recovery workflow carried out above is in the trail, because 0006 audits that table. Nothing in
-- 0078 wrote these rows: the trigger did.
select ok(
  (select count(*) from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51, 'public', 'account_recovery_requests',
     'a8000000-0000-4000-8000-000000000001')) > 0,
  'the recovery request''s own changes are in the audit trail');
select ok(
  (select bool_or('status' = any (changed_columns)) from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51, 'public', 'account_recovery_requests',
     'a8000000-0000-4000-8000-000000000001')),
  'and name the status column as one that changed — the name, without the value');

select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 1)),
  1, 'the limit is honoured');
select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 0)),
  1, 'a limit of zero is clamped up to one');
select ok(
  (select count(*) from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 9999)) <= 51,
  'and a huge one is clamped down');
select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51, 'public', 'listings', null,
     (select occurred_at from audit.audit_logs where request_id = 'req-two'),
     (select id from audit.audit_logs where request_id = 'req-two'))),
  1, 'the cursor continues after a row, without repeating it');

select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000003', true, 51)),
  0, 'a moderator reads no audit');
select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000004', true, 51)),
  0, 'nor does a support agent');
select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000005', true, 51)),
  0, 'nor a buyer');
select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', false, 51)),
  0, 'nor an admin at aal1');
select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000007', true, 51)),
  0, 'nor a revoked admin');

-- Reading the audit trail writes nothing to it.
create temporary table pg_temp_audit_before as
  select count(*) as n from audit.audit_logs;
select is(
  (select count(*)::integer from app_private.admin_audit_page(
     'f8000000-0000-4000-8000-000000000001', true, 51, 'public', 'listings')),
  2, 'a second read returns the same rows');
select is(
  (select n from pg_temp_audit_before),
  (select count(*) from audit.audit_logs),
  'and reading the audit trail wrote nothing to it');

-- ---------------------------------------------------------------------------------------------------
-- 15. What the nineteen result types do not carry
-- ---------------------------------------------------------------------------------------------------
-- Asserted against the catalogue rather than against a sample row, so an empty result can never make one
-- of these pass by accident.
create or replace function pg_temp.result_columns(p_name text) returns text
language sql stable as $$
  select coalesce(string_agg(lower(a.attname), ',' order by a.attname), '')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join lateral unnest(coalesce(p.proallargtypes, array[]::oid[]))
      with ordinality as t(typ, ord) on true
    join lateral unnest(coalesce(p.proargnames, array[]::text[]))
      with ordinality as a(attname, ord2) on a.ord2 = t.ord
    join lateral unnest(coalesce(p.proargmodes, array[]::"char"[]))
      with ordinality as m(mode, ord3) on m.ord3 = t.ord
   where n.nspname = 'app_private' and p.proname = p_name and m.mode in ('o', 't');
$$;

select is(
  (select count(*)::integer from unnest(array[
     'admin_seller_page', 'admin_seller_detail', 'admin_user_page', 'admin_user_detail',
     'admin_user_roles', 'admin_role_catalogue', 'admin_account_security_timeline',
     'recovery_review_queue', 'recovery_request_for_staff', 'recovery_evidence_for_staff',
     'recovery_review_for_staff', 'recovery_decide_for_staff', 'recovery_complete_for_staff',
     'admin_audit_page']) as f(name)
    where pg_temp.result_columns(f.name) = ''),
  0, 'every one of the fourteen result types is readable, so the absences below are absences and not empty strings');

select ok(pg_temp.result_columns('admin_seller_page') not like '%user_id%',
  'the seller page returns no account identifier');
select ok(pg_temp.result_columns('admin_seller_page') not like '%legal_name%',
  'nor a legal name');
select ok(pg_temp.result_columns('admin_seller_page') not like '%contact_%',
  'nor any contact detail');
select ok(pg_temp.result_columns('admin_seller_detail') not like '%user_id%',
  'the seller detail returns no account identifier');
select ok(pg_temp.result_columns('admin_seller_detail') not like '%legal_name%',
  'nor a legal name');
select ok(pg_temp.result_columns('admin_seller_detail') not like '%contact_%',
  'nor any contact detail');
select ok(pg_temp.result_columns('admin_seller_detail') not like '%object_path%',
  'nor a path into private storage');

select ok(pg_temp.result_columns('admin_user_page') not like '%full_name%',
  'the user page returns no legal name');
select ok(pg_temp.result_columns('admin_user_page') not like '%phone_e164%',
  'nor a phone number');
select ok(pg_temp.result_columns('admin_user_page') not like '%avatar%',
  'nor an avatar path');
select ok(pg_temp.result_columns('admin_user_page') not like '%email_verified_at%',
  'and reports verification as a boolean rather than as a timestamp on a contact');
select ok(pg_temp.result_columns('admin_user_detail') not like '%full_name%',
  'the user detail returns no legal name');
select ok(pg_temp.result_columns('admin_user_detail') not like '%phone_e164%',
  'nor a phone number');
select ok(pg_temp.result_columns('admin_user_detail') not like '%avatar%',
  'nor an avatar path');

select ok(pg_temp.result_columns('admin_user_roles') not like '%granted_by%',
  'the roles reader names nobody who granted a role');
select ok(pg_temp.result_columns('admin_user_roles') not like '%revoked_by%',
  'nor anybody who revoked one');
select ok(pg_temp.result_columns('admin_role_catalogue') not like '%user_id%',
  'the role catalogue names no holder');

select ok(pg_temp.result_columns('admin_account_security_timeline') not like '%request_ip%',
  'the security timeline returns no request address');
select ok(pg_temp.result_columns('admin_account_security_timeline') not like '%device_id%',
  'nor a device');

select ok(pg_temp.result_columns('recovery_review_queue') not like '%hash%',
  'the recovery queue returns no contact digest');
select ok(pg_temp.result_columns('recovery_review_queue') not like '%user_id%',
  'no account identifier and nobody''s colleague');
select ok(pg_temp.result_columns('recovery_review_queue') not like '%request_ip%',
  'and no request address');
select ok(pg_temp.result_columns('recovery_request_for_staff') not like '%hash%',
  'the recovery detail returns no contact digest');
select ok(pg_temp.result_columns('recovery_request_for_staff') not like '%user_id%',
  'no account identifier and nobody''s colleague');
select ok(pg_temp.result_columns('recovery_request_for_staff') not like '%request_ip%',
  'no request address');
select ok(pg_temp.result_columns('recovery_request_for_staff') not like '%otp%',
  'and never the OTP challenge');
select ok(pg_temp.result_columns('recovery_evidence_for_staff') not like '%object_path%',
  'the evidence reader returns no object path, so it is not a way to read the file');

select ok(pg_temp.result_columns('admin_audit_page') not like '%old_values%',
  'the audit reader returns no old values');
select ok(pg_temp.result_columns('admin_audit_page') not like '%new_values%',
  'nor new ones — which is what keeps every audited table''s columns out of it');
select ok(pg_temp.result_columns('admin_audit_page') not like '%actor_id%',
  'nor an actor identifier');
select ok(pg_temp.result_columns('admin_audit_page') not like '%request_ip%',
  'nor a request address');
select ok(pg_temp.result_columns('admin_audit_page') like '%changed_columns%',
  'and it does return which columns changed, which is what an audit reader needs');

-- ---------------------------------------------------------------------------------------------------
-- 16. The boundary: every function is a definer function reachable only by app_system
-- ---------------------------------------------------------------------------------------------------
create or replace function pg_temp.names() returns setof text language sql stable as $$
  values ('admin_can_read_sellers'), ('admin_can_read_users'), ('admin_can_read_roles'),
         ('admin_can_read_security'), ('admin_can_review_recovery'), ('admin_can_read_audit'),
         ('admin_seller_page'), ('admin_seller_detail'), ('admin_user_page'), ('admin_user_detail'),
         ('admin_user_roles'), ('admin_role_catalogue'), ('admin_account_security_timeline'),
         ('recovery_review_queue'), ('recovery_request_for_staff'), ('recovery_evidence_for_staff'),
         ('recovery_review_for_staff'), ('recovery_decide_for_staff'), ('recovery_complete_for_staff'),
         ('admin_audit_page');
$$;

select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())),
  20, 'all twenty functions exist');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and not p.prosecdef),
  0, 'every one is SECURITY DEFINER');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and not coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog, public']),
  0, 'every one pins its search_path');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and has_function_privilege('public', p.oid, 'execute')),
  0, 'none is executable by public');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and has_function_privilege('authenticated', p.oid, 'execute')),
  0, 'none is executable by authenticated');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and not has_function_privilege('app_system', p.oid, 'execute')),
  0, 'and every one is executable by app_system');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and has_function_privilege('app_worker', p.oid, 'execute')),
  0, 'app_worker reaches none of them');

-- No role name appears in any of the twenty: authorization is by permission key, always.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and (p.prosrc like '%''super_admin''%' or p.prosrc like '%''support_agent''%'
           or p.prosrc like '%''moderator''%' or p.prosrc like '%''admin''%')),
  0, 'not one of them names a role');

-- ---------------------------------------------------------------------------------------------------
-- 17. What these twenty functions do not write
-- ---------------------------------------------------------------------------------------------------
-- Role assignment is the gap the owner deferred to its own increment after Phase 7, and this is the
-- assertion that fails if somebody adds that writer without one.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.prosrc ~* 'insert\s+into\s+public\.user_roles'
        or p.prosrc ~* 'update\s+public\.user_roles'
        or p.prosrc ~* 'delete\s+from\s+public\.user_roles')),
  0, 'no app_private function writes public.user_roles — role assignment remains deferred');
-- Seller status now has a writer, and it is 0079's rather than one of these. These twenty are still reads
-- and recovery steps: the boundary between the read surface and the status writer is the point.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and p.prosrc ~* 'update\s+public\.seller_profiles'),
  0, 'and none of these twenty sets a seller''s account status — 0079''s own writer does that');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and p.prosrc like '%users.role.manage%'),
  0, 'users.role.manage is consumed by nothing in this increment');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select * from pg_temp.names())
      and p.prosrc like '%sellers.profile.manage%'),
  0, 'and none of these twenty consumes sellers.profile.manage either — 0079''s predicate holds that key');

-- The reads are genuinely read-only: nothing among the thirteen readers writes anything at all.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('admin_seller_page', 'admin_seller_detail', 'admin_user_page',
                        'admin_user_detail', 'admin_user_roles', 'admin_role_catalogue',
                        'admin_account_security_timeline', 'recovery_review_queue',
                        'recovery_request_for_staff', 'recovery_evidence_for_staff',
                        'admin_audit_page')
      and (p.prosrc ~* '\minsert\s+into\m' or p.prosrc ~* '\mupdate\s+public\.'
           or p.prosrc ~* '\mdelete\s+from\m')),
  0, 'not one of the eleven readers writes anything');

-- And the three writers delegate rather than touching the recovery tables themselves.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('recovery_review_for_staff', 'recovery_decide_for_staff',
                        'recovery_complete_for_staff')
      and p.prosrc ~* 'update\s+public\.account_recovery'),
  0, 'none of the three recovery writers updates a recovery table directly');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('recovery_review_for_staff', 'recovery_decide_for_staff',
                        'recovery_complete_for_staff')
      and p.prosrc ~* 'hold_until'),
  0, 'and none of them writes or computes the hold');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('recovery_review_for_staff', 'recovery_decide_for_staff',
                        'recovery_complete_for_staff')
      and p.prosrc ~* 'sessions_revoked_at'),
  0, 'nor revokes a session itself');

select * from finish();
rollback;
