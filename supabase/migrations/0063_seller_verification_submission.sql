-- 0063 — The seller's own verification submission (Phase 6-I).
--
-- ---------------------------------------------------------------------------------------------------
-- What the survey found, and what it decided for this migration
-- ---------------------------------------------------------------------------------------------------
-- 0009 owns verification: the two tables, the six-name status vocabulary, the one-open-attempt index, the
-- constraints that make a decision structurally a reviewer's, the audit trigger and
-- `tg_apply_verification_decision`. 0012 owns the private bucket. **This migration adds no state, no status
-- and no second model.** It adds the seller-side submission writes S-10 approved, and the readback a seller
-- needs to use them.
--
-- **The seller's reachable state space is 0009's RLS, read literally.** Both self policies bound the seller
-- to `status in ('draft','submitted')` in USING *and* WITH CHECK, so a seller can reach exactly two of the
-- six statuses and cannot touch a row once it is `under_review`, `approved`, `rejected` or `expired`. Every
-- function below is narrower than that or equal to it; none is wider.
--
--   draft                      a new attempt, which is what `status`'s own default is
--   draft → submitted          the submission. 0009's name for "waiting for a reviewer"
--   under_review/approved/      not reachable from here at all: no function assigns them, none has a status
--   rejected/expired            parameter, and `reviewed_has_time` plus `reviewer_recorded` make
--                               `approved` and `rejected` impossible without a reviewer and a review time
--                               that nothing here can supply
--
-- **A decision remains solely the reviewer's.** `sellers.verification.review` plus `is_aal2()` gate 0009's
-- reviewer policies; `tg_apply_verification_decision` is not called, not modified and not imitated here. Its
-- `submitted` branch does move `seller_profiles.verification_status` from `unverified` to `pending` when this
-- migration's submit lands — that is the existing machinery reflecting a pending submission, guarded by
-- `where verification_status = 'unverified'` so it can never overwrite `verified` or `rejected`.
--
-- **Owner decisions ratified for 6-I, implemented exactly:**
--
--   1. **No minimum document count.** `draft → submitted` requires no document and no particular type. The
--      schema imposes none, the reviewer judges sufficiency, and nothing here invents a requirement. This is
--      also consistent with 0009 letting documents be attached while the attempt is already `submitted`.
--   2. **A verified seller is offered nothing.** `seller_verification_start` answers `already_verified` and
--      writes nothing when `seller_profiles.verification_status` is `verified`, so no second attempt exists
--      to be created. The one-open index would have permitted one; this refuses it.
--   3. **Document removal, draft and submitted only.** Enforced in the function below, which is *narrower*
--      than 0009's RLS: `seller_verification_documents_self_all` is `FOR ALL` with a USING clause that is not
--      status-restricted, so RLS alone would permit a seller to delete a document from an approved attempt.
--      Nothing reaches these tables through RLS on this path, and this function refuses it.
--
-- **The document taxonomy is 0009's**, exactly: `national_id`, `passport`, `commercial_register`, `tax_card`,
-- `bank_statement`, `other`. No type is invented, and no type is required.
--
-- **Storage is 0012's bucket, read rather than assumed.** `verification-documents`, private, whose
-- `file_size_limit` and `allowed_mime_types` are read from `storage.buckets` at call time — so the limits are
-- the bucket's own and cannot drift from a copy kept here. No second bucket, and no second storage model: the
-- established three-step flow (server-authorized target → browser upload → server confirmation) is 6-E's.
--
-- **Audit.** `seller_verifications` carries 0009's `audit.tg_record_change('decision_reason')`, so creating an
-- attempt and submitting one are both audited with the decision reason redacted. The documents table carries
-- no audit trigger and no append-only contract entry; that is 0009's design and this migration does not add
-- one. No verification event is emitted by anything here — there is no outbox row for a submission, and
-- nothing fabricates an approved or rejected event.

