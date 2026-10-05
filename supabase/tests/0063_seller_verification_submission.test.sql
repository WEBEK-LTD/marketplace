-- pgTAP — migration 0063: the seller's own verification submission.
--
-- Six things are being held to account.
--
-- **A seller can never reach a decision.** `approved`, `rejected`, `under_review` and `expired` appear in no
-- assignment in any of the six functions, none has a `status` parameter, and `reviewed_at`, `reviewed_by` and
-- `decision_reason` appear in no column list — asserted on the sources, then again by driving every function
-- against an attempt in each of those states and finding it refused. 0009's constraints make `approved` and
-- `rejected` structurally impossible without a reviewer this migration cannot supply.
--
-- **Ownership is the storefront's, and cross-seller access is indistinguishable from absence.** Two sellers,
-- a borrowed object path and a borrowed document id: each answers exactly as a thing that does not exist.
--
-- **The object path is unforgeable.** Traversal, a nested path, another seller's namespace, another bucket,
-- another document type, a bad extension — six attacks, six refusals, and the path the server issues contains
-- no identifier at all.
--
-- **The limits are the bucket's own**, read from `storage.buckets`: 20 MiB and the three MIME types, exercised
-- at the boundary in both directions.
--
-- **The owner's three 6-I decisions.** No document minimum for `draft → submitted`; a verified storefront is
-- offered nothing and gets no row; document removal only while `draft` or `submitted`, enforced in the
-- function and therefore *narrower* than 0009's RLS.
--
-- **The audit trail is 0009's.** The verification's own audit trigger records the insert and the submission
-- with `decision_reason` redacted; the documents table has no audit trigger, and this migration adds none.
--
-- Deterministic: fixed uuids, no wall-clock dependence. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(204);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTT', '961', 'T', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZY', 'ZYZ', '997', 'Testland', 'Testland', '997', 'XTT', true);

insert into auth.users (id, email, phone, email_confirmed_at, phone_confirmed_at) values
  ('d0000000-0000-4000-8000-000000000001', 'ver-one@test.invalid', '+201000000001',
   '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
  ('d0000000-0000-4000-8000-000000000002', 'ver-two@test.invalid', null, null, null),
  ('d0000000-0000-4000-8000-000000000003', 'ver-verified@test.invalid', '+201000000003',
   '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
  ('d0000000-0000-4000-8000-000000000004', 'ver-suspended@test.invalid', null, null, null),
  ('d0000000-0000-4000-8000-000000000005', 'ver-closed@test.invalid', null, null, null),
  ('d0000000-0000-4000-8000-000000000006', 'ver-nobody@test.invalid', null, null, null),
  ('d0000000-0000-4000-8000-000000000007', 'ver-rejected@test.invalid', '+201000000007',
   '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
  ('d0000000-0000-4000-8000-000000000008', 'ver-review@test.invalid', '+201000000008',
   '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
  ('d0000000-0000-4000-8000-000000000009', 'ver-reviewer@test.invalid', null, null, null),
  ('d0000000-0000-4000-8000-000000000010', 'ver-decided@test.invalid', null, null, null);

insert into public.seller_profiles
  (user_id, slug, display_name, country_code, status, suspended_at, suspension_reason, closed_at,
   verification_status, verified_at)
values
  ('d0000000-0000-4000-8000-000000000001', 'ver-shop-one', 'Shop One', 'ZY', 'pending',
   null, null, null, 'unverified', null),
  ('d0000000-0000-4000-8000-000000000002', 'ver-shop-two', 'Shop Two', 'ZY', 'pending',
   null, null, null, 'unverified', null),
  ('d0000000-0000-4000-8000-000000000003', 'ver-shop-verified', 'Verified Shop', 'ZY', 'active',
   null, null, null, 'verified', '2026-02-01T00:00:00Z'),
  ('d0000000-0000-4000-8000-000000000004', 'ver-shop-susp', 'Suspended Shop', 'ZY', 'suspended',
   '2026-03-01T00:00:00Z', 'Repeated policy breaches, internal note', null, 'unverified', null),
  ('d0000000-0000-4000-8000-000000000005', 'ver-shop-closed', 'Closed Shop', 'ZY', 'closed',
   null, null, '2026-04-01T00:00:00Z', 'unverified', null),
  ('d0000000-0000-4000-8000-000000000007', 'ver-shop-rejected', 'Rejected Shop', 'ZY', 'pending',
   null, null, null, 'rejected', null),
  ('d0000000-0000-4000-8000-000000000008', 'ver-shop-review', 'Review Shop', 'ZY', 'pending',
   null, null, null, 'pending', null),
  ('d0000000-0000-4000-8000-000000000010', 'ver-shop-decided', 'Decided Shop', 'ZY', 'pending',
   null, null, null, 'rejected', null);

-- A decided attempt and one with a reviewer, built directly so the functions are tested against states a
-- seller cannot produce.
insert into public.seller_verifications
  (id, seller_user_id, status, submitted_at, reviewed_at, reviewed_by, decision_reason,
   email_verified_at, phone_verified_at)
values
  ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000007', 'rejected',
   '2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z', 'd0000000-0000-4000-8000-000000000009',
   'Documents were illegible, internal note', null, null),
  ('e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000008', 'under_review',
   '2026-05-01T00:00:00Z', null, null, null, null, null),
  -- This storefront's attempt stays decided for the whole file: nothing below starts a new one for it,
  -- so the readback assertions about a decided attempt cannot be disturbed by statement order.
  ('e0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000010', 'rejected',
   '2026-05-01T00:00:00Z', '2026-05-03T00:00:00Z', 'd0000000-0000-4000-8000-000000000009',
   'Register was expired, internal note', null, null);

insert into public.seller_verification_documents
  (id, verification_id, document_type, object_path, original_filename, content_type, byte_size, status,
   review_note, reviewed_at, reviewed_by)
values
  ('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'national_id',
   'verification-documents/ver-shop-rejected/national_id/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf',
   'id.pdf', 'application/pdf', 4096, 'rejected', 'Blurred, internal note',
   '2026-05-02T00:00:00Z', 'd0000000-0000-4000-8000-000000000009'),
  ('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002', 'passport',
   'verification-documents/ver-shop-review/passport/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png',
   'p.png', 'image/png', 2048, 'pending', null, null, null),
  ('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003', 'commercial_register',
   'verification-documents/ver-shop-decided/commercial_register/cccccccc-cccc-cccc-cccc-cccccccccccc.pdf',
   'cr.pdf', 'application/pdf', 8192, 'rejected', 'Expired, internal note',
   '2026-05-03T00:00:00Z', 'd0000000-0000-4000-8000-000000000009');

create temporary table audit_mark as
select coalesce(max(a.id), 0) as id from audit.audit_logs a;

-- ---------------------------------------------------------------------------------------------------
-- Security: the S8 contract, for all six functions
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_to_string(array_agg(p.proname || '/' || p.pronargs order by p.proname), ' ')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_verification%'),
  'seller_verification/1 seller_verification_document_attach/6 seller_verification_document_remove/2'
    || ' seller_verification_document_target/4 seller_verification_start/1 seller_verification_submit/1',
  'this migration adds exactly six functions, each with the arity it declares, and no overloads');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_verification%' and not p.prosecdef),
  0::bigint,
  'every one of them is SECURITY DEFINER');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'seller\_verification%'
      and array_to_string(p.proconfig, ',') <> 'search_path=pg_catalog, public'),
  0::bigint,
  'and every one has its search_path pinned');

