-- 0079 — Seller account status management (Phase 7-O).
--
-- One function. No schema change, no new permission, no new status, no new table, no trigger, and no write
-- to any table but `public.seller_profiles`.
--
-- This closes the first of the two capability gaps 0078 reported. The second — role assignment and removal —
-- remains a reported gap by owner decision, deferred to a dedicated security-focused increment after
-- Phase 7. Nothing in this migration writes `public.user_roles`, and 0078's assertion that nothing does
-- still holds.
--
-- ---------------------------------------------------------------------------------------------------
-- The transition table, as decided
-- ---------------------------------------------------------------------------------------------------
--
--     from        to           extra requirement
--     ---------   ----------   ---------------------------------------------------------------
--     pending  →  suspended    a reason
--     active   →  suspended    a reason
--     suspended → active       `verification_status = 'verified'`
--     suspended → pending      `verification_status <> 'verified'`
--     pending  →  closed       —
--     active   →  closed       —
--     suspended → closed       —
--
-- Nothing else is legal. In particular:
--
--   * **`closed` is terminal.** No transition leaves it. There is no reopen, no reactivate, and no path
--     from `closed` to anything — so a mis-closure is not correctable from this writer, which is the
--     consequence the decision accepts.
--   * **`active → pending` is refused.** An administrator cannot walk a live storefront backwards.
--   * **`pending → active` is refused here.** Activation is a consequence of 7-G's verification approval,
--     which is the only path that produces `verification_status = 'verified'` and the only owner of that
--     column. This writer touches `verification_status` nowhere at all.
--   * A request to move a storefront to the status it already holds is refused as `no_change` rather than
--     performed, so no audit row is written for a no-op.
--
-- **`suspended → pending` requires that the storefront is NOT verified, and this is an interpretation
-- worth confirming.** The decision states the two reinstatement conditions in parallel — `suspended →
-- active` requires `verified`, `suspended → pending` is for when it is not — so they are implemented as
-- strict complements: a verified storefront reinstates to `active` and a verified one cannot be parked in
-- `pending`. That reading invents nothing and cannot become a way to un-verify a storefront's standing
-- without touching 7-G, which is why it was chosen over the looser one. If the intent was that `pending`
-- is always available as a reinstatement target, the change is to drop one condition in this function.
--
-- ---------------------------------------------------------------------------------------------------
-- What the CHECK constraints force
-- ---------------------------------------------------------------------------------------------------
-- 0009's constraints are biconditional, so the timestamps are not optional bookkeeping — they are part of
-- what a status *is*:
--
--     seller_profiles_suspended_has_time    (status = 'suspended') = (suspended_at is not null)
--     seller_profiles_closed_has_time       (status = 'closed')    = (closed_at is not null)
--     seller_profiles_active_needs_verification  status <> 'active' or verification_status = 'verified'
--
-- So leaving `suspended` **must** null `suspended_at`, and reaching `closed` **must** null it too. That
-- second one is why a closure clears `suspension_reason` as well: the constraint takes the timestamp away
-- whatever this function wants, and a reason left behind with no time attached would read on the row as a
-- current suspension of a closed storefront. The history of both lives in the audit trail, which is the
-- decision's own stated reason for clearing them on reinstatement.
--
-- `suspension_reason` stays **nullable in the column**, as decided. The requirement is enforced here, where
-- the transition is, and not by tightening a column that older rows and 7-G's own paths also write.
--
-- ---------------------------------------------------------------------------------------------------
-- What this deliberately does NOT do
-- ---------------------------------------------------------------------------------------------------
--   * **No cascade, anywhere.** It writes one row in one table. It does not touch a listing, a service, an
--     offer, a service request, an order, a balance or a payout — not because those are unimportant but
--     because public visibility already follows seller status without them: `public.listing_is_visible()`
--     requires `s.status = 'active'` and is documented as "the single visibility decision every surface
--     follows", `public.is_seller_publicly_visible()` says the same for the storefront and its shipping
--     profiles, and the public listing policy is `using (listing_status_is_public(status) and
--     is_seller_publicly_visible(seller_user_id))`. Writing listing rows to match would be a second copy
--     of that decision, and the copy is the one that would drift.
--   * **No seller-side unlocking or locking.** Every seller-facing writer already gates on
--     `status not in ('pending','active')` (0059, 0060, 0061, 0062, 0063), and
--     `seller_profiles_self_update` already carries `status <> 'suspended'`. Suspension therefore stops a
--     seller editing, listing and submitting for verification with no further action, and reinstatement
--     restores it the same way.
--   * **No financial behaviour.** Nothing here reads or writes the ledger, balances, withdrawals or
--     payouts. Phase 8 owns those.
--   * **No audit row of its own.** 0009's `seller_profiles_audit` trigger already records every change to
--     this table through `audit.tg_record_change()`, naming the columns that moved. A second row written
--     from here would be a duplicate of the authoritative one.
--   * **No security event and no notification.** Neither vocabulary is extended.
--   * **No verification write.** `verification_status` and `verified_at` are read and never set.
--
-- ---------------------------------------------------------------------------------------------------
-- Two limitations of the existing audit trigger, recorded rather than worked around
-- ---------------------------------------------------------------------------------------------------
-- Both are pre-existing properties of `audit.tg_record_change()` that this writer inherits. Neither is
-- changed here, because the decision is to use the existing mechanism and to add no second audit path.
--
--   1. **The acting colleague is not recorded.** The trigger takes its actor from
--      `public.current_user_id()`, which reads a JWT claim. `app_system` connects with no claims, so every
--      audit row for a status change made through this writer carries `actor_type = 'system'` and
--      `actor_id = null`. The row records *what* changed and *when*, and not *who*. That is true of every
--      `app_system` write to every audited table in this repository, not only this one.
--   2. **`record_id` is null.** The trigger reads `coalesce(new_row, old_row) ->> 'id'`, and
--      `seller_profiles` has no `id` column — its key is `user_id`. Every audit row for this table since
--      0009 has therefore carried a null `record_id`, which means 7-O's audit reader cannot narrow to one
--      storefront by record.
--
-- Both are asserted as facts in this migration's own pgTAP suite, so they are visible rather than assumed.

