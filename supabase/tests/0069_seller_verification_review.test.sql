-- pgTAP — migration 0069: the reviewer's side of seller verification.
--
-- Seven things are being held to account.
--
-- **The permission is the only key that opens this.** A buyer, a seller, a moderator, a support agent, an
-- account with no role at all, an admin whose grant was revoked, an admin whose grant expired, and an admin
-- at aal1 each get exactly what a stranger gets: no queue rows, `not_found` on the detail, `not_found` on a
-- document, `not_found` on a decision. The same admin at aal2 gets all four.
--
-- **AAL2 is inside the permission test, not beside it.** 0003's `roles_console_requires_mfa` makes every
-- console role `requires_mfa`, so `verification_reviewer_can_review(admin, false)` is false — which is
-- asserted directly, and then again through every function.
--
-- **Nothing that is not a submission is reachable.** Drafts are absent from the queue, `not_found` on the
-- detail, `not_found` by document id, and not decidable.
--
-- **The queue is the schema's ordering.** Oldest `submitted_at` first, `id` breaking ties, keyset paging that
-- neither repeats nor skips a row, a limit that is clamped, and status filters that admit exactly the five
-- non-draft statuses and nothing else.
--
-- **A reviewer cannot name an object.** `verification_review_document` has no path parameter; the path it
-- returns is the one 0063 composed, and another verification's document id is refused only by being another
-- document, not by being a path.
--
-- **The decision is 0009's own UPDATE, and 0009's machinery answers it.** Approve and reject each set exactly
-- four columns; `tg_apply_verification_decision` then moves `seller_profiles.verification_status` and
-- `verified_at`; `audit.tg_record_change` records the change with `decision_reason` redacted. A second
-- decision on a decided row is a `conflict` and changes nothing. A rejection without a reason and an approval
-- without both contact verifications are refused as outcomes rather than as constraint violations. `expired`
-- is not decidable and no function assigns it.
--
-- **The migration adds no schema and no privilege beyond `app_system`.** Asserted on the catalogue: five
-- functions, all SECURITY DEFINER with the pinned search_path, EXECUTE revoked from PUBLIC and granted to
-- `app_system` alone, and 0009's tables, constraints, indexes, triggers and policies unchanged in number.
--
-- Deterministic: fixed uuids, no wall-clock dependence. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(142);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XRV', '962', 'R', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZR', 'ZRZ', '996', 'Reviewland', 'Reviewland', '996', 'XRV', true);

-- Three sellers and eight accounts on the reviewing side.
insert into auth.users (id, email) values
  ('e0000000-0000-4000-8000-000000000001', 'rev-seller-one@test.invalid'),
  ('e0000000-0000-4000-8000-000000000002', 'rev-seller-two@test.invalid'),
  ('e0000000-0000-4000-8000-000000000003', 'rev-seller-three@test.invalid'),
  ('e0000000-0000-4000-8000-000000000004', 'rev-seller-four@test.invalid'),
  ('e0000000-0000-4000-8000-000000000010', 'rev-admin@test.invalid'),
  ('e0000000-0000-4000-8000-000000000011', 'rev-super@test.invalid'),
  ('e0000000-0000-4000-8000-000000000012', 'rev-moderator@test.invalid'),
  ('e0000000-0000-4000-8000-000000000013', 'rev-support@test.invalid'),
  ('e0000000-0000-4000-8000-000000000014', 'rev-buyer@test.invalid'),
  ('e0000000-0000-4000-8000-000000000015', 'rev-nobody@test.invalid'),
  ('e0000000-0000-4000-8000-000000000016', 'rev-revoked@test.invalid'),
  ('e0000000-0000-4000-8000-000000000017', 'rev-expired@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, country_code, governorate, city,
   contact_email, contact_phone_e164, status, verification_status, verified_at)