-- No input parameter anywhere names a seller, an owner, a status, a reviewer or a decision.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames[1:p.pronargs]) as arg
    where n.nspname = 'app_private' and p.proname like 'seller\_verification%'
      and (arg like '%seller%'
        or arg like '%owner%'
        or arg like '%status%'
        or arg like '%review%'
        or arg like '%decision%'
        or arg like '%verif%'
        or arg like '%approv%'
        or arg like '%\_at')),
  0::bigint,
  'no function takes a seller, an owner, a status, a reviewer, a decision, a verification or a timestamp');
select is(
  (select array_to_string(p.proargnames[1:p.pronargs], ',') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_verification_submit'),
  'p_user_id',
  'the submitter takes one caller id and nothing else at all');
select is(
  (select array_to_string(p.proargnames[1:p.pronargs], ',') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_verification_start'),
  'p_user_id',
  'and so does the starter');

-- The states a seller may not reach appear nowhere in any function's executable text. These scans read the
-- code, so the line comments are stripped first: several of them discuss the reviewer fields precisely in
-- order to record that no column list contains them, and prose about an absence must not read as its
-- presence. `v_code` below is each body with its `--` comments removed.
create temporary view verification_code as
select p.proname,
       regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') as code
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname like 'seller\_verification%';

select is((select count(*) from verification_code), 6::bigint,
  'the scans below cover all six functions');
select is(
  (select count(*) from verification_code c
    where strpos(c.code, '''approved''') > 0 or strpos(c.code, '''rejected''') > 0
       or strpos(c.code, '''expired''') > 0),
  0::bigint,
  'no function names approved, rejected or expired anywhere in its code');
select is(
  (select count(*) from verification_code c
    where strpos(c.code, 'reviewed_at') > 0 or strpos(c.code, 'reviewed_by') > 0
       or strpos(c.code, 'decision_reason') > 0 or strpos(c.code, 'review_note') > 0),
  0::bigint,
  'and no reviewer field, decision reason or review note appears in any column list, target or expression');
select is(
  (select count(*) from verification_code c where strpos(c.code, 'tg_apply_verification_decision') > 0),
  0::bigint,
  'and none calls the decision trigger function to simulate a decision');
select is(
  (select count(*) from verification_code c where strpos(c.code, 'update public.seller_profiles') > 0),
  0::bigint,
  'and none writes to seller_profiles: the verification_status change is 0009''s trigger''s to make');
select is(
  (select count(*) from verification_code c where strpos(c.code, 'delete from public.seller_verifications') > 0),
  0::bigint,
  'and none deletes an attempt: a seller withdraws nothing, and 0009 grants no DELETE there anyway');

-- No dynamic SQL.
select is(
  (select count(*) from verification_code c
    where strpos(c.code, 'execute format') > 0 or strpos(c.code, 'execute ''') > 0
       or strpos(c.code, 'execute (') > 0),
  0::bigint,
  'none of them builds SQL at run time for a request-controlled value');

-- The readback's shape.
select is(
  (select array_to_string(p.proargnames[2:9], ',') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_verification'),
  'outcome,status,submitted_at,created_at,email_verified,phone_verified,document_count,documents',
  'the readback returns no verification id, no seller id, no reviewer, no review time, no decision reason and no expiry');

-- ACLs.
select ok(not has_function_privilege('public', 'app_private.seller_verification(uuid)', 'execute'),
  'PUBLIC cannot read a seller''s verification');
select ok(not has_function_privilege('anon', 'app_private.seller_verification(uuid)', 'execute'),
  'anon cannot');
select ok(not has_function_privilege('authenticated', 'app_private.seller_verification(uuid)', 'execute'),
  'authenticated cannot');
select ok(has_function_privilege('app_system', 'app_private.seller_verification(uuid)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('app_worker', 'app_private.seller_verification(uuid)', 'execute'),
  'app_worker cannot');
select ok(not has_function_privilege('public', 'app_private.seller_verification_start(uuid)', 'execute'),
  'PUBLIC cannot start an attempt');
select ok(has_function_privilege('app_system', 'app_private.seller_verification_start(uuid)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('authenticated',
  'app_private.seller_verification_document_target(uuid, text, text, bigint)', 'execute'),
  'authenticated cannot authorize a document upload');
select ok(has_function_privilege('app_system',
  'app_private.seller_verification_document_target(uuid, text, text, bigint)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('authenticated',
  'app_private.seller_verification_document_attach(uuid, text, text, text, text, bigint)', 'execute'),
  'authenticated cannot record one');
select ok(has_function_privilege('app_system',
  'app_private.seller_verification_document_attach(uuid, text, text, text, text, bigint)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('authenticated',
  'app_private.seller_verification_document_remove(uuid, uuid)', 'execute'),
  'authenticated cannot remove one');
select ok(has_function_privilege('app_system',
  'app_private.seller_verification_document_remove(uuid, uuid)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('authenticated', 'app_private.seller_verification_submit(uuid)', 'execute'),
  'authenticated cannot submit');
select ok(has_function_privilege('app_system', 'app_private.seller_verification_submit(uuid)', 'execute'),
  'app_system can');

select is(
  (select count(*) from information_schema.table_privileges
    where table_schema = 'public' and table_name in ('seller_verifications', 'seller_verification_documents')
      and grantee in ('app_system', 'app_worker')),
  0::bigint,
  'app_system holds no privilege on either verification table');
select is(
  (select array_to_string(array_agg(distinct privilege_type order by privilege_type), ',')
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'seller_verifications' and grantee = 'authenticated'),
  'INSERT,SELECT,UPDATE',
  '0009''s authenticated grants on seller_verifications are unchanged: still no DELETE');
select is(
  (select array_to_string(array_agg(distinct privilege_type order by privilege_type), ',')
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'seller_verification_documents'
      and grantee = 'authenticated'),
  'DELETE,INSERT,SELECT,UPDATE',
  'and on the documents table: unchanged, DELETE included, which 0009 granted');
select is(
  (select array_to_string(array_agg(policyname order by policyname), ',')
     from pg_policies where schemaname = 'public' and tablename = 'seller_verifications'),
  'seller_verifications_reviewer_read,seller_verifications_reviewer_update,'
    || 'seller_verifications_self_insert,seller_verifications_self_read,seller_verifications_self_update',
  '0009''s five seller_verifications policies are still in place, by name, as defence in depth');
select is(
  (select array_to_string(array_agg(policyname order by policyname), ',')
     from pg_policies where schemaname = 'public' and tablename = 'seller_verification_documents'),
  'seller_verification_documents_reviewer_read,seller_verification_documents_reviewer_update,'
    || 'seller_verification_documents_self_all',
  'and its three document policies, likewise by name');
select is(
  (select count(*) from pg_policies where schemaname = 'public'
     and tablename in ('seller_verifications', 'seller_verification_documents')
     and policyname like '%reviewer%' and qual like '%sellers.verification.review%'),
  4::bigint,
  'the four reviewer policies still gate on the sellers.verification.review permission');
select ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app_private' and p.proname = 'tg_apply_verification_decision'),
  '0009''s decision trigger function still exists and was not replaced');
select is(
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'seller_verifications' and not t.tgisinternal),
  3::bigint,
  'and seller_verifications still carries exactly 0009''s three triggers');
select is(
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'seller_verification_documents' and not t.tgisinternal),
  0::bigint,
  'while the documents table still carries none: 0063 added no trigger and no parallel history');

select lives_ok($$ select app_private.assert_security_contract() $$,
  'the deploy-time security contract still holds');

-- ---------------------------------------------------------------------------------------------------
-- The bucket is the authority, and it is the one 0012 defined
-- ---------------------------------------------------------------------------------------------------
select is(
  (select b.public from storage.buckets b where b.id = 'verification-documents'),
  false,
  'the verification bucket is private');
select is(
  (select b.file_size_limit from storage.buckets b where b.id = 'verification-documents'),
  20971520::bigint,
  'its size limit is 20 MiB, read from the bucket rather than copied');
select is(
  (select array_to_string(b.allowed_mime_types, ',') from storage.buckets b
    where b.id = 'verification-documents'),
  'image/jpeg,image/png,application/pdf',
  'and its three allowed types are the bucket''s own, in 0012''s own order');
select is(
  (select count(*) from app_private.storage_bucket_contract c
    where c.bucket_id = 'verification-documents' and c.must_be_public = false),
  1::bigint,
  'the bucket contract still declares it private');
select is(
  (select count(*) from storage.buckets b where b.id like '%verification%'),
  1::bigint,
  'and there is exactly one verification bucket: 0063 created no second one');

-- ---------------------------------------------------------------------------------------------------
-- No attempt yet
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_verification('d0000000-0000-4000-8000-000000000001')),
  'none', 'a storefront that has never applied reads as none, not as an error');