-- ---------------------------------------------------------------------------------------------------
-- 1. The predicate
-- ---------------------------------------------------------------------------------------------------
-- 0003's own rule with the assurance level supplied instead of read from a claim, and the key written as a
-- **literal**. This is the manage key, which is not the read key 0078's seller readers use: a moderator
-- holds `sellers.profile.read` and does not hold this, so a moderator reads storefronts and cannot move
-- one. Both roles that hold this key — `admin` and `super_admin` — are `requires_mfa`, so the predicate's
-- own `(not r.requires_mfa or p_is_aal2)` refuses staff at `aal1`, which is how every other staff write in
-- Phase 7 reaches the same outcome.
create or replace function app_private.admin_can_manage_sellers(
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
       and rp.permission_key = 'sellers.profile.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.admin_can_manage_sellers(uuid, boolean) is
  'True when the account holds sellers.profile.manage in a session strong enough for the role that grants it — the key 0009''s own admin update policy requires, and the one 0033 gives to admin and super_admin alone. It is not the seller read key: a moderator reads storefronts and cannot move one.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The writer
-- ---------------------------------------------------------------------------------------------------
-- Addressed by **slug**, which is how every seller surface in 7-O addresses a storefront: the account
-- behind it never crosses, in either direction. The row is locked before anything is decided, so two
-- colleagues acting at once are ordered rather than raced and the second is told what the first did.
--
-- Named with the `admin_` prefix that 0078's seller readers carry, and deliberately **not** `seller_…`:
-- Phase 6's own suites (0057 through 0060) assert the exact inventory of `seller_`-prefixed functions,
-- because those are the seller's self-service surface and an unapproved addition to it is what those guards
-- exist to catch. A staff writer is not part of that surface, so it does not belong in that inventory — and
-- naming it as though it were would have turned a true statement about seller self-service into four
-- failing assertions.
create or replace function app_private.admin_seller_status_set(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_slug text,
  p_status text,
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
  v_current text;
  v_verification text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  -- Absence and a missing key are one answer, as they are on every read in 0078. There is no forbidden on
  -- this surface: a distinguishable refusal would be a way to ask whether a storefront exists.
  if p_user_id is null or p_slug is null or btrim(p_slug) = ''
     or not app_private.admin_can_manage_sellers(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- The four values 0009 allows, and nothing else. Checked before the row is read so an unusable status
  -- never becomes a lock.
  if p_status is null or p_status not in ('pending', 'active', 'suspended', 'closed') then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  select s.status, s.verification_status
    into v_current, v_verification
    from public.seller_profiles s
   where s.slug = p_slug
     for update;

  if v_current is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- **There is deliberately no refusal here for a colleague acting on their own storefront.** The seller
  -- decisions do not ask for one, and the role decisions forbid self-action explicitly — so the silence on
  -- this side is not an oversight to be filled from this file. It is reported for an owner decision, and
  -- the case that makes it worth deciding is a suspended seller who also holds the manage key reinstating
  -- themselves. 0078's reader already reports `is_own_storefront`, so a console can show it either way.

  if v_current = p_status then
    return query select 'no_change'::text, v_current;
    return;
  end if;

  -- `closed` is terminal. Stated first because it is the one refusal that is about where the storefront
  -- already is rather than about where it is going.
  if v_current = 'closed' then
    return query select 'not_allowed'::text, v_current;
    return;
  end if;

  -- The seven legal pairs, written out. A matrix rather than a rule, because the rule would have to be
  -- invented and the matrix was decided.
  if not (
       (v_current = 'pending'   and p_status = 'suspended')
    or (v_current = 'active'    and p_status = 'suspended')
    or (v_current = 'suspended' and p_status = 'active')
    or (v_current = 'suspended' and p_status = 'pending')
    or (v_current = 'pending'   and p_status = 'closed')
    or (v_current = 'active'    and p_status = 'closed')
    or (v_current = 'suspended' and p_status = 'closed')
  ) then
    -- Covers `active → pending` and `pending → active`. The second is 7-G's alone: activation follows
    -- verification approval and nothing here produces `verified`.
    return query select 'not_allowed'::text, v_current;
    return;
  end if;

  if p_status = 'suspended' and v_reason is null then
    return query select 'reason_required'::text, v_current;
    return;
  end if;

  -- The two reinstatement conditions, as strict complements. `active` additionally satisfies
  -- `seller_profiles_active_needs_verification`, so this check is the readable form of a constraint that
  -- would otherwise refuse the statement.
  if p_status = 'active' and v_verification <> 'verified' then
    return query select 'not_verified'::text, v_current;
    return;
  end if;
  if p_status = 'pending' and v_verification = 'verified' then
    return query select 'already_verified'::text, v_current;
    return;
  end if;

  -- One statement, four columns, consistent with the biconditional constraints in every branch. Nothing
  -- else in this table is touched: not the slug, not the display name, not the contact details, and
  -- neither verification column.
  update public.seller_profiles s
     set status = p_status,
         suspended_at = case when p_status = 'suspended' then now() else null end,
         suspension_reason = case when p_status = 'suspended' then v_reason else null end,
         closed_at = case when p_status = 'closed' then now() else null end
   where s.slug = p_slug;

  -- 0009's `seller_profiles_audit` trigger has now recorded the change and the columns that moved. This
  -- function writes no audit row, no security event and no outbox event.
  return query select 'updated'::text, p_status;
end;
$$;

comment on function app_private.admin_seller_status_set(uuid, boolean, text, text, text) is
  'Moves one storefront between the four statuses 0009 allows, for a colleague holding sellers.profile.manage at aal2, addressed by slug. It locks the row, then applies the seven legal transitions and nothing else: closed is terminal, active → pending is refused, and pending → active belongs to 7-G''s verification approval alone. A suspension requires a reason; reinstatement to active requires a verified storefront and reinstatement to pending requires an unverified one. It clears the timestamps the CHECK constraints require it to, writes one row in one table, cascades into no other domain, and leaves the audit trail to 0009''s own trigger.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.admin_can_manage_sellers(uuid, boolean) from public;
revoke execute on function app_private.admin_seller_status_set(uuid, boolean, text, text, text) from public;

grant execute on function app_private.admin_can_manage_sellers(uuid, boolean) to app_system;
grant execute on function app_private.admin_seller_status_set(uuid, boolean, text, text, text) to app_system;

select app_private.assert_security_contract();
