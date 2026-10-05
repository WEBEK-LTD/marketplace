-- 0069 — The reviewer's side of seller verification (Phase 7-G).
--
-- ---------------------------------------------------------------------------------------------------
-- What the survey found, and what it decided for this migration
-- ---------------------------------------------------------------------------------------------------
-- **No table, column, constraint, index, trigger, policy, role, permission or role-permission
-- assignment is created or changed here.** 0009 owns the verification model; 0033 owns the permission
-- and who holds it; 0063 owns the seller's own submission. All three are read, none is rewritten.
--
-- **Where the existing decision path actually is.** It is not a function. 0009 made a verification
-- decision *structurally* an UPDATE on `public.seller_verifications` guarded by its own CHECK
-- constraints, with two triggers hanging off it:
--
--   * `seller_verifications_reviewed_has_time` — `(status in ('approved','rejected')) = (reviewed_at is
--     not null)`, so a decision without a time is impossible and a time without a decision is too;
--   * `seller_verifications_reviewer_recorded` — a review time requires a `reviewed_by`;
--   * `seller_verifications_rejection_has_reason` — `rejected` requires a non-blank `decision_reason`;
--   * `seller_verifications_approval_needs_contacts` — `approved` requires both contact timestamps;
--   * `app_private.tg_apply_verification_decision` — AFTER INSERT OR UPDATE OF status, which is what
--     moves `seller_profiles.verification_status` to `verified`/`rejected`/`pending` and sets
--     `verified_at`. **This migration does not call it, modify it or imitate it.** It fires because a
--     row's status changed, exactly as it does today;
--   * `audit.tg_record_change('decision_reason')` — which records the change with the reason redacted.
--
-- So "consume the existing decision path" means: perform that one UPDATE, set exactly the four columns
-- 0009 made load-bearing, and let the constraints and both triggers do the rest. `verification_review_decide`
-- below is that UPDATE and nothing more. It introduces no status value, no column, no second state
-- machine and no second audit event.
--
-- **Why any function is needed at all.** 0009's reviewer policies already express the whole
-- authorization rule:
--
--     create policy seller_verifications_reviewer_read  ... using (public.has_permission('sellers.verification.review'));
--     create policy seller_verifications_reviewer_update ... using (public.has_permission('sellers.verification.review') and public.is_aal2());
--
-- Both resolve the caller through `app_private.jwt_claims()`. Under the approved architecture the admin
-- application reaches the database only through the API, which connects as `app_system` — not
-- `authenticated`, carrying no claims — so both helpers answer false for every account on that path.
-- These are their `app_system` counterparts, exactly as 0066, 0067 and 0068 were for their surfaces. The
-- originals keep their grants and are untouched, and `authenticated` gains nothing here.
--
-- **The permission rule is not restated; it is the same expression.** `public.has_permission` counts a
-- role only when `not r.requires_mfa or public.is_aal2()`. `verification_reviewer_can_review` below uses
-- `not r.requires_mfa or p_is_aal2` over the same three tables, with the assurance level passed in rather
-- than read from a claim this connection does not have — the identical predicate 0068 uses. The key it
-- asks about is written into the function body, so no caller can ask it about a different permission.
--
-- Note what that means for AAL2, and why nothing extra is needed to enforce it: 0003's
-- `roles_console_requires_mfa` CHECK makes `requires_mfa` true for *every* `is_admin_console` role, so a
-- staff account at aal1 holds no permission at all here — including this one. The assurance requirement
-- on 0009's reviewer UPDATE policy is therefore already inside the permission test, and it is applied to
-- reads as well as writes below, which is **narrower** than 0009 (whose reviewer read policy does not
-- name `is_aal2()` separately, for the same reason).
--
-- **Who holds the permission is read, never changed.** As this repository stands, 0033 grants
-- `sellers.verification.review` to `admin` and `super_admin` only; `moderator` and `support_agent` do not
-- hold it. Nothing in this migration grants, assigns or widens it — the functions only ask.
--
-- **Least privilege in what comes back.** The queue and the detail return what a reviewer must see to
-- decide and nothing else. `seller_user_id` is never returned: an account id is not needed to review an
-- application, and returning one would put another person's identifier into an admin browser. Likewise a
-- document's `object_path` never leaves the database on a read — it is a capability inside a private
-- bucket. It is returned by exactly one function, `verification_review_document`, which takes a *document
-- id* and hands the path back to the API for signing; there is no function here that accepts a path, so
-- there is nothing for a reviewer to supply an arbitrary one to.
--
-- **Ordering is the schema's.** 0009 created `seller_verifications_queue on (status, submitted_at)`, so
-- the queue filters on status and orders by `submitted_at`, oldest first, with `id` breaking ties into a
-- total order for keyset pagination. Every row this queue can return is non-draft, and
-- `seller_verifications_submitted_has_time` guarantees a non-null `submitted_at` for those, so the
-- ordering has no null to fall over. **No priority, score, SLA or ranking is invented**, and drafts are
-- excluded deliberately: a draft is an application the seller has not submitted, and a review queue is
-- of submissions.
--
-- **Not here, deliberately.** No per-document decision: 0009's `seller_verification_documents.status`,
-- `review_note`, `reviewed_at` and `reviewed_by` exist, but 7-G's approved scope is the verification
-- decision, and writing a document status is a workflow nobody has specified. No transition into
-- `under_review` — this migration accepts a row that is already in it and never moves one there, because
-- claiming a case is a workflow, not a scope item. No `expired` transition: nothing here writes that
-- status, and a row already in it is simply not decidable.