select is(
  (select document_count from app_private.seller_verification('d0000000-0000-4000-8000-000000000001')),
  0, 'with no documents');
select is(
  (select documents from app_private.seller_verification('d0000000-0000-4000-8000-000000000001')),
  '[]'::jsonb, 'and an empty list rather than a null');
select is(
  (select outcome from app_private.seller_verification('d0000000-0000-4000-8000-000000000006')),
  'not_found', 'an account with no storefront reads as not_found, which is a different thing');
select is(
  (select outcome from app_private.seller_verification(null)),
  'not_found', 'and so does a caller with no id');

-- ---------------------------------------------------------------------------------------------------
-- Starting an attempt
-- ---------------------------------------------------------------------------------------------------
create temporary table started as
select * from app_private.seller_verification_start('d0000000-0000-4000-8000-000000000001');

select is((select outcome from started), 'created', 'a pending seller starts an attempt');
select is((select status from started), 'draft', 'and it is a draft, which is 0009''s own default');
select is(
  (select v.submitted_at from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'),
  null::timestamptz, 'with no submission time');
select is(
  (select v.reviewed_at from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'),
  null::timestamptz, 'no review time');
select is(
  (select v.reviewed_by from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'),
  null::uuid, 'no reviewer');
select is(
  (select v.decision_reason from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'),
  null::text, 'and no decision reason');
select is(
  (select s.verification_status from public.seller_profiles s
    where s.user_id = 'd0000000-0000-4000-8000-000000000001'),
  'unverified',
  'the profile is still unverified: a draft is not a pending submission');

select is(
  (select outcome from app_private.seller_verification_start('d0000000-0000-4000-8000-000000000001')),
  'exists', 'starting a second attempt while one is open answers exists');
select is(
  (select status from app_private.seller_verification_start('d0000000-0000-4000-8000-000000000001')),
  'draft', 'and names the open one''s status');
select is(
  (select count(*) from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'),
  1::bigint,
  'and no second row was created: 0009''s one-open index is respected, not raised against');

-- Owner decision 2.
select is(
  (select outcome from app_private.seller_verification_start('d0000000-0000-4000-8000-000000000003')),
  'already_verified', 'a verified storefront is not offered another attempt');
select is(
  (select count(*) from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000003'),
  0::bigint,
  'and none is created for it, even though the one-open index would have permitted one');
select is(
  (select s.verification_status from public.seller_profiles s
    where s.user_id = 'd0000000-0000-4000-8000-000000000003'),
  'verified', 'and its verified status is untouched');

select is(
  (select outcome from app_private.seller_verification_start('d0000000-0000-4000-8000-000000000004')),
  'not_editable', 'a suspended seller receives no verification authorization');
select is(
  (select outcome from app_private.seller_verification_start('d0000000-0000-4000-8000-000000000005')),
  'not_editable', 'and neither does a closed one');
select is(
  (select outcome from app_private.seller_verification_start('d0000000-0000-4000-8000-000000000006')),
  'not_found', 'an account with no storefront cannot start one');
select is(
  (select outcome from app_private.seller_verification_start(null)),
  'not_found', 'nor can a caller with no id');
select is(
  (select count(*) from public.seller_verifications v
    where v.seller_user_id in ('d0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000005')),
  0::bigint,
  'and none of those refusals wrote anything');

-- A rejected storefront may apply again: the rejected attempt is not open, so a new draft is the path.
select is(
  (select outcome from app_private.seller_verification_start('d0000000-0000-4000-8000-000000000007')),
  'created', 'a rejected storefront may start a new attempt');
select is(
  (select count(*) from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000007'),
  2::bigint, 'which is a second row beside the rejected one, not a change to it');
select is(
  (select v.status from public.seller_verifications v where v.id = 'e0000000-0000-4000-8000-000000000001'),
  'rejected', 'the rejected attempt is untouched');
select is(
  (select v.decision_reason from public.seller_verifications v
    where v.id = 'e0000000-0000-4000-8000-000000000001'),
  'Documents were illegible, internal note',
  'and so is its decision reason, which nothing here reads or rewrites');

select is(
  (select outcome from app_private.seller_verification_start('d0000000-0000-4000-8000-000000000008')),
  'exists', 'a storefront whose attempt is under review cannot start another');
select is(
  (select status from app_private.seller_verification_start('d0000000-0000-4000-8000-000000000008')),
  'under_review', 'and is told which state the open one is in');

-- ---------------------------------------------------------------------------------------------------
-- Authorizing a document upload
-- ---------------------------------------------------------------------------------------------------
create temporary table target as
select * from app_private.seller_verification_document_target(
  'd0000000-0000-4000-8000-000000000001', 'national_id', 'application/pdf', 4096);

select is((select outcome from target), 'authorized', 'an open attempt authorizes an upload');
select is((select bucket_id from target), 'verification-documents',
  'into 0012''s own private bucket, named by the server');
select is((select max_byte_size from target), 20971520::bigint,
  'and reports the bucket''s own ceiling');
select ok(
  (select object_path from target) ~
    '^verification-documents/ver-shop-one/national_id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$',
  'the path is bucket, the caller''s own slug, the validated type, a fresh uuid and the derived extension');
select is(
  (select strpos((select object_path from target), 'd0000000-0000-4000-8000-000000000001')),
  0, 'the caller''s own identifier is not in the path');
select is(
  (select strpos((select object_path from target),
     (select v.id::text from public.seller_verifications v
       where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'))),
  0, 'and neither is the verification''s: the path discloses no identifier at all');
select isnt(
  (select object_path from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'national_id', 'application/pdf', 4096)),
  (select object_path from target),
  'two authorizations never name the same object');

select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'passport', 'image/jpeg', 10)),
  'authorized', 'a passport is an allowed type');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'commercial_register', 'image/png', 10)),
  'authorized', 'so is a commercial register');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'tax_card', 'image/png', 10)),
  'authorized', 'so is a tax card');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'bank_statement', 'application/pdf', 10)),
  'authorized', 'so is a bank statement');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'other', 'application/pdf', 10)),
  'authorized', 'and so is other: 0009''s six types, and exactly those');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'drivers_licence', 'application/pdf', 10)),
  'invalid', 'a type outside 0009''s list is refused, not stored as free text');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', null, 'application/pdf', 10)),
  'invalid', 'and so is no type at all');

