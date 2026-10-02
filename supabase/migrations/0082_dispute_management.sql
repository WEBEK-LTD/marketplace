-- 0082 — Dispute management, the admin side (Phase 7-R).
--
-- Seven functions, no schema change, no new permission, no new status, no new resolution value, and **no new
-- writer for anything**. 0027 owns everything substantive: the disputes, the thread, the six statuses, the
-- four resolutions, and the three writers `open_dispute`, `post_dispute_message` and `resolve_dispute`.
--
-- ---------------------------------------------------------------------------------------------------
-- Why a migration is needed at all
-- ---------------------------------------------------------------------------------------------------
-- The same reason every admin increment has had one. 0027 defines the staff capability as row-level policies
-- for the `authenticated` database role:
--
--     disputes_staff_read              has_permission('disputes.dispute.read')
--     disputes_staff_write             has_permission('disputes.dispute.manage') and is_aal2()
--     dispute_messages_staff_read      has_permission('disputes.dispute.read')
--     dispute_evidence_staff_read      has_permission('disputes.dispute.read')
--
-- A policy for `authenticated` is a rule about a session carrying JWT claims. This application does not
-- connect that way: `app_system` is `noinherit`, holds no table privileges (0003, S8), and `withRlsContext`
-- is forbidden in production code. So each policy describes a capability authorized in the database and
-- reachable by nothing — until a named `app_private` function exists for it. The readers below are that, and
-- they add nothing those policies do not already permit: each restates 0003's own permission rule with the
-- assurance level as a parameter and the key as a **literal**.
--
-- **Read is gated at `aal2` here too.** The three read policies do not AND `is_aal2()` — only the write one
-- does — but both roles that hold either dispute key, `admin` and `super_admin`, are `requires_mfa` in 0033,
-- so the predicate's own `(not r.requires_mfa or p_is_aal2)` refuses staff at `aal1`. The same effective
-- outcome 7-G, 7-L, 7-N, 7-O, 7-P and 7-Q reach the same way, without strengthening or weakening a policy.
--
-- **Moderator holds neither key, by decision.** 0033 says so in as many words: "Disputes are a separate
-- responsibility and are deliberately not granted, so `disputes.dispute.read` and `disputes.dispute.manage`
-- are absent by decision, not by oversight." So this surface is Admin and Super Admin only, and a Moderator
-- reading it gets the same neutral answer a missing row produces.
--
-- ---------------------------------------------------------------------------------------------------
-- THE PHASE 7 / PHASE 8 BOUNDARY, AND WHERE IT IS ENFORCED
-- ---------------------------------------------------------------------------------------------------
-- **A resolution decides; it does not pay.** That is 0027's own sentence about its own writer, and it is the
-- whole reason dispute management can exist in Phase 7 at all:
--
--     'Records the decision and puts the order back where it was. A resolution decides; any money it implies
--      moves through the Refunds module, with its own record and its own capability checks.'
--
-- So `resolve_dispute` writes `public.disputes` and `public.orders.status` and nothing else. It touches no
-- ledger entry, no seller balance, no payout, no withdrawal, no `public.refunds` row, no
-- `public.payment_disputes` row and no provider. **Neither of those last two tables has a writer anywhere in
-- this repository** — Phase 8 is not merely out of scope here, it does not exist yet — so there is nothing
-- for this surface to reach even by accident.
--
-- **Nothing below adds one.** Each wrapper calls exactly one 0027 writer, passes the caller's account, and
-- translates the outcome. No function here writes a money table, and pgTAP asserts that by name for every
-- financial table in the schema.
--
-- **The order-status restoration is 0027's, not this migration's.** `resolve_dispute` sets
-- `orders.status = order_status_before`, restoring the snapshot the same writer took when the dispute opened.
-- It is included as existing authoritative dispute-resolution behaviour, by owner decision, and **no separate
-- order-status writer is created here**: no function below contains an `update public.orders`, which pgTAP
-- also asserts.
--
-- **The financial consequence, stated so nobody mistakes it for a financial write.** 0021's
-- `release_seller_holds` considers only `o.status = 'completed'`, so while an order sits at `disputed` its
-- earnings stay in `seller_pending` with no ledger write at all; restoring the snapshot makes it eligible
-- again if it was `completed`, and the money then moves later, by the scheduled job. The resolution changes
-- what a future job is allowed to do. It moves nothing itself.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT THIS SURFACE DELIBERATELY DOES NOT DO
-- ---------------------------------------------------------------------------------------------------
-- **No evidence reader.** `public.dispute_evidence` has two read policies, a private bucket and four CHECK
-- constraints — and **nothing inserts a row**. The only write to that table anywhere would be a party's
-- upload, and no upload path exists. By owner decision the whole evidence surface is deferred until an
-- increment defines that workflow; there is no reader for it below and no signed-URL issuer.
--
-- **No writer for the four unreachable statuses.** `awaiting_seller`, `awaiting_buyer`, `under_review` and
-- `cancelled` are in `disputes_status_allowed`, in the partial unique index and in read-side filters — and
-- **nothing sets any of them**. `open_dispute` takes the column default `open`; `resolve_dispute` sets
-- `resolved`. Deferred by owner decision, recorded here, and the console offers only the two reachable
-- statuses as filters. The readers below hide nothing: they compare `p_status` as a parameter, so a dispute
-- in one of those four states would be returned if one existed.
--
-- **No writer for `assigned_to` or `due_at`.** Both columns exist; nothing assigns a dispute and nothing
-- changes a due date after it is opened. Deferred by owner decision.
--
-- **No second audit path and no notification.** `disputes_audit` already records every change through
-- `audit.tg_record_change('details', 'resolution_note')`, with both of those columns redacted; `orders_status_change`
-- already trails the order status; and 0027's writers already enqueue `dispute.message_posted` and
-- `dispute.resolved`. Nothing below writes an audit row, a security event, a notification or a second outbox
-- event.
--
-- **No party read path.** These functions are the staff surface. A buyer or a seller reads their own dispute
-- through 0027's party policies, and no such surface exists yet either.
--
-- ---------------------------------------------------------------------------------------------------
-- Money
-- ---------------------------------------------------------------------------------------------------
-- `claim_amount_minor`, `resolution_amount_minor` and the order totals are `bigint`. They are returned as
-- `bigint` and cross the API as **decimal strings** beside an explicit `currency_code`, never as a JSON
-- number: a JSON number is an IEEE double and a 64-bit minor amount does not fit one. That is the convention
-- 0015's offers and 0016's listing prices already use.
--
-- **No amount is validated here beyond what 0027 validates.** `disputes_resolution_amount_is_for_a_refund`
-- and `disputes_resolution_amount_positive` are the rules, and `resolve_dispute` applies them with the row
-- locked; the wrapper below adds no bound of its own and no comparison against the order total, because
-- 0027 makes none at resolution time.