-- ---------------------------------------------------------------------------------------------------
-- The one authorization predicate
-- ---------------------------------------------------------------------------------------------------
-- `public.has_permission('sellers.verification.review')`, for a caller the connection cannot see.
--
-- The key is a literal in the body rather than a parameter: this function answers exactly one question,
-- so nothing that can call it can use it to enumerate the permission model.
create or replace function app_private.verification_reviewer_can_review(
  p_user_id uuid,
  p_is_aal2 boolean
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
      join public.role_permissions rp on rp.role_key = r.key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
       and rp.permission_key = 'sellers.verification.review'
       -- 0003's own rule, with the assurance level supplied instead of read from a JWT claim.
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.verification_reviewer_can_review(uuid, boolean) is
  'Whether one account currently holds sellers.verification.review, under 0003''s own requires_mfa rule with the assurance level supplied by the API rather than read from a JWT claim this connection does not have. The app_system counterpart of public.has_permission(''sellers.verification.review''); the key is fixed in the body so this cannot be used to ask about any other permission. Grants nothing.';

-- ---------------------------------------------------------------------------------------------------
-- The queue
-- ---------------------------------------------------------------------------------------------------
-- One page of submissions, oldest first.
--
-- An unauthorized caller gets **no rows**, which is indistinguishable from an empty queue — the same
-- choice the rest of this project makes everywhere (a row somebody may not see is never matched rather
-- than refused, so asking cannot confirm that it is there). The API refuses such a caller before it ever
-- gets here; this is the second lock, not the first.
--
-- `p_status` is either null — the two statuses that are actually awaiting a decision — or exactly one of
-- the five non-draft statuses, so a reviewer can look back at what was decided. Anything else, including
-- `draft`, returns nothing.
create or replace function app_private.verification_review_queue(
  p_reviewer_id uuid,
  p_is_aal2 boolean,
  p_status text default null,
  p_limit integer default 20,
  p_cursor_submitted_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  status text,
  submitted_at timestamptz,
  created_at timestamptz,
  reviewed_at timestamptz,
  email_verified boolean,
  phone_verified boolean,
  document_count integer,
  seller_slug text,
  seller_display_name text,
  seller_status text,
  seller_verification_status text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select v.id,
         v.status,
         v.submitted_at,
         v.created_at,
         v.reviewed_at,
         v.email_verified_at is not null,
         v.phone_verified_at is not null,
         (select count(*)::integer from public.seller_verification_documents d
           where d.verification_id = v.id),
         s.slug,
         s.display_name,
         s.status,
         s.verification_status
    from public.seller_verifications v
    join public.seller_profiles s on s.user_id = v.seller_user_id
   where app_private.verification_reviewer_can_review(p_reviewer_id, p_is_aal2)
     and (
       case
         when p_status is null then v.status in ('submitted', 'under_review')
         when p_status in ('submitted', 'under_review', 'approved', 'rejected', 'expired')
           then v.status = p_status
         else false
       end
     )
     and (
       p_cursor_submitted_at is null
       or p_cursor_id is null
       or (v.submitted_at, v.id) > (p_cursor_submitted_at, p_cursor_id)
     )
   order by v.submitted_at asc, v.id asc
   -- 51 rather than 50: the contract's largest page is 50, and the API asks for one more than the page
   -- it will return so it can tell whether there is a next one. Clamped here regardless of what is
   -- asked for, so an unbounded read is not reachable through this function.
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.verification_review_queue(uuid, boolean, text, integer, timestamptz, uuid) is
  'One page of seller verification submissions for an authorized reviewer, ordered by 0009''s own queue index (status, submitted_at) oldest first with id breaking ties. Drafts are never returned and no account id is. An unauthorized caller gets no rows, indistinguishable from an empty queue. Reads only; invents no priority, score or SLA.';

-- ---------------------------------------------------------------------------------------------------
-- One submission, in full
-- ---------------------------------------------------------------------------------------------------
-- What a reviewer needs in front of them to decide: the application's own state, the storefront identity
-- the evidence has to agree with, and the documents' metadata.
--
-- `outcome` is `found` or `not_found`, and `not_found` covers both "no such verification" and "you may
-- not review", deliberately identically.
--
-- **No `object_path` is in the documents array.** A reviewer's browser receives document *ids*; the path
-- is fetched, for one document at a time, by `verification_review_document` below.
create or replace function app_private.verification_review_detail(
  p_reviewer_id uuid,
  p_is_aal2 boolean,
  p_verification_id uuid
) returns table (
  outcome text,
  id uuid,
  status text,
  submitted_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  reviewed_at timestamptz,
  decision_reason text,
  expires_at timestamptz,
  email_verified boolean,
  phone_verified boolean,
  seller_slug text,
  seller_display_name text,
  seller_legal_name text,
  seller_country_code text,
  seller_governorate text,
  seller_city text,
  seller_contact_email text,
  seller_contact_phone text,
  seller_status text,
  seller_verification_status text,
  seller_created_at timestamptz,
  documents jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.seller_verifications;
  v_seller public.seller_profiles;
begin
  if p_verification_id is null
     or not app_private.verification_reviewer_can_review(p_reviewer_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::text, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::text, null::timestamptz, null::boolean, null::boolean,
      null::text, null::text, null::text, null::text, null::text, null::text, null::text, null::text,
      null::text, null::text, null::timestamptz, null::jsonb;
    return;
  end if;

  select * into v_row from public.seller_verifications v where v.id = p_verification_id;
  if v_row.id is null or v_row.status = 'draft' then
    -- A draft is not a submission, and the queue cannot show one either.
    return query select 'not_found'::text, null::uuid, null::text, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::text, null::timestamptz, null::boolean, null::boolean,
      null::text, null::text, null::text, null::text, null::text, null::text, null::text, null::text,
      null::text, null::text, null::timestamptz, null::jsonb;
    return;
  end if;

  select * into v_seller from public.seller_profiles s where s.user_id = v_row.seller_user_id;

  return query select
    'found'::text,
    v_row.id,
    v_row.status,
    v_row.submitted_at,
    v_row.created_at,
    v_row.updated_at,
    v_row.reviewed_at,
    v_row.decision_reason,
    v_row.expires_at,
    v_row.email_verified_at is not null,
    v_row.phone_verified_at is not null,
    v_seller.slug,
    v_seller.display_name,
    v_seller.legal_name,
    v_seller.country_code::text,
    v_seller.governorate,
    v_seller.city,
    v_seller.contact_email::text,
    v_seller.contact_phone_e164,
    v_seller.status,
    v_seller.verification_status,
    v_seller.created_at,
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
                order by d.uploaded_at asc, d.id asc)
         from public.seller_verification_documents d
        where d.verification_id = v_row.id),
      '[]'::jsonb
    );
end;
$$;

comment on function app_private.verification_review_detail(uuid, boolean, uuid) is
  'One seller verification submission for an authorized reviewer: its own state, the storefront identity the evidence must agree with, and its documents'' metadata. Returns not_found for a verification that does not exist, for a draft, and for a caller who may not review — the three are deliberately indistinguishable. No account id and no storage object path is ever in the result.';

-- ---------------------------------------------------------------------------------------------------
-- One document's storage location
-- ---------------------------------------------------------------------------------------------------
-- **This is the whole of the reviewer read path's access control, and it is why a reviewer cannot reach
-- another seller's object.** The only thing a caller supplies is a document id. The bucket and the object
-- path come *out* of the row that id names — the same path `seller_verification_document_target`
-- composed in 0063 from the seller's own slug — so there is no input here that a path could be smuggled
-- through, and the API above has no other way to learn one.
--
-- `not_found` again covers "no such document", "its verification is a draft" and "you may not review".
create or replace function app_private.verification_review_document(
  p_reviewer_id uuid,
  p_is_aal2 boolean,
  p_document_id uuid
) returns table (
  outcome text,
  verification_id uuid,
  bucket_id text,
  object_path text,
  content_type text,
  original_filename text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_document_id uuid;
  v_verification_id uuid;
  v_object_path text;
  v_content_type text;
  v_original_filename text;
begin
  if p_document_id is null
     or not app_private.verification_reviewer_can_review(p_reviewer_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  select d.id, d.verification_id, d.object_path, d.content_type, d.original_filename
    into v_document_id, v_verification_id, v_object_path, v_content_type, v_original_filename
    from public.seller_verification_documents d
    join public.seller_verifications v on v.id = d.verification_id
   where d.id = p_document_id
     and v.status <> 'draft';

  if v_document_id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  return query select
    'authorized'::text,
    v_verification_id,
    -- 0012's bucket, named by 0063 when the object was authorized. Read, not composed.
    'verification-documents'::text,
    v_object_path,
    v_content_type,
    v_original_filename;
end;
$$;

comment on function app_private.verification_review_document(uuid, boolean, uuid) is
  'The bucket and object path of one verification document, for an authorized reviewer, looked up by document id. The path comes out of the row and is never supplied by the caller, so a reviewer cannot name an arbitrary object. Returns not_found for a document that does not exist, one whose verification is still a draft, and a caller who may not review.';

-- ---------------------------------------------------------------------------------------------------
-- The decision
-- ---------------------------------------------------------------------------------------------------
-- **The existing decision path, performed and not reimplemented.** One UPDATE, four columns — the exact
-- four 0009's constraints make load-bearing — and then 0009's own machinery runs: the CHECKs validate the
-- combination, `tg_apply_verification_decision` propagates it to `seller_profiles`, and
-- `audit.tg_record_change('decision_reason')` records it with the reason redacted. Nothing here writes to
-- `seller_profiles`, emits an event, or records an audit row of its own.
--
-- The row is locked before it is examined, so two reviewers deciding at the same moment serialize: the
-- first wins and the second sees the status the first left behind and answers `conflict`. The UPDATE is
-- also guarded by the same status predicate, so a repeated decision changes nothing.
--
--   outcome            meaning
--   -----------------  ----------------------------------------------------------------------------
--   decided            the UPDATE happened; `status` is what the row now holds
--   not_found          no such verification, a draft, or a caller who may not review
--   conflict           the row is not in a state this path decides from; `status` is its current one
--   reason_required    `rejected` without a reason, which 0009's own CHECK would refuse anyway
--   contacts_unverified  `approved` before both contact verifications, which 0009's CHECK refuses
--   invalid            `p_decision` is not one of the two decisions this path can make
create or replace function app_private.verification_review_decide(
  p_reviewer_id uuid,
  p_is_aal2 boolean,
  p_verification_id uuid,
  p_decision text,
  p_reason text default null
) returns table (
  outcome text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.seller_verifications;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_verification_id is null
     or not app_private.verification_reviewer_can_review(p_reviewer_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- Only the two decisions the reviewer surface makes. No other status is reachable from this function:
  -- `draft` and `submitted` belong to the seller (0063), `under_review` is not claimed here, and
  -- `expired` is nobody's to set from a review screen.
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  select * into v_row from public.seller_verifications v where v.id = p_verification_id for update;

  if v_row.id is null or v_row.status = 'draft' then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- Already decided, or expired: the existing model has no transition out of those from a review screen.
  if v_row.status not in ('submitted', 'under_review') then
    return query select 'conflict'::text, v_row.status;
    return;
  end if;

  -- 0009's `seller_verifications_rejection_has_reason`, answered as an outcome rather than as a failed
  -- statement so the surface can ask for the field instead of showing an error.
  if p_decision = 'rejected' and v_reason is null then
    return query select 'reason_required'::text, v_row.status;
    return;
  end if;

  -- 0009's `seller_verifications_approval_needs_contacts`, for the same reason.
  if p_decision = 'approved'
     and (v_row.email_verified_at is null or v_row.phone_verified_at is null) then
    return query select 'contacts_unverified'::text, v_row.status;
    return;
  end if;

  update public.seller_verifications v
     set status = p_decision,
         reviewed_at = now(),
         reviewed_by = p_reviewer_id,
         decision_reason = v_reason
   where v.id = p_verification_id
     and v.status in ('submitted', 'under_review');

  if not found then
    -- Lost to a concurrent decision between the lock and the write. Report what the row now says.
    select * into v_row from public.seller_verifications v where v.id = p_verification_id;
    return query select 'conflict'::text, v_row.status;
    return;
  end if;

  return query select 'decided'::text, p_decision;
end;
$$;

comment on function app_private.verification_review_decide(uuid, boolean, uuid, text, text) is
  'Records one seller verification decision by performing 0009''s own reviewer UPDATE: status, reviewed_at, reviewed_by and decision_reason, nothing else. The CHECK constraints, tg_apply_verification_decision and the audit trigger then do exactly what they already do. Locks the row, so a repeated or concurrent decision answers conflict rather than overwriting a decided one. Introduces no status value and no second state machine.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- The API role alone. `authenticated` gains nothing: it already has 0009's reviewer policies, which
-- resolve the caller from its own verified session, and a function that takes an account **and an
-- assurance level** as parameters must never be callable by something that could choose either.
revoke all on function app_private.verification_reviewer_can_review(uuid, boolean) from public;
revoke all on function app_private.verification_review_queue(uuid, boolean, text, integer, timestamptz, uuid) from public;
revoke all on function app_private.verification_review_detail(uuid, boolean, uuid) from public;
revoke all on function app_private.verification_review_document(uuid, boolean, uuid) from public;
revoke all on function app_private.verification_review_decide(uuid, boolean, uuid, text, text) from public;

grant execute on function app_private.verification_reviewer_can_review(uuid, boolean) to app_system;
grant execute on function app_private.verification_review_queue(uuid, boolean, text, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.verification_review_detail(uuid, boolean, uuid) to app_system;
grant execute on function app_private.verification_review_document(uuid, boolean, uuid) to app_system;
grant execute on function app_private.verification_review_decide(uuid, boolean, uuid, text, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