select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'passport', 'image/webp', 10)),
  'invalid', 'a content type the bucket does not allow is refused');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'passport', 'image/svg+xml', 10)),
  'invalid', 'and so is an SVG, which is a script container');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'passport', null, 10)),
  'invalid', 'and so is none');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'passport', 'application/pdf', 20971520)),
  'authorized', 'exactly the bucket''s limit is allowed');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'passport', 'application/pdf', 20971521)),
  'invalid', 'one byte over it is not');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'passport', 'application/pdf', 0)),
  'invalid', 'nor is zero');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'passport', 'application/pdf', -1)),
  'invalid', 'nor a negative size');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'passport', 'application/pdf', null)),
  'invalid', 'nor an unstated one');

select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000002', 'passport', 'application/pdf', 10)),
  'not_found', 'a storefront with no attempt cannot authorize an upload');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000008', 'passport', 'application/pdf', 10)),
  'not_found',
  'and neither can one whose attempt is under review: it is no longer theirs to add to');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000004', 'passport', 'application/pdf', 10)),
  'not_editable', 'a suspended seller cannot');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000005', 'passport', 'application/pdf', 10)),
  'not_editable', 'nor a closed one');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000006', 'passport', 'application/pdf', 10)),
  'not_found', 'nor an account with no storefront');