-- ---------------------------------------------------------------------------------------------------
-- The readback
-- ---------------------------------------------------------------------------------------------------
-- The seller's current attempt, and the documents on it. `outcome` distinguishes three things a surface acts
-- on differently: `not_found` (no storefront), `none` (a storefront that has never applied) and `found`.
--
-- The open attempt when there is one — the one-open index makes "open" singular — otherwise the most recent
-- decided one, so a seller can see that they are verified or that they were rejected.
--
-- **What is not returned.** No verification id, no seller id, no `reviewed_by`, no `reviewed_at`, no
-- `decision_reason`, no `expires_at`, no document `review_note`, no document reviewer and no `object_path`.
-- The two contact timestamps come back as booleans, because whether a contact is verified is what a surface
-- renders and when it happened is not. A document's own `status` *is* returned: it is the state of the
-- seller's own document, exactly as a seller reads their own listing's status, and it carries no note.
create or replace function app_private.seller_verification(p_user_id uuid)
returns table (
  outcome text,
  status text,
  submitted_at timestamptz,
  created_at timestamptz,
  email_verified boolean,
  phone_verified boolean,
  document_count integer,
  documents jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_status text;
  v_row public.seller_verifications;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text, null::timestamptz, null::timestamptz,
      null::boolean, null::boolean, null::integer, null::jsonb;
    return;
  end if;

  select s.status into v_seller_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_seller_status is null then
    return query select 'not_found'::text, null::text, null::timestamptz, null::timestamptz,
      null::boolean, null::boolean, null::integer, null::jsonb;
    return;
  end if;

  -- The open attempt first, then the newest decided one. `order by` does both in one pass: an open status
  -- sorts ahead of every other, and `created_at desc` breaks the rest.
  select * into v_row
    from public.seller_verifications v
   where v.seller_user_id = p_user_id
   order by (v.status in ('draft', 'submitted', 'under_review')) desc, v.created_at desc
   limit 1;

  if v_row.id is null then
    return query select 'none'::text, null::text, null::timestamptz, null::timestamptz,
      null::boolean, null::boolean, 0, '[]'::jsonb;
    return;
  end if;

  return query
    select 'found'::text,
           v_row.status,
           v_row.submitted_at,
           v_row.created_at,
           v_row.email_verified_at is not null,
           v_row.phone_verified_at is not null,
           (select count(*)::integer from public.seller_verification_documents d
             where d.verification_id = v_row.id),
           coalesce(
             (select jsonb_agg(
                       jsonb_build_object(
                         'id', d.id,
                         'documentType', d.document_type,
                         'originalFilename', d.original_filename,
                         'contentType', d.content_type,
                         'byteSize', d.byte_size::text,
                         'status', d.status,
                         'uploadedAt', d.uploaded_at
                       )
                       order by d.uploaded_at, d.id
                     )
                from public.seller_verification_documents d
               where d.verification_id = v_row.id),
             '[]'::jsonb);
end;
$$;
comment on function app_private.seller_verification(uuid) is
  'The calling seller''s current verification attempt and its documents: the open one when there is one, otherwise the most recently decided one. Carries no verification or seller identifier, no reviewer, no review time, no decision reason, no expiry and no object path; the two contact timestamps come back as booleans. A document''s own status is returned, its review note is not.';

-- ---------------------------------------------------------------------------------------------------
-- Start an attempt
-- ---------------------------------------------------------------------------------------------------
-- Outcomes: `created`, `exists` (one is already open — the one-open index says there can be only one),
-- `already_verified` (owner decision 2), `not_found` (no storefront), `not_editable` (suspended or closed).
--
-- `status` is not a parameter and is not assigned: the row takes 0009's own default, which is `draft`. There
-- is no `seller_user_id` parameter either — the owner is the caller.
create or replace function app_private.seller_verification_start(p_user_id uuid)
returns table (
  outcome text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_status text;
  v_verification_status text;
  v_open text;
  v_status text;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  select s.status, s.verification_status into v_seller_status, v_verification_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_seller_status is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text;
    return;
  end if;

  -- Owner decision 2: a verified storefront is not offered another attempt, and none is created for it.
  if v_verification_status = 'verified' then
    return query select 'already_verified'::text, null::text;
    return;
  end if;

  -- The one-open index would refuse a second open attempt with a unique violation; reading it first turns
  -- that into an outcome, and tells the caller which of their attempts is the live one.
  select v.status into v_open
    from public.seller_verifications v
   where v.seller_user_id = p_user_id
     and v.status in ('draft', 'submitted', 'under_review');

  if v_open is not null then
    return query select 'exists'::text, v_open;
    return;
  end if;

  begin
    insert into public.seller_verifications (seller_user_id)
    values (p_user_id)
    returning seller_verifications.status into v_status;
  exception
    when unique_violation then
      -- Two requests raced for the same storefront. The other won; this one reports what exists.
      return query select 'exists'::text, null::text;
      return;
    when check_violation or foreign_key_violation or restrict_violation then
      return query select 'invalid'::text, null::text;
      return;
  end;

  return query select 'created'::text, v_status;
end;
$$;
comment on function app_private.seller_verification_start(uuid) is
  'Opens one verification attempt for the calling seller, always in 0009''s own default status of draft. Takes no status and no owner: neither is expressible. A storefront that already has an open attempt answers exists, one that is already verified answers already_verified and nothing is written (owner decision 2), and a suspended or closed one is refused without a reason.';

-- ---------------------------------------------------------------------------------------------------
-- Where a document may be uploaded
-- ---------------------------------------------------------------------------------------------------
-- The first step of the established three-step flow. Outcomes: `authorized`, `not_found` (no storefront or
-- no open attempt), `not_editable` (the storefront, or an attempt that is no longer the seller's to add to),
-- `invalid` (a type, content type or size the schema or the bucket refuses).
--
-- Every component of the returned path is the server's: the bucket name, the caller's own slug, the document
-- type this function validated against 0009's own list, a fresh random name and an extension derived from the
-- validated content type. **Nothing from the request appears in the path**, which is what makes traversal and
-- cross-seller paths unexpressible rather than merely refused. The verification's id is deliberately not in
-- the path either, so the path discloses no identifier even while it travels to the browser for the upload.
create or replace function app_private.seller_verification_document_target(
  p_user_id uuid,
  p_document_type text,
  p_content_type text,
  p_byte_size bigint
) returns table (
  outcome text,
  bucket_id text,
  object_path text,
  max_byte_size bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_slug text;
  v_seller_status text;
  v_verification_status text;
  v_bucket text := 'verification-documents';
  v_limit bigint;
  v_allowed text[];
  v_extension text;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text, null::text, null::bigint;
    return;
  end if;

  select s.slug, s.status into v_slug, v_seller_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_slug is null then
    return query select 'not_found'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- 0009's RLS admits document writes while the parent is `draft` or `submitted`, and this is that rule.
  select v.status into v_verification_status
    from public.seller_verifications v
   where v.seller_user_id = p_user_id
     and v.status in ('draft', 'submitted');

  if v_verification_status is null then
    -- Either no attempt at all, or one that is no longer the seller's to add to. One answer for both.
    return query select 'not_found'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- 0009's own document taxonomy, and nothing else is uploadable through this function.
  if p_document_type is null or p_document_type not in
     ('national_id', 'passport', 'commercial_register', 'tax_card', 'bank_statement', 'other') then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- The bucket is the authority on what may be stored in it, read at call time rather than copied here.
  select b.file_size_limit, b.allowed_mime_types into v_limit, v_allowed
    from storage.buckets b
   where b.id = v_bucket;

  if v_limit is null or v_allowed is null then
    -- The bucket is missing or misconfigured. Authorizing an upload into a bucket whose rules cannot be read
    -- would be authorizing an unbounded one.
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  if p_content_type is null or not (p_content_type = any (v_allowed)) then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_limit then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- The extension follows from the content type, so the stored name cannot disagree with what was declared.
  v_extension := case p_content_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'application/pdf' then 'pdf'
  end;
  if v_extension is null then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  return query select
    'authorized'::text,
    v_bucket,
    v_bucket || '/' || v_slug || '/' || p_document_type || '/' || gen_random_uuid()::text || '.' || v_extension,
    v_limit;
end;
$$;
comment on function app_private.seller_verification_document_target(uuid, text, text, bigint) is
  'Authorizes one verification document upload for the calling seller and returns the object path the server composed. The bucket, the caller''s own slug, the validated document type, a fresh random name and an extension derived from the validated content type are all the server''s: nothing from the request appears in the path, and neither does any identifier. The type list is 0009''s; the size and MIME limits are read from storage.buckets at call time. Requires an attempt in draft or submitted, which is 0009''s own RLS rule for writing a document.';

-- ---------------------------------------------------------------------------------------------------
-- Record a document that was uploaded
-- ---------------------------------------------------------------------------------------------------
-- Outcomes: `attached`, `not_found`, `not_editable`, `invalid` (a type, a path that is not one this server
-- issued, or a size or content type the bucket refuses), `path_taken` (that object is already recorded).
create or replace function app_private.seller_verification_document_attach(
  p_user_id uuid,
  p_document_type text,
  p_object_path text,
  p_original_filename text,
  p_content_type text,
  p_byte_size bigint
) returns table (
  outcome text,
  document_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_slug text;
  v_seller_status text;
  v_verification_id uuid;
  v_bucket text := 'verification-documents';
  v_limit bigint;
  v_allowed text[];
  v_expected_prefix text;
  v_tail text;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::integer;
    return;
  end if;

  select s.slug, s.status into v_slug, v_seller_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_slug is null then
    return query select 'not_found'::text, null::integer;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::integer;
    return;
  end if;

  select v.id into v_verification_id
    from public.seller_verifications v
   where v.seller_user_id = p_user_id
     and v.status in ('draft', 'submitted');

  if v_verification_id is null then
    return query select 'not_found'::text, null::integer;
    return;
  end if;

  if p_document_type is null or p_document_type not in
     ('national_id', 'passport', 'commercial_register', 'tax_card', 'bank_statement', 'other') then
    return query select 'invalid'::text, null::integer;
    return;
  end if;

  select b.file_size_limit, b.allowed_mime_types into v_limit, v_allowed
    from storage.buckets b
   where b.id = v_bucket;

  if v_limit is null or v_allowed is null then
    return query select 'invalid'::text, null::integer;
    return;
  end if;
  if p_content_type is null or not (p_content_type = any (v_allowed)) then
    return query select 'invalid'::text, null::integer;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_limit then
    return query select 'invalid'::text, null::integer;
    return;
  end if;

  -- The prefix is rebuilt from the caller's own slug and the validated type. A path for another seller, for
  -- another type, for another bucket, or with anything before the prefix, cannot match it.
  v_expected_prefix := v_bucket || '/' || v_slug || '/' || p_document_type || '/';
  if p_object_path is null or left(p_object_path, length(v_expected_prefix)) <> v_expected_prefix then
    return query select 'invalid'::text, null::integer;
    return;
  end if;

  -- And the remainder must be one plain file name of the shape the target issues: a uuid and one of the three
  -- extensions. No slash, so nothing can be nested below the namespace; no dot-segment, so `..` is
  -- unrepresentable; no control character, no backslash, no encoded separator.
  v_tail := substr(p_object_path, length(v_expected_prefix) + 1);
  if v_tail !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf)$' then
    return query select 'invalid'::text, null::integer;
    return;
  end if;

  -- `status` is not assigned: the row takes 0009's own default of `pending`, and there is no parameter for
  -- it. `review_note`, `reviewed_at` and `reviewed_by` appear in no column list here, so a seller cannot
  -- write a reviewer's field even by accident.
  begin
    insert into public.seller_verification_documents (
      verification_id, document_type, object_path, original_filename, content_type, byte_size
    ) values (
      v_verification_id,
      p_document_type,
      p_object_path,
      nullif(btrim(coalesce(p_original_filename, '')), ''),
      p_content_type,
      p_byte_size
    );
  exception
    when unique_violation then
      -- `seller_verification_documents_path` is unique across the table: that object is already recorded.
      -- Which attempt it belongs to is not disclosed.
      return query select 'path_taken'::text, null::integer;
      return;
    when check_violation or foreign_key_violation or restrict_violation then
      return query select 'invalid'::text, null::integer;
      return;
  end;

  return query select 'attached'::text,
    (select count(*)::integer from public.seller_verification_documents d
      where d.verification_id = v_verification_id);
end;
$$;
comment on function app_private.seller_verification_document_attach(uuid, text, text, text, text, bigint) is
  'Records an uploaded verification document against the calling seller''s open attempt. The path must lie in the caller''s own namespace and match the exact shape seller_verification_document_target issues, so another seller''s object, a nested path and any traversal are all unrepresentable. Requires an attempt in draft or submitted. status takes 0009''s default of pending and has no parameter; review_note, reviewed_at and reviewed_by appear in no column list. Answers with the number of documents on the attempt, never with a path.';

-- ---------------------------------------------------------------------------------------------------
-- Remove a document
-- ---------------------------------------------------------------------------------------------------
-- Owner decision 3, and **narrower than 0009's RLS on purpose**: that policy is `FOR ALL` with a USING clause
-- that is not status-restricted, so RLS alone would let a seller delete a document from an approved attempt.
-- This function admits `draft` and `submitted` and nothing else.
--
-- The document is named by its own id. That is the row's own identity, it belongs to the caller, the
-- statement is scoped by the caller's ownership anyway, and it is the only stable handle a document has —
-- 0009 gives it no slug, and its object path is private. No *seller* or *verification* identifier appears in
-- this signature or in any answer.
--
-- Outcomes: `removed`, `not_found` (no storefront, no open attempt, or no such document of the caller's),
-- `not_editable` (the storefront).
create or replace function app_private.seller_verification_document_remove(
  p_user_id uuid,
  p_document_id uuid
) returns table (
  outcome text,
  document_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_status text;
  v_verification_id uuid;
  v_removed uuid;
begin
  if p_user_id is null or p_document_id is null then
    return query select 'not_found'::text, null::integer;
    return;
  end if;

  select s.status into v_seller_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_seller_status is null then
    return query select 'not_found'::text, null::integer;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::integer;
    return;
  end if;

  -- Only an attempt the seller may still change. An `under_review`, `approved`, `rejected` or `expired`
  -- attempt does not match, so its documents are not reachable from here at all.
  select v.id into v_verification_id
    from public.seller_verifications v
   where v.seller_user_id = p_user_id
     and v.status in ('draft', 'submitted');

  if v_verification_id is null then
    return query select 'not_found'::text, null::integer;
    return;
  end if;

  -- Scoped by the attempt that was just resolved from the caller's own ownership, so a document id belonging
  -- to another seller matches nothing and answers exactly as one that does not exist.
  delete from public.seller_verification_documents as d
   where d.id = p_document_id
     and d.verification_id = v_verification_id
  returning d.id into v_removed;

  if v_removed is null then
    return query select 'not_found'::text, null::integer;
    return;
  end if;

  return query select 'removed'::text,
    (select count(*)::integer from public.seller_verification_documents d
      where d.verification_id = v_verification_id);
end;
$$;
comment on function app_private.seller_verification_document_remove(uuid, uuid) is
  'Removes one of the calling seller''s own verification documents, and only while the attempt is draft or submitted (owner decision 3). Deliberately narrower than 0009''s RLS, whose FOR ALL policy has an unrestricted USING clause and would otherwise permit deleting a document from an approved attempt. The delete is scoped by the attempt resolved from the caller''s own ownership, so another seller''s document id answers exactly as one that does not exist.';

-- ---------------------------------------------------------------------------------------------------
-- Submit for review
-- ---------------------------------------------------------------------------------------------------
-- `draft → submitted`, with `submitted_at`, which `seller_verifications_submitted_has_time` requires of
-- anything that is not a draft.
--
-- **No document is required** (owner decision 1): the schema imposes no minimum, the reviewer judges whether
-- the evidence is sufficient, and nothing here invents a requirement.
--
-- The two contact timestamps are taken from `auth.users` — the server's own record of which contacts this
-- account has confirmed — and never from a request. They exist because
-- `seller_verifications_approval_needs_contacts` requires both before a reviewer may approve; recording them
-- at submission is the seller supplying evidence, not a decision. Nothing else about the review is touched:
-- `reviewed_at`, `reviewed_by` and `decision_reason` appear in no assignment, and the constraints would
-- refuse `approved` or `rejected` without them in any case.
--
-- Outcomes: `submitted`, `not_found`, `not_editable` (the storefront, or an attempt that is not a draft).
create or replace function app_private.seller_verification_submit(p_user_id uuid)
returns table (
  outcome text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_status text;
  v_verification_id uuid;
  v_verification_status text;
  v_email_at timestamptz;
  v_phone_at timestamptz;
  v_status text;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  select s.status into v_seller_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_seller_status is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text;
    return;
  end if;

  select v.id, v.status into v_verification_id, v_verification_status
    from public.seller_verifications v
   where v.seller_user_id = p_user_id
     and v.status in ('draft', 'submitted', 'under_review')
     for update;

  if v_verification_id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  if v_verification_status <> 'draft' then
    -- Already submitted, or already with a reviewer. Either way it is not the seller's to submit again.
    return query select 'not_editable'::text, null::text;
    return;
  end if;

  -- The account's own confirmed contacts, from the server's record of them.
  select u.email_confirmed_at, u.phone_confirmed_at into v_email_at, v_phone_at
    from auth.users u
   where u.id = p_user_id;

  begin
    update public.seller_verifications as v
       set status = 'submitted',
           submitted_at = now(),
           email_verified_at = v_email_at,
           phone_verified_at = v_phone_at
     where v.id = v_verification_id
       and v.seller_user_id = p_user_id
       and v.status = 'draft'
    returning v.status into v_status;
  exception
    when check_violation or restrict_violation or foreign_key_violation then
      return query select 'invalid'::text, null::text;
      return;
  end;

  if v_status is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  return query select 'submitted'::text, v_status;
end;
$$;
comment on function app_private.seller_verification_submit(uuid) is
  'Moves the calling seller''s draft verification to submitted and records submitted_at. Requires no document and no particular document type (owner decision 1): the schema imposes no minimum and the reviewer judges sufficiency. The two contact timestamps are read from auth.users, never from a request, because approval_needs_contacts requires them of a reviewer later. Assigns no reviewed_at, reviewed_by or decision_reason, so approved and rejected remain structurally unreachable; 0009''s tg_apply_verification_decision then reflects the pending submission onto the profile, guarded so it can never overwrite verified or rejected.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- S8 unchanged: named functions, PUBLIC revoked, `app_system` only. `authenticated` gains nothing, no table
-- privilege is granted anywhere by this migration, and 0009's six verification policies — the two self ones
-- and the four reviewer ones — stay exactly as they are as defence in depth beneath a path that no longer
-- goes through them.
revoke execute on function app_private.seller_verification(uuid) from public;
grant execute on function app_private.seller_verification(uuid) to app_system;
revoke execute on function app_private.seller_verification_start(uuid) from public;
grant execute on function app_private.seller_verification_start(uuid) to app_system;
revoke execute on function app_private.seller_verification_document_target(uuid, text, text, bigint) from public;
grant execute on function app_private.seller_verification_document_target(uuid, text, text, bigint) to app_system;
revoke execute on function app_private.seller_verification_document_attach(uuid, text, text, text, text, bigint)
  from public;
grant execute on function app_private.seller_verification_document_attach(uuid, text, text, text, text, bigint)
  to app_system;
revoke execute on function app_private.seller_verification_document_remove(uuid, uuid) from public;
grant execute on function app_private.seller_verification_document_remove(uuid, uuid) to app_system;
revoke execute on function app_private.seller_verification_submit(uuid) from public;
grant execute on function app_private.seller_verification_submit(uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