values
  ('e0000000-0000-4000-8000-000000000001', 'rev-shop-one', 'Review Shop One', 'One Trading LLC', 'ZR',
   'Giza', 'Dokki', 'one@shops.invalid', '+201000000101', 'pending', 'pending', null),
  ('e0000000-0000-4000-8000-000000000002', 'rev-shop-two', 'Review Shop Two', null, 'ZR',
   null, null, null, null, 'pending', 'pending', null),
  ('e0000000-0000-4000-8000-000000000003', 'rev-shop-three', 'Review Shop Three', null, 'ZR',
   null, null, null, null, 'pending', 'unverified', null),
  ('e0000000-0000-4000-8000-000000000004', 'rev-shop-four', 'Review Shop Four', null, 'ZR',
   null, null, null, null, 'pending', 'pending', null);

insert into public.user_roles (user_id, role_key, granted_at, expires_at, revoked_at) values
  ('e0000000-0000-4000-8000-000000000010', 'admin',         '2026-01-01T00:00:00Z', null, null),
  ('e0000000-0000-4000-8000-000000000011', 'super_admin',   '2026-01-01T00:00:00Z', null, null),
  ('e0000000-0000-4000-8000-000000000012', 'moderator',     '2026-01-01T00:00:00Z', null, null),
  ('e0000000-0000-4000-8000-000000000013', 'support_agent', '2026-01-01T00:00:00Z', null, null),
  ('e0000000-0000-4000-8000-000000000014', 'buyer',         '2026-01-01T00:00:00Z', null, null),
  -- A grant that was taken away, and one that ran out. Neither counts.
  ('e0000000-0000-4000-8000-000000000016', 'admin',         '2026-01-01T00:00:00Z', null, '2026-01-03T00:00:00Z'),
  ('e0000000-0000-4000-8000-000000000017', 'admin',         '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', null);
insert into public.user_roles (user_id, role_key) values
  ('e0000000-0000-4000-8000-000000000001', 'seller'),
  ('e0000000-0000-4000-8000-000000000002', 'seller');

-- Four verifications: two waiting (one of them under review), one already decided, one still a draft.
insert into public.seller_verifications
  (id, seller_user_id, status, submitted_at, created_at, reviewed_at, reviewed_by, decision_reason,
   email_verified_at, phone_verified_at)
values
  -- Oldest submission, both contacts verified: the approvable one.
  ('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'submitted',
   '2026-05-01T09:00:00Z', '2026-05-01T08:00:00Z', null, null, null,
   '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z'),
  -- Newer, already picked up, and missing the phone verification.
  ('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002', 'under_review',
   '2026-05-02T09:00:00Z', '2026-05-02T08:00:00Z', null, null, null,
   '2026-04-03T00:00:00Z', null),
  -- Never submitted.
  ('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003', 'draft',
   null, '2026-05-03T08:00:00Z', null, null, null, null, null),
  -- Already decided by somebody else.
  ('f0000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000004', 'rejected',
   '2026-04-20T09:00:00Z', '2026-04-20T08:00:00Z', '2026-04-21T09:00:00Z',
   'e0000000-0000-4000-8000-000000000011', 'Documents did not match the legal name.', null, null);

insert into public.seller_verification_documents
  (id, verification_id, document_type, object_path, original_filename, content_type, byte_size,
   status, uploaded_at)
values
  ('a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'national_id',
   'verification-documents/rev-shop-one/national_id/11111111-1111-4111-8111-111111111111.jpg',
   'id-front.jpg', 'image/jpeg', 120000, 'pending', '2026-05-01T08:30:00Z'),
  ('a0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000001', 'tax_card',
   'verification-documents/rev-shop-one/tax_card/22222222-2222-4222-8222-222222222222.pdf',
   'tax.pdf', 'application/pdf', 240000, 'pending', '2026-05-01T08:40:00Z'),
  ('a0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000002', 'passport',
   'verification-documents/rev-shop-two/passport/33333333-3333-4333-8333-333333333333.png',
   'passport.png', 'image/png', 90000, 'pending', '2026-05-02T08:30:00Z'),
  -- On the draft: never reachable from any function here.
  ('a0000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000003', 'other',
   'verification-documents/rev-shop-three/other/44444444-4444-4444-8444-444444444444.pdf',
   'draft.pdf', 'application/pdf', 10000, 'pending', '2026-05-03T08:30:00Z');

