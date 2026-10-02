-- 0084 — Audit actor attribution: a dedicated, transaction-local attribution channel (Phase 8-B).
--
-- **The gap.** `audit.tg_record_change()` takes its actor from `public.current_user_id()`, which reads
-- `request.jwt.claims`. The API connects as `app_system`, which carries no claims, so every console
-- write has recorded `actor_type = 'system'` with no actor. Seventeen audited tables are written through
-- `app_private` today, and fourteen of the forty-three audited tables are financial. F-2 makes this the
-- gate on the first new Phase 8 financial writer.
--
-- **Why a new channel rather than the existing one.** Fourteen functions read `current_user_id()`, and
-- they fall into two groups that must never be conflated: seven write attribution (`tg_record_change`,
-- `record_audit_event`, `record_security_event`, `enqueue_outbox_event`, `claim_idempotency_key` and the
-- two status-history triggers), and seven decide access (`has_permission`, `has_role`, `is_aal2`,
-- `has_step_up_grant`, `is_conversation_participant`, `is_verified_seller`, `can_join_realtime_topic`).
-- Making `current_user_id()` answer on the `app_system` connection would arm both at once — a generic
-- authorization oracle. So this migration adds a channel that only attribution reads, changes
-- `current_user_id()` not at all, and installs a deployment-blocking guard that fails the migration if
-- any authorization function ever learns to read it.
--
-- **The mechanism (A2).** The writer already receives the actor it was authorized with — 163
-- `app_private` functions take one. It publishes that same value into a transaction-local GUC before it
-- writes, and the trigger reads it. Nothing crosses the API boundary that did not already cross it, the
-- application changes nothing, and the actor that authorized the call is provably the actor the audit
-- row names, because there is only one value.
--
-- **Transaction-local storage, call-scoped attribution.** The value lives in a transaction-local GUC, so
-- `set_config(..., true)` discards it when the transaction commits or rolls back: no session state is
-- created and no pooled connection can carry one request's actor into another's, which is what C3
-- ("transaction-level locks only; no session-mode connections") requires.
--
-- The *active* actor, though, is scoped to the **writer call**, not to the whole transaction. Each writer
-- saves the actor it found, publishes its own for the duration of a labelled block, and restores the saved
-- one the moment that block is left — by an early return or the last statement alike. So:
--
--   * an empty scope publishes no actor at all;
--   * the first actor-bearing writer publishes its trusted actor for its own call;
--   * a nested writer with the **same** actor continues in that scope;
--   * a nested writer with a **different** actor fails closed with 42501, while the outer scope is active;
--   * after a nested writer returns, the previous actor is restored;
--   * a NULL actor establishes nothing and clears nothing, so a nested actorless step that is genuinely
--     part of the active operation inherits its actor — which is how `create_payout` and `settle_payout`
--     reach `transition_withdrawal(..., null, ...)` without losing or forging an identity;
--   * and two different actors may act **in sequence** in one transaction, each recording their own rows,
--     because the first writer's scope has fully returned before the second begins. A seller requesting a
--     withdrawal and a staff member then reviewing it is exactly that, and 0021's and 0022's own fixtures
--     do it in one transaction.
--
-- 42501 therefore means "a conflicting actor while another attribution scope is active", never "a second
-- actor anywhere in this transaction".
--
-- **The taxonomy.** An authenticated human actor — buyer, seller or staff — that an existing writer
-- already authorizes is `actor_type = 'user'` with that person's id. Worker-owned execution is
-- `'worker'`, a true system operation is `'system'`, and neither carries an actor id, because neither has
-- a person behind it: inventing a worker identity would be inventing a fact.
--
-- **What is in scope.** The financial subset only. Four writers of audited financial tables already carry
-- a trusted actor parameter, and each gains one line:
--
--     transition_withdrawal   p_actor_user_id   the staff member deciding a withdrawal
--     request_withdrawal      p_seller_user_id  the seller asking for their own funds
--     reconcile_settlement    p_actor_user_id   the staff member reconciling a statement
--     close_settlement        p_actor_user_id   the staff member closing one
--
-- No other writer is touched, no actor parameter is invented, no historical attribution is rewritten, no
-- authorization is changed, and `audit.audit_logs` stays append-only: attribution is correct at insert
-- time or not at all. `request_withdrawal`'s seller authorization is exactly what 0021 wrote — the limits,
-- the available balance, the dispute freeze and the post-recovery hold all still decide the request, and
-- the actor it publishes is the same seller those checks are applied to.
--
-- **The spoofing boundary, stated exactly.** The browser cannot reach this channel: it is set only inside
-- SECURITY DEFINER functions, from a parameter the API derived from the provider's own answer
-- (`getUser`), never from a token body and never from a request payload. `set_audit_actor` is executable
-- by no role at all — not `app_system`, not `app_worker` — so it is reachable only from a definer
-- function running as the owner. The channel is therefore exactly as trustworthy as the authorization
-- parameter beside it, which is the same value; a source guard in the repository additionally asserts
-- that no application code names the channel or the setter.