select is(
  (select outcome from app_private.seller_verification_document_target(
    null, 'passport', 'application/pdf', 10)),
  'not_found', 'nor a caller with no id');
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000004', 'drivers_licence', 'image/webp', 99999999)),
  'not_editable',
  'a suspended seller sending nonsense still gets not_editable, so the body cannot probe the gate');

-- ---------------------------------------------------------------------------------------------------
-- Recording a document
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'national_id', (select object_path from target),
    '  passport-scan.pdf  ', 'application/pdf', 4096)),
  'attached', 'an authorized path is recorded');
select is(
  (select document_count from app_private.seller_verification(
    'd0000000-0000-4000-8000-000000000001')),
  1, 'and counted');
select is(
  (select d.original_filename from public.seller_verification_documents d
    where d.object_path = (select object_path from target)),
  'passport-scan.pdf', 'the filename is stored trimmed');
select is(
  (select d.status from public.seller_verification_documents d
    where d.object_path = (select object_path from target)),
  'pending', 'the status is 0009''s own default, which no parameter could have set');
select is(
  (select d.review_note from public.seller_verification_documents d
    where d.object_path = (select object_path from target)),
  null::text, 'no review note');
select is(
  (select d.reviewed_by from public.seller_verification_documents d
    where d.object_path = (select object_path from target)),
  null::uuid, 'no reviewer');
select is(
  (select d.reviewed_at from public.seller_verification_documents d
    where d.object_path = (select object_path from target)),
  null::timestamptz, 'and no review time: a seller writes none of the three');

-- The path attacks.
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport',
    'verification-documents/ver-shop-one/passport/../../../etc/passwd', 'x', 'application/pdf', 10)),
  'invalid', 'a traversal is refused');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport',
    'verification-documents/ver-shop-two/passport/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf',
    'x', 'application/pdf', 10)),
  'invalid', 'another seller''s namespace is refused');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport',
    'seller-media/ver-shop-one/passport/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf',
    'x', 'application/pdf', 10)),
  'invalid', 'another bucket is refused');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport',
    'verification-documents/ver-shop-one/national_id/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab.pdf',
    'x', 'application/pdf', 10)),
  'invalid', 'a path for a different document type than the one declared is refused');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport',
    'verification-documents/ver-shop-one/passport/nested/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf',
    'x', 'application/pdf', 10)),
  'invalid', 'a nested path is refused');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport',
    'verification-documents/ver-shop-one/passport/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.exe',
    'x', 'application/pdf', 10)),
  'invalid', 'an extension the target never issues is refused');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport',
    'verification-documents/ver-shop-one/passport/not-a-uuid.pdf', 'x', 'application/pdf', 10)),
  'invalid', 'a name that is not a uuid is refused');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport',
    'x/verification-documents/ver-shop-one/passport/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf',
    'x', 'application/pdf', 10)),
  'invalid', 'anything before the prefix is refused');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport', null, 'x', 'application/pdf', 10)),
  'invalid', 'and so is no path at all');
select is(
  (select count(*) from public.seller_verification_documents d
    join public.seller_verifications v on v.id = d.verification_id
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'),
  1::bigint,
  'not one of those attacks recorded anything');

select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'national_id', (select object_path from target),
    'again.pdf', 'application/pdf', 4096)),
  'path_taken', 'recording the same object twice answers path_taken');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'national_id',
    'verification-documents/ver-shop-rejected/national_id/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf',
    'x', 'application/pdf', 10)),
  'invalid',
  'and another seller''s already-recorded object is refused by the prefix, never reaching the uniqueness check');

select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport',
    'verification-documents/ver-shop-one/passport/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaac.pdf',
    'x', 'image/webp', 10)),
  'invalid', 'a content type the bucket refuses is refused here too');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport',
    'verification-documents/ver-shop-one/passport/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaac.pdf',
    'x', 'application/pdf', 20971521)),
  'invalid', 'and so is a size over the bucket''s limit');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000002', 'passport',
    'verification-documents/ver-shop-two/passport/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf',
    'x', 'application/pdf', 10)),
  'not_found', 'a storefront with no attempt cannot record a document');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000008', 'passport',
    'verification-documents/ver-shop-review/passport/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf',
    'x', 'application/pdf', 10)),
  'not_found', 'and neither can one whose attempt is under review');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000004', 'passport',
    'verification-documents/ver-shop-susp/passport/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf',
    'x', 'application/pdf', 10)),
  'not_editable', 'a suspended seller cannot');