-- Shorthands ----------------------------------------------------------------------------------------
create temporary view admin_queue as
  select * from app_private.verification_review_queue(
    'e0000000-0000-4000-8000-000000000010', true, null, 20, null, null);

-- ---------------------------------------------------------------------------------------------------
-- 1. The migration's shape: five functions, no schema, no extra privilege
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('verification_reviewer_can_review', 'verification_review_queue',
                        'verification_review_detail', 'verification_review_document',
                        'verification_review_decide')),
  5, '0069 defines exactly five functions');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'verification_review%'
      and not p.prosecdef),
  0, 'every one of them is SECURITY DEFINER');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'verification_review%' or p.proname = 'verification_reviewer_can_review')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                       where cfg = 'search_path=pg_catalog, public')),
  0, 'every one of them pins search_path = pg_catalog, public');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'verification_review%' or p.proname = 'verification_reviewer_can_review')
      and has_function_privilege('public', p.oid, 'execute')),
  0, 'PUBLIC may execute none of them');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'verification_review%' or p.proname = 'verification_reviewer_can_review')
      and has_function_privilege('app_system', p.oid, 'execute')),
  5, 'app_system may execute all five');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'verification_review%' or p.proname = 'verification_reviewer_can_review')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  0, 'authenticated may execute none of them: it already has 0009''s policies');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'verification_review%' or p.proname = 'verification_reviewer_can_review')
      and has_function_privilege('app_worker', p.oid, 'execute')),
  0, 'app_worker may execute none of them');

-- 0009's model is untouched.
select has_table('public', 'seller_verifications', '0009''s verification table still exists');
select has_table('public', 'seller_verification_documents', '0009''s document table still exists');
select is(
  (select count(*)::int from pg_policy p where p.polrelid = 'public.seller_verifications'::regclass),
  5, 'seller_verifications still carries exactly 0009''s five policies');
select is(
  (select count(*)::int from pg_policy p where p.polrelid = 'public.seller_verification_documents'::regclass),
  3, 'seller_verification_documents still carries exactly 0009''s three policies');
select has_index('public', 'seller_verifications', 'seller_verifications_queue',
  '0009''s queue index — the ordering this migration uses — is still there');
select is(
  (select count(*)::int from pg_trigger t
    where t.tgrelid = 'public.seller_verifications'::regclass and not t.tgisinternal),
  3, 'seller_verifications still carries exactly 0009''s three triggers');

-- Nothing in this migration mentions a status the reviewer path may not set.
select isnt(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'verification_review_decide'),
  null, 'the decision function has a body to inspect');
select ok(
  (select prosrc not like '%''expired''%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'verification_review_decide'),
  'the decision function never assigns or names expired as a target');

-- ---------------------------------------------------------------------------------------------------
-- 2. The permission predicate on its own
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.verification_reviewer_can_review('e0000000-0000-4000-8000-000000000010', true),
  'an admin at aal2 may review');
select ok(app_private.verification_reviewer_can_review('e0000000-0000-4000-8000-000000000011', true),
  'a super_admin at aal2 may review');
select ok(not app_private.verification_reviewer_can_review('e0000000-0000-4000-8000-000000000010', false),
  'the same admin at aal1 may not: every console role is requires_mfa');
select ok(not app_private.verification_reviewer_can_review('e0000000-0000-4000-8000-000000000010', null),
  'a null assurance level is aal1, not a bypass');
select ok(not app_private.verification_reviewer_can_review('e0000000-0000-4000-8000-000000000012', true),
  'a moderator at aal2 may not: the repository does not grant it this permission');
select ok(not app_private.verification_reviewer_can_review('e0000000-0000-4000-8000-000000000013', true),
  'a support agent at aal2 may not');
select ok(not app_private.verification_reviewer_can_review('e0000000-0000-4000-8000-000000000014', true),
  'a buyer may not');
