-- 0020 — Payment exception cases, their actions and policies, and fee allocation (v5.2 migration plan).
--
-- The five exception cases named in v5.2 are `late_success`, `duplicate_success`, `amount_mismatch`,
-- `currency_mismatch` and `unknown_reference`. Each is resolved per provider capability and platform
-- policy; unresolved receipts belong to the `unallocated_receipts` ledger account, which arrives with
-- the ledger in 0021.
--
-- D19 is structural here: no refund is ever automatic. A policy whose resolution is a refund or a
-- reversal must require manual approval — the CHECK constraint says so, so an automatic refund cannot be
-- configured by accident. Relaxing that is an owner decision after B1-A, and would be its own migration.
--
-- `settle_payment_attempt()` is the one place an attempt becomes `succeeded`. It refuses to do so on an
-- amount or currency mismatch, never lets a late success fulfil directly, and never lets a second
-- success fulfil a checkout that another attempt already fulfilled — each of those opens the matching
-- case instead.
--
-- NOT BUILT HERE, on purpose: `fee_allocation_policies` is conditional on D20, which is still BLOCKED.
-- `payment_fee_allocations` is not conditional and is built, because D20 also requires the ledger to
-- support platform, seller, buyer and split allocation without a later schema redesign.

-- ---------------------------------------------------------------------------------------------------
-- Exception policies
-- ---------------------------------------------------------------------------------------------------
create table public.payment_exception_policies (
  id uuid primary key default gen_random_uuid(),
  case_type text not null,
  resolution text not null,
  requires_manual_approval boolean not null default true,
  priority integer not null default 0,
  notes text,
  effective_from date not null default current_date,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_exception_policies_case_type_allowed check (
    case_type in ('late_success', 'duplicate_success', 'amount_mismatch', 'currency_mismatch', 'unknown_reference')
  ),
  constraint payment_exception_policies_resolution_allowed check (
    resolution in ('refund', 'reverse', 'reconcile', 'manual_review', 'hold')
  ),
  -- D19: no automatic refund is ever assumed, so a refunding or reversing policy always needs a human.
  constraint payment_exception_policies_refund_needs_approval check (
    resolution not in ('refund', 'reverse') or requires_manual_approval
  ),
  constraint payment_exception_policies_effective_order check (effective_to is null or effective_to > effective_from)
);
comment on table public.payment_exception_policies is
  'How each kind of payment exception is handled. Rows are seeded in 0033; a refunding or reversing policy always requires manual approval (D19).';
create index payment_exception_policies_lookup on public.payment_exception_policies (case_type, priority desc) where is_active;
create trigger payment_exception_policies_set_updated_at before update on public.payment_exception_policies
  for each row execute function app_private.tg_set_updated_at();
create trigger payment_exception_policies_audit after insert or update or delete on public.payment_exception_policies
  for each row execute function audit.tg_record_change();

create or replace function public.resolve_payment_exception_policy(p_case_type text, p_on date default null)
returns public.payment_exception_policies
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.*
    from public.payment_exception_policies p
   where p.is_active
     and p.case_type = p_case_type
     and p.effective_from <= coalesce(p_on, current_date)
     and (p.effective_to is null or p.effective_to > coalesce(p_on, current_date))
   order by p.priority desc, p.effective_from desc
   limit 1;
$$;
comment on function public.resolve_payment_exception_policy(text, date) is
  'The policy that applies to a case type. NULL means nothing is configured, and the case waits for a human.';

-- ---------------------------------------------------------------------------------------------------
-- Exception cases and actions
-- ---------------------------------------------------------------------------------------------------
create table public.payment_exception_cases (
  id uuid primary key default gen_random_uuid(),
  case_type text not null,
  status text not null default 'open',
  payment_provider_id uuid references public.payment_providers (id) on delete restrict,
  payment_id uuid references public.payments (id) on delete set null,
  payment_attempt_id uuid references public.payment_attempts (id) on delete set null,
  payment_event_id uuid references public.payment_events (id) on delete set null,
  checkout_id uuid references public.checkouts (id) on delete set null,
  provider_reference text,
  currency_code char(3) references public.currencies (code) on delete restrict,
  observed_amount_minor bigint,
  expected_amount_minor bigint,
  observed_currency_code char(3),
  policy_id uuid references public.payment_exception_policies (id) on delete set null,
  resolution text,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_exception_cases_type_allowed check (
    case_type in ('late_success', 'duplicate_success', 'amount_mismatch', 'currency_mismatch', 'unknown_reference')
  ),
  constraint payment_exception_cases_status_allowed check (status in ('open', 'in_progress', 'resolved', 'dismissed')),
  constraint payment_exception_cases_resolution_allowed check (
    resolution is null or resolution in ('refund', 'reverse', 'reconcile', 'manual_review', 'hold')
  ),
  constraint payment_exception_cases_amounts_positive check (
    (observed_amount_minor is null or observed_amount_minor >= 0)
    and (expected_amount_minor is null or expected_amount_minor >= 0)
  ),
  constraint payment_exception_cases_closed_has_time check ((status in ('resolved', 'dismissed')) = (resolved_at is not null)),
  constraint payment_exception_cases_closed_has_actor check (resolved_at is null or resolved_by is not null)
);
comment on table public.payment_exception_cases is
  'One case per unexpected payment outcome. Money that cannot be matched stays visible here until a human resolves it; it is never silently absorbed.';
