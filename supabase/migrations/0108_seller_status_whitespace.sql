-- 0108 — Whitespace normalisation in the seller status writer (corrective).
--
-- One function recreated. No schema change, no new permission, no new status, no behaviour change beyond
-- the defect described below, and no write to any table.
--
-- ---------------------------------------------------------------------------------------------------
-- The defect
-- ---------------------------------------------------------------------------------------------------
--
-- `app_private.admin_seller_status_set` normalised its suspension reason with
--
--     nullif(btrim(coalesce(p_reason, '')), '')
--
-- and `btrim(x)` with no character set trims **spaces only**. A reason consisting entirely of tabs or
-- newlines therefore survived it, was not null, and so did not fire the `reason_required` refusal — a
-- storefront could be suspended with a reason that reads as blank everywhere it is displayed. The same
-- loose form guarded `p_slug`, where a whitespace-only slug reached the lookup instead of being refused
-- as absent.
--
-- 0105 replaced this pattern across 64 constraints and 92 functions on owner decision 6, and added the
-- structural check that refuses it in any migration from 0106 onward. 0079 predates that line and was
-- therefore exempt, which is why the check did not catch it; it was found by reading, during 0100, and
-- recorded as a corrective candidate rather than fixed inside the increment that noticed it.
--
-- ---------------------------------------------------------------------------------------------------
-- What changes
-- ---------------------------------------------------------------------------------------------------
--
-- The two `btrim` calls gain the explicit character set `E' \t\r\n'` that 0096 and 0100 use. Every other
-- line of the function is the text 0079 shipped, extracted rather than retyped: the seven legal
-- transitions, the terminal `closed`, the verification complements, the row lock, the single update and
-- the four columns it touches are all unchanged, and the audit trail still belongs to 0009's trigger.
--
-- Nothing financial is involved. No existing row is rewritten: a storefront already suspended with a
-- whitespace-only reason keeps the value it has, because changing stored data is a separate decision from
-- closing the hole that let it in, and the owner has not been asked for that one.

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
  v_reason text := nullif(btrim(coalesce(p_reason, ''), E' \t\r\n'), '');
begin
  -- Absence and a missing key are one answer, as they are on every read in 0078. There is no forbidden on
  -- this surface: a distinguishable refusal would be a way to ask whether a storefront exists.
  if p_user_id is null or p_slug is null or btrim(p_slug, E' \t\r\n') = ''
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
-- Restated because `create or replace` keeps the existing privileges but says nothing about them, and a
-- reader of this file should not have to open 0079 to learn who may execute what it recreates.
revoke execute on function app_private.admin_seller_status_set(uuid, boolean, text, text, text) from public;
grant execute on function app_private.admin_seller_status_set(uuid, boolean, text, text, text) to app_system;

select app_private.assert_security_contract();