-- ---------------------------------------------------------------------------------------------------
-- The channel
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.audit_actor() returns uuid
language plpgsql
-- Deliberately VOLATILE. A writer publishes the actor and then writes, both inside one top-level
-- statement — `select app_private.reconcile_settlement(...)` is one statement, and the audit trigger
-- fires within it. A STABLE marking lets the planner answer from the value as of statement start, which
-- is before the writer published anything, and the row would be attributed to nobody. Verified: marked
-- stable, this returns NULL inside the trigger and the audit row reads `system`.
security definer
set search_path = pg_catalog, public
as $$
declare
  raw text := nullif(current_setting('app.audit_actor_id', true), '');
begin
  if raw is null then
    return null;
  end if;
  -- A value that is not a uuid is not an actor. Attribution never raises inside a trigger: a malformed
  -- channel degrades to "no attributed actor", which records the truthful `system`, not a wrong person.
  begin
    return raw::uuid;
  exception when others then
    return null;
  end;
end;
$$;
comment on function app_private.audit_actor() is
  'The staff actor attributed to the current transaction, or NULL. Attribution only: no authorization function may read this, and the security contract fails the deployment if one does.';

create or replace function app_private.set_audit_actor(p_actor_user_id uuid) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing uuid := app_private.audit_actor();
begin
  -- A call that names no actor claims nothing. If the transaction already has one it keeps it: a nested
  -- system step inside Alice's action is still Alice's action.
  if p_actor_user_id is null then
    return;
  end if;
  -- Fail closed. A second, different actor in one transaction is a bug or an attack, never a correction.
  if existing is not null and existing <> p_actor_user_id then
    raise exception 'this transaction is already attributed to a different actor'
      using errcode = 'insufficient_privilege';
  end if;
  if existing is null then
    perform set_config('app.audit_actor_id', p_actor_user_id::text, true);
  end if;
end;
$$;
comment on function app_private.set_audit_actor(uuid) is
  'Enters an attribution scope with the actor a writer was already authorized with. Idempotent for the same actor, raises 42501 for a different one while a scope is active, and no-op for NULL — NULL establishes nothing and clears nothing. Executable by no role: only a SECURITY DEFINER function running as the owner can reach it.';

create or replace function app_private.restore_audit_actor(p_saved uuid) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Leaving a writer's scope. The saved value may be NULL, which is how an outermost writer returns the
  -- transaction to having no active actor rather than leaving its own behind for unrelated work.
  perform set_config('app.audit_actor_id', coalesce(p_saved::text, ''), true);
end;
$$;
comment on function app_private.restore_audit_actor(uuid) is
  'Leaves an attribution scope, restoring the actor that was active when it was entered. Executable by no role, for the same reason as the setter.';

-- ---------------------------------------------------------------------------------------------------
-- What is allowed to touch the channel
-- ---------------------------------------------------------------------------------------------------
create table app_private.audit_attribution_contract (
  function_schema name not null,
  function_name name not null,
  role text not null,
  -- Which of the writer's own parameters it publishes. A writer names one; nothing else does, because
  -- nothing else publishes anything. The guard compares it with the function's real signature and body,
  -- so a writer cannot drift into publishing a different value than the one it was authorized with.
  actor_parameter name,
  reason text not null,
  primary key (function_schema, function_name),
  constraint audit_attribution_contract_role_allowed check (role in ('setter', 'reader', 'writer', 'guard')),
  constraint audit_attribution_contract_writer_names_actor check ((role = 'writer') = (actor_parameter is not null)),
  constraint audit_attribution_contract_reason_present check (length(btrim(reason)) > 0)
);
comment on table app_private.audit_attribution_contract is
  'Every function permitted to name the audit attribution channel, and why. Compared with reality by `audit_attribution_problems()`; anything else naming the channel fails the deployment.';
alter table app_private.audit_attribution_contract enable row level security;