select ok(not app_private.verification_reviewer_can_review('e0000000-0000-4000-8000-000000000001', true),
  'a seller may not review — including their own application');
select ok(not app_private.verification_reviewer_can_review('e0000000-0000-4000-8000-000000000015', true),
  'an account with no role at all may not');
select ok(not app_private.verification_reviewer_can_review('e0000000-0000-4000-8000-000000000016', true),
  'a revoked admin grant does not count');
select ok(not app_private.verification_reviewer_can_review('e0000000-0000-4000-8000-000000000017', true),
  'an expired admin grant does not count');
select ok(not app_private.verification_reviewer_can_review(null, true),
  'no account is not an account');

-- The permission assignment itself is read, never changed.
select is(
  (select array_agg(rp.role_key order by rp.role_key)
     from public.role_permissions rp where rp.permission_key = 'sellers.verification.review'),
  array['admin', 'super_admin'],
  'sellers.verification.review still belongs to admin and super_admin, and to nobody else');

-- ---------------------------------------------------------------------------------------------------
-- 3. The queue
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from admin_queue), 2,
  'the default queue is the two submissions awaiting a decision');

select is(
  (select array_agg(id::text order by ordinality) from (
     select id, row_number() over () as ordinality from admin_queue) q),
  array['f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002'],
  'ordered by submitted_at, oldest first');

select is((select count(*)::int from admin_queue where id = 'f0000000-0000-4000-8000-000000000003'),
  0, 'a draft is never in the queue');
select is((select count(*)::int from admin_queue where id = 'f0000000-0000-4000-8000-000000000004'),
  0, 'a decided verification is not in the default queue');

select is((select document_count from admin_queue where id = 'f0000000-0000-4000-8000-000000000001'),
  2, 'the queue counts the submission''s documents');
select is((select email_verified from admin_queue where id = 'f0000000-0000-4000-8000-000000000001'),
  true, 'a verified contact is reported as a boolean');
select is((select phone_verified from admin_queue where id = 'f0000000-0000-4000-8000-000000000002'),
  false, 'and an unverified one as false, not as a timestamp');
select is((select seller_slug from admin_queue where id = 'f0000000-0000-4000-8000-000000000001'),
  'rev-shop-one', 'the queue names the storefront');
select is((select seller_display_name from admin_queue where id = 'f0000000-0000-4000-8000-000000000001'),
  'Review Shop One', 'and its display name');

-- No account identifier anywhere in the queue's shape.
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'app_private' and table_name = 'verification_review_queue'),
  0, 'the queue is a function, not a table');