-- Several documents, and several of one type.
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport',
    (select object_path from app_private.seller_verification_document_target(
      'd0000000-0000-4000-8000-000000000001', 'passport', 'image/jpeg', 512)),
    'p1.jpg', 'image/jpeg', 512)),
  'attached', 'a second document of a different type is allowed');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'passport',
    (select object_path from app_private.seller_verification_document_target(
      'd0000000-0000-4000-8000-000000000001', 'passport', 'image/jpeg', 512)),
    'p2.jpg', 'image/jpeg', 512)),
  'attached', 'and a second of the *same* type, which 0009''s non-unique index permits');
select is(
  (select document_count from app_private.seller_verification('d0000000-0000-4000-8000-000000000001')),
  3, 'all three are counted');

-- What the readback discloses about them.
select is(
  (select jsonb_array_length(documents) from app_private.seller_verification(
    'd0000000-0000-4000-8000-000000000001')),
  3, 'the readback lists all three');
select is(
  (select count(*) from app_private.seller_verification('d0000000-0000-4000-8000-000000000001') r,
     jsonb_array_elements(r.documents) as doc
    where doc ? 'objectPath' or doc ? 'object_path' or doc ? 'reviewNote' or doc ? 'review_note'
       or doc ? 'reviewedBy' or doc ? 'reviewedAt' or doc ? 'verificationId'),
  0::bigint,
  'and no document carries an object path, a review note, a reviewer or a verification id');
select is(
  (select array_to_string(array_agg(k order by k), ',') from app_private.seller_verification(
     'd0000000-0000-4000-8000-000000000001') r,
     jsonb_array_elements(r.documents) as doc,
     jsonb_object_keys(doc) as k
    where doc->>'documentType' = 'national_id'),
  'byteSize,contentType,documentType,id,originalFilename,status,uploadedAt',
  'each document carries exactly seven fields, and its own id is its only identifier');
select is(
  (select doc->>'byteSize' from app_private.seller_verification(
     'd0000000-0000-4000-8000-000000000001') r,
     jsonb_array_elements(r.documents) as doc
    where doc->>'documentType' = 'national_id'),
  '4096',
  'the byte size is a string, as this repository carries every bigint');

-- ---------------------------------------------------------------------------------------------------
-- Removing a document (owner decision 3)
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_verification_document_remove(
    'd0000000-0000-4000-8000-000000000002',
    (select d.id from public.seller_verification_documents d
      join public.seller_verifications v on v.id = d.verification_id
      where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'
      order by d.uploaded_at, d.id limit 1))),
  'not_found',
  'another seller cannot remove this document, and learns nothing about whether it exists');
select is(
  (select document_count from app_private.seller_verification('d0000000-0000-4000-8000-000000000001')),
  3, 'and it is still there');
select is(
  (select outcome from app_private.seller_verification_document_remove(
    'd0000000-0000-4000-8000-000000000001', '99999999-9999-4999-8999-999999999999')),
  'not_found', 'a document id that does not exist answers the same way');
select is(
  (select outcome from app_private.seller_verification_document_remove(
    'd0000000-0000-4000-8000-000000000001', null)),
  'not_found', 'and so does no id at all');
select is(
  (select outcome from app_private.seller_verification_document_remove(
    'd0000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000001')),
  'not_editable', 'a suspended seller cannot remove anything');
select is(
  (select outcome from app_private.seller_verification_document_remove(
    'd0000000-0000-4000-8000-000000000006', 'f0000000-0000-4000-8000-000000000001')),
  'not_found', 'nor can an account with no storefront');

-- The decision-3 boundary: a document on a decided attempt is unreachable.
select is(
  (select outcome from app_private.seller_verification_document_remove(
    'd0000000-0000-4000-8000-000000000010', 'f0000000-0000-4000-8000-000000000003')),
  'not_found',
  'a document on a rejected attempt cannot be removed, even by the seller who uploaded it');
select is(
  (select count(*) from public.seller_verification_documents d
    where d.id = 'f0000000-0000-4000-8000-000000000003'),
  1::bigint,
  'and it is still there: this function is narrower than 0009''s RLS, which would have allowed it');
select is(
  (select outcome from app_private.seller_verification_document_remove(
    'd0000000-0000-4000-8000-000000000007', 'f0000000-0000-4000-8000-000000000001')),
  'not_found',
  'and a seller with a fresh draft cannot reach back into their own earlier decided attempt''s documents');
select is(
  (select count(*) from public.seller_verification_documents d
    where d.id = 'f0000000-0000-4000-8000-000000000001'),
  1::bigint, 'that one survives too');
select is(
  (select outcome from app_private.seller_verification_document_remove(
    'd0000000-0000-4000-8000-000000000008', 'f0000000-0000-4000-8000-000000000002')),
  'not_found',
  'and a document on an attempt under review cannot be removed either');
select is(
  (select count(*) from public.seller_verification_documents d
    where d.id = 'f0000000-0000-4000-8000-000000000002'),
  1::bigint, 'which is also still there');

create temporary table removed as
select * from app_private.seller_verification_document_remove(
  'd0000000-0000-4000-8000-000000000001',
  (select d.id from public.seller_verification_documents d
    join public.seller_verifications v on v.id = d.verification_id
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'
      and d.document_type = 'national_id'));

select is((select outcome from removed), 'removed',
  'a seller removes their own document from a draft attempt');
select is((select document_count from removed), 2, 'and the remaining count comes back');
select is(
  (select count(*) from public.seller_verification_documents d
    join public.seller_verifications v on v.id = d.verification_id
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'
      and d.document_type = 'national_id'),
  0::bigint, 'the row is gone');