insert into app_private.audit_attribution_contract (function_schema, function_name, role, actor_parameter, reason) values
  ('app_private', 'set_audit_actor',            'setter', null,               'enters an attribution scope'),
  ('app_private', 'restore_audit_actor',        'setter', null,               'leaves one, restoring the actor it found'),
  ('app_private', 'audit_actor',                'reader', null,               'the one reader of the channel'),
  ('audit',       'tg_record_change',           'reader', null,               'the attribution source of every audited row'),
  ('public',      'audit_attribution_problems', 'guard',  null,               'the guard names the channel in order to police it'),
  ('app_private', 'transition_withdrawal',      'writer', 'p_actor_user_id',  'a staff member deciding a withdrawal'),
  ('app_private', 'request_withdrawal',         'writer', 'p_seller_user_id', 'a seller asking for their own funds: a human financial action, not a system one'),
  ('app_private', 'reconcile_settlement',       'writer', 'p_actor_user_id',  'a staff member reconciling a provider statement'),
  ('app_private', 'close_settlement',           'writer', 'p_actor_user_id',  'a staff member closing a reconciled settlement');

-- ---------------------------------------------------------------------------------------------------
-- The attribution source
-- ---------------------------------------------------------------------------------------------------
create or replace function audit.tg_record_change() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  redacted text[] := coalesce(tg_argv, '{}'::text[]);
  old_row jsonb;
  new_row jsonb;
  changed text[];
  key text;
  attributed uuid := app_private.audit_actor();
  claimed uuid := public.current_user_id();
  actor uuid;
  actor_kind text;
begin
  -- The order is the whole of the attribution policy (Phase 8-B).
  --   1. a staff actor a writer published for this transaction — the console case;
  --   2. the verified claims of a signed-in session — unchanged from 0006, for anything reaching a
  --      table as `authenticated`;
  --   3. work arriving on the worker's own connection — owned by a job, not by a person;
  --   4. everything else — a true system operation.
  -- Only 1 and 2 can produce an actor id. Nothing here invents a worker or system identity.
  if attributed is not null then
    actor := attributed;
    actor_kind := 'user';
  elsif claimed is not null then
    actor := claimed;
    actor_kind := 'user';
  elsif session_user = 'app_worker' then
    actor := null;
    actor_kind := 'worker';
  else
    actor := null;
    actor_kind := 'system';
  end if;

  if tg_op <> 'INSERT' then
    old_row := to_jsonb(old);
  end if;
  if tg_op <> 'DELETE' then
    new_row := to_jsonb(new);
  end if;

  foreach key in array redacted loop
    if old_row ? key then old_row := jsonb_set(old_row, array[key], '"[redacted]"'::jsonb); end if;
    if new_row ? key then new_row := jsonb_set(new_row, array[key], '"[redacted]"'::jsonb); end if;
  end loop;

  if tg_op = 'UPDATE' then
    select coalesce(array_agg(k order by k), '{}'::text[])
      into changed
      from jsonb_object_keys(new_row) as k
      where new_row -> k is distinct from old_row -> k;
    if array_length(changed, 1) is null then
      return null;
    end if;
  end if;

  insert into audit.audit_logs (
    actor_id, actor_type, action, table_schema, table_name, record_id, changed_columns, old_values, new_values
  )
  values (
    actor,
    actor_kind,
    lower(tg_op),
    tg_table_schema,
    tg_table_name,
    coalesce(new_row, old_row) ->> 'id',
    changed,
    old_row,
    new_row
  );
  return null;
end;
$$;
comment on function audit.tg_record_change() is
  'AFTER ROW trigger writing one audit entry per change. Trigger arguments name columns to redact. The actor is the attribution channel, then the verified claims, then the connection: user, user, worker, system.';