select is(
  (select count(*)::int from unnest(
     (select proargnames from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app_private' and p.proname = 'verification_review_queue')) name
    where name in ('seller_user_id', 'user_id', 'reviewed_by')),
  0, 'no seller account id and no reviewer id is in the queue''s result');

-- Status filters.
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, 'submitted', 20, null, null)),
  1, 'filtering on submitted returns the submitted one');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, 'under_review', 20, null, null)),
  1, 'filtering on under_review returns the one being reviewed');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, 'rejected', 20, null, null)),
  1, 'a reviewer can look back at what was rejected');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, 'approved', 20, null, null)),
  0, 'nothing is approved yet');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, 'expired', 20, null, null)),
  0, 'and nothing is expired');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, 'draft', 20, null, null)),
  0, 'draft is refused as a filter: a draft is not a submission');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, 'anything else', 20, null, null)),
  0, 'an unknown status matches nothing rather than everything');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, '''; drop table public.seller_verifications; --',
     20, null, null)),
  0, 'the status filter is a value and never a fragment of the statement');

-- Paging.
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, null, 1, null, null)),
  1, 'the limit is honoured');
select is(
  (select id::text from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, null, 1, null, null)),
  'f0000000-0000-4000-8000-000000000001', 'the first page is the oldest submission');
select is(
  (select id::text from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, null, 20,
     '2026-05-01T09:00:00Z', 'f0000000-0000-4000-8000-000000000001')),
  'f0000000-0000-4000-8000-000000000002',
  'the next page starts after the cursor, repeating nothing');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, null, 20,
     '2026-05-02T09:00:00Z', 'f0000000-0000-4000-8000-000000000002')),
  0, 'and the page after the last one is empty');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, null, 500, null, null)),
  2, 'an oversized limit is clamped rather than refused');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, null, 51, null, null)),
  2, 'and the API''s own look-ahead page size is within the clamp');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, null, 0, null, null)),
  1, 'a zero limit is clamped up to one');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, null, null, null, null)),
  2, 'a null limit falls back to the default');

-- Who sees the queue at all.
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000011', true, null, 20, null, null)),
  2, 'a super_admin at aal2 sees the queue');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', false, null, 20, null, null)),
  0, 'an admin at aal1 sees nothing');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000012', true, null, 20, null, null)),
  0, 'a moderator sees nothing');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000013', true, null, 20, null, null)),
  0, 'a support agent sees nothing');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000014', true, null, 20, null, null)),
  0, 'a buyer sees nothing');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000001', true, null, 20, null, null)),
  0, 'a seller does not see the queue their own application is in');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000015', true, null, 20, null, null)),
  0, 'an account with no role sees nothing');
select is(
  (select count(*)::int from app_private.verification_review_queue(null, true, null, 20, null, null)),
  0, 'and no account sees nothing');

-- ---------------------------------------------------------------------------------------------------
-- 4. The detail
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001')),
  'found', 'an authorized reviewer reads a submission');

select is(
  (select status from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001')),
  'submitted', 'with its current status');
select is(
  (select seller_legal_name from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001')),
  'One Trading LLC', 'and the legal name the evidence has to agree with');
select is(
  (select seller_contact_email from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001')),
  'one@shops.invalid', 'and the contact details a reviewer checks');
select is(
  (select seller_contact_phone from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001')),
  '+201000000101', 'in E.164, exactly as stored');
select is(
  (select jsonb_array_length(documents) from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001')),
  2, 'and both of its documents');
select is(
  (select documents -> 0 ->> 'originalFilename' from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001')),
  'id-front.jpg', 'documents are ordered by upload time');
select is(
  (select documents -> 0 ->> 'byteSize' from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001')),
  '120000', 'a bigint size crosses as a string, never as a JSON number');

-- The one thing the detail must never carry.
select is(
  (select count(*)::int from jsonb_array_elements(
     (select documents from app_private.verification_review_detail(
        'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001'))) doc
    where doc.value ? 'objectPath' or doc.value ? 'object_path'),
  0, 'no document in the detail carries a storage object path');
select is(
  (select count(*)::int from jsonb_array_elements(
     (select documents from app_private.verification_review_detail(
        'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001'))) doc
    where doc.value ? 'reviewedBy' or doc.value ? 'reviewNote'),
  0, 'and no reviewer identifier or internal note');
select is(
  (select count(*)::int from unnest(
     (select proargnames from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app_private' and p.proname = 'verification_review_detail')) name
    where name in ('seller_user_id', 'reviewed_by')),
  0, 'the detail returns no account id for the seller and none for the reviewer');

-- The decided one, read back.
select is(
  (select decision_reason from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000004')),
  'Documents did not match the legal name.',
  'a decided verification reads back with the reason the reviewer recorded');
select isnt(
  (select reviewed_at from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000004')),
  null, 'and with its review time');

-- What is not readable.
select is(
  (select outcome from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000003')),
  'not_found', 'a draft is not readable by a reviewer');
select is(
  (select outcome from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-0000000000ff')),
  'not_found', 'nor is a verification that does not exist');
select is(
  (select outcome from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, null)),
  'not_found', 'nor is no verification at all');
select is(
  (select outcome from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', false, 'f0000000-0000-4000-8000-000000000001')),
  'not_found', 'an admin at aal1 cannot read a submission');
select is(
  (select outcome from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000012', true, 'f0000000-0000-4000-8000-000000000001')),
  'not_found', 'a moderator cannot');
select is(
  (select outcome from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000013', true, 'f0000000-0000-4000-8000-000000000001')),
  'not_found', 'a support agent cannot');
select is(
  (select outcome from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000014', true, 'f0000000-0000-4000-8000-000000000001')),
  'not_found', 'a buyer cannot');
select is(
  (select outcome from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000001', true, 'f0000000-0000-4000-8000-000000000001')),
  'not_found', 'and the seller cannot read their own application through the reviewer path');
select is(
  (select outcome from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000002', true, 'f0000000-0000-4000-8000-000000000001')),
  'not_found', 'nor can another seller — identical to a verification that is not there');

-- ---------------------------------------------------------------------------------------------------
-- 5. The document read path
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.verification_review_document(
     'e0000000-0000-4000-8000-000000000010', true, 'a0000000-0000-4000-8000-000000000001')),
  'authorized', 'an authorized reviewer may locate a submitted document');
select is(
  (select bucket_id from app_private.verification_review_document(
     'e0000000-0000-4000-8000-000000000010', true, 'a0000000-0000-4000-8000-000000000001')),
  'verification-documents', 'in 0012''s private bucket, named by the database');
select is(
  (select object_path from app_private.verification_review_document(
     'e0000000-0000-4000-8000-000000000010', true, 'a0000000-0000-4000-8000-000000000001')),
  'verification-documents/rev-shop-one/national_id/11111111-1111-4111-8111-111111111111.jpg',
  'and the path is the stored one, composed by 0063 from the seller''s own slug');
select is(
  (select content_type from app_private.verification_review_document(
     'e0000000-0000-4000-8000-000000000010', true, 'a0000000-0000-4000-8000-000000000001')),
  'image/jpeg', 'with the content type it was recorded with');

-- The function takes a document, never a path.
select ok(
  (select pg_get_function_arguments(p.oid) not like '%path%'
      and pg_get_function_arguments(p.oid) not like '%bucket%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'verification_review_document'),
  'no input parameter of the document reader is a path or a bucket');
select is(
  (select p.pronargs::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'verification_review_document'),
  3, 'it takes exactly three parameters: a reviewer, an assurance level and a document');

select is(
  (select outcome from app_private.verification_review_document(
     'e0000000-0000-4000-8000-000000000010', true, 'a0000000-0000-4000-8000-000000000004')),
  'not_found', 'a document on a draft is not reachable');
select is(
  (select outcome from app_private.verification_review_document(
     'e0000000-0000-4000-8000-000000000010', true, 'a0000000-0000-4000-8000-0000000000ff')),
  'not_found', 'nor is a document that does not exist');
select is(
  (select outcome from app_private.verification_review_document(
     'e0000000-0000-4000-8000-000000000010', true, null)),
  'not_found', 'nor is no document at all');
select is(
  (select object_path from app_private.verification_review_document(
     'e0000000-0000-4000-8000-000000000010', true, 'a0000000-0000-4000-8000-0000000000ff')),
  null, 'and a refusal carries no path');
select is(
  (select outcome from app_private.verification_review_document(
     'e0000000-0000-4000-8000-000000000010', false, 'a0000000-0000-4000-8000-000000000001')),
  'not_found', 'an admin at aal1 cannot locate a document');
select is(
  (select outcome from app_private.verification_review_document(
     'e0000000-0000-4000-8000-000000000012', true, 'a0000000-0000-4000-8000-000000000001')),
  'not_found', 'a moderator cannot');
select is(
  (select outcome from app_private.verification_review_document(
     'e0000000-0000-4000-8000-000000000013', true, 'a0000000-0000-4000-8000-000000000001')),
  'not_found', 'a support agent cannot');
select is(
  (select outcome from app_private.verification_review_document(
     'e0000000-0000-4000-8000-000000000002', true, 'a0000000-0000-4000-8000-000000000001')),
  'not_found', 'and a seller cannot reach another seller''s document');

-- ---------------------------------------------------------------------------------------------------
-- 6. The decision — refusals first, so the fixtures survive for the writes below
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000012', true, 'f0000000-0000-4000-8000-000000000001',
     'approved', null)),
  'not_found', 'a moderator cannot decide');
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000013', true, 'f0000000-0000-4000-8000-000000000001',
     'approved', null)),
  'not_found', 'a support agent cannot decide');
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000014', true, 'f0000000-0000-4000-8000-000000000001',
     'approved', null)),
  'not_found', 'a buyer cannot decide');
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000001', true, 'f0000000-0000-4000-8000-000000000001',
     'approved', null)),
  'not_found', 'and a seller cannot approve their own application');
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', false, 'f0000000-0000-4000-8000-000000000001',
     'approved', null)),
  'not_found', 'an admin at aal1 cannot decide');
select is(
  (select status from public.seller_verifications where id = 'f0000000-0000-4000-8000-000000000001'),
  'submitted', 'and after all five refusals the verification is untouched');

select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000003',
     'approved', null)),
  'not_found', 'a draft cannot be decided');
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-0000000000ff',
     'approved', null)),
  'not_found', 'nor can a verification that does not exist');
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000004',
     'approved', 'Reconsidered.')),
  'conflict', 'an already decided verification cannot be decided again');
select is(
  (select status from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000004',
     'approved', 'Reconsidered.')),
  'rejected', 'and the conflict reports the status it actually holds');
select is(
  (select decision_reason from public.seller_verifications
    where id = 'f0000000-0000-4000-8000-000000000004'),
  'Documents did not match the legal name.',
  'the decided row keeps the reason the first reviewer recorded');

select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001',
     'under_review', null)),
  'invalid', 'under_review is not a decision this path makes');
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001',
     'expired', null)),
  'invalid', 'nor is expired');
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001',
     'submitted', null)),
  'invalid', 'nor is a status belonging to the seller''s own flow');
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001',
     null, null)),
  'invalid', 'nor is no decision at all');

select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001',
     'rejected', null)),
  'reason_required', 'a rejection without a reason is refused as an outcome');
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001',
     'rejected', '    ')),
  'reason_required', 'and a blank one is no reason');
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000002',
     'approved', null)),
  'contacts_unverified',
  'an approval before both contacts are verified is refused as an outcome, not as a constraint error');
select is(
  (select status from public.seller_verifications where id = 'f0000000-0000-4000-8000-000000000002'),
  'under_review', 'and that verification is unchanged');

-- ---------------------------------------------------------------------------------------------------
-- 7. The decision — the writes, and 0009's machinery answering them
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001',
     'approved', 'Identity and tax card match.')),
  'decided', 'an authorized reviewer at aal2 approves a submission');

select is(
  (select status from public.seller_verifications where id = 'f0000000-0000-4000-8000-000000000001'),
  'approved', 'the row holds the new status');
select is(
  (select reviewed_by from public.seller_verifications where id = 'f0000000-0000-4000-8000-000000000001'),
  'e0000000-0000-4000-8000-000000000010'::uuid,
  'the reviewer is recorded — from the parameter, never from a browser');
select isnt(
  (select reviewed_at from public.seller_verifications where id = 'f0000000-0000-4000-8000-000000000001'),
  null, 'the review time is recorded, which 0009''s constraint requires');
select is(
  (select decision_reason from public.seller_verifications where id = 'f0000000-0000-4000-8000-000000000001'),
  'Identity and tax card match.', 'and an optional note on an approval is kept');

-- The existing trigger, doing exactly what it already did.
select is(
  (select verification_status from public.seller_profiles
    where user_id = 'e0000000-0000-4000-8000-000000000001'),
  'verified', 'tg_apply_verification_decision moved the storefront to verified');
select isnt(
  (select verified_at from public.seller_profiles where user_id = 'e0000000-0000-4000-8000-000000000001'),
  null, 'and stamped verified_at, which 0009''s own constraint requires');

-- The existing audit trigger, doing exactly what it already did.
select is(
  (select count(*)::int from audit.audit_logs a
    where a.table_name = 'seller_verifications'
      and a.record_id = 'f0000000-0000-4000-8000-000000000001'
      and a.action = 'update'),
  1, '0009''s audit trigger recorded the decision — one row, not a second event of our own');
select ok(
  (select 'status' = any (a.changed_columns) from audit.audit_logs a
    where a.table_name = 'seller_verifications'
      and a.record_id = 'f0000000-0000-4000-8000-000000000001'
      and a.action = 'update'),
  'and it names status among the changed columns');
select is(
  (select a.new_values ->> 'decision_reason' from audit.audit_logs a
    where a.table_name = 'seller_verifications'
      and a.record_id = 'f0000000-0000-4000-8000-000000000001'
      and a.action = 'update'),
  '[redacted]',
  'with the decision reason replaced by 0009''s redaction marker rather than stored');
select is(
  (select a.new_values ->> 'reviewed_by' from audit.audit_logs a
    where a.table_name = 'seller_verifications'
      and a.record_id = 'f0000000-0000-4000-8000-000000000001'
      and a.action = 'update'),
  'e0000000-0000-4000-8000-000000000010',
  'the reviewer is in the audit row, because it is a column of the row that changed');

-- Repeating the decision.
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001',
     'approved', 'Identity and tax card match.')),
  'conflict', 'repeating the same decision is a conflict, not a second write');
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000011', true, 'f0000000-0000-4000-8000-000000000001',
     'rejected', 'Changed my mind.')),
  'conflict', 'and a second reviewer cannot overturn it from this surface');
select is(
  (select count(*)::int from audit.audit_logs a
    where a.table_name = 'seller_verifications'
      and a.record_id = 'f0000000-0000-4000-8000-000000000001'
      and a.action = 'update'),
  1, 'neither attempt produced an audit row, because neither wrote anything');
select is(
  (select verification_status from public.seller_profiles
    where user_id = 'e0000000-0000-4000-8000-000000000001'),
  'verified', 'and the storefront is still verified');

-- A rejection, on the other submission, once its contacts are irrelevant.
select is(
  (select outcome from app_private.verification_review_decide(
     'e0000000-0000-4000-8000-000000000011', true, 'f0000000-0000-4000-8000-000000000002',
     'rejected', '  The passport scan is unreadable.  ')),
  'decided', 'a super_admin rejects the other submission');
select is(
  (select decision_reason from public.seller_verifications where id = 'f0000000-0000-4000-8000-000000000002'),
  'The passport scan is unreadable.', 'the reason is trimmed before it is stored');
select is(
  (select verification_status from public.seller_profiles
    where user_id = 'e0000000-0000-4000-8000-000000000002'),
  'rejected', 'and 0009''s trigger moved that storefront to rejected');
select is(
  (select verified_at from public.seller_profiles where user_id = 'e0000000-0000-4000-8000-000000000002'),
  null, 'with no verified_at');

-- The queue after the decisions.
select is((select count(*)::int from admin_queue), 0, 'the queue is empty once both were decided');
select is(
  (select count(*)::int from app_private.verification_review_queue(
     'e0000000-0000-4000-8000-000000000010', true, 'approved', 20, null, null)),
  1, 'and the approved filter now returns the one that was approved');

select is(
  (select status from app_private.verification_review_detail(
     'e0000000-0000-4000-8000-000000000010', true, 'f0000000-0000-4000-8000-000000000001')),
  'approved', 'the detail reads back the decision immediately');

-- Nothing in this migration ever wrote to seller_profiles itself.
select ok(
  (select prosrc not like '%seller_profiles%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'verification_review_decide'),
  'the decision function never touches seller_profiles: 0009''s trigger does that');
select ok(
  (select prosrc not like '%outbox%' and prosrc not like '%notification%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'verification_review_decide'),
  'and it emits no event: 7-G changes no notification behaviour');

select * from finish();
rollback;