-- ---------------------------------------------------------------------------------------------------
-- 1. The two predicates
-- ---------------------------------------------------------------------------------------------------
-- 0003's rule, restated with each key as a literal. Two functions rather than one taking a key: a shared
-- `holds_key(user, aal2, key)` reachable from `app_system` would be a generic permission oracle, and one bug
-- away from being asked about any key at all.
create or replace function app_private.dispute_can_read(
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
       and rp.permission_key = 'disputes.dispute.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.dispute_can_read(uuid, boolean) is
  'Whether one account holds disputes.dispute.read effectively — the key as a literal, and 0003''s own requires_mfa rule applied with the assurance level as a parameter. Only admin and super_admin hold it (0033, where moderator is excluded by decision), and both require MFA, so staff at aal1 hold nothing.';

create or replace function app_private.dispute_can_manage(
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
       and rp.permission_key = 'disputes.dispute.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.dispute_can_manage(uuid, boolean) is
  'Whether one account holds disputes.dispute.manage effectively — the key 0027''s own write policy requires together with is_aal2(). A different key from the read one, which is why the detail reports the capability rather than leaving a console to guess.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The queue
-- ---------------------------------------------------------------------------------------------------
-- Oldest first, because a dispute is a thing waiting to be worked: somebody is out of pocket while it sits
-- there, and the useful end of this list is the end that has waited longest. That is the opposite of the
-- review queue and the same as the support and recovery queues.
--
-- **The status filter compares a parameter**, so nothing is hidden: a dispute in one of the four states
-- nothing can currently set would be returned if one existed. What the console offers as a filter is the
-- console's business, and it offers the two reachable ones.
--
-- `is_party` is returned because `resolve_dispute` refuses a resolver who is the buyer or the seller, so a
-- console that could not see it would offer a control the writer rejects. It is the only thing said about the
-- caller's relationship to the dispute, and **no account is named**: not the buyer, not the seller, not the
-- colleague who resolved it. The storefront is named by the slug its own public projection publishes.
create or replace function app_private.dispute_queue_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_status text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  status text,
  reason_code text,
  currency_code char(3),
  claim_amount_minor bigint,
  order_number text,
  order_status text,
  order_type text,
  seller_slug text,
  seller_display_name text,
  is_party boolean,
  resolved_by_me boolean,
  resolution text,
  message_count bigint,
  has_details boolean,
  due_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.id,
         d.status,
         d.reason_code,
         d.currency_code,
         d.claim_amount_minor,
         o.order_number,
         o.status,
         o.order_type,
         s.slug,
         s.display_name,
         d.buyer_user_id = p_user_id or d.seller_user_id = p_user_id,
         d.resolved_by is not null and d.resolved_by = p_user_id,
         d.resolution,
         (select count(*) from public.dispute_messages m where m.dispute_id = d.id),
         -- Whether the opener wrote anything, without carrying four thousand characters of it into a queue.
         d.details is not null,
         d.due_at,
         d.created_at
    from public.disputes d
    join public.orders o on o.id = d.order_id
    left join public.seller_profiles s on s.user_id = d.seller_user_id
   where p_user_id is not null
     and app_private.dispute_can_read(p_user_id, p_is_aal2)
     and (p_status is null or d.status = p_status)
     -- The cursor is bound as two typed parameters and compared as a pair; no fragment is built from it.
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (d.created_at, d.id) > (p_cursor_created_at, p_cursor_id)
     )
   order by d.created_at, d.id
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.dispute_queue_for_staff(uuid, boolean, integer, text, timestamptz, uuid) is
  'One page of disputes for a holder of disputes.dispute.read at aal2, oldest first, optionally narrowed to one of 0027''s statuses. A row carries the reason, the claim, the order it is about and the storefront''s own handle — and no buyer, no seller account and no colleague resolver: the reader learns only whether they are a party and whether a decision was their own. It hides nothing: the status is compared as a parameter, so a dispute in a state nothing can currently set would still be returned.';

-- ---------------------------------------------------------------------------------------------------
-- 3. One dispute
-- ---------------------------------------------------------------------------------------------------
-- What a colleague needs to rule: what is claimed and why, which order it is about and where that order
-- stands, and any decision already recorded. The order's own totals cross so the claim can be judged against
-- the order — as `bigint`, alongside the one `currency_code` both the dispute and the order share by
-- composite foreign key.
--
-- `can_manage` is the capability, not the key: whether this same session may act. It is here because the read
-- is gated on one key and both writes on another, so a screen would otherwise have to guess and would offer a
-- control the database refuses.
--
-- **No evidence count is returned**, although the table exists: nothing inserts a row, so a count would be a
-- permanent zero implying a feature. The evidence surface is deferred whole.
create or replace function app_private.dispute_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_dispute_id uuid
) returns table (
  outcome text,
  id uuid,
  status text,
  reason_code text,
  details text,
  currency_code char(3),
  claim_amount_minor bigint,
  order_number text,
  order_status text,
  order_type text,
  order_grand_total_minor bigint,
  order_status_before text,
  order_placed_at timestamptz,
  seller_slug text,
  seller_display_name text,
  opened_by_role text,
  resolution text,
  resolution_amount_minor bigint,
  resolution_note text,
  resolved_at timestamptz,
  resolved_by_me boolean,
  is_party boolean,
  can_manage boolean,
  due_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null or p_dispute_id is null
     or not app_private.dispute_can_read(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::char(3),
                        null::bigint, null::text, null::text, null::text, null::bigint, null::text,
                        null::timestamptz, null::text, null::text, null::text, null::text, null::bigint,
                        null::text, null::timestamptz, null::boolean, null::boolean, null::boolean,
                        null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  return query
    select 'found'::text,
           d.id,
           d.status,
           d.reason_code,
           d.details,
           d.currency_code,
           d.claim_amount_minor,
           o.order_number,
           o.status,
           o.order_type,
           o.grand_total_minor,
           d.order_status_before,
           o.placed_at,
           s.slug,
           s.display_name,
           -- Which side opened it, as a side rather than an account. `disputes_opened_by_is_a_party`
           -- guarantees it is one of the two.
           case when d.opened_by = d.buyer_user_id then 'buyer' else 'seller' end,
           d.resolution,
           d.resolution_amount_minor,
           d.resolution_note,
           d.resolved_at,
           d.resolved_by is not null and d.resolved_by = p_user_id,
           d.buyer_user_id = p_user_id or d.seller_user_id = p_user_id,
           app_private.dispute_can_manage(p_user_id, p_is_aal2),
           d.due_at,
           d.created_at,
           d.updated_at
      from public.disputes d
      join public.orders o on o.id = d.order_id
      left join public.seller_profiles s on s.user_id = d.seller_user_id
     where d.id = p_dispute_id;

  if not found then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::char(3),
                        null::bigint, null::text, null::text, null::text, null::bigint, null::text,
                        null::timestamptz, null::text, null::text, null::text, null::text, null::bigint,
                        null::text, null::timestamptz, null::boolean, null::boolean, null::boolean,
                        null::timestamptz, null::timestamptz, null::timestamptz;
  end if;
end;
$$;

comment on function app_private.dispute_for_staff(uuid, boolean, uuid) is
  'One dispute for a holder of disputes.dispute.read at aal2, with the order it is about. A dispute that does not exist and a caller without the key answer identically. It names no account: which side opened it crosses as a side, the storefront by its own handle, and the reader learns only whether they are a party and whether a decision was theirs. No evidence count is returned, because nothing inserts evidence and a permanent zero would imply a feature.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The thread
-- ---------------------------------------------------------------------------------------------------
-- Every message, including the internal staff notes a party may not see: `dispute_messages_staff_read` gates
-- the whole table on `disputes.dispute.read`, and `dispute_messages_party_read` is the one that excludes
-- them. So a colleague reading here sees the exchange as it is.
--
-- **No author is named.** `author_role` is `buyer`, `seller` or `staff`, which is 0027's own column, and
-- `is_own_message` is the only thing said about the reader. A screen that named the staff author would be
-- naming a colleague on a record the other side may later see in a subject-access request.
create or replace function app_private.dispute_messages_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_dispute_id uuid,
  p_limit integer default 100
) returns table (
  id uuid,
  author_role text,
  body text,
  is_internal boolean,
  is_own_message boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select m.id,
         m.author_role,
         m.body,
         m.is_internal,
         m.author_user_id is not null and m.author_user_id = p_user_id,
         m.created_at
    from public.dispute_messages m
   where p_user_id is not null
     and p_dispute_id is not null
     and app_private.dispute_can_read(p_user_id, p_is_aal2)
     and m.dispute_id = p_dispute_id
   order by m.created_at, m.id
   limit least(greatest(coalesce(p_limit, 100), 1), 201);
$$;

comment on function app_private.dispute_messages_for_staff(uuid, boolean, uuid, integer) is
  'The thread on one dispute, oldest first, for a holder of disputes.dispute.read at aal2 — including the internal staff notes, which 0027 gates on this same key and hides from a party. It names no author: the role is 0027''s own column and the reader learns only which messages are their own.';

-- ---------------------------------------------------------------------------------------------------
-- 5. Posting a staff message or an internal note
-- ---------------------------------------------------------------------------------------------------
-- The permission and the assurance level are required here; **every other rule is 0027's.**
-- `post_dispute_message` works the author's role out of the dispute row rather than trusting an argument,
-- refuses a closed thread, and refuses an internal note from a party. Each refusal is returned as an outcome
-- rather than raised.
--
-- A colleague holding the manage key is `staff` to that writer unless they happen to be the buyer or the
-- seller, in which case it records them as that side — 0027's behaviour, preserved exactly. An internal note
-- from such a person is refused by the writer itself, which is why `is_party` is on both projections above.
create or replace function app_private.dispute_message_post_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_dispute_id uuid,
  p_body text,
  p_is_internal boolean
) returns table (
  outcome text,
  message_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  if p_user_id is null or p_dispute_id is null
     or not app_private.dispute_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  -- `dispute_messages_body_length` is the rule; answering here keeps an empty body a validation failure
  -- rather than a database error.
  if btrim(coalesce(p_body, '')) = '' then
    return query select 'body_required'::text, null::uuid;
    return;
  end if;

  begin
    v_id := app_private.post_dispute_message(p_dispute_id, p_user_id, btrim(p_body),
                                             coalesce(p_is_internal, false));
  exception
    when no_data_found then
      return query select 'not_found'::text, null::uuid;
      return;
    when restrict_violation then
      -- The dispute is resolved or cancelled, so its thread is closed. 0027's refusal.
      return query select 'closed'::text, null::uuid;
      return;
    when insufficient_privilege then
      -- An internal note from somebody who is a party to this dispute. 0027's refusal, and it discloses
      -- nothing: the only relationship it concerns is the caller's own.
      return query select 'is_party'::text, null::uuid;
      return;
    when invalid_parameter_value or check_violation then
      return query select 'invalid'::text, null::uuid;
      return;
  end;

  -- 0027's writer has enqueued `dispute.message_posted` and the append-only table keeps the message itself.
  -- This function writes no audit row, no security event, no notification and no second outbox event.
  return query select 'posted'::text, v_id;
end;
$$;

comment on function app_private.dispute_message_post_for_staff(uuid, boolean, uuid, text, boolean) is
  'Adds one staff message or internal note to a dispute through 0027''s post_dispute_message, requiring disputes.dispute.manage at aal2 first. Every other rule is 0027''s: the author''s role is worked out from the dispute, a closed thread is refused, and an internal note from a party is refused. It duplicates none of the writer''s effects.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Recording a resolution
-- ---------------------------------------------------------------------------------------------------
-- The permission and the assurance level are required here; **every other rule is 0027's.**
-- `resolve_dispute` validates the resolution against its four values, requires a reason, locks the row,
-- refuses one already resolved or cancelled, refuses a resolver who is a party, records who ruled and when,
-- restores the order's snapshot status and enqueues `dispute.resolved`.
--
-- ---------------------------------------------------------------------------------------------------
-- **THIS FUNCTION MOVES NO MONEY, AND NEITHER DOES THE WRITER IT CALLS.**
--
-- `refund_buyer` and `partial_refund` **record a decision**. No `public.refunds` row is created, no payment is
-- reversed, no ledger entry is posted, no seller balance changes, no payout or withdrawal is affected, and no
-- provider is called. Executing a refund is Phase 8's, `public.refunds` has no writer anywhere in this
-- repository, and the keys for it are `payments.refund.*` — which this surface never consumes.
--
-- The amount is recorded because `disputes.resolution_amount_minor` exists and 0027 permits it for exactly
-- those two resolutions. It is the decided amount, not a paid one.
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.dispute_resolve_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_dispute_id uuid,
  p_resolution text,
  p_resolution_note text,
  p_resolution_amount_minor bigint default null
) returns table (
  outcome text,
  status text,
  resolution text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_resolution text;
begin
  if p_user_id is null or p_dispute_id is null
     or not app_private.dispute_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  -- 0027's own four, and nothing else. Checked before the writer so an unusable resolution is a validation
  -- failure rather than a database error.
  if p_resolution is null
     or p_resolution not in ('refund_buyer', 'partial_refund', 'release_seller', 'no_action') then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  -- A dispute is never resolved without a reason. The writer raises for this; answering here keeps it a
  -- validation failure.
  if btrim(coalesce(p_resolution_note, '')) = '' then
    return query select 'reason_required'::text, null::text, null::text;
    return;
  end if;
  -- `disputes_resolution_amount_is_for_a_refund` permits an amount only for the two refund resolutions, and
  -- `resolve_dispute` nulls it for the others through a CASE. Refusing it here instead of silently dropping
  -- it means a console that sent one against `no_action` is told rather than quietly ignored.
  if p_resolution_amount_minor is not null
     and p_resolution not in ('refund_buyer', 'partial_refund') then
    return query select 'amount_not_allowed'::text, null::text, null::text;
    return;
  end if;
  -- `disputes_resolution_amount_positive`. Answered here for the same reason.
  if p_resolution_amount_minor is not null and p_resolution_amount_minor <= 0 then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  begin
    v_resolution := app_private.resolve_dispute(p_dispute_id, p_resolution, p_user_id,
                                                btrim(p_resolution_note), p_resolution_amount_minor);
  exception
    when no_data_found then
      return query select 'not_found'::text, null::text, null::text;
      return;
    when restrict_violation then
      -- Already resolved or cancelled. Somebody else got there first, or the page is stale.
      return query select 'already_resolved'::text, null::text, null::text;
      return;
    when insufficient_privilege then
      -- Nobody resolves a dispute they are a party to. 0027's refusal, and the remedy is a colleague.
      return query select 'is_party'::text, null::text, null::text;
      return;
    when invalid_parameter_value or check_violation then
      return query select 'invalid'::text, null::text, null::text;
      return;
  end;

  -- 0027's writer has recorded the decision, restored the order's snapshot status and enqueued
  -- `dispute.resolved`; 0018's own trigger has trailed the order status change and enqueued its event; and
  -- `disputes_audit` has recorded the row change with `details` and `resolution_note` redacted. This function
  -- writes no audit row, no security event, no notification and no second outbox event — and no refund.
  return query select 'resolved'::text, 'resolved'::text, v_resolution;
end;
$$;

comment on function app_private.dispute_resolve_for_staff(uuid, boolean, uuid, text, text, bigint) is
  'Records a dispute resolution through 0027''s resolve_dispute, requiring disputes.dispute.manage at aal2 first. It passes that writer''s four resolutions and requires its reason, and returns its refusals as outcomes — a dispute that does not exist, one already resolved, and one the caller is a party to, which nobody resolves. IT MOVES NO MONEY: refund_buyer and partial_refund record a decision, and no refund row, payment reversal, ledger entry, balance change, payout or provider call happens here or in the writer. Executing a refund is Phase 8 and public.refunds has no writer at all.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.dispute_can_read(uuid, boolean) from public;
revoke execute on function app_private.dispute_can_manage(uuid, boolean) from public;
revoke execute on function app_private.dispute_queue_for_staff(uuid, boolean, integer, text, timestamptz, uuid) from public;
revoke execute on function app_private.dispute_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.dispute_messages_for_staff(uuid, boolean, uuid, integer) from public;
revoke execute on function app_private.dispute_message_post_for_staff(uuid, boolean, uuid, text, boolean) from public;
revoke execute on function app_private.dispute_resolve_for_staff(uuid, boolean, uuid, text, text, bigint) from public;

grant execute on function app_private.dispute_can_read(uuid, boolean) to app_system;
grant execute on function app_private.dispute_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.dispute_queue_for_staff(uuid, boolean, integer, text, timestamptz, uuid) to app_system;
grant execute on function app_private.dispute_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.dispute_messages_for_staff(uuid, boolean, uuid, integer) to app_system;
grant execute on function app_private.dispute_message_post_for_staff(uuid, boolean, uuid, text, boolean) to app_system;
grant execute on function app_private.dispute_resolve_for_staff(uuid, boolean, uuid, text, text, bigint) to app_system;

select app_private.assert_security_contract();