select is(
  (select count(*) from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'),
  1::bigint,
  'and the attempt itself survives: removing a document is not withdrawing an application');

-- ---------------------------------------------------------------------------------------------------
-- Submitting
-- ---------------------------------------------------------------------------------------------------
create temporary table submitted as
select * from app_private.seller_verification_submit('d0000000-0000-4000-8000-000000000001');

select is((select outcome from submitted), 'submitted', 'a draft is submitted');
select is((select status from submitted), 'submitted', 'and the status is 0009''s own submitted');
select ok(
  (select v.submitted_at from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001') is not null,
  'submitted_at was recorded, as submitted_has_time requires of anything that is not a draft');
select is(
  (select v.email_verified_at from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'),
  '2026-01-01T00:00:00Z'::timestamptz,
  'the email confirmation time came from auth.users, not from a request');
select is(
  (select v.phone_verified_at from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'),
  '2026-01-02T00:00:00Z'::timestamptz,
  'and so did the phone''s');
select is(
  (select v.reviewed_at from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'),
  null::timestamptz, 'no review time was set');
select is(
  (select v.reviewed_by from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'),
  null::uuid, 'no reviewer was recorded');
select is(
  (select v.decision_reason from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'),
  null::text, 'and no decision reason: the seller reached no decision');
select is(
  (select s.verification_status from public.seller_profiles s
    where s.user_id = 'd0000000-0000-4000-8000-000000000001'),
  'pending',
  'the profile became pending, from 0009''s own trigger rather than from anything written here');
select is(
  (select s.verified_at from public.seller_profiles s
    where s.user_id = 'd0000000-0000-4000-8000-000000000001'),
  null::timestamptz, 'and it is not verified');
select is(
  (select s.status from public.seller_profiles s
    where s.user_id = 'd0000000-0000-4000-8000-000000000001'),
  'pending',
  'the storefront''s own status is unchanged: submitting verifies nothing and activates nothing');

select is(
  (select outcome from app_private.seller_verification_submit('d0000000-0000-4000-8000-000000000001')),
  'not_editable', 'it cannot be submitted twice');
select is(
  (select outcome from app_private.seller_verification_submit('d0000000-0000-4000-8000-000000000008')),
  'not_editable', 'an attempt under review cannot be submitted');
select is(
  (select outcome from app_private.seller_verification_submit('d0000000-0000-4000-8000-000000000002')),
  'not_found', 'a storefront with no attempt has nothing to submit');
select is(
  (select outcome from app_private.seller_verification_submit('d0000000-0000-4000-8000-000000000004')),
  'not_editable', 'a suspended seller cannot submit');
select is(
  (select outcome from app_private.seller_verification_submit('d0000000-0000-4000-8000-000000000005')),
  'not_editable', 'nor a closed one');
select is(
  (select outcome from app_private.seller_verification_submit('d0000000-0000-4000-8000-000000000006')),
  'not_found', 'nor an account with no storefront');
select is(
  (select outcome from app_private.seller_verification_submit(null)),
  'not_found', 'nor a caller with no id');

-- Documents stay attachable after submission, which is 0009's rule and the reason no minimum is needed.
select is(
  (select outcome from app_private.seller_verification_document_target(
    'd0000000-0000-4000-8000-000000000001', 'bank_statement', 'application/pdf', 100)),
  'authorized', 'a submitted attempt still authorizes an upload');
select is(
  (select outcome from app_private.seller_verification_document_attach(
    'd0000000-0000-4000-8000-000000000001', 'bank_statement',
    (select object_path from app_private.seller_verification_document_target(
      'd0000000-0000-4000-8000-000000000001', 'bank_statement', 'application/pdf', 100)),
    'b.pdf', 'application/pdf', 100)),
  'attached', 'and still records one, which is 0009''s own RLS rule for a submitted attempt');
select is(
  (select outcome from app_private.seller_verification_document_remove(
    'd0000000-0000-4000-8000-000000000001',
    (select d.id from public.seller_verification_documents d
      join public.seller_verifications v on v.id = d.verification_id
      where v.seller_user_id = 'd0000000-0000-4000-8000-000000000001'
        and d.document_type = 'bank_statement'))),
  'removed', 'and still allows removal, which owner decision 3 permits while submitted');

-- Owner decision 1, stated as its own case.
select is(
  (select outcome from app_private.seller_verification_start('d0000000-0000-4000-8000-000000000002')),
  'created', 'a second storefront starts an attempt');
select is(
  (select count(*) from public.seller_verification_documents d
    join public.seller_verifications v on v.id = d.verification_id
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000002'),
  0::bigint, 'with no documents at all');
select is(
  (select outcome from app_private.seller_verification_submit('d0000000-0000-4000-8000-000000000002')),
  'submitted',
  'and submits: there is no minimum document count, because the schema imposes none (owner decision 1)');
select is(
  (select v.email_verified_at from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000002'),
  null::timestamptz,
  'an account with no confirmed email records none: the timestamp is the server''s fact, not a claim');
select is(
  (select v.phone_verified_at from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000002'),
  null::timestamptz, 'and the same for the phone');
select is(
  (select v.status from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000002'),
  'submitted',
  'the attempt is submitted even so: whether the evidence suffices is the reviewer''s judgement');

-- ---------------------------------------------------------------------------------------------------
-- A seller can never reach a decision
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.seller_verifications v
    where v.seller_user_id in ('d0000000-0000-4000-8000-000000000001',
                               'd0000000-0000-4000-8000-000000000002',
                               'd0000000-0000-4000-8000-000000000007')
      and v.status not in ('draft', 'submitted', 'rejected')),
  0::bigint,
  'every attempt these functions touched is a draft or a submission; the rejected one was pre-existing');
select is(
  (select count(*) from public.seller_verifications v
    where v.status in ('approved', 'under_review', 'expired')
      and v.id <> 'e0000000-0000-4000-8000-000000000002'),
  0::bigint,
  'nothing was approved, moved into review or expired by anything here');
select is(
  (select count(*) from public.seller_profiles s where s.verification_status = 'verified'
     and s.user_id <> 'd0000000-0000-4000-8000-000000000003'),
  0::bigint,
  'and no storefront became verified: the pre-existing verified one is the only one');
select is(
  (select count(*) from public.seller_profiles s where s.status = 'active'
     and s.user_id <> 'd0000000-0000-4000-8000-000000000003'),
  0::bigint,
  'nor did any storefront become active: submitting activates nothing');
select is(
  (select count(*) from public.user_roles),
  0::bigint,
  'and no role was assigned');
select is(
  (select count(*) from public.seller_verification_documents d where d.status <> 'pending'
     and d.id not in ('f0000000-0000-4000-8000-000000000001',
                      'f0000000-0000-4000-8000-000000000003')),
  0::bigint,
  'every document these functions recorded is pending: a seller accepts and rejects nothing');

-- ---------------------------------------------------------------------------------------------------
-- The readback, and what it refuses to disclose
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_verification('d0000000-0000-4000-8000-000000000001')),
  'found', 'the seller sees their own attempt');
select is(
  (select status from app_private.seller_verification('d0000000-0000-4000-8000-000000000001')),
  'submitted', 'with its real status');
select is(
  (select email_verified from app_private.seller_verification('d0000000-0000-4000-8000-000000000001')),
  true, 'and the contact facts as booleans');
select is(
  (select phone_verified from app_private.seller_verification('d0000000-0000-4000-8000-000000000002')),
  false, 'true or false, never a timestamp');
select is(
  (select status from app_private.seller_verification('d0000000-0000-4000-8000-000000000003')),
  null::text,
  'a verified storefront with no attempt row still reads as none rather than inventing one');
select is(
  (select outcome from app_private.seller_verification('d0000000-0000-4000-8000-000000000003')),
  'none', 'which is the outcome that says so');
select is(
  (select status from app_private.seller_verification('d0000000-0000-4000-8000-000000000008')),
  'under_review',
  'a seller may read an attempt that is under review, even though they may not change it');
select is(
  (select jsonb_array_length(documents) from app_private.seller_verification(
    'd0000000-0000-4000-8000-000000000008')),
  1, 'including its documents');
select is(
  (select status from app_private.seller_verification('d0000000-0000-4000-8000-000000000010')),
  'rejected',
  'a storefront whose only attempt was rejected reads that attempt, decision and all');
select is(
  (select doc->>'status' from app_private.seller_verification(
     'd0000000-0000-4000-8000-000000000010') r, jsonb_array_elements(r.documents) as doc),
  'rejected',
  'and its own document''s status, which is a fact about its own document');
select is(
  (select count(*) from app_private.seller_verification('d0000000-0000-4000-8000-000000000010') r,
     jsonb_array_elements(r.documents) as doc
    where doc::text like '%internal note%'),
  0::bigint,
  'but never the review note on it: that is the reviewer''s, and it is not in the projection');
select is(
  (select count(*) from app_private.seller_verification('d0000000-0000-4000-8000-000000000010') r
    where r.documents::text like '%e0000000-0000-4000-8000-000000000003%'),
  0::bigint,
  'and the verification''s own id appears nowhere in the answer');
select is(
  (select count(*) from app_private.seller_verification('d0000000-0000-4000-8000-000000000010') r
    where r.documents::text like '%ver-shop-decided%'),
  0::bigint,
  'nor does the object path, or any fragment of it');

-- Which attempt is chosen when a storefront has two. Seller 7 has the pre-existing rejected attempt and
-- the draft started earlier in this file; the open one is preferred regardless of which is newer.
select is(
  (select count(*) from public.seller_verifications v
    where v.seller_user_id = 'd0000000-0000-4000-8000-000000000007'),
  2::bigint, 'the resubmitting storefront has two attempts');
select is(
  (select status from app_private.seller_verification('d0000000-0000-4000-8000-000000000007')),
  'draft',
  'and reads the open one, not the decided one: this pins the ordering so it cannot drift silently');
select is(
  (select document_count from app_private.seller_verification('d0000000-0000-4000-8000-000000000007')),
  0,
  'with the open attempt''s own document count, so the decided attempt''s document is not counted in');

-- ---------------------------------------------------------------------------------------------------
-- Audit: 0009's, unchanged
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from audit.audit_logs a
    where a.id > (select m.id from audit_mark m)
      and a.table_name = 'seller_verifications') > 0,
  'creating and submitting an attempt are audited, by 0009''s own trigger');
select is(
  (select count(*) from audit.audit_logs a
    where a.id > (select m.id from audit_mark m)
      and a.table_name = 'seller_verification_documents'),
  0::bigint,
  'the documents table is not audited, which is 0009''s design and not something 0063 changed');
select is(
  (select count(*) from audit.audit_logs a
    where a.id > (select m.id from audit_mark m)
      and (coalesce(a.new_values::text, '') || coalesce(a.old_values::text, '')) like '%illegible%'),
  0::bigint,
  'and no audit row this file produced carries a decision reason: the trigger redacts that column');
select is(
  (select count(*) from audit.audit_logs a
    where a.id > (select m.id from audit_mark m)
      and a.table_name = 'seller_verifications'
      and 'decision_reason' = any(a.changed_columns)),
  0::bigint,
  'nor names it among the changed columns, because nothing here changed it');
select throws_ok(
  $$ delete from audit.audit_logs where id = (select min(a.id) from audit.audit_logs a) $$,
  '23001', null,
  'the audit log is still append-only, so no trace of a submission can be erased afterwards');

-- No outbox event was fabricated.
select is(
  (select count(*) from public.outbox_events e where e.event_type like '%verification%'),
  0::bigint,
  'and no verification event was published: 0063 emits none, approved or rejected least of all');

select * from finish();
rollback;