-- A redelivered webhook must not open the same case twice.
create unique index payment_exception_cases_per_event on public.payment_exception_cases (case_type, payment_event_id)
  where payment_event_id is not null;
create unique index payment_exception_cases_open_per_attempt on public.payment_exception_cases (case_type, payment_attempt_id)
  where payment_attempt_id is not null and status in ('open', 'in_progress');
create index payment_exception_cases_queue on public.payment_exception_cases (status, opened_at) where status in ('open', 'in_progress');
create index payment_exception_cases_payment on public.payment_exception_cases (payment_id, opened_at desc);
create trigger payment_exception_cases_set_updated_at before update on public.payment_exception_cases
  for each row execute function app_private.tg_set_updated_at();
create trigger payment_exception_cases_audit after insert or update on public.payment_exception_cases
  for each row execute function audit.tg_record_change('notes');

create table public.payment_exception_actions (
  id uuid primary key default gen_random_uuid(),
  payment_exception_case_id uuid not null references public.payment_exception_cases (id) on delete cascade,
  action_type text not null,
  performed_by uuid references auth.users (id) on delete set null,
  performed_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb,
  outcome text,
  constraint payment_exception_actions_type_allowed check (
    action_type in ('opened', 'note', 'refund_requested', 'reversal_requested', 'reconciled', 'escalated', 'resolved', 'dismissed')
  ),
  constraint payment_exception_actions_details_is_object check (jsonb_typeof(details) = 'object')
);
comment on table public.payment_exception_actions is 'Append-only trail of what was done about a case, and by whom.';
create index payment_exception_actions_case on public.payment_exception_actions (payment_exception_case_id, performed_at);
create trigger payment_exception_actions_append_only before update or delete on public.payment_exception_actions
  for each row execute function app_private.tg_reject_write();