-- ---------------------------------------------------------------------------------------------------
-- The writers in scope
-- ---------------------------------------------------------------------------------------------------
-- Each is its own migration's **latest** definition, with its statements unchanged, wrapped in the scope
-- described above: the only edits inside a body are `return X;` becoming `audit_scope_result := X; exit
-- actor_scope;`, so every exit path leaves through one place and restores the actor it found. Its first
-- statement, plus a labelled block and the restore that closes its scope: `transition_withdrawal` from
-- 0021, `request_withdrawal` from **0028** — which replaced 0021's
-- with the post-recovery security hold — and both settlement steps from 0023. Taking 0021's older
-- `request_withdrawal` would silently drop that hold, and 0028's own pgTAP assertion catches it. Their
-- authorization, their journals, their state machines and their comments are exactly what they were:
-- `create or replace` keeps the same function, so each keeps the comment its own migration gave it.
create or replace function app_private.transition_withdrawal(
  p_withdrawal_id uuid,
  p_next_status text,
  p_actor_user_id uuid default null,
  p_reason text default null
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  withdrawal public.withdrawals;
  journal_id uuid;
  audit_scope_saved uuid;
  audit_scope_result text;
begin
  -- Phase 8-B, call-scoped attribution. The actor this call was already authorized with is published
  -- for the duration of *this call* and no longer: the previous actor is saved first and restored the
  -- moment the labelled block below is left, by any path. A different actor arriving while this scope is
  -- active is refused by `set_audit_actor`; the same actor, or none at all, continues in it.
  audit_scope_saved := app_private.audit_actor();
  perform app_private.set_audit_actor(p_actor_user_id);
  <<actor_scope>>
  begin
    select * into withdrawal from public.withdrawals where id = p_withdrawal_id for update;
    if withdrawal.id is null then
      raise exception 'withdrawal % does not exist', p_withdrawal_id using errcode = 'no_data_found';
    end if;
    if withdrawal.status = p_next_status then
      audit_scope_result := 'unchanged'; exit actor_scope;
    end if;

    -- Releasing and paying both discharge the reservation; the transition trigger has already refused
    -- anything that is not a transition.
    if p_next_status in ('cancelled', 'rejected', 'failed') then
      journal_id := app_private.post_ledger_journal(
        'withdrawal_released',
        withdrawal.currency_code,
        jsonb_build_array(
          jsonb_build_object('account_type', 'seller_reserved', 'seller_user_id', withdrawal.seller_user_id,
                             'direction', 'debit', 'amount_minor', withdrawal.amount_minor,
                             'withdrawal_id', withdrawal.id, 'memo', coalesce(p_reason, p_next_status)),
          jsonb_build_object('account_type', 'seller_available', 'seller_user_id', withdrawal.seller_user_id,
                             'direction', 'credit', 'amount_minor', withdrawal.amount_minor,
                             'withdrawal_id', withdrawal.id, 'memo', coalesce(p_reason, p_next_status))
        ),
        'withdrawal', withdrawal.id::text,
        format('withdrawal:%s:released', withdrawal.id),
        'Withdrawal funds released'
      );
    elsif p_next_status = 'paid' then
      journal_id := app_private.post_ledger_journal(
        'withdrawal_paid',
        withdrawal.currency_code,
        jsonb_build_array(
          jsonb_build_object('account_type', 'seller_reserved', 'seller_user_id', withdrawal.seller_user_id,
                             'direction', 'debit', 'amount_minor', withdrawal.amount_minor,
                             'withdrawal_id', withdrawal.id, 'memo', 'withdrawal paid'),
          jsonb_build_object('account_type', 'payout_clearing',
                             'direction', 'credit', 'amount_minor', withdrawal.amount_minor,
                             'withdrawal_id', withdrawal.id, 'memo', 'withdrawal paid')
        ),
        'withdrawal', withdrawal.id::text,
        format('withdrawal:%s:paid', withdrawal.id),
        'Withdrawal paid out'
      );
    end if;

    update public.withdrawals w
       set status = p_next_status,
           reviewed_at = case when p_next_status = 'under_review' then now() else w.reviewed_at end,
           reviewed_by = case when p_next_status = 'under_review' then coalesce(p_actor_user_id, w.reviewed_by) else w.reviewed_by end,
           approved_at = case when p_next_status = 'approved' then now() else w.approved_at end,
           approved_by = case when p_next_status = 'approved' then coalesce(p_actor_user_id, w.approved_by) else w.approved_by end,
           processing_at = case when p_next_status = 'processing' then now() else w.processing_at end,
           paid_at = case when p_next_status = 'paid' then now() else w.paid_at end,
           rejected_at = case when p_next_status = 'rejected' then now() else w.rejected_at end,
           rejection_reason = case when p_next_status = 'rejected' then p_reason else w.rejection_reason end,
           failed_at = case when p_next_status = 'failed' then now() else w.failed_at end,
           failure_code = case when p_next_status = 'failed' then p_reason else w.failure_code end,
           cancelled_at = case when p_next_status = 'cancelled' then now() else w.cancelled_at end,
           settlement_journal_id = coalesce(journal_id, w.settlement_journal_id)
     where w.id = p_withdrawal_id;

    perform public.enqueue_outbox_event(
      'withdrawal', p_withdrawal_id::text, format('withdrawal.%s', p_next_status),
      jsonb_build_object('withdrawal_id', p_withdrawal_id, 'status', p_next_status)
    );
    audit_scope_result := p_next_status; exit actor_scope;
  end;
  perform app_private.restore_audit_actor(audit_scope_saved);
  return audit_scope_result;
end;
$$;

create or replace function app_private.request_withdrawal(
  p_seller_user_id uuid,
  p_currency_code char(3),
  p_amount_minor bigint,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing_id uuid;
  caps public.withdrawal_limits;
  balance public.seller_balances;
  open_requests integer;
  today_total bigint;
  withdrawal_id uuid;
  journal_id uuid;
  audit_scope_saved uuid;
  audit_scope_result uuid;
begin
  -- Phase 8-B, call-scoped attribution. The actor this call was already authorized with is published
  -- for the duration of *this call* and no longer: the previous actor is saved first and restored the
  -- moment the labelled block below is left, by any path. A different actor arriving while this scope is
  -- active is refused by `set_audit_actor`; the same actor, or none at all, continues in it.
  audit_scope_saved := app_private.audit_actor();
  perform app_private.set_audit_actor(p_seller_user_id);
  <<actor_scope>>
  begin
    if p_idempotency_key is not null then
      select w.id into existing_id from public.withdrawals w where w.idempotency_key = p_idempotency_key;
      if existing_id is not null then
        audit_scope_result := existing_id; exit actor_scope;
      end if;
    end if;

    -- Fail closed: a currency with no active limits row cannot be withdrawn in.
    select * into caps from public.withdrawal_limits l
     where l.currency_code = p_currency_code and l.is_active;
    if caps.currency_code is null then
      raise exception 'withdrawals are not configured for %', p_currency_code using errcode = 'restrict_violation';
    end if;

    if p_amount_minor < caps.min_amount_minor then
      raise exception 'the withdrawal minimum for % is %', p_currency_code, caps.min_amount_minor
        using errcode = 'check_violation';
    end if;
    if caps.max_amount_minor is not null and p_amount_minor > caps.max_amount_minor then
      raise exception 'the withdrawal maximum for % is %', p_currency_code, caps.max_amount_minor
        using errcode = 'check_violation';
    end if;

    -- 0028: the block a completed account recovery puts on withdrawals.
    if public.user_has_security_hold(p_seller_user_id, 'withdrawal') then
      raise exception 'withdrawals are held after a recent account recovery' using errcode = 'restrict_violation';
    end if;

    -- D26: nothing is withdrawable while a dispute is holding this seller's funds.
    if public.seller_funds_are_frozen(p_seller_user_id) then
      raise exception 'an open dispute is holding this seller''s funds' using errcode = 'restrict_violation';
    end if;

    perform app_private.ensure_seller_balance(p_seller_user_id, p_currency_code);
    select * into balance
      from public.seller_balances b
     where b.seller_user_id = p_seller_user_id and b.currency_code = p_currency_code
       for update;

    if balance.available_minor < p_amount_minor then
      raise exception 'available funds % are below the requested %', balance.available_minor, p_amount_minor
        using errcode = 'check_violation';
    end if;

    select count(*) into open_requests
      from public.withdrawals w
     where w.seller_user_id = p_seller_user_id
       and w.currency_code = p_currency_code
       and w.status in ('requested', 'under_review', 'approved', 'processing');
    if caps.max_open_requests is not null and open_requests >= caps.max_open_requests then
      raise exception 'this seller already has % open withdrawals', open_requests using errcode = 'restrict_violation';
    end if;

    if caps.daily_limit_minor is not null then
      select coalesce(sum(w.amount_minor), 0) into today_total
        from public.withdrawals w
       where w.seller_user_id = p_seller_user_id
         and w.currency_code = p_currency_code
         and w.requested_at >= date_trunc('day', now())
         and w.status <> 'cancelled';
      if today_total + p_amount_minor > caps.daily_limit_minor then
        raise exception 'the daily withdrawal limit for % is %', p_currency_code, caps.daily_limit_minor
          using errcode = 'restrict_violation';
      end if;
    end if;

    insert into public.withdrawals (currency_code, seller_user_id, amount_minor, idempotency_key)
    values (p_currency_code, p_seller_user_id, p_amount_minor, p_idempotency_key)
    returning id into withdrawal_id;

    -- Funds are reserved the moment the request exists, so the same money cannot be requested twice.
    journal_id := app_private.post_ledger_journal(
      'withdrawal_reserved',
      p_currency_code,
      jsonb_build_array(
        jsonb_build_object('account_type', 'seller_available', 'seller_user_id', p_seller_user_id,
                           'direction', 'debit', 'amount_minor', p_amount_minor,
                           'withdrawal_id', withdrawal_id, 'memo', 'withdrawal requested'),
        jsonb_build_object('account_type', 'seller_reserved', 'seller_user_id', p_seller_user_id,
                           'direction', 'credit', 'amount_minor', p_amount_minor,
                           'withdrawal_id', withdrawal_id, 'memo', 'withdrawal requested')
      ),
      'withdrawal', withdrawal_id::text,
      format('withdrawal:%s:reserved', withdrawal_id),
      'Withdrawal requested'
    );

    update public.withdrawals set reserve_journal_id = journal_id where id = withdrawal_id;

    perform public.enqueue_outbox_event(
      'withdrawal', withdrawal_id::text, 'withdrawal.requested',
      jsonb_build_object('withdrawal_id', withdrawal_id, 'seller_user_id', p_seller_user_id,
                         'currency_code', p_currency_code, 'amount_minor', p_amount_minor)
    );
    audit_scope_result := withdrawal_id; exit actor_scope;
  end;
  perform app_private.restore_audit_actor(audit_scope_saved);
  return audit_scope_result;
end;
$$;

create or replace function app_private.reconcile_settlement(
  p_settlement_id uuid,
  p_actor_user_id uuid default null
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  settlement public.provider_settlements;
  payouts_confirmed bigint := 0;
  fees_reported bigint := 0;
  fees_already_recorded bigint := 0;
  fee_delta bigint := 0;
  unattributed bigint := 0;
  variance bigint := 0;
  debits bigint := 0;
  credits bigint := 0;
  balancing bigint := 0;
  entries jsonb := '[]'::jsonb;
  journal_id uuid;
  audit_scope_saved uuid;
  audit_scope_result text;
begin
  -- Phase 8-B, call-scoped attribution. The actor this call was already authorized with is published
  -- for the duration of *this call* and no longer: the previous actor is saved first and restored the
  -- moment the labelled block below is left, by any path. A different actor arriving while this scope is
  -- active is refused by `set_audit_actor`; the same actor, or none at all, continues in it.
  audit_scope_saved := app_private.audit_actor();
  perform app_private.set_audit_actor(p_actor_user_id);
  <<actor_scope>>
  begin
    select * into settlement from public.provider_settlements s where s.id = p_settlement_id for update;
    if settlement.id is null then
      raise exception 'settlement % does not exist', p_settlement_id using errcode = 'no_data_found';
    end if;
    if settlement.status <> 'matched' then
      raise exception 'settlement % must be matched before it can be reconciled, not %',
        p_settlement_id, settlement.status using errcode = 'restrict_violation';
    end if;

    -- B1-C: the settlement model is still open, so nothing is posted to the ledger yet. The comparison
    -- has already been made and recorded; only the journal waits.
    if not coalesce((public.site_setting('finance.settlement_posting_enabled'))::boolean, false) then
      update public.provider_settlements
         set posting_blocked_reason = 'the settlement model is not approved yet (B1-C)'
       where id = p_settlement_id;
      audit_scope_result := 'posting_blocked'; exit actor_scope;
    end if;

    -- Payouts the statement confirms have left discharge the obligation 0022 put into payout clearing.
    select coalesce(sum(i.amount_minor), 0) into payouts_confirmed
      from public.provider_settlement_items i
     where i.provider_settlement_id = p_settlement_id
       and i.item_kind = 'payout'
       and i.direction = 'outbound'
       and i.match_status = 'matched';

    select coalesce(sum(i.amount_minor), 0) into fees_reported
      from public.provider_settlement_items i
     where i.provider_settlement_id = p_settlement_id and i.item_kind = 'fee';

    -- Fees we have already taken as an expense are not taken twice (D20).
    select coalesce(sum(fa.amount_minor), 0) into fees_already_recorded
      from public.payment_fee_allocations fa
     where fa.allocated_to = 'platform'
       and fa.currency_code = settlement.currency_code
       and fa.payment_id in (
         select i.payment_id from public.provider_settlement_items i
          where i.provider_settlement_id = p_settlement_id and i.payment_id is not null
       );
    fee_delta := greatest(fees_reported - fees_already_recorded, 0);

    -- Money on the statement we cannot yet attribute to anything of ours.
    select coalesce(sum(i.amount_minor), 0) into unattributed
      from public.provider_settlement_items i
     where i.provider_settlement_id = p_settlement_id
       and i.direction = 'inbound'
       and i.match_status in ('unmatched', 'mismatched');

    variance := settlement.variance_minor;

    if payouts_confirmed > 0 then
      entries := entries || jsonb_build_array(jsonb_build_object(
        'account_type', 'payout_clearing', 'direction', 'debit', 'amount_minor', payouts_confirmed,
        'memo', 'payouts confirmed by the statement'));
      debits := debits + payouts_confirmed;
    end if;
    if fee_delta > 0 then
      entries := entries || jsonb_build_array(jsonb_build_object(
        'account_type', 'payment_fees', 'direction', 'debit', 'amount_minor', fee_delta,
        'memo', 'fees the statement reports that were not already recorded'));
      debits := debits + fee_delta;
    end if;
    if unattributed > 0 then
      entries := entries || jsonb_build_array(jsonb_build_object(
        'account_type', 'unallocated_receipts', 'direction', 'credit', 'amount_minor', unattributed,
        'memo', 'statement lines not attributable to our records'));
      credits := credits + unattributed;
    end if;
    if variance > 0 then
      entries := entries || jsonb_build_array(jsonb_build_object(
        'account_type', 'fee_variance', 'direction', 'debit', 'amount_minor', variance,
        'memo', 'the statement claims more than its lines add up to'));
      debits := debits + variance;
    elsif variance < 0 then
      entries := entries || jsonb_build_array(jsonb_build_object(
        'account_type', 'fee_variance', 'direction', 'credit', 'amount_minor', -variance,
        'memo', 'the statement claims less than its lines add up to'));
      credits := credits - variance;
    end if;

    balancing := debits - credits;
    if balancing > 0 then
      entries := entries || jsonb_build_array(jsonb_build_object(
        'account_type', 'provider_clearing', 'direction', 'credit', 'amount_minor', balancing,
        'memo', 'settlement against provider clearing'));
    elsif balancing < 0 then
      entries := entries || jsonb_build_array(jsonb_build_object(
        'account_type', 'provider_clearing', 'direction', 'debit', 'amount_minor', -balancing,
        'memo', 'settlement against provider clearing'));
    end if;

    if jsonb_array_length(entries) < 2 then
      -- The statement agrees with itself and with everything we already hold, so there is nothing for a
      -- journal to say. An empty journal is not posted to make the record look busier than it is.
      update public.provider_settlements
         set status = 'reconciled',
             reconciled_at = now(),
             reconciled_by = p_actor_user_id,
             posting_blocked_reason = null
       where id = p_settlement_id;

      perform public.enqueue_outbox_event(
        'settlement', p_settlement_id::text, 'settlement.reconciled',
        jsonb_build_object('provider_settlement_id', p_settlement_id, 'variance_minor', 0,
                           'unmatched_amount_minor', 0)
      );
      audit_scope_result := 'balanced'; exit actor_scope;
    end if;

    journal_id := app_private.post_ledger_journal(
      'settlement', settlement.currency_code, entries,
      'settlement', p_settlement_id::text,
      format('settlement:%s', p_settlement_id),
      format('Provider settlement %s', settlement.statement_reference),
      p_actor_user_id
    );

    update public.provider_settlements
       set status = case when variance = 0 and unattributed = 0 then 'reconciled' else 'variance' end,
           reconciled_at = now(),
           reconciled_by = p_actor_user_id,
           ledger_journal_id = journal_id,
           posting_blocked_reason = null
     where id = p_settlement_id;

    perform public.enqueue_outbox_event(
      'settlement', p_settlement_id::text,
      case when variance = 0 and unattributed = 0 then 'settlement.reconciled' else 'settlement.variance' end,
      jsonb_build_object('provider_settlement_id', p_settlement_id, 'variance_minor', variance,
                         'unmatched_amount_minor', unattributed, 'ledger_journal_id', journal_id)
    );

    audit_scope_result := case when variance = 0 and unattributed = 0 then 'balanced' else 'variance' end; exit actor_scope;
  end;
  perform app_private.restore_audit_actor(audit_scope_saved);
  return audit_scope_result;
end;
$$;

create or replace function app_private.close_settlement(p_settlement_id uuid, p_actor_user_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
  audit_scope_saved uuid;
  audit_scope_result boolean;
begin
  -- Phase 8-B, call-scoped attribution. The actor this call was already authorized with is published
  -- for the duration of *this call* and no longer: the previous actor is saved first and restored the
  -- moment the labelled block below is left, by any path. A different actor arriving while this scope is
  -- active is refused by `set_audit_actor`; the same actor, or none at all, continues in it.
  audit_scope_saved := app_private.audit_actor();
  perform app_private.set_audit_actor(p_actor_user_id);
  <<actor_scope>>
  begin
    update public.provider_settlements
       set status = 'closed', closed_at = now(), reconciled_by = coalesce(reconciled_by, p_actor_user_id)
     where id = p_settlement_id
       and status in ('reconciled', 'variance');
    get diagnostics updated = row_count;
    if updated = 0 then
      raise exception 'only a reconciled settlement can be closed' using errcode = 'restrict_violation';
    end if;
    audit_scope_result := true; exit actor_scope;
  end;
  perform app_private.restore_audit_actor(audit_scope_saved);
  return audit_scope_result;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- The guard (Q6): the channel may never become an authorization input
-- ---------------------------------------------------------------------------------------------------
create or replace function public.audit_attribution_problems()
returns table (object text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with named as (
    select n.nspname::name as s, p.proname::name as f, p.oid, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'app_private', 'audit')
       and p.prokind = 'f'
       and pg_get_functiondef(p.oid) like '%app.audit_actor_id%'
  )
  -- 1. Anything naming the channel that the contract does not approve.
  select format('%s.%s', named.s, named.f), 'names the audit attribution channel without being in the contract'
    from named
   where not exists (
     select 1 from app_private.audit_attribution_contract c
      where c.function_schema = named.s and c.function_name = named.f)
  union all
  -- 2. The authorization predicates, named one by one so a failure says which one turned.
  select format('%s.%s', named.s, named.f), 'an authorization function reads the audit attribution channel'
    from named
   where named.f in ('current_user_id', 'has_permission', 'has_role', 'is_aal2', 'has_step_up_grant',
                     'is_conversation_participant', 'is_verified_seller', 'can_join_realtime_topic',
                     'staff_has_permission')
  union all
  -- 3. Any permission predicate: the console's predicates all take (p_user_id uuid, p_is_aal2 boolean).
  select format('%s.%s', named.s, named.f), 'a permission predicate reads the audit attribution channel'
    from named
   where pg_get_function_arguments(named.oid) = 'p_user_id uuid, p_is_aal2 boolean'
  union all
  -- 4. Any function an RLS policy calls: a policy that could see the channel is a policy the channel
  --    decides, which is the oracle this guard exists to prevent.
  select format('%s.%s', named.s, named.f), 'an RLS policy calls a function that reads the audit attribution channel'
    from named
   where exists (
     select 1 from pg_policies pol
      where coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '') like '%' || named.f || '%')
  union all
  -- 5. The channel's own functions must be reachable only from a definer function running as the owner.
  select format('app_private.%s', p.proname), format('%s may execute it directly', r.rolname)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('public'), ('anon'), ('authenticated'), ('app_api'), ('app_system'), ('app_worker')) as r(rolname)
   where n.nspname = 'app_private'
     and p.proname in ('set_audit_actor', 'restore_audit_actor', 'audit_actor')
     and has_function_privilege(r.rolname, p.oid, 'execute')
  union all
  -- 6. Every approved writer must still take the parameter it names, and must still publish that one
  --    and no other. This is what keeps the audited actor and the authorized actor the same value.
  select format('%s.%s', c.function_schema, c.function_name),
         format('an approved attribution writer no longer takes and publishes %s', c.actor_parameter)
    from app_private.audit_attribution_contract c
   where c.role = 'writer'
     and not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = c.function_schema and p.proname = c.function_name
          and pg_get_function_arguments(p.oid) like '%' || c.actor_parameter || ' uuid%'
          and pg_get_functiondef(p.oid) ~ ('set_audit_actor\(' || c.actor_parameter || '\)')
          -- A writer that enters a scope and never leaves it would strand its actor over the rest of the
          -- transaction, which is the whole failure this scoping exists to prevent.
          and pg_get_functiondef(p.oid) ~ 'restore_audit_actor\(audit_scope_saved\)');
$$;
comment on function public.audit_attribution_problems() is
  'Where the audit attribution channel has escaped attribution: an unapproved reader, an authorization function, a permission predicate, an RLS-reachable function, a direct grant, or an approved writer that lost its actor parameter.';

create or replace function public.security_contract_problems()
returns table (area text, object text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select 'rls', * from public.rls_problems()
  union all select 'grants', * from public.grant_problems()
  union all select 'anon', * from public.anon_privilege_problems()
  union all select 'roles', * from public.role_boundary_problems()
  union all select 'security_definer', * from public.definer_problems()
  union all select 'views', * from public.view_security_problems()
  union all select 'append_only', * from public.append_only_problems()
  union all select 'storage', * from public.storage_bucket_problems()
  union all select 'audit_attribution', * from public.audit_attribution_problems();
$$;
comment on function public.security_contract_problems() is
  'Every violation of the Phase 2 security contract, in one place. Empty means the contract holds.';

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;
revoke execute on all functions in schema audit from public;

-- The channel is reachable only from a SECURITY DEFINER function running as the owner. No role holds it.
revoke all on function app_private.audit_actor(), app_private.set_audit_actor(uuid),
  app_private.restore_audit_actor(uuid)
  from public, anon, authenticated, app_api, app_system, app_worker;

-- The guard reads like every other guard: server roles only, so the admin security page and the
-- scheduled contract check can reach it and a signed-in request cannot.
grant execute on function public.audit_attribution_problems() to app_system, app_worker;

select app_private.assert_security_contract();