create or replace function app_private.open_payment_exception(
  p_case_type text,
  p_provider_id uuid default null,
  p_payment_id uuid default null,
  p_attempt_id uuid default null,
  p_event_id uuid default null,
  p_checkout_id uuid default null,
  p_currency_code char(3) default null,
  p_observed_amount_minor bigint default null,
  p_expected_amount_minor bigint default null,
  p_observed_currency_code char(3) default null,
  p_provider_reference text default null,
  p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  policy public.payment_exception_policies;
  new_id uuid;
begin
  policy := public.resolve_payment_exception_policy(p_case_type);

  insert into public.payment_exception_cases (
    case_type, payment_provider_id, payment_id, payment_attempt_id, payment_event_id, checkout_id,
    provider_reference, currency_code, observed_amount_minor, expected_amount_minor, observed_currency_code,
    policy_id, resolution, notes
  )
  values (
    p_case_type, p_provider_id, p_payment_id, p_attempt_id, p_event_id, p_checkout_id,
    p_provider_reference, p_currency_code, p_observed_amount_minor, p_expected_amount_minor, p_observed_currency_code,
    policy.id, policy.resolution, p_notes
  )
  on conflict do nothing
  returning id into new_id;

  if new_id is null then
    -- The case is already open for this event or attempt; a redelivery adds nothing.
    return null;
  end if;

  insert into public.payment_exception_actions (payment_exception_case_id, action_type, details)
  values (new_id, 'opened', jsonb_build_object('case_type', p_case_type, 'policy_id', policy.id, 'resolution', policy.resolution));

  perform public.enqueue_outbox_event(
    'payment_exception', new_id::text, 'payment_exception.opened',
    jsonb_build_object('case_id', new_id, 'case_type', p_case_type, 'payment_id', p_payment_id, 'attempt_id', p_attempt_id)
  );
  return new_id;
end;
$$;
comment on function app_private.open_payment_exception(text, uuid, uuid, uuid, uuid, uuid, char, bigint, bigint, char, text, text) is
  'Opens an exception case under the configured policy, once per event or open attempt, and publishes it for review.';

-- ---------------------------------------------------------------------------------------------------
-- Settling an attempt — the one place `succeeded` is written
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.settle_payment_attempt(
  p_attempt_id uuid,
  p_status text,
  p_provider_reference text default null,
  p_observed_amount_minor bigint default null,
  p_observed_currency_code char(3) default null,
  p_failure_code text default null
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt public.payment_attempts;
  checkout_row public.checkouts;
  payment_row public.payments;
  was_expired boolean;
begin
  if p_status not in ('pending', 'requires_action', 'succeeded', 'failed', 'cancelled', 'expired') then
    raise exception 'unknown attempt status %', p_status;
  end if;

  select * into attempt from public.payment_attempts a where a.id = p_attempt_id for update;
  if attempt.id is null then
    raise exception 'payment attempt % does not exist', p_attempt_id using errcode = 'no_data_found';
  end if;

  -- Re-reporting the same terminal outcome changes nothing (C10).
  if attempt.status = 'succeeded' then
    return 'already_succeeded';
  end if;

  if p_status <> 'succeeded' then
    update public.payment_attempts
       set status = p_status,
           provider_payment_ref = coalesce(p_provider_reference, provider_payment_ref),
           failed_at = case when p_status in ('failed', 'expired') then now() else failed_at end,
           failure_code = coalesce(p_failure_code, failure_code)
     where id = p_attempt_id;
    return p_status;
  end if;

  select * into payment_row from public.payments p where p.id = attempt.payment_id for update;

  -- A currency or amount mismatch never becomes a success; it becomes a case.
  if p_observed_currency_code is not null and p_observed_currency_code <> attempt.currency_code then
    perform app_private.open_payment_exception(
      'currency_mismatch', attempt.payment_provider_id, attempt.payment_id, p_attempt_id, null,
      payment_row.checkout_id, attempt.currency_code, p_observed_amount_minor, attempt.amount_minor,
      p_observed_currency_code, p_provider_reference, null
    );
    return 'currency_mismatch';
  end if;

  if p_observed_amount_minor is not null and p_observed_amount_minor <> attempt.amount_minor then
    perform app_private.open_payment_exception(
      'amount_mismatch', attempt.payment_provider_id, attempt.payment_id, p_attempt_id, null,
      payment_row.checkout_id, attempt.currency_code, p_observed_amount_minor, attempt.amount_minor,
      null, p_provider_reference, null
    );
    return 'amount_mismatch';
  end if;

  was_expired := attempt.status = 'expired';

  update public.payment_attempts
     set status = 'succeeded',
         succeeded_at = now(),
         provider_payment_ref = coalesce(p_provider_reference, provider_payment_ref)
   where id = p_attempt_id;

  update public.payments
     set status = 'paid', paid_at = coalesce(paid_at, now()), payment_provider_id = attempt.payment_provider_id
   where id = attempt.payment_id and status not in ('paid', 'partially_refunded', 'refunded');

  select * into checkout_row from public.checkouts c where c.id = payment_row.checkout_id for update;

  -- A second success for an already fulfilled checkout is money that arrived twice: record it, never
  -- fulfil again (D19).
  if checkout_row.fulfilled_attempt_id is not null and checkout_row.fulfilled_attempt_id <> p_attempt_id then
    perform app_private.open_payment_exception(
      'duplicate_success', attempt.payment_provider_id, attempt.payment_id, p_attempt_id, null,
      checkout_row.id, attempt.currency_code, coalesce(p_observed_amount_minor, attempt.amount_minor),
      attempt.amount_minor, null, p_provider_reference, null
    );
    return 'duplicate_success';
  end if;

  -- A success that arrives after the attempt expired never fulfils directly (D18).
  if was_expired then
    perform app_private.open_payment_exception(
      'late_success', attempt.payment_provider_id, attempt.payment_id, p_attempt_id, null,
      checkout_row.id, attempt.currency_code, coalesce(p_observed_amount_minor, attempt.amount_minor),
      attempt.amount_minor, null, p_provider_reference, null
    );
    return 'late_success';
  end if;

  perform public.enqueue_outbox_event(
    'payment', attempt.payment_id::text, 'payment.succeeded',
    jsonb_build_object('payment_id', attempt.payment_id, 'attempt_id', p_attempt_id, 'checkout_id', checkout_row.id)
  );
  return 'succeeded';
end;
$$;
comment on function app_private.settle_payment_attempt(uuid, text, text, bigint, char, text) is
  'The only path to a succeeded attempt. Mismatches, duplicates and late successes open a case instead of fulfilling; the worker fulfils only on the `succeeded` outcome.';

-- ---------------------------------------------------------------------------------------------------
-- Fee allocation (D20)
-- ---------------------------------------------------------------------------------------------------
create table public.payment_fee_allocations (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null,
  payment_id uuid not null,
  payment_attempt_id uuid references public.payment_attempts (id) on delete set null,
  order_id uuid references public.orders (id) on delete set null,
  seller_user_id uuid references public.seller_profiles (user_id) on delete restrict,
  fee_type text not null,
  allocated_to text not null default 'platform',
  amount_minor bigint not null,
  allocation_group_id uuid,
  policy_snapshot jsonb,
  created_at timestamptz not null default now(),
  foreign key (payment_id, currency_code) references public.payments (id, currency_code) on delete restrict,
  constraint payment_fee_allocations_fee_type_allowed check (fee_type in ('provider', 'platform', 'other')),
  constraint payment_fee_allocations_allocated_to_allowed check (allocated_to in ('platform', 'seller', 'buyer')),
  constraint payment_fee_allocations_amount_positive check (amount_minor > 0),
  constraint payment_fee_allocations_seller_is_named check ((allocated_to = 'seller') = (seller_user_id is not null)),
  constraint payment_fee_allocations_policy_is_object check (policy_snapshot is null or jsonb_typeof(policy_snapshot) = 'object')
);
comment on table public.payment_fee_allocations is
  'Who bears each fee. D20''s default is that the platform absorbs provider fees, which is the column default. A split is several rows sharing an allocation_group_id, one per party — so platform, seller, buyer and split are all expressible without a later schema change.';
comment on column public.payment_fee_allocations.allocation_group_id is
  'Ties the parts of one split fee together. NULL when a single party bears the whole fee.';
create index payment_fee_allocations_payment on public.payment_fee_allocations (payment_id, created_at);
create index payment_fee_allocations_order on public.payment_fee_allocations (order_id) where order_id is not null;
create index payment_fee_allocations_group on public.payment_fee_allocations (allocation_group_id) where allocation_group_id is not null;
create trigger payment_fee_allocations_append_only before update or delete on public.payment_fee_allocations
  for each row execute function app_private.tg_reject_write();

select app_private.register_currency_dependency(
  'payment_fee_allocations.currency_code', 'public', 'payment_fee_allocations', 'currency_code',
  'recorded fee allocations in the currency'
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.payment_exception_policies enable row level security;
alter table public.payment_exception_cases enable row level security;
alter table public.payment_exception_actions enable row level security;
alter table public.payment_fee_allocations enable row level security;

create policy payment_exception_policies_staff_read on public.payment_exception_policies for select to authenticated
  using (public.has_permission('payments.exception.read'));
create policy payment_exception_policies_admin_write on public.payment_exception_policies for all to authenticated
  using (public.has_permission('payments.exception.manage') and public.is_aal2())
  with check (public.has_permission('payments.exception.manage') and public.is_aal2());

create policy payment_exception_cases_staff_read on public.payment_exception_cases for select to authenticated
  using (public.has_permission('payments.exception.read'));
create policy payment_exception_cases_staff_update on public.payment_exception_cases for update to authenticated
  using (public.has_permission('payments.exception.manage') and public.is_aal2())
  with check (public.has_permission('payments.exception.manage') and public.is_aal2());

create policy payment_exception_actions_staff_read on public.payment_exception_actions for select to authenticated
  using (public.has_permission('payments.exception.read'));
create policy payment_exception_actions_staff_insert on public.payment_exception_actions for insert to authenticated
  with check (
    performed_by = public.current_user_id()
    and public.has_permission('payments.exception.manage')
    and public.is_aal2()
  );

-- A seller may see the fees charged against their own orders; buyers see fees they were asked to bear.
create policy payment_fee_allocations_seller_read on public.payment_fee_allocations for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy payment_fee_allocations_buyer_read on public.payment_fee_allocations for select to authenticated
  using (
    allocated_to = 'buyer'
    and exists (select 1 from public.payments p where p.id = payment_id and p.buyer_user_id = public.current_user_id())
  );
create policy payment_fee_allocations_staff_read on public.payment_fee_allocations for select to authenticated
  using (public.has_permission('payments.payment.read'));

grant select, insert, update, delete on public.payment_exception_policies to authenticated;
grant select, update on public.payment_exception_cases to authenticated;
grant select, insert on public.payment_exception_actions to authenticated;
grant select on public.payment_fee_allocations to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function public.resolve_payment_exception_policy(text, date) to authenticated;

grant execute on function
  public.resolve_payment_exception_policy(text, date),
  app_private.open_payment_exception(text, uuid, uuid, uuid, uuid, uuid, char, bigint, bigint, char, text, text),
  app_private.settle_payment_attempt(uuid, text, text, bigint, char, text)
  to app_system, app_worker;
